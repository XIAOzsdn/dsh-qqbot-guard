/**
 * 群内自然语言管理指令：受信任成员 @ 机器人即可操作。
 * - 目标成员优先取“被 @ 的那个人的 openid”，比昵称更准确
 * - v1.9.0 起所有指令先交给 AI 决策；关键词只在模型超时/不可用时兜底
 * - 昵称必须精确命中台账，绝不猜人；找不到就回复候选成员
 */
import { LIMITS } from './defaults.js';
import { effectiveModeration } from './config.js';
import { mention } from './mention.js';
import { normalizeName } from './napcat.js';
import {
  ADMIN_ACTION_NAMES, ADMIN_HELP_TEXT, executeAdminIntent, parseAdminIntent,
} from './natural-admin.js';
import { currentKeywords, matchKeyword, maybeReviewKeywords } from './natural-keywords.js';
import { parseSchedule } from './scheduler.js';
import {
  PAY_METHODS, RECHARGE_ERRORS, createRequest as createRechargeRequest, parseRechargeCommand, rechargeErrorText, updateRequest,
} from './recharge.js';

const HELP_TEXT = [
  '没听懂你的意思。可以这样说：',
  '“看看群里有多少人”',
  '“把‘某某’踢出群聊并拉黑”',
  '“禁言‘某某’10分钟”',
  '“解除‘某某’的禁言”',
  '“警告‘某某’”',
  '“查询‘某某’的信息”',
  '“查一下 API 余额” / “看看设备状态” / “重启一下插件”',
  '“全体禁言” / “解除全体禁言”',
  '“充值 50 支付宝” / “充值 100 元 微信”（发起 API 余额充值，二维码发到群里）',
  '“22:30 全体禁言”“每天 23:00 全体禁言”“明天 9 点禁言‘某某’ 1 小时”',
  '“查看定时任务” / “取消定时任务 1”',
  '还可以查/改设置：说“管理功能”看完整清单。',
  '也可以直接 @ 要处理的成员，再说动作。',
].join('\n');

const QUOTED = /[‘’“”"'「」『』]([^‘’“”"'「」『』]{1,40})[‘’“”"'「」『』]/u;
/** 群成员 openid：32 位十六进制。消息里直接给 openid 时优先按它定位。 */
const OPENID = /\b([0-9A-Fa-f]{32})\b/u;
/** 时长片段（1分钟 / 10 分 / 半小时 / 30s）：绝不能当成昵称。 */
const DURATION_TOKEN = /^(?:\d+(?:\.\d+)?\s*(?:天|d|小时|h|分钟|分|m|秒|s)|半小时|一刻钟|半天|\d+)$/iu;

/** 是否是“时长/纯数字”这类不能作为成员的片段。 */
export function isDurationLike(value) {
  const text = String(value || '').trim();
  return text !== '' && DURATION_TOKEN.test(text);
}

/** 最近一次被操作/查询的成员（按群），用于“禁言 1 分钟”这类省略目标的续指令。 */
const lastTargets = new Map();
const LAST_TARGET_TTL_MS = 10 * 60 * 1000;

function rememberTarget(gid, member) {
  if (!gid || !member || !member.uid) return;
  lastTargets.set(String(gid), {
    uid: String(member.uid),
    name: String(member.name || ''),
    at: Date.now(),
  });
}

function lastTargetFor(gid) {
  const hit = lastTargets.get(String(gid || ''));
  if (!hit) return null;
  if (Date.now() - hit.at > LAST_TARGET_TTL_MS) {
    lastTargets.delete(String(gid || ''));
    return null;
  }
  return hit;
}

/** 测试/换群时清空最近目标。 */
export function clearLastTarget(gid) {
  if (gid === undefined) lastTargets.clear();
  else lastTargets.delete(String(gid));
}

/** 去掉机器人/成员 @ 标签，只留正文 */
export function stripMentions(text) {
  return String(text || '')
    .replace(/<qqbot-at-user[^>]*\/>/giu, ' ')
    .replace(/<@!?[A-Za-z0-9_-]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 提取消息里被 @ 的成员 openid（排除机器人自己）。
 * 兼容官方 `<qqbot-at-user id="..." />` 与旧的 `<@openid>` 写法。
 * @param {string} text 原始消息
 * @param {string} [appId] 机器人 AppID，用于剔除“@机器人”本身
 */
export function extractMentionUids(text, appId = '') {
  const s = String(text || '');
  const ids = [];
  const tagRe = /<qqbot-at-user[^>]*\bid=["']?([^"'\s/>]+)["']?[^>]*\/?>/giu;
  let m;
  while ((m = tagRe.exec(s))) ids.push(String(m[1] || '').trim());
  const simpleRe = /<@!?([^>\s]+)>/gu;
  while ((m = simpleRe.exec(s))) ids.push(String(m[1] || '').trim());
  const botId = String(appId || '').trim();
  const out = [];
  for (const id of ids) {
    if (!id || id === botId) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 从一句话里提取要操作的成员名 */
export function extractTarget(text) {
  const s = String(text || '');
  // 消息里直接写了 openid：这就是最明确的目标，优先于任何昵称猜测
  const byOpenid = s.match(OPENID);
  if (byOpenid) return byOpenid[1];
  const quoted = s.match(QUOTED);
  if (quoted) return quoted[1].trim();
  const patterns = [
    /(?:把|将)\s*([^\s，,。！!？?]{1,30}?)\s*(?:成员|踢|移出|请出|移除|禁言|闭嘴|安静|消停|静音|拉黑|警告|处理|收拾)/u,
    /(?:让|叫|给)\s*([^\s，,。！!？?]{1,30}?)\s*(?:闭嘴|安静|消停|不许说话|别说话|禁言|滚|走人|出去|老实点)/u,
    /([^\s，,。！!？?]{1,30}?)\s*(?:别说话|闭嘴|安静|消停|不许说话)/u,
    /(?:踢出|踢人|踢掉|移出群|请出|移除|禁言|解禁|静音|解除禁言|拉黑|警告|提醒|查一下|查询|查查|看看|资料|信息|处理)(?:一下)?\s*(?:成员)?\s*([^\s，,。！!？?]{1,30})/u,
    /(?:查询|查一下|看看|查查)\s*([^\s，,。！!？?]{1,30})/u,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    // 去掉“让/叫/给/把/将”这类前缀，避免把“让他”当成昵称
    const hit = m?.[1]?.trim().replace(/^(?:把|将|让|叫|给)\s*/u, '').trim();
    // 指代词不算目标：宁可让管理员再确认，也不能猜错人
    if (hit && !/^(群里|成员|黑名单|多少|人数|大家|所有人|他|她|它|他们|她们|它们|ta|某人|这位|那个|那个人)$/iu.test(hit)) {
      // “禁言 1 分钟”里的 1 / 1分钟 是时长，不是昵称
      if (isDurationLike(hit)) continue;
      return hit;
    }
  }
  return '';
}

/** 解析禁言时长：30秒 / 10分钟 / 半小时 / 1小时 / 2天 */
function parseMuteSeconds(text) {
  const t = String(text || '');
  if (/半小时/u.test(t)) return 1800;
  if (/一刻钟/u.test(t)) return 900;
  if (/半天/u.test(t)) return 43_200;
  const m = t.match(/(\d+)\s*(天|d|小时|h|分钟|分|m|秒|s)/iu);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = String(m[2]).toLowerCase();
  if (m[2].includes('天') || unit === 'd') return n * 86_400;
  if (m[2].includes('小时') || unit === 'h') return n * 3600;
  if (unit === '秒' || unit === 's') return n;
  return n * 60;
}

/**
 * 本地关键词解析（零模型开销）。
 * @param {string} text 原始消息
 * @param {{mentionUids?: string[]}} [opts] 被 @ 的成员 openid；只有一个时直接作为目标
 */
export function parseNaturalIntent(text, opts = {}) {
  // 本地规则只认中文；英文指令走 AI（见 handleNaturalCommand）
  const t = stripMentions(text);
  if (!t) return null;
  const mentionUids = Array.isArray(opts?.mentionUids) ? opts.mentionUids.filter(Boolean) : [];
  // 只 @ 了一个人时，用 openid 定位，避免改名/重名导致误伤
  const mentioned = mentionUids.length === 1 ? String(mentionUids[0]) : '';
  const target = mentioned || extractTarget(t);
  // 全体禁言 / 解除全体禁言：需要 NapCat；没有时由 Moderation 退化为逐个禁言
  if (/(全体|全员|所有人|全群|全部人)/u.test(t) && /(禁言|闭嘴|噤声|安静|静音|封口|别说话)/u.test(t)) {
    const off = /(解除|取消|关闭|结束|恢复|解禁|放开|打开|允许)/u.test(t);
    return {
      action: off ? 'whole-unban' : 'whole-ban',
      target: '',
      seconds: off ? 0 : Math.max(0, Math.min(86_400, parseMuteSeconds(t))),
      blacklist: false,
    };
  }
  // 充值：必须带金额，可选支付方式（“充值 50 支付宝”）
  const recharge = parseRechargeCommand(t);
  if (recharge) {
    return {
      action: 'recharge', target: '', seconds: 0, blacklist: false,
      amount: recharge.amount, method: recharge.method,
    };
  }
  if (/多少\s*(人|成员)|成员.{0,4}(数|数量)|人数|几个人/u.test(t)) {
    return { action: 'count', target: '', seconds: 0, blacklist: false };
  }
  // 运维类：余额 / 设备 / 重启 / 帮助 / 群规（不需要目标成员）
  if (/(api\s*余额|接口余额|余额|额度|quota|balance|还剩多少(钱|额度))/iu.test(t)) {
    return { action: 'balance', target: '', seconds: 0, blacklist: false };
  }
  if (/(设备|主机|机器|运行状态|系统状态|cpu|内存占用|负载|插件版本|版本)/iu.test(t)) {
    // 精确指定指标时只回这一项，避免“查 CPU”附送一屏无关信息
    const metric = /内存|memory|ram/iu.test(t) ? 'mem'
      : /cpu|处理器|processor|占用率/iu.test(t) ? 'cpu' : '';
    return { action: 'device', target: '', seconds: 0, blacklist: false, metric };
  }
  if (/(重启|重载|重新启动|reload|restart|reboot)/iu.test(t)) {
    return { action: 'restart', target: '', seconds: 0, blacklist: false };
  }
  if (/^(帮助|help|指令|命令|怎么用|能做什么|你会什么|有哪些(指令|功能))/iu.test(t)) {
    return { action: 'help', target: '', seconds: 0, blacklist: false };
  }
  if (/(群规|群规则|规则是什么)/u.test(t)) {
    return { action: 'rule', target: '', seconds: 0, blacklist: false };
  }
  if (/移出黑名单|解除黑名单|取消黑名单|从黑名单(里)?(移出|删除)/u.test(t)) {
    return { action: 'unblacklist', target, seconds: 0, blacklist: false };
  }
  if (/解除[^。！？!?]{0,12}(禁言|静音)|解禁|解封|取消[^。！？!?]{0,12}(禁言|静音)|恢复(他|她)?发言|允许(他|她)?说话/u.test(t)) {
    return { action: 'unmute', target, seconds: 0, blacklist: false };
  }
  if (/黑名单|拉黑|封禁/u.test(t) && !/踢|移出群|请出|赶出/u.test(t)) {
    return { action: 'blacklist', target, seconds: 0, blacklist: false };
  }
  if (/禁言|闭嘴|别说话|不许说话|安静|消停|静音|封口|老实点/u.test(t)) {
    const seconds = Math.max(0, Math.min(86_400, parseMuteSeconds(t)));
    return { action: 'mute', target, seconds, blacklist: false };
  }
  if (/踢出|踢人|踢掉|踢了|移出群|请出|清出|赶出|送走|滚出/u.test(t)) {
    return { action: 'kick', target, seconds: 0, blacklist: /黑名单|拉黑/u.test(t) };
  }
  if (/警告|提醒|敲打|点名|教育/u.test(t)) {
    return { action: 'warn', target, seconds: 0, blacklist: false };
  }
  if (/查询|查一下|查查|资料|信息|看看|是谁/u.test(t)) {
    return { action: 'info', target, seconds: 0, blacklist: false };
  }
  return null;
}

/**
 * 在台账里解析目标成员。
 * 只认“openid 精确命中”或“昵称精确命中且唯一”；不再模糊猜人，
 * 避免踢错/禁错。找不到时返回候选列表，由调用方提示改用完整昵称或 @。
 */
export function resolveTarget(store, gid, target) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, reason: 'missing' };
  const direct = store.getMember(gid, t);
  if (direct) return { ok: true, member: direct };
  const exact = new Map(store.findMembersByName(gid, t).map((m) => [m.uid, m]));
  if (exact.size === 1) return { ok: true, member: [...exact.values()][0] };
  if (exact.size > 1) {
    return { ok: false, reason: 'ambiguous', count: exact.size, candidates: [...exact.values()] };
  }
  return { ok: false, reason: 'notfound', candidates: store.searchMembers(gid, t, LIMITS.intentCandidateLimit) };
}

function timeText(iso) {
  const d = new Date(iso || '');
  return Number.isNaN(d.getTime()) ? '无' : d.toLocaleString('zh-CN', { hour12: false });
}

const ROLE_LABEL = { owner: '群主', admin: '管理员', member: '成员' };

/** 定时任务的到点时间文案 */
function whenText(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

/**
 * 在 NapCat 花名册里找成员（只读用途：查询/提示，不用于执行操作）。
 * 只认昵称/群名片精确命中；返回去重后的花名册条目。
 */
export function findInRoster(store, gid, target) {
  const wanted = normalizeName(String(target || '').trim());
  if (!wanted) return [];
  const entry = store?.getDirectory?.(gid);
  const out = [];
  const seen = new Set();
  for (const r of entry?.members || []) {
    if (!r || !r.qq || seen.has(r.qq)) continue;
    if (normalizeName(r.nickname) !== wanted && normalizeName(r.card) !== wanted) continue;
    seen.add(r.qq);
    out.push(r);
  }
  return out;
}

function rosterProfile(row) {
  const parts = [`QQ ${row.qq}`];
  if (row.role && ROLE_LABEL[row.role]) parts.push(ROLE_LABEL[row.role]);
  if (row.joinTime) parts.push(`入群 ${timeText(new Date(row.joinTime * 1000).toISOString())}`);
  return `「${row.card || row.nickname || row.qq}」（${parts.join('，')}）`;
}

/**
 * 处理一条自然语言指令。
 * @returns {Promise<{handled: boolean, action?: string, ok?: boolean}>}
 */
export async function handleNaturalCommand(deps) {
  const {
    gid, uid, name, text, msgId, settings, store, client, ai, logger, localOnly,
    mentionUids = [], directory, scheduler,
  } = deps;
  if (!client) return { handled: false };

  const reply = async (message, meta = {}) => {
    let body = String(message);
    // 结果类回复优先让 AI 改写；AI 不可用/超时就原样发本地文本
    if (meta.polish && typeof deps.polish === 'function') {
      try {
        const polished = await deps.polish(body, { action: meta.action || '', raw: plainRaw });
        if (polished) body = String(polished);
      } catch { /* 改写失败不影响结果 */ }
    }
    const content = `${mention(uid)} ${body.slice(0, LIMITS.warnMaxChars)}`;
    try {
      const r = await client.sendGroupText(gid, content, { msgId });
      if (!r?.ok) {
        logger?.warn?.(`[qqbot-guard] 自然语言指令回复发送失败：${r?.err?.human || r?.err?.code || '未知原因'}`);
        store.appendAudit({
          kind: 'command', action: 'natural-reply-failed', groupId: gid,
          groupName: store.state.groups[gid]?.name || '',
          userId: uid, userName: name || '',
          detail: `回复发送失败：${r?.err?.human || '未知原因'}`,
          ok: false, code: r?.err?.code || '', confidence: 1,
        });
      }
      return r;
    } catch (error) {
      logger?.warn?.('[qqbot-guard] 自然语言指令回复失败：' + (error instanceof Error ? error.message : String(error)));
      return { ok: false, err: { code: 'REPLY_ERROR', human: '回复发送异常' } };
    }
  };
  const audit = (action, detail, ok = true, code = '') => {
    store.appendAudit({
      kind: 'command',
      action: `natural-${action}`,
      groupId: gid,
      groupName: store.state.groups[gid]?.name || '',
      userId: uid,
      userName: name || '',
      detail,
      ok,
      code,
      confidence: 1,
    });
  };

  /**
   * 到点按最近用法重排快捷关键词，并 @ 部署方提醒。
   * 关键词只作 AI 失败时的兜底，因此这里只做提示与快照更新，不改变 AI 优先策略。
   */
  const reviewKeywords = async () => {
    try {
      const rv = maybeReviewKeywords({ settings, store });
      if (!rv.reviewed) return;
      await deps.saveSettings?.(
        { natural: { keywords: rv.keywords } },
        { actor: name || uid, summary: '按最近用法重排自然语言快捷关键词' },
      );
      const trusted = Array.isArray(settings?.moderation?.trustedUsers)
        ? settings.moderation.trustedUsers
        : [];
      const target = String(settings?.natural?.notifyUid || trusted[0]?.uid || '').trim();
      const words = rv.keywords.map((k) => `“${k.phrase}”`).join('、');
      const content = `${target ? `${mention(target)} ` : ''}最近 7 天用了 ${rv.weekCount} 次自然语言指令，已按你最近常用的动作重排快捷关键词（${rv.keywords.length} 个）：${words}。AI 仍是主决策，关键词只在模型超时 / 不可用时兜底。`;
      const r = await client.sendGroupText(gid, content.slice(0, LIMITS.warnMaxChars));
      store.appendAudit({
        kind: 'command',
        action: 'natural-keywords-review',
        groupId: gid,
        groupName: store.state.groups[gid]?.name || '',
        userId: uid,
        userName: name || '',
        detail: `关键词重排（${rv.reason === 'volume' ? '最近用量偏高' : '周期到期'}）`,
        ok: !!r?.ok,
        code: r?.err?.code || '',
        confidence: 1,
      });
    } catch (error) {
      logger?.warn?.('[qqbot-guard] 关键词重排提醒失败：' + (error instanceof Error ? error.message : String(error)));
    }
  };

  /** 记录一次已执行的指令，并按需触发关键词重排提醒 */
  const done = async (action, ok = true, source = 'ai') => {
    try {
      store.noteNaturalUsage?.({ action, source });
    } catch { /* 统计失败不影响指令结果 */ }
    await reviewKeywords();
    return { handled: true, action, ok };
  };

  try {
    const plainRaw = stripMentions(text);
    const plain = plainRaw;
    // 0) 充值等待答复优先：用户回复“继续 / 放弃”时先处理，不再走通用解析
    if (typeof deps.rechargeReply === 'function') {
      const replyResult = deps.rechargeReply(gid, uid, plain);
      if (replyResult?.handled) {
        audit('recharge-wait', plain.slice(0, 40), true);
        return { handled: true, action: 'recharge-wait', ok: true };
      }
    }
    // 英文指令只走 AI：AI 不可用时直接报错，不猜
    const looksEnglish = /[a-z]/iu.test(plainRaw) && !/[一-龥]/u.test(plainRaw);
    // 英文只走 AI：没有 AI 就直接报错，不用本地英文词表去猜
    const aiConfigured = !localOnly && !!ai && settings.ai?.master !== false && !!settings.ai?.enabled && settings.natural?.aiFirst !== false;
    if (looksEnglish && !aiConfigured) {
      await reply('英文指令只通过 AI 解析，当前 AI 未启用（或未配置）。请改用中文指令，或在设置 → AI 辅助审核里启用 AI。');
      audit('help', '英文指令缺少 AI 解析', false, 'AI_REQUIRED_FOR_ENGLISH');
      return { handled: true, action: 'help', ok: false };
    }
    // 0) 静态帮助：不涉及任何操作，不需要模型
    if (/(管理功能|全部指令|完整指令|能设置什么|都能查什么)/u.test(plain)) {
      await reply(ADMIN_HELP_TEXT);
      audit('admin-help', '查看管理功能清单');
      return { handled: true, action: 'admin-help', ok: true };
    }
    // 0.1) 完全没说哪一类“关键词”时才反问；入群审批 / 违规 / 白名单都直接走管理员指令
    if (/(列出|查看|有哪些|看看|显示|查一下|列出全部).{0,8}关键词/u.test(plain)
      && !/(违规|违禁|敏感|白名单|入群|进群|加群|审批|通过|拒绝|答题|验证)/u.test(plain)) {
      const message = [
        '“关键词”分几种，你要看哪一种？',
        '• 违规词：说“查看违规词”',
        '• 入群审批通过 / 拒绝关键词：说“查看入群审批通过关键词”',
        '• 入群答题 / 验证答案：说“当前设置”，或到设置页的「入群管理」里看',
        '• 命令白名单：说“查看白名单”',
      ].join('\n');
      await reply(message);
      audit('clarify-keywords', message, false, 'AMBIGUOUS_KEYWORDS');
      return { handled: true, action: 'clarify-keywords', ok: false };
    }

    // 1) AI 优先：所有自然语言指令都必须先经过模型决策（含查/改设置类）
    // 本地解析只作为给模型的 hint 和失败时的兜底，不再抢在模型之前执行
    const aiOn = aiConfigured;
    const local = parseNaturalIntent(plain, { mentionUids });
    const adminLocal = parseAdminIntent(plain, { mentionUids });
    let intent = null;
    if (aiOn) {
      try {
        const members = store.searchMembers(gid, '', LIMITS.aiIntentCandidates)
          .filter((m) => m.name || m.uid)
          .map((m) => ({ name: m.name || '', uid: m.uid }));
        const last = lastTargetFor(gid);
        const localHint = adminLocal || local;
        const r = await ai.parseIntent({
          text: plainRaw,
          groupName: store.state.groups[gid]?.name || '',
          mentionUids,
          members,
          // 省略目标的续指令（“禁言 1 分钟”）靠它接上下文
          lastTarget: last ? { name: last.name, uid: last.uid } : null,
          hint: localHint ? { action: localHint.action, target: localHint.target, seconds: localHint.seconds } : null,
        });
        if (r?.ok && r.intent && r.intent.action !== 'none') intent = r.intent;
      } catch { /* 模型超时 / 不可用：走关键词兜底 */ }
    }
    // 1.1) 关键词种类纠偏：模型容易把“入群审批通过关键词”也归成“违规词”，这里按上下文强制分开
    if (intent) {
      const joinCtx = /(入群|进群|加群|审批|申请)/u.test(plain) && /(通过|拒绝|验证)/u.test(plain);
      const plainWord = /^(list-keywords|add-keyword|del-keyword)$/.test(intent.action);
      const joinWord = /^(list-(join|decline)-keywords|add-(join|decline)-keyword|del-(join|decline)-keyword)$/.test(intent.action);
      if (joinCtx && plainWord) {
        const kind = /拒绝/u.test(plain) ? 'decline' : 'join';
        intent.action = intent.action.replace('keyword', `${kind}-keyword`);
      } else if (!joinCtx && joinWord && /(违规|违禁|敏感)/u.test(plain)) {
        intent.action = 'list-keywords';
        if (/添加|新增|加入/u.test(plain)) intent.action = 'add-keyword';
        else if (/删除|移除|去掉|删掉/u.test(plain)) intent.action = 'del-keyword';
      }
    }
    // 2) 兜底：只有命中“保留的快捷关键词”才执行；AI 未启用时才退回完整本地规则
    let source = 'ai';
    if (!intent) {
      source = 'keyword';
      const hit = matchKeyword(plain, currentKeywords(settings));
      if (!aiOn) {
        intent = adminLocal || local;
      } else if (hit && adminLocal && hit.action === adminLocal.action) {
        intent = adminLocal;
      } else if (hit && local && hit.action === local.action) {
        intent = local;
      } else if (local && (local.action === 'whole-ban' || local.action === 'whole-unban' || local.action === 'recharge')) {
        // 全员禁言 / 充值：本地规则必须出现强信号词（全体/全员 或 充值+金额）才会给出该动作，
        // 关键词表对同一动作只保留一个说法；这里直接信任本地强信号接管，
        // 避免 AI 失败时连基本指令都识别不了。
        intent = local;
      }
    }
    if (!intent) {
      if (looksEnglish) {
        const message = aiOn
          ? '英文指令只通过 AI 解析，这次 AI 没有返回结果（超时 / 出错）。请重试，或改用中文指令。'
          : '英文指令只通过 AI 解析，当前 AI 未启用（或未配置）。请改用中文指令，或在设置 → AI 辅助审核里启用 AI。';
        await reply(message);
        audit('help', '英文指令缺少 AI 解析', false, 'AI_REQUIRED_FOR_ENGLISH');
        return { handled: true, action: 'help', ok: false };
      }
      const keywords = currentKeywords(settings);
      const hint = keywords.map((k) => `“${k.phrase}”`).join('、');
      const message = aiOn
        ? `AI 这次没能理解这句话（可能超时或不可用）。可以换个说法，或直接用快捷关键词：${hint}。`
        : `没听懂这句话。当前未启用 AI 决策，只能用快捷关键词：${hint}。可在设置 → 自然语言里开启 AI 优先。`;
      await reply(message);
      audit('help', '未识别的自然语言指令', false, 'UNKNOWN_INTENT');
      return { handled: true, action: 'help', ok: false };
    }
    // AI 判断出的是“查询 / 改设置”类动作：交给管理后台执行器
    if (ADMIN_ACTION_NAMES.includes(intent.action)) {
      const r = await executeAdminIntent({
        intent: { action: intent.action, target: intent.target || '', args: intent.args || {} },
        gid, uid, name, store, settings, directory, ai, scheduler,
        client: typeof deps.getClient === 'function' ? deps.getClient() : deps.client,
        saveSettings: deps.saveSettings,
        sendAnnouncement: deps.sendAnnouncement,
      });
      await reply(r.message, { polish: true });
      audit(`admin-${intent.action}`, r.message, r.ok, '');
      return done(`admin-${intent.action}`, r.ok, source);
    }
    // 运维类动作（设备 / 余额 / 重启 / 帮助 / 群规）交给 Moderation 统一实现，
    // 自然语言与斜杠指令因此共用同一套二次确认与结果回报逻辑。
    /** 解析“22:30 / 明天 9 点 / 每天 23:00”这类时间；没有就返回 null */
    const when = scheduler ? parseSchedule(plain) : null;
    const scheduled = !!(when && when.at > Date.now() + 2000);

    if (['device', 'balance', 'restart', 'help', 'rule'].includes(intent.action)) {
      if (typeof deps.handleOps === 'function') {
        const r = await deps.handleOps(intent.action, intent);
        if (r?.handled) return r;
      }
      await reply(HELP_TEXT);
      audit(intent.action, '运维指令不可用', false, 'OPS_UNAVAILABLE');
      return { handled: true, action: 'help', ok: false };
    }
    // 全体禁言 / 解除全体禁言
    if (intent.action === 'whole-ban' || intent.action === 'whole-unban') {
      const enable = intent.action === 'whole-ban';
      const label = enable ? '全员禁言' : '解除全员禁言';
      const seconds = enable ? Math.max(0, Number(intent.seconds) || 0) : 0;
      if (scheduled) {
        const r = scheduler.add({
          gid, kind: intent.action, seconds, at: when.at, repeat: when.repeat, time: when.time,
          createdBy: name || uid,
        });
        if (!r.ok) {
          await reply(`定时任务创建失败：${r.error}`);
          return { handled: true, action: intent.action, ok: false };
        }
        const extra = seconds > 0 && enable
          ? `，到点 ${seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`}后自动解除`
          : '';
        const extra2 = r.replaced ? '（已替换该群同类旧任务）' : '';
        const text = `已安排 ${when.repeat === 'daily' ? `每天 ${when.time}` : whenText(when.at)} 执行「${label}」${extra}${extra2}。说“定时任务列表”可查看。`;
        await reply(text, { polish: true, action: intent.action });
        audit(`${intent.action}-schedule`, text, true);
        return done(`schedule-${intent.action}`, true, 'schedule');
      }
      const r = await deps.handleOps?.(intent.action, intent);
      if (r?.handled) return r;
      await reply('全员禁言执行失败：机器人未连接或缺少权限，请稍后重试。');
      return { handled: true, action: intent.action, ok: false };
    }
    // 充值：插件受理 → 写请求文件并唤醒 agent（浏览器完成真实充值）→ 结果异步回执
    if (intent.action === 'recharge') {
      const parsed = parseRechargeCommand(plain) || {};
      const amount = Number(intent.amount) || parsed.amount || 0;
      const method = String(intent.method || parsed.method || '');
      if (!amount) {
        await reply('请告诉我充值金额，例如：「充值 50 支付宝」。');
        audit('recharge', '缺少充值金额', false, 'NO_AMOUNT');
        return done('recharge', false, source);
      }
      if (!method || !PAY_METHODS[method]) {
        await reply(`充值 ${amount} 元，请选择支付方式：支付宝 或 微信支付（例如「充值 ${amount} 支付宝」）。`);
        audit('recharge', '缺少支付方式', false, 'NO_METHOD');
        return done('recharge', false, source);
      }
      // 完全未配置充值处理端（BrowserSkill / agent 桥未接入）→ 配置引导；
      // 已配置但当前唤不醒会话 → 专业错误码 + 处置建议，两者不能混用。
      if (typeof deps.requestRecharge !== 'function') {
        await reply(RECHARGE_ERRORS.NOT_CONFIGURED);
        audit('recharge', '未配置充值处理端', false, 'RECHARGE_NOT_CONFIGURED');
        return done('recharge', false, source);
      }
      const item = createRechargeRequest(store, { gid, uid, name, amount, method, msgId });
      let result = false;
      try { result = await deps.requestRecharge(item); } catch { result = 'E_AGENT_UNAVAILABLE'; }
      if (result !== true) {
        const code = typeof result === 'string' && result ? result : 'E_AGENT_UNAVAILABLE';
        updateRequest(store, item.id, { status: 'failed', error: code });
        await reply(`${rechargeErrorText(code)}（请求编号 ${item.id}）`);
        audit('recharge', '充值投递失败', false, `RECHARGE_${String(code).replace(/^E_/u, '')}`);
        return done('recharge', false, source);
      }
      const text = `已受理充值 ${amount} 元（${PAY_METHODS[method]}），正在生成支付二维码，请稍候……`;
      updateRequest(store, item.id, { status: 'dispatched' });
      await reply(text);
      audit('recharge-request', text, true, '');
      return done('recharge', true, source);
    }
    // 目标补全顺序：消息里的 openid/昵称 → 唯一 @ → 最近一次操作的成员。
    // “禁言 1 分钟”这类省略目标的续指令因此能接上上一条“查询 xxx”的上下文。
    if (intent.action !== 'count') {
      let target = String(intent.target || '').trim();
      if (isDurationLike(target)) target = '';
      if (!target && mentionUids.length === 1) target = String(mentionUids[0]);
      if (!target) {
        const last = lastTargetFor(gid);
        if (last) target = last.uid;
      }
      intent.target = target;
    }

    if (intent.action === 'count') {
      const info = await client.getGroupInfo(gid);
      const official = Number(info?.data?.group_member_num || 0);
      const ledger = store.countMembers(gid);
      let roster = 0;
      try {
        if (directory?.enabled?.()) await directory.ensureFresh([gid]);
        const entry = store.getDirectory(gid);
        roster = Array.isArray(entry?.members) ? entry.members.length : 0;
      } catch { roster = 0; }
      const extra = roster ? `；NapCat 花名册 ${roster} 人` : '';
      const message = info?.ok
        ? `本群官方显示 ${official || '未知'} 人；机器人台账记录 ${ledger} 人${extra}。`
        : `机器人台账记录 ${ledger} 人${extra}；官方成员数暂时取不到：${info?.err?.human || '无权限'}`;
      await reply(message, { polish: true, action: 'count' });
      audit('count', message, !!info?.ok, info?.err?.code || '');
      return done('count', !!info?.ok, source);
    }

    if (!intent.target) {
      await reply('请告诉我要操作哪位成员：可以直接 @ 他，或用完整昵称（例如：把“某某”移出群聊）。');
      audit(intent.action, '缺少操作目标', false, 'NO_TARGET');
      return done(intent.action, false, source);
    }
    const found = resolveTarget(store, gid, intent.target);
    if (!found.ok) {
      // 目标是“上一次操作的成员”但已经不在台账里：清掉，避免后续续指令反复失败
      const last = lastTargetFor(gid);
      if (last && String(last.uid) === String(intent.target)) clearLastTarget(gid);
      // 台账里没有：查一下 NapCat 花名册。只用来“告诉管理员他在不在群里、QQ 是多少”，
      // 这里只用于“告诉管理员他在不在群里、QQ 号是多少”，实际处置仍走协议端。
      let roster = findInRoster(store, gid, intent.target);
      if (!roster.length && directory?.enabled?.()) {
        try {
          await directory.ensureFresh([gid]);
          roster = findInRoster(store, gid, intent.target);
        } catch { roster = []; }
      }
      if (roster.length === 1) {
        const row = roster[0];
        const message = intent.action === 'info'
          ? `${rosterProfile(row)}。他还没有在群里发过言，本地台账里没有记录：插件无法按昵称定位他，可以在面板「群与成员」里按 QQ 号禁言 / 移出。`
          : `本地台账里没有找到「${intent.target}」，${rosterProfile(row)} 在协议端花名册里。他还没发过言，插件还定位不到他；可以先用面板按 QQ 号处理。`;
        await reply(message, { polish: true, action: intent.action });
        audit(intent.action, message, false, 'TARGET_ONLY_IN_ROSTER');
        return done(intent.action, false, source);
      }
      const names = (Array.isArray(found.candidates) ? found.candidates : [])
        .filter((m) => m && (m.name || m.uid))
        .slice(0, LIMITS.intentCandidateLimit)
        .map((m) => (m.name ? `${m.name}（${m.uid}）` : String(m.uid)));
      const message = found.reason === 'ambiguous'
        ? `群里有 ${found.count} 位同名成员，为避免误操作已停止。请 @ 他，或用 openid 指定：${names.join('、')}。`
        : `没有找到昵称精确匹配「${intent.target}」的成员。${names.length ? `相近的成员：${names.join('、')}。` : '他需要先在群里发过言，机器人才能看到。'}建议直接 @ 他，或使用完整昵称/openid。`;
      await reply(message, { polish: true, action: intent.action });
      audit(intent.action, message, false, 'TARGET_NOT_FOUND');
      return done(intent.action, false, source);
    }
    const member = found.member;
    // 记住这一次明确解析到的成员：下一条“禁言 1 分钟”可以省略目标
    rememberTarget(gid, member);
    const label = member.name || member.uid;
    if (String(member.uid) === String(uid)) {
      await reply('不能对自己执行该操作。');
      audit(intent.action, '尝试对自己操作', false, 'SELF_TARGET');
      return done(intent.action, false, source);
    }

    // 定时禁言 / 定时解禁：说清楚“什么时候”就只排期，不立刻执行
    if (scheduled && (intent.action === 'mute' || intent.action === 'unmute')) {
      const kind = intent.action;
      const seconds = kind === 'mute'
        ? (intent.seconds > 0 ? intent.seconds : effectiveModeration(settings, gid).muteSeconds)
        : 0;
      const r = scheduler.add({
        gid, kind, uid: member.uid, qq: member.qq || '', seconds,
        at: when.at, repeat: when.repeat, time: when.time, createdBy: name || uid,
      });
      if (!r.ok) {
        await reply(`定时任务创建失败：${r.error}`);
        return { handled: true, action: kind, ok: false };
      }
      const text = `已安排 ${when.repeat === 'daily' ? `每天 ${when.time}` : whenText(when.at)} ${kind === 'mute' ? `禁言「${label}」${Math.max(1, Math.round(seconds / 60))} 分钟` : `解除「${label}」的禁言`}。说“定时任务列表”可查看。`;
      await reply(text, { polish: true, action: kind });
      audit(`${kind}-schedule`, text, true);
      return done(`schedule-${kind}`, true, 'schedule');
    }

    if (intent.action === 'kick') {
      const r = await client.removeMembers(gid, [member.uid], !!intent.blacklist);
      const message = r.ok
        ? `已将「${label}」移出群聊${intent.blacklist ? '，并加入黑名单' : ''}。`
        : `移出「${label}」失败：${r.err?.human || '未知原因'}`;
      if (r.ok && intent.blacklist) {
        store.addBlacklist(gid, member.uid, {
          name: member.name, reason: `自然语言指令（${name || '管理员'}）`, by: 'natural',
        });
      }
      await reply(message, { polish: true, action: 'kick' });
      audit('kick', message, r.ok, r.err?.code || '');
      return done('kick', r.ok, source);
    }

    if (intent.action === 'mute' || intent.action === 'unmute') {
      const seconds = intent.action === 'unmute'
        ? null
        : (intent.seconds > 0 ? intent.seconds : effectiveModeration(settings, gid).muteSeconds);
      const r = await client.setMemberMute(gid, member.uid, seconds);
      const minutes = seconds ? Math.max(1, Math.round(seconds / 60)) : 0;
      const message = r.ok
        ? (intent.action === 'unmute' ? `已解除「${label}」的禁言。` : `已禁言「${label}」${minutes} 分钟。`)
        : `${intent.action === 'unmute' ? '解除禁言' : '禁言'}「${label}」失败：${r.err?.human || '未知原因'}`;
      await reply(message, { polish: true, action: intent.action });
      audit(intent.action, message, r.ok, r.err?.code || '');
      return done(intent.action, r.ok, source);
    }

    if (intent.action === 'warn') {
      const mod = effectiveModeration(settings, gid);
      const content = String(mod.warnTemplate || '{user} 请注意群规。')
        .replace(/\{user\}/gu, mention(member.uid))
        .replace(/\{group\}/gu, store.state.groups[gid]?.name || '本群')
        .replace(/\{rule\}/gu, '管理员警告');
      const r = await client.sendGroupText(gid, content.slice(0, LIMITS.warnMaxChars));
      const message = r.ok ? `已警告「${label}」。` : `警告「${label}」失败：${r.err?.human || '未知原因'}`;
      await reply(message, { polish: true, action: 'warn' });
      audit('warn', message, r.ok, r.err?.code || '');
      return done('warn', r.ok, source);
    }

    if (intent.action === 'blacklist' || intent.action === 'unblacklist') {
      const added = intent.action === 'blacklist';
      if (added) {
        store.addBlacklist(gid, member.uid, {
          name: member.name, reason: `自然语言指令（${name || '管理员'}）`, by: 'natural',
        });
      } else {
        store.removeBlacklist(gid, member.uid);
      }
      const message = added ? `已将「${label}」加入黑名单。` : `已将「${label}」移出黑名单。`;
      await reply(message, { polish: true, action: intent.action });
      audit(intent.action, message);
      return done(intent.action, true, source);
    }

    if (intent.action === 'info') {
      const message = [
        `「${member.name || '未备注'}」`,
        `openid：${member.uid}`,
        `最近发言：${timeText(member.lastSeenAt)}`,
        `台账发言：${member.msgCount || 0} 次`,
        `黑名单：${store.isBlacklisted(gid, member.uid) ? '是' : '否'}`,
      ].join('；');
      await reply(message, { polish: true, action: 'info' });
      audit('info', message);
      return done('info', true, source);
    }

    await reply(HELP_TEXT);
    audit('help', '未支持的操作', false, 'UNSUPPORTED');
    return { handled: true, action: 'help', ok: false };
  } catch (error) {
    const message = '执行失败：' + (error instanceof Error ? error.message : String(error));
    logger?.warn?.('[qqbot-guard] 自然语言指令异常：' + message);
    await reply(message);
    audit('error', message, false, 'EXCEPTION');
    return { handled: true, action: 'error', ok: false };
  }
}
