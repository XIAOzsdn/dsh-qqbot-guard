/**
 * 充值请求：解析「充值 50 支付宝」、排队、脱敏订单号、与 agent 的文件桥。
 *
 * 流程（插件 ⇄ agent 协作）：
 *   1. QQ 用户发充值指令 → 插件写请求文件 <dataDir>/recharge/req-<id>.json
 *   2. 插件调用 agent.followup() 唤醒 agent
 *   3. agent 用浏览器完成充值，把二维码图片写到 <dataDir>/recharge/qr-<id>.png
 *   4. agent 把结果写到 <dataDir>/recharge/res-<id>.json
 *   5. 插件轮询目录：发二维码图片 / 把结果回执到群里
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
/** 支持的支付方式 */
export const PAY_METHODS = Object.freeze({
  alipay: '支付宝',
  wechat: '微信支付',
});

const METHOD_ALIASES = [
  ['支付宝', 'alipay'], ['alipay', 'alipay'], ['zfb', 'alipay'], ['阿里', 'alipay'],
  ['微信支付', 'wechat'], ['微信', 'wechat'], ['wechat', 'wechat'], ['wx', 'wechat'], ['weixin', 'wechat'],
];

/** 充值失败分类：仅在“完全未配置”时用配置引导；其余给出错误码 + 处置建议 */
export const RECHARGE_ERRORS = Object.freeze({
  /** 完全没有配置充值处理端（未安装 BrowserSkill / 插件未接入） */
  NOT_CONFIGURED: '充值失败，请先进行配置后再试，具体配置方法请参考帮助文档或联系 GitHub 仓库维护人员咨询',
  /** 处理端在，但插件无法访问 DSH 的 agent 服务 */
  AGENT_UNAVAILABLE: '充值处理失败（E_AGENT_UNAVAILABLE）：插件无法访问 DSH 的会话服务（agents）。请确认 DSH 已完整启动后重试；若持续出现请查看 recharge/bridge.log。',
  /** 浏览器扩展未连接 */
  BROWSER_NOT_CONNECTED: '充值处理失败（E_BROWSER_NOT_CONNECTED）：浏览器扩展未连接，无法打开支付页。请打开浏览器扩展并确认显示「已连接」后重试；仍未连接可执行 bsk daemon pair 重新配对。',
  /** bsk CLI 未安装或不在 PATH */
  BSK_CLI_MISSING: '充值处理失败（E_BSK_CLI_MISSING）：未找到 bsk CLI。请按 BrowserSkill 官方文档安装，或在 DSH profile 的 cordis.patch.yml 配置 bskPath 指向实际安装位置后重启 DSH。',
  /** 模型平台未登录 */
  LOGIN_REQUIRED: '充值处理失败（E_LOGIN_REQUIRED）：模型平台未登录。请在浏览器中登录对应平台后重试。',
  /** 充值页结构变化，定位不到元素 */
  PAGE_CHANGED: '充值处理失败（E_PAGE_CHANGED）：充值页结构已变化，未能定位金额或支付按钮。请联系维护者更新页面适配，或稍后重试。',
  /** 2 分钟内未支付 */
  PAYMENT_TIMEOUT: '充值未完成（E_PAYMENT_TIMEOUT）：2 分钟内未检测到支付成功，订单已关闭。如需继续请重新发起充值。',
  /** 二维码发送失败 */
  QR_SEND_FAILED: '充值处理失败（E_QR_SEND_FAILED）：二维码发送到群失败。请确认机器人仍在该群且未被禁言，然后重试。',
  /** 处理端超过时限未返回结果 */
  HANDLER_TIMEOUT: '充值处理超时（E_HANDLER_TIMEOUT）：处理端超过 3 分钟未返回结果。请确认 DSH 与浏览器扩展在线后重试；若持续出现请提供请求编号。',
  /** 并发任务过多 */
  BUSY: '充值处理繁忙（E_BUSY）：当前有多个充值任务正在执行，请稍后再试。',
  /** 5 分钟内未生成二维码，强制中断 */
  QR_TIMEOUT: '充值已中断（E_QR_TIMEOUT）：5 分钟内未生成支付二维码，本次任务已强制结束。请稍后重试；若持续出现请检查浏览器扩展是否连接、模型平台是否登录，或查看 bsk status。',
  /** 其他未知错误 */
  UNKNOWN: '充值处理失败（E_UNKNOWN）：执行过程中出现未预期错误，请稍后重试；若持续失败请提供请求编号以便排查。',
});

/** 把失败码（可带详情）转成给用户的专业提示；兼容 E_ 前缀 */
export function rechargeErrorText(code, detail) {
  const key = String(code || '').trim().toUpperCase().replace(/^E_/u, '');
  const base = RECHARGE_ERRORS[key] || RECHARGE_ERRORS.UNKNOWN;
  const extra = String(detail || '').trim().slice(0, 80);
  return extra ? `${base}（详情：${extra}）` : base;
}

/** 从自由文本错误里推断失败码（agent 没写 code 时兜底） */
export function inferRechargeErrorCode(text) {
  const s = String(text || '');
  if (/bsk|cli.*not found|not found.*bsk/iu.test(s)) return 'BSK_CLI_MISSING';
  if (/connect|连接|connected/iu.test(s)) return 'BROWSER_NOT_CONNECTED';
  if (/登录|login|sign in/iu.test(s)) return 'LOGIN_REQUIRED';
  if (/超时|timeout|timed out/iu.test(s)) return 'PAYMENT_TIMEOUT';
  if (/页面|page|selector|element|元素/iu.test(s)) return 'PAGE_CHANGED';
  return 'UNKNOWN';
}

/**
 * 根据已用时长与工具调用次数，粗估当前阶段与剩余时间。
 * 不读取页面内容，只看会话事件规模，避免侵入 agent 的执行。
 * @param {number} elapsedMs 从投递到现在的毫秒数
 * @param {number} toolCalls 会话里已发生的工具调用次数
 * @returns {{stage: string, eta: string, elapsedSec: number, percent: number}}
 */
export function estimateRechargeProgress(elapsedMs, toolCalls) {
  const elapsedSec = Math.max(0, Math.round(Number(elapsedMs) / 1000));
  const calls = Math.max(0, Number(toolCalls) || 0);
  let stage = '正在启动处理会话并加载浏览器技能';
  let percent = 15;
  if (calls >= 1) { stage = '正在打开充值页并选择金额/支付方式'; percent = 45; }
  if (calls >= 3) { stage = '正在生成支付二维码'; percent = 75; }
  if (calls >= 5) { stage = '正在确认二维码与订单信息'; percent = 85; }
  let eta = '预计 60 秒内完成';
  if (calls >= 3) eta = '预计 30 秒内出二维码';
  if (elapsedSec >= 60) eta = '已处理约 1 分钟，预计还需 30–60 秒';
  if (elapsedSec >= 120) eta = '处理时间较长，请耐心等待（5 分钟未出二维码会自动中断）';
  if (elapsedSec >= 180) eta = '仍未出二维码，接近 5 分钟上限，超时将自动中断';
  return { stage, eta, elapsedSec, percent };
}

/** 生成给群里的进度文案（简短、不刷屏） */
export function formatRechargeProgress(item, progress) {
  const method = PAY_METHODS[item?.method] || item?.method || '';
  return `充值进度（${item?.id || ''}）：${progress.stage}；${progress.eta}。金额 ${item?.amount ?? ''} 元（${method}）。`;
}

/** 进度推送的秒级里程碑：最多 3 条，避免刷屏 */
export const RECHARGE_PROGRESS_MILESTONES = Object.freeze([20, 60, 120]);

/**
 * 充值三段计时（合计最多 10 分钟）：
 * 1) 未出二维码：投递后 5 分钟强制中断（E_QR_TIMEOUT）
 * 2) 二维码已发出：重新计时 3 分钟等待支付
 * 3) 3 分钟未到账：询问用户是否继续；继续则再延长 2 分钟，放弃则立即结束
 */
export const RECHARGE_TIMEOUTS = Object.freeze({
  qrWaitMs: 5 * 60_000,
  payWaitMs: 3 * 60_000,
  extendMs: 2 * 60_000,
  askReplyMs: 2 * 60_000,
});

/** 用户回复是否表示“继续等待” */
export function isContinueReply(text) {
  return /继续|再等|等等|等一下|延长|别停|不要停|continue/iu.test(String(text || ''));
}

/** 用户回复是否表示“放弃等待” */
export function isAbandonReply(text) {
  return /放弃|不用了|不充了|停止|结束|算了|取消|abandon|stop/iu.test(String(text || ''));
}

/**
 * 从自然语言里解析金额与支付方式；不是充值指令返回 null。
 *
 * 收紧点（旧版只要句子里有「充」+「N元」就判成充值，会把“我要充3块钱话费”
 * 当成给插件充值）：
 *   1) 必须出现明确的充值动词（充值 / 充钱 / 充点 / top-up / recharge）；
 *   2) 或者「充 + 金额」同时出现；
 *   3) 出现「话费 / 流量 / 电费 / 水费 / 油卡 / 游戏币 / 会员」等外部充值对象时一律不接管。
 */
const RECHARGE_VERB = /(充值|充钱|充点|充些|充个|top\s*-?\s*up|recharge)/iu;
/** 裸「充」只有在紧跟金额时才算动词（“充 100 微信”），避免“我充了会员”之类误判 */
const BARE_CHONG_AMOUNT = /充\s*[:：]?\s*(?:[¥￥$]\s*)?\d+(?:\.\d{1,2})?/u;
const EXTERNAL_TOPUP = /(话费|流量|电费|水费|燃气|油卡|游戏币|点卡|会员|话费卡|充值卡|校园卡|公交卡)/iu;

export function parseRechargeCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 外部充值对象：不是给模型 API 充值，直接放行给别的逻辑
  if (EXTERNAL_TOPUP.test(raw)) return null;
  const hasVerb = RECHARGE_VERB.test(raw) || BARE_CHONG_AMOUNT.test(raw);
  // 金额：数字 + 可选"元/块"；金额前允许货币符号
  const m = raw.match(/(?:充值|充\s*值|充钱|充点|充些|充个|充|top\s*-?\s*up|recharge)\s*[:：]?\s*(?:[¥￥$]\s*)?(\d+(?:\.\d{1,2})?)/iu)
    || raw.match(/(?:[¥￥$]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块|rmb|cny)/iu);
  if (!m) return null;
  let method = '';
  for (const [word, key] of METHOD_ALIASES) {
    if (raw.toLowerCase().includes(word.toLowerCase())) { method = key; break; }
  }
  // 没有明确动词时，必须「金额 + 支付方式」同时出现才算充值指令
  if (!hasVerb && !method) return null;
  const amount = Math.round(Number(m[1]) * 100) / 100;
  if (!(amount >= 1 && amount <= 50000)) return null;
  return { amount, method, methodLabel: PAY_METHODS[method] || '' };
}

/**
 * 订单号脱敏：中间 5 位替换为 *。
 * 短号（≤5 位）无法保留任何可见位，改为只留首尾各 1 位（≥3 位时），
 * 2 位及以下整体打码，避免“不足 5 位原样返回”把完整单号泄露到群里。
 */
export function maskOrderId(orderId) {
  const s = String(orderId || '').trim();
  if (!s) return '';
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length <= 5) return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
  const mid = Math.max(0, Math.floor((s.length - 5) / 2));
  return s.slice(0, mid) + '*****' + s.slice(mid + 5);
}

/** 充值请求目录（agent 与插件交换文件的目录） */
export function rechargeDir(dataDir) {
  const dir = join(String(dataDir || ''), 'recharge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 充值专用工作区：插件自己的会话在这里运行，不依赖用户当前打开的对话 */
export function rechargeWorkspace(dataDir) {
  const dir = join(String(dataDir || ''), 'recharge-workspace');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 创建一条充值请求（写入 state 与请求文件） */
export function createRequest(store, input = {}) {
  const now = new Date().toISOString();
  const item = {
    id: 'rcg-' + randomUUID().replace(/-/g, '').slice(0, 10),
    gid: String(input.gid || ''),
    uid: String(input.uid || ''),
    name: String(input.name || '').slice(0, 64),
    amount: Number(input.amount) || 0,
    method: input.method === 'wechat' ? 'wechat' : 'alipay',
    msgId: String(input.msgId || ''),
    status: 'pending',
    orderId: '',
    balanceAfter: null,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  if (!Array.isArray(store.state.recharge)) store.state.recharge = [];
  store.state.recharge.push(item);
  store.state.recharge = store.state.recharge.slice(-300);
  store.saveState();
  try {
    const dir = rechargeDir(store.dir);
    writeFileSync(join(dir, `req-${item.id}.json`), JSON.stringify({
      id: item.id,
      gid: item.gid,
      uid: item.uid,
      name: item.name,
      amount: item.amount,
      method: item.method,
      methodLabel: PAY_METHODS[item.method] || '',
      createdAt: item.createdAt,
    }, null, 2), 'utf8');
  } catch {
    /* 目录不可写时仍保留 state 记录 */
  }
  return item;
}

/** 更新请求状态 */
export function updateRequest(store, id, patch = {}) {
  const list = Array.isArray(store.state.recharge) ? store.state.recharge : [];
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  store.saveState();
  return item;
}

/** 列出请求（可按状态筛选） */
export function listRequests(store, status = '') {
  const list = Array.isArray(store.state.recharge) ? store.state.recharge : [];
  return (status ? list.filter((x) => x.status === status) : list).slice().reverse();
}

/**
 * 给 agent 的唤醒提示词：由插件按当前请求**动态填写实际数据**
 * （请求ID、群、用户、金额、支付方式、请求文件、工作区、二维码/结果输出路径）。
 * 不写死安装路径——每台机器的 DSH 位置不同，插件按实际数据生成。
 */
export function buildAgentPrompt(item, dataDir) {
  const dir = rechargeDir(dataDir);
  const ws = rechargeWorkspace(dataDir);
  const method = PAY_METHODS[item.method] || item.method;
  return [
    '【插件充值任务】dsh-qqbot-guard 内部执行指令，勿向用户转述。',
    '',
    '## 请求信息',
    '- 以下均为本次请求的实际数据（由插件按当前命令实时填入，不是固定值）：',
    `- 请求ID：${item.id}`,
    `- 群：${item.gid}`,
    `- 用户：${item.name || item.uid}（QQ 号 ${item.uid}）`,
    `- 金额：${item.amount} 元`,
    `- 支付方式：${method}`,
    `- 请求文件：${join(dir, `req-${item.id}.json`)}`,
    `- 工作区：${ws}`,
    `- 二维码输出：${join(dir, `qr-${item.id}.png`)}`,
    `- 结果输出：${join(dir, `res-${item.id}.json`)}`,
    '',
    '## 操作步骤',
    '0. 读取请求文件确认上述信息；若 bsk_* 工具不可用，先调用 skill 加载 "browser-skill"；加载后仍不可用 → BSK_CLI_MISSING。',
    '1. 确保浏览器可用：先用系统命令打开「默认浏览器」（Windows 示例：`start msedge` / `start chrome` / `start`；打不开时依次尝试 Chrome、Edge）；'
      + '然后检查 BrowserSkill 扩展连接状态（执行 `bsk status` 看 browsers connected，或打开扩展弹窗确认 connected）。'
      + '已连接 → 继续；未连接 → 先重连（重新打开浏览器、打开扩展弹窗，必要时重启 bsk daemon），'
      + '最多重试 2 次；2 次重连都失败 → 写入 BROWSER_NOT_CONNECTED 结果并结束，不再执行后续步骤。',
    '2. 打开 https://platform.deepseek.com/top_up，出现登录页 → LOGIN_REQUIRED。',
    '3. 按上述金额与支付方式选择，点「去支付」；定位不到元素 → PAGE_CHANGED。',
    '4. 二维码出现后截图保存到「二维码输出」路径。',
    '5. 轮询支付结果（5s 间隔，最长 2 分钟）：出现"支付成功"文案、二维码消失或余额变化即视为成功；超时 → PAYMENT_TIMEOUT。',
    '6. 打开 https://platform.deepseek.com/transactions，读取最新一笔充值的订单号与余额。',
    '',
    '## 输出方式',
    '写入「结果输出」路径（UTF-8 JSON）：',
    '成功：{"ok":true,"orderId":"<订单号>","balanceAfter":"<余额>","message":"<可选备注>"}',
    '失败：{"ok":false,"code":"<失败码>","error":"<具体原因>"}',
    '失败码仅限：BROWSER_NOT_CONNECTED / BSK_CLI_MISSING / LOGIN_REQUIRED / PAYMENT_TIMEOUT / PAGE_CHANGED / UNKNOWN。',
    '写完在本会话回复一句结果摘要即可，不复述本提示、不暴露路径与 QQ 号。',
  ].join('\n');
}

/** 扫描 agent 回传的二维码与结果文件 */
export function scanAgentFiles(dataDir) {
  const dir = rechargeDir(dataDir);
  let names = [];
  try { names = readdirSync(dir); } catch { return { qrs: [], results: [] }; }
  const qrs = names.filter((n) => /^qr-.*\.png$/u.test(n)).map((n) => join(dir, n));
  const results = names.filter((n) => /^res-.*\.json$/u.test(n));
  return { qrs, results: results.map((n) => ({ name: n, path: join(dir, n) })) };
}

/** 读取并删除一个结果文件；损坏时返回 null 并删除 */
export function takeResultFile(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    rmSync(path, { force: true });
    return data && typeof data === 'object' ? data : null;
  } catch {
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
    return null;
  }
}

/** 删除二维码文件（发送成功后调用） */
export function removeFile(path) {
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}
