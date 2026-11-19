/**
 * 群内自然语言「管理后台」：把插件里能查、能改的东西都做成一句话指令。
 *
 * 分工与 lib/natural.js 保持一致：
 * - `parseAdminIntent()` 只用本地关键词规则，命中即返回，零模型开销；
 * - 没命中时由 `ai.parseIntent()` 判断（管理动作目录见 ADMIN_ACTIONS）；
 * - 只有受信任成员才会走到这里（由 Moderation 鉴权）。
 *
 * 所有写操作都走 `saveSettings(patch)`，与面板保存共用同一套校验、审计与重启逻辑。
 */
import { LIMITS } from './defaults.js';
import { mergeMemberRows, normalizeName } from './napcat.js';

const MAX_LIST = 40;
const MAX_TEXT = 1500;

/** 可切换的功能开关：关键词 -> 设置补丁 */
const TOGGLES = Object.freeze([
  {
    key: 'moderation',
    match: /(自动审核|违规审核|审核|自动处置|违禁检测|敏感词检测|auto ?moderation|moderation)/iu,
    label: '自动审核',
    get: (s) => !!s.moderation?.enabled,
    patch: (on) => ({ moderation: { enabled: on } }),
  },
  {
    key: 'join',
    match: /(入群欢迎|入群验证|欢迎语|入群答题|答题验证|welcome|join (verification|quiz))/iu,
    label: '入群欢迎/验证',
    get: (s) => !!(s.join?.welcome?.enabled || s.join?.quiz?.enabled),
    patch: (on) => ({ join: { welcome: { enabled: on }, quiz: { enabled: on } } }),
  },
  {
    key: 'joinApprove',
    match: /(入群(自动通过|自动审批)|自动通过入群|自动审批入群|入群审批自动通过|auto ?approve|auto ?approval)/iu,
    label: '入群自动通过',
    get: (s) => !!s.join?.autoApprove,
    patch: (on) => ({ join: { autoApprove: on } }),
  },
  {
    key: 'commands',
    match: /(群内指令|斜杠指令|指令功能|commands?)/iu,
    label: '群内指令',
    get: (s) => !!s.commands?.enabled,
    patch: (on) => ({ commands: { enabled: on } }),
  },
  {
    key: 'natural',
    match: /(自然语言|大白话指令|自然语言指令|natural language)/iu,
    label: '自然语言指令',
    get: (s) => !!s.commands?.naturalEnabled,
    patch: (on) => ({ commands: { naturalEnabled: on } }),
  },
  {
    key: 'guest',
    match: /(闲聊|普通用户通道|闲聊通道|聊天功能|chitchat|chat(ting)?|small talk)/iu,
    label: '闲聊通道',
    get: (s) => !!s.guest?.enabled,
    patch: (on) => ({ guest: { enabled: on } }),
  },
  {
    key: 'announcements',
    match: /(群公告|公告功能|announcements?)/iu,
    label: '公告',
    get: (s) => !!s.announcements?.enabled,
    patch: (on) => ({ announcements: { enabled: on } }),
  },
  {
    key: 'ai',
    match: /(AI\s*(辅助|审核|判断|功能)|智能审核|模型审核|\bai\b)/iu,
    label: 'AI 辅助',
    get: (s) => !!s.ai?.enabled && s.ai?.master !== false,
    patch: (on) => ({ ai: { enabled: on } }),
  },
  {
    key: 'napcat',
    match: /(NapCat|成员目录|花名册同步|QQ\s*号显示|member (directory|roster))/iu,
    label: 'NapCat 成员目录',
    get: (s) => !!s.napcat?.enabled,
    patch: (on) => ({ napcat: { enabled: on } }),
  },
]);

const ACTION_LABEL = Object.freeze({
  warn: '警告',
  mute: '禁言',
  kick: '移出群聊',
  delete: '删除消息',
});

/** 给 AI 提示词与帮助文本共用的动作目录 */
export const ADMIN_ACTIONS = Object.freeze([
  { action: 'list-members', desc: '列出群成员名单（含 QQ 号）', args: '' },
  { action: 'list-blacklist', desc: '查看群黑名单', args: '' },
  { action: 'list-whitelist', desc: '查看指令白名单', args: '' },
  { action: 'list-trusted', desc: '查看信任成员（豁免处置）', args: '' },
  { action: 'list-keywords', desc: '查看违规关键词', args: '' },
  { action: 'list-join-keywords', desc: '查看入群审批自动通过关键词', args: '' },
  { action: 'list-decline-keywords', desc: '查看入群审批拒绝关键词', args: '' },
  { action: 'list-settings', desc: '查看当前设置摘要', args: '' },
  { action: 'list-pending', desc: '查看待审批入群申请', args: '' },
  { action: 'list-announcements', desc: '查看公告列表', args: '' },
  { action: 'list-schedules', desc: '查看定时任务（定时禁言 / 全员禁言）', args: '' },
  { action: 'cancel-schedule', desc: '取消定时任务', args: 'target(序号或 id 前缀)' },
  { action: 'sync-directory', desc: '立即同步 NapCat 花名册', args: '' },
  { action: 'add-keyword', desc: '添加违规关键词', args: 'word' },
  { action: 'del-keyword', desc: '删除违规关键词', args: 'word' },
  { action: 'add-join-keyword', desc: '添加入群审批通过关键词', args: 'word' },
  { action: 'del-join-keyword', desc: '删除入群审批通过关键词', args: 'word' },
  { action: 'add-decline-keyword', desc: '添加入群审批拒绝关键词', args: 'word' },
  { action: 'del-decline-keyword', desc: '删除入群审批拒绝关键词', args: 'word' },
  { action: 'add-whitelist', desc: '把成员加入指令白名单', args: 'target' },
  { action: 'del-whitelist', desc: '把成员移出指令白名单', args: 'target' },
  { action: 'add-trusted', desc: '把成员设为信任成员', args: 'target' },
  { action: 'del-trusted', desc: '取消成员的信任身份', args: 'target' },
  { action: 'add-blacklist', desc: '把成员加入群黑名单', args: 'target' },
  { action: 'del-blacklist', desc: '把成员移出群黑名单', args: 'target' },
  { action: 'set-mute-seconds', desc: '设置默认禁言时长', args: 'seconds' },
  { action: 'set-action', desc: '设置违规处置方式', args: 'action(warn|mute|kick|delete)' },
  { action: 'set-welcome', desc: '设置入群欢迎语', args: 'text' },
  { action: 'set-rule', desc: '设置群规文本', args: 'text' },
  { action: 'set-prefix', desc: '设置指令前缀', args: 'text' },
  { action: 'toggle', desc: '开启/关闭某个功能', args: 'feature, enabled' },
  { action: 'announce', desc: '发布群公告', args: 'text' },
  { action: 'del-announcement', desc: '删除公告', args: 'target(序号或开头文字)' },
]);

export const ADMIN_ACTION_NAMES = Object.freeze(ADMIN_ACTIONS.map((x) => x.action));

export const ADMIN_HELP_TEXT = [
  '除了踢人/禁言，还能这样使唤我：',
  '“列出所有群成员名单” / “看看花名册”',
  '“查看黑名单”“查看白名单”“查看违规词”“查看设置”',
  '“查看入群审批通过关键词” / “查看入群审批拒绝词”',
  '“全体禁言” / “解除全员禁言” / “22:30 全体禁言”',
  '“查看定时任务” / “取消定时任务 1”',
  '“添加入群通过关键词 学生” / “删除入群通过关键词 学生”',
  '“查看待审批”“查看公告”“同步一下花名册”',
  '“添加违规词 某词” / “删除违规词 某词”',
  '“把‘某某’加入黑名单 / 移出黑名单”',
  '“把‘某某’加入白名单 / 移出白名单”',
  '“把‘某某’设为信任成员 / 取消信任”',
  '“默认禁言时长设为 10 分钟”“违规处置改为禁言”',
  '“入群欢迎语改为 欢迎新朋友” / “群规改为 友善交流”',
  '“指令前缀改为 !”',
  '“关闭自动审核”“开启闲聊”“关闭自然语言指令”',
  '“发公告 今晚八点开黑” / “删除公告 1”',
].join('\n');

function cleanText(text) {
  return String(text || '')
    .replace(/<@!?[^>]*>/gu, ' ')
    .replace(/\[CQ:[^\]]*\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function unquote(value) {
  return String(value || '')
    .trim()
    .replace(/^[「『“"'【\[]+/u, '')
    .replace(/[」』”"'】\]]+$/u, '')
    .trim();
}

function boolWord(text) {
  if (/(关闭|关掉|禁用|停用|别|取消|不要)/u.test(text)) return false;
  if (/(开启|打开|启用|恢复|允许)/u.test(text)) return true;
  return null;
}

function secondsOf(text) {
  const t = String(text || '');
  if (/半小时/u.test(t)) return 1800;
  if (/一刻钟/u.test(t)) return 900;
  if (/半天/u.test(t)) return 43_200;
  const m = t.match(/(\d+)\s*(天|小时|分钟|分|秒)/u);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (m[2] === '天') return n * 86_400;
  if (m[2] === '小时') return n * 3600;
  if (m[2] === '秒') return n;
  return n * 60;
}

/** 解析「添加违规词 xxx」这类列表写操作的词 */
function wordOf(text, keywordRe) {
  const m = String(text || '').match(new RegExp(`(?:${keywordRe})[：:\\s]*[「『“"']?(.+)$`, 'u'));
  return m ? unquote(m[1]) : '';
}

/** 解析「欢迎语改为 xxx」这类“动词 + 新值”的内容 */
function valueAfterVerb(text) {
  const m = String(text || '').match(/(?:改为|改成|设为|设置成|变成|设置为)[：:\s]*[「『“"']?(.+)$/u);
  return m ? unquote(m[1]) : '';
}

/**
 * 本地关键词解析：命中返回 {action, target, args}，否则 null。
 * 规则顺序刻意「先查询、后修改」，避免“查看黑名单”被当成加黑名单。
 */
export function parseAdminIntent(text, opts = {}) {
  // 英文指令先改写成中文规范说法（kick John / list all members…）
  const t = cleanText(text);
  if (!t) return null;
  const mentionUids = Array.isArray(opts?.mentionUids) ? opts.mentionUids.filter(Boolean) : [];
  const mention = mentionUids.length === 1 ? String(mentionUids[0]) : '';
  const say = (action, args = {}, target = '') => ({ action, target, args });

  // ---- 查询类 ----
  const joinCtx = /(入群|进群|加群|审批|申请)/u.test(t) && /(通过|拒绝|验证)/u.test(t);
  const joinWordCtx = joinCtx && /(关键词|关键字|词)/u.test(t);
  if (joinWordCtx && !/(添加|新增|加上|加入|删除|移除|去掉|删掉|删|取消)/u.test(t)) {
    return /拒绝/u.test(t) ? say('list-decline-keywords') : say('list-join-keywords');
  }
  if (joinWordCtx && /(添加|新增|加上|加入)/u.test(t)) {
    return say(/拒绝/u.test(t) ? 'add-decline-keyword' : 'add-join-keyword', { word: wordOf(t, '关键词|关键字') });
  }
  if (joinWordCtx && /(删除|移除|去掉|删掉|删|取消)/u.test(t)) {
    return say(/拒绝/u.test(t) ? 'del-decline-keyword' : 'del-join-keyword', { word: wordOf(t, '关键词|关键字') });
  }
  if (/黑名单/u.test(t) && !/(加入|加进|拉黑|移出|解除|取消|踢出|添加|放到?黑名单)/u.test(t)) {
    return say('list-blacklist');
  }
  if (/(白名单|指令白名单|允许用指令)/u.test(t) && !/(加入|添加|移出|删除|取消)/u.test(t)) {
    return say('list-whitelist');
  }
  if (/(信任成员|信任名单|豁免名单)/u.test(t) && !/(添加|加入|设为|取消|删除|移出)/u.test(t)) {
    return say('list-trusted');
  }
  if (/(违规词|关键词|违禁词|敏感词)/u.test(t) && !/(添加|新增|加入|删除|移除|去掉|删掉)/u.test(t)) {
    return say('list-keywords');
  }
  if (/(定时任务|排期|定时列表)/u.test(t) && !/(取消|删除|移除|停止)/u.test(t)) return say('list-schedules');
  if (/(取消|删除|移除|停止)/u.test(t) && /(定时任务|排期)/u.test(t)) {
    const m = t.match(/(定时任务|排期)[^\d]{0,4}(\d{1,6})/u) || t.match(/(\d{1,6})\s*号?\s*(定时任务|排期)/u);
    return say('cancel-schedule', {}, m ? m[1] : '');
  }
  if (/(待审批|入群申请|申请列表|待处理申请)/u.test(t)) return say('list-pending');
  if (/公告/u.test(t) && /(查看|列出|看看|显示|有哪些|列表|内容|是什么)/u.test(t) && !/(发|发布|删除|撤回)/u.test(t)) {
    return say('list-announcements');
  }
  if (/(同步|刷新)/u.test(t) && /(花名册|成员|成员目录)/u.test(t)) return say('sync-directory');
  if (/(设置|配置|参数)/u.test(t) && /(查看|看看|显示|当前|现在|是什么|摘要|状态)/u.test(t)) {
    return say('list-settings');
  }
  if (/(名单|花名册|所有成员|全部成员|全体成员|成员列表)/u.test(t) && !/(黑名单|白名单|信任|申请)/u.test(t)) {
    return say('list-members');
  }
  if (/^(列出|查看|看看|显示|列一下|给我看看?|都有谁)/u.test(t) && /成员/u.test(t) && !/(黑名单|白名单|申请)/u.test(t)) {
    return say('list-members');
  }

  // ---- 修改类 ----
  if (/(添加|新增|加上|加入|加)/u.test(t) && /(违规词|关键词|违禁词|敏感词)/u.test(t)) {
    const word = wordOf(t, '违规词|关键词|违禁词|敏感词');
    return say('add-keyword', { word });
  }
  if (/(删除|移除|去掉|删掉|删|取消)/u.test(t) && /(违规词|关键词|违禁词|敏感词)/u.test(t)) {
    const word = wordOf(t, '违规词|关键词|违禁词|敏感词');
    return say('del-keyword', { word });
  }
  if (/(加入|添加|加进|设为|设置)/u.test(t) && /(白名单|指令白名单)/u.test(t)) {
    return say('add-whitelist', {}, mention || adminTarget(t));
  }
  if (/(移出|删除|取消|移除)/u.test(t) && /(白名单|指令白名单)/u.test(t)) {
    return say('del-whitelist', {}, mention || adminTarget(t));
  }
  if (/(设为|设置|添加|加入)/u.test(t) && /(信任成员|信任)/u.test(t)) {
    return say('add-trusted', {}, mention || adminTarget(t));
  }
  if (/(取消|移除|删除|撤销)/u.test(t) && /(信任成员|信任)/u.test(t)) {
    return say('del-trusted', {}, mention || adminTarget(t));
  }
  if (/(加入|加进|添加|放到?)/u.test(t) && /黑名单/u.test(t)) {
    return say('add-blacklist', {}, mention || adminTarget(t));
  }
  if (/(移出|删除|取消|移除|解除)/u.test(t) && /黑名单/u.test(t)) {
    return say('del-blacklist', {}, mention || adminTarget(t));
  }
  if (/禁言时长/u.test(t) && /(设|改|调整|变成|为)/u.test(t)) {
    return say('set-mute-seconds', { seconds: secondsOf(t) });
  }
  if (/(处置|处理|处罚|违规动作|默认动作)/u.test(t) && /(改为|改成|设为|设置成|变成)/u.test(t)) {
    const m = t.match(/(警告|禁言|踢出|移出|删消息|删除消息)/u);
    return say('set-action', { action: m ? m[1] : '' });
  }
  if (/(欢迎语|入群欢迎|欢迎词)/u.test(t) && /(改为|改成|设为|设置成|变成)/u.test(t)) {
    return say('set-welcome', { text: valueAfterVerb(t) });
  }
  if (/群规/u.test(t) && /(改为|改成|设为|设置成|变成)/u.test(t)) {
    return say('set-rule', { text: valueAfterVerb(t) });
  }
  if (/(指令前缀|命令前缀|前缀)/u.test(t) && /(改为|改成|设为|设置成|变成)/u.test(t)) {
    const m = t.match(/(?:改为|改成|设为|设置成|变成)[：:\s]*[“"'「]?(\S+)/u);
    return say('set-prefix', { text: m ? unquote(m[1]) : '' });
  }
  if (/(开启|打开|启用|关闭|关掉|禁用|停用)/u.test(t)) {
    const on = boolWord(t);
    const feature = TOGGLES.find((f) => f.match.test(t));
    if (feature && on !== null) return say('toggle', { feature: feature.key, enabled: on });
  }
  if (/(发布|发|新建|添加|写)\s*(一下|一条|个)?\s*公告/u.test(t)) {
    const m = t.match(/公告[：:\s]*(.+)$/u);
    return say('announce', { text: m ? unquote(m[1]) : '' });
  }
  if (/(删除|撤回|移除|删)\s*(一下|一条|个)?\s*公告/u.test(t)) {
    const m = t.match(/公告[：:\s]*(.+)$/u);
    return say('del-announcement', {}, m ? unquote(m[1]) : '');
  }
  return null;
}

/** 从“把‘张三’加入白名单”里取目标（去掉动作词） */
function adminTarget(text) {
  const t = cleanText(text);
  const quoted = t.match(/[「『“"]([^」』”"]+)[」』”"]/u);
  if (quoted) return quoted[1].trim();
  const m = t.match(/(?:把|将|给)\s*([^\s，,。]+?)\s*(?:加入|移出|设为|设置|取消|添加|放到?|从)/u);
  if (m) return m[1].trim();
  return '';
}

/** 在台账 / NapCat 花名册里定位成员；返回 {uid,name,qq} 或 null */
function resolveMember(store, gid, target) {
  const t = String(target || '').trim();
  if (!t) return null;
  const direct = store.getMember(gid, t);
  if (direct) return { uid: direct.uid, name: direct.name || direct.uid, qq: direct.qq || '' };
  const exact = store.findMembersByName(gid, t);
  if (exact.length === 1) {
    const m = exact[0];
    return { uid: m.uid, name: m.name || m.uid, qq: m.qq || '' };
  }
  if (exact.length > 1) return { ambiguous: exact.length, names: exact.slice(0, 5).map((m) => m.name || m.uid) };
  const entry = store.getDirectory?.(gid);
  const wanted = normalizeName(t);
  for (const r of entry?.members || []) {
    if (!r) continue;
    if (normalizeName(r.nickname) === wanted || normalizeName(r.card) === wanted || String(r.qq) === t) {
      const led = store.findMembersByName(gid, r.card || r.nickname);
      const uid = led.length === 1 ? led[0].uid : '';
      return { uid, name: r.card || r.nickname || t, qq: r.qq, rosterOnly: !uid };
    }
  }
  return null;
}

function truncateList(items, mapper) {
  const shown = items.slice(0, MAX_LIST).map(mapper);
  const more = items.length > MAX_LIST ? `\n……另有 ${items.length - MAX_LIST} 项，可在面板查看` : '';
  return shown.join('\n') + more;
}

function featureOf(key) {
  return TOGGLES.find((f) => f.key === key) || null;
}

/**
 * 执行一条管理指令。
 * @returns {Promise<{ok:boolean, message:string}>}
 */
/** 群公告文本里的 HTML 实体/换行还原成可读文本 */
export function decodeNoticeText(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/&#10;/gu, '\n')
    .replace(/&#9;/gu, '\t')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/<[^>]+>/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** 一条公告里包含的图片数（不同版本字段不同；image/images 常重复，按 id 去重） */
export function noticeImageCount(notice) {
  const list = []
    .concat(notice?.message?.image || [], notice?.message?.images || [], notice?.image || [], notice?.images || [])
    .filter(Boolean);
  const ids = new Set();
  for (const item of list) {
    ids.add(String(item.id || item.file || item.url || JSON.stringify(item)));
  }
  return ids.size;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 结构化展示群公告列表：标题、置顶/需确认、时间、图片数、正文 */
export function formatNoticeList(items, { max = 6, bodyChars = 220 } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, max);
  const total = Array.isArray(items) ? items.length : list.length;
  const out = [`📢 群公告（共 ${total} 条）`];
  list.forEach((n, i) => {
    const text = decodeNoticeText(n?.message?.text || n?.content || n?.message || '');
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const title = (lines[0] || '未命名公告').slice(0, 24);
    const tags = [];
    if (n?.pinned) tags.push('置顶');
    if (Number(n?.settings?.confirm_required)) tags.push('需确认');
    if (n?.send_to_new_member) tags.push('发给新成员');
    const ts = Number(n?.publish_time) > 0 ? new Date(Number(n.publish_time) * 1000) : null;
    const when = ts && !Number.isNaN(ts.getTime())
      ? `${ts.getFullYear()}-${pad2(ts.getMonth() + 1)}-${pad2(ts.getDate())} ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}`
      : '';
    // 正文 = 除首行标题外的所有行（避免用 replace 截断后留下半段）
    const body = lines.slice(1).join(' ').replace(/\s+/gu, ' ').trim();
    const preview = body.length > bodyChars ? `${body.slice(0, bodyChars)}…` : body;
    const imgs = noticeImageCount(n);
    out.push('');
    out.push(`${i + 1}. 【${title}】${tags.length ? ` ${tags.map((t) => `〔${t}〕`).join('')}` : ''}`);
    if (when) out.push(`   🕒 ${when}${Number(n?.read_num) ? ` · 已读 ${n.read_num}` : ''}`);
    if (imgs) out.push(`   🖼 含 ${imgs} 张图片`);
    if (preview) out.push(`   ${preview}`);
  });
  return out.join('\n');
}

export async function executeAdminIntent(deps) {
  const {
    intent, gid, uid, name, store, settings, directory, saveSettings, ai, scheduler, client,
  } = deps;
  const s = settings || store.settings;
  const action = String(intent?.action || '');
  const args = intent?.args || {};
  const target = String(intent?.target || args.target || '').trim();
  const groupName = store.state.groups[gid]?.name || '本群';
  const actor = `自然语言指令（${name || '管理员'}）`;

  const save = async (patch, summary) => {
    if (typeof saveSettings !== 'function') {
      return { ok: false, message: '当前运行环境不支持在群里改设置，请到面板修改。' };
    }
    const r = await saveSettings(patch, { actor, summary: [summary] });
    if (r && r.ok === false) {
      return { ok: false, message: `保存失败：${r.error?.message || '设置校验未通过'}` };
    }
    return { ok: true };
  };

  switch (action) {
    case 'list-members': {
      try {
        if (directory?.enabled?.()) await directory.ensureFresh([gid]);
      } catch { /* 目录不可用也不影响台账 */ }
      const { rows } = mergeMemberRows({
        ledger: store.listMembers(gid),
        directories: store.listDirectories(gid),
        query: '',
        limit: LIMITS.memberSearchLimit,
        selfQQ: directory?.selfQQ || '',
        allowUsers: s.commands?.allowUsers || [],
        trustedUsers: s.moderation?.trustedUsers || [],
      });
      if (!rows.length) return { ok: true, message: '暂时没有成员数据：让成员在群里发句话，或在面板同步花名册。' };
      const roster = store.countDirectory(gid);
      const head = `群成员 ${rows.length} 人（花名册 ${roster} 人 / 台账 ${store.countMembers(gid)} 人）：`;
      const body = truncateList(rows, (m, i) => {
        const qq = m.qq ? `QQ ${m.qq}` : 'QQ 未知';
        const tags = [];
        if (m.isBot) tags.push('机器人');
        if (m.role === 'owner') tags.push('群主');
        else if (m.role === 'admin') tags.push('管理员');
        if (m.whitelisted) tags.push('白名单');
        if (m.trusted) tags.push('信任');
        const tagText = tags.length ? `[${tags.join('·')}] ` : '';
        const rawName = String(m.name || m.nickname || '').trim();
        const name = rawName || (m.uid ? `未命名(${m.uid.slice(-6)})` : '未命名');
        const noQQ = m.uid ? `，openid 尾号 ${m.uid.slice(-6)}` : '';
        const last = m.lastSeenAt ? '' : '（未发言）';
        return `${i + 1}. ${tagText}${name}（${qq}${m.qq ? '' : noQQ}）${last}`;
      });
      return { ok: true, message: (head + '\n' + body).slice(0, MAX_TEXT) };
    }
    case 'list-schedules': {
      if (!scheduler) return { ok: false, message: '定时任务需要在插件运行时里使用，请稍后再试。' };
      const items = scheduler.list(gid);
      if (!items.length) return { ok: true, message: '当前没有定时任务。可以说“22:30 全体禁言”或“每天 23:00 全体禁言”。' };
      const body = items.map((x, i) => {
        const time = x.repeat === 'daily' ? `每天 ${x.time}` : new Date(x.at).toLocaleString('zh-CN', { hour12: false });
        const what = x.kind === 'mute' ? `禁言 ${x.qq ? 'QQ ' + x.qq : (x.uid || '某人')}${x.seconds ? ` ${Math.round(x.seconds / 60)} 分钟` : ''}`
          : x.kind === 'unmute' ? `解除 ${x.qq ? 'QQ ' + x.qq : (x.uid || '某人')} 的禁言`
          : x.kind === 'whole-ban' ? '全体禁言' : '解除全体禁言';
        return `${i + 1}. ${time} · ${what}`;
      }).join('\n');
      return { ok: true, message: (`定时任务 ${items.length} 条：\n` + body).slice(0, MAX_TEXT) };
    }
    case 'cancel-schedule': {
      if (!scheduler) return { ok: false, message: '定时任务需要在插件运行时里使用，请稍后再试。' };
      const items = scheduler.list(gid);
      if (!items.length) return { ok: true, message: '当前没有定时任务。' };
      const key = target || String(args.target || '');
      let hit = items.find((x) => x.id === key);
      if (!hit && /^\d+$/.test(key)) hit = items[Number(key) - 1];
      if (!hit && key) hit = items.find((x) => x.id.startsWith(key));
      if (!hit) return { ok: false, message: '没有找到这条定时任务，可以说“查看定时任务”看序号。' };
      const r = scheduler.cancel(hit.id);
      return r.ok ? { ok: true, message: '已取消这条定时任务。' } : { ok: false, message: r.error || '取消失败' };
    }
    case 'list-blacklist': {
      const items = store.listBlacklist(gid);
      if (!items.length) return { ok: true, message: '当前没有黑名单成员。' };
      return { ok: true, message: `黑名单 ${items.length} 人：\n` + truncateList(items, (m, i) => `${i + 1}. ${m.name || m.uid}（${m.uid}）`) };
    }
    case 'list-whitelist': {
      const users = Array.isArray(s.commands?.allowUsers) ? s.commands.allowUsers : [];
      if (!users.length) return { ok: true, message: '指令白名单是空的（目前没有人能用指令，信任成员除外）。' };
      return { ok: true, message: `指令白名单 ${users.length} 人：\n` + truncateList(users, (u, i) => `${i + 1}. ${u}`) };
    }
    case 'list-trusted': {
      const users = Array.isArray(s.moderation?.trustedUsers) ? s.moderation.trustedUsers : [];
      if (!users.length) return { ok: true, message: '还没有信任成员（信任成员免处置，可直接用指令）。' };
      return { ok: true, message: `信任成员 ${users.length} 人：\n` + truncateList(users, (u, i) => `${i + 1}. ${u.name || u.uid}（${u.uid}）`) };
    }
    case 'list-keywords': {
      const words = Array.isArray(s.moderation?.keywords) ? s.moderation.keywords : [];
      if (!words.length) return { ok: true, message: '违规关键词是空的。' };
      return { ok: true, message: `违规关键词 ${words.length} 个：\n` + truncateList(words, (w, i) => `${i + 1}. ${w}`) };
    }
    case 'list-pending': {
      const items = store.listPending();
      if (!items.length) return { ok: true, message: '没有待审批的入群申请。' };
      return { ok: true, message: `待审批 ${items.length} 条：\n` + truncateList(items, (p, i) => `${i + 1}. ${p.name || p.uid}（申请入群）`) };
    }
    case 'list-announcements': {
      // 优先用当前连接客户端读真·群公告（NapCatClient 能兼容数组/data+inst 两种返回）
      try {
        if (typeof client?.getGroupNotices === 'function') {
          const r = await client.getGroupNotices(gid);
          if (r?.ok && Array.isArray(r.all) && r.all.length) {
            return { ok: true, message: formatNoticeList(r.all) };
          }
        }
      } catch { /* 继续尝试成员目录 */ }
      try {
        if (directory?.getGroupNotices) {
          const r = await directory.getGroupNotices(gid);
          if (r?.ok && Array.isArray(r.all) && r.all.length) {
            return { ok: true, message: formatNoticeList(r.all) };
          }
        }
      } catch { /* NapCat 不可用则走本地列表 */ }
      const items = store.announcements?.items || [];
      if (!items.length) return { ok: true, message: '还没有公告。' };
      return { ok: true, message: `公告 ${items.length} 条：\n` + truncateList(items, (a, i) => `${i + 1}. ${String(a.content || '').slice(0, 40)}`) };
    }
    case 'list-join-keywords': {
      const words = Array.isArray(s.join?.approveKeywords) ? s.join.approveKeywords : [];
      const head = `入群自动通过：${s.join?.autoApprove ? '开' : '关'}；通过关键词 ${words.length} 个`;
      if (!words.length) return { ok: true, message: `${head}（还没设置，可按“添加入群通过关键词 学生”加一条）。` };
      return { ok: true, message: `${head}：\n` + truncateList(words, (w, i) => `${i + 1}. ${w}`) };
    }
    case 'list-decline-keywords': {
      const words = Array.isArray(s.join?.declineKeywords) ? s.join.declineKeywords : [];
      if (!words.length) return { ok: true, message: '入群审批拒绝关键词是空的。' };
      return { ok: true, message: `入群审批拒绝关键词 ${words.length} 个：\n` + truncateList(words, (w, i) => `${i + 1}. ${w}`) };
    }
    case 'list-settings': {
      const mod = s.moderation || {};
      return {
        ok: true,
        message: [
          `【${groupName} 当前设置】`,
          `自动审核：${mod.enabled ? '开' : '关'}；违规处置：${ACTION_LABEL[mod.action] || mod.action || '警告'}；默认禁言 ${Math.round((mod.muteSeconds || 0) / 60)} 分钟`,
          `违规词 ${(mod.keywords || []).length} 个；黑名单 ${store.listBlacklist(gid).length} 人`,
          `入群欢迎：${s.join?.welcome?.enabled ? '开' : '关'}；入群答题：${s.join?.quiz?.enabled ? '开' : '关'}；自动通过：${s.join?.autoApprove ? '开' : '关'}（通过词 ${(s.join?.approveKeywords || []).length} / 拒绝词 ${(s.join?.declineKeywords || []).length}）`,
          `群内指令：${s.commands?.enabled ? '开' : '关'}（前缀 ${s.commands?.prefix || '/'}）；自然语言：${s.commands?.naturalEnabled ? '开' : '关'}`,
          `闲聊通道：${s.guest?.enabled ? '开' : '关'}；AI 总开关：${s.ai?.master === false ? '关' : '开'}；AI 辅助：${s.ai?.enabled ? '开' : '关'}`,
          `NapCat 成员目录：${s.napcat?.enabled ? '开' : '关'}；公告：${s.announcements?.enabled ? '开' : '关'}`,
        ].join('\n'),
      };
    }
    case 'sync-directory': {
      if (!directory?.enabled?.()) return { ok: false, message: 'NapCat 成员目录未启用，无法同步。' };
      const r = await directory.sync([gid]);
      if (!r?.ok) return { ok: false, message: `同步失败：${r?.error || 'NapCat 未连接'}` };
      // MemberDirectory.sync() 的字段是 syncedGroups / syncedMembers（与面板同源），
      // 旧代码读 r.groups / r.members 恒为 0，群里永远显示“0 个群、0 位成员”。
      const groups = Number(r.syncedGroups) || 0;
      const members = Number(r.syncedMembers) || 0;
      const skip = Number(r.skippedGroups) || 0;
      const warn = r.warning ? `（${r.warning}）` : (skip ? `（${skip} 个群未匹配到 QQ 群号，可在面板补映射）` : '');
      return { ok: true, message: `花名册已同步：${groups} 个群、${members} 位成员${warn}` };
    }
    case 'add-keyword': {
      const word = unquote(args.word);
      if (!word) return { ok: false, message: '要加哪个违规词？例如：添加违规词 某词' };
      const words = Array.isArray(s.moderation?.keywords) ? s.moderation.keywords : [];
      if (words.some((w) => normalizeName(w) === normalizeName(word))) {
        return { ok: true, message: `违规词「${word}」已经在列表里了。` };
      }
      const r = await save({ moderation: { keywords: [...words, word] } }, `添加违规词：${word}`);
      return r.ok ? { ok: true, message: `已添加违规词「${word}」，现在共 ${words.length + 1} 个。` } : r;
    }
    case 'del-keyword': {
      const word = unquote(args.word);
      if (!word) return { ok: false, message: '要删哪个违规词？例如：删除违规词 某词' };
      const words = Array.isArray(s.moderation?.keywords) ? s.moderation.keywords : [];
      const left = words.filter((w) => normalizeName(w) !== normalizeName(word));
      if (left.length === words.length) return { ok: false, message: `违规词列表里没有「${word}」。` };
      const r = await save({ moderation: { keywords: left } }, `删除违规词：${word}`);
      return r.ok ? { ok: true, message: `已删除违规词「${word}」，还剩 ${left.length} 个。` } : r;
    }
    case 'add-join-keyword':
    case 'add-decline-keyword': {
      const word = unquote(args.word);
      if (!word) return { ok: false, message: '要加哪个词？例如：添加入群通过关键词 学生' };
      const field = action === 'add-join-keyword' ? 'approveKeywords' : 'declineKeywords';
      const label = action === 'add-join-keyword' ? '入群通过关键词' : '入群拒绝关键词';
      const words = Array.isArray(s.join?.[field]) ? s.join[field] : [];
      if (words.some((w) => normalizeName(w) === normalizeName(word))) {
        return { ok: true, message: `${label}「${word}」已经在列表里了。` };
      }
      const r = await save({ join: { [field]: [...words, word] } }, `添加${label}：${word}`);
      return r.ok ? { ok: true, message: `已添加${label}「${word}」，现在共 ${words.length + 1} 个。` } : r;
    }
    case 'del-join-keyword':
    case 'del-decline-keyword': {
      const word = unquote(args.word);
      if (!word) return { ok: false, message: '要删哪个词？例如：删除入群通过关键词 学生' };
      const field = action === 'del-join-keyword' ? 'approveKeywords' : 'declineKeywords';
      const label = action === 'del-join-keyword' ? '入群通过关键词' : '入群拒绝关键词';
      const words = Array.isArray(s.join?.[field]) ? s.join[field] : [];
      const left = words.filter((w) => normalizeName(w) !== normalizeName(word));
      if (left.length === words.length) return { ok: false, message: `${label}列表里没有「${word}」。` };
      const r = await save({ join: { [field]: left } }, `删除${label}：${word}`);
      return r.ok ? { ok: true, message: `已删除${label}「${word}」，还剩 ${left.length} 个。` } : r;
    }
    case 'add-whitelist':
    case 'del-whitelist': {
      const m = resolveMember(store, gid, target);
      if (!m) return { ok: false, message: '没找到这位成员：请 @ 他，或用完整昵称。' };
      if (m.ambiguous) return { ok: false, message: `有 ${m.ambiguous} 位同名成员（${m.names.join('、')}），请 @ 指定。` };
      const users = Array.isArray(s.commands?.allowUsers) ? s.commands.allowUsers : [];
      const has = users.includes(m.uid);
      if (action === 'add-whitelist' && has) return { ok: true, message: `「${m.name}」已经在指令白名单里了。` };
      if (action === 'del-whitelist' && !has) return { ok: true, message: `「${m.name}」不在指令白名单里。` };
      const next = action === 'add-whitelist' ? [...users, m.uid] : users.filter((x) => x !== m.uid);
      const r = await save({ commands: { allowUsers: next } }, `${action === 'add-whitelist' ? '加入' : '移出'}指令白名单：${m.name}`);
      return r.ok ? { ok: true, message: `已${action === 'add-whitelist' ? '把' : '将'}「${m.name}」${action === 'add-whitelist' ? '加入' : '移出'}指令白名单。` } : r;
    }
    case 'add-trusted':
    case 'del-trusted': {
      const m = resolveMember(store, gid, target);
      if (!m) return { ok: false, message: '没找到这位成员：请 @ 他，或用完整昵称。' };
      if (m.ambiguous) return { ok: false, message: `有 ${m.ambiguous} 位同名成员（${m.names.join('、')}），请 @ 指定。` };
      const users = Array.isArray(s.moderation?.trustedUsers) ? s.moderation.trustedUsers : [];
      const has = users.some((u) => String(u.uid) === String(m.uid));
      if (action === 'add-trusted' && has) return { ok: true, message: `「${m.name}」已经是信任成员了。` };
      if (action === 'del-trusted' && !has) return { ok: true, message: `「${m.name}」不是信任成员。` };
      const next = action === 'add-trusted'
        ? [...users, { uid: m.uid, name: m.name, note: actor }]
        : users.filter((u) => String(u.uid) !== String(m.uid));
      const r = await save({ moderation: { trustedUsers: next } }, `${action === 'add-trusted' ? '设为' : '取消'}信任成员：${m.name}`);
      return r.ok ? { ok: true, message: `已${action === 'add-trusted' ? '把' : '取消'}「${m.name}」${action === 'add-trusted' ? '设为信任成员（免处置、可用指令）' : '的信任身份'}。` } : r;
    }
    case 'add-blacklist':
    case 'del-blacklist': {
      if (action === 'del-blacklist') {
        const users = store.listBlacklist(gid);
        const wanted = normalizeName(target);
        const hit = users.find((u) => String(u.uid) === target
          || (wanted && normalizeName(u.name || '') === wanted)
          || (target && String(u.uid) === String(resolveMember(store, gid, target)?.uid || '')));
        if (!hit) return { ok: true, message: '他不在黑名单里（也可能名字写错了，可以说“查看黑名单”对照）。' };
        store.removeBlacklist(gid, hit.uid);
        return { ok: true, message: `已把「${hit.name || hit.uid}」移出黑名单。` };
      }
      const m = resolveMember(store, gid, target);
      if (!m) return { ok: false, message: '没找到这位成员：请 @ 他，或用完整昵称 / openid。' };
      if (m.ambiguous) return { ok: false, message: `有 ${m.ambiguous} 位同名成员（${m.names.join('、')}），请 @ 指定。` };
      if (m.rosterOnly) {
        return { ok: false, message: `「${m.name}」（QQ ${m.qq}）还没在群里发过言，官方接口只能按 openid 拉黑；请让他在群里说句话，或在面板按 QQ 号处理。` };
      }
      store.addBlacklist(gid, m.uid, { name: m.name, reason: actor, by: 'natural' });
      return { ok: true, message: `已把「${m.name}」加入黑名单。` };
    }
    case 'set-mute-seconds': {
      const seconds = Number(args.seconds) || secondsOf(args.seconds || '') || 0;
      if (!seconds) return { ok: false, message: '要说清楚时长，例如：默认禁言时长设为 10 分钟' };
      const r = await save({ moderation: { muteSeconds: seconds } }, `默认禁言时长：${Math.round(seconds / 60)} 分钟`);
      return r.ok ? { ok: true, message: `默认禁言时长已设为 ${Math.round(seconds / 60)} 分钟。` } : r;
    }
    case 'set-action': {
      const raw = String(args.action || '').trim();
      const map = { 警告: 'warn', 禁言: 'mute', 踢出: 'kick', 移出: 'kick', 删消息: 'delete', 删除消息: 'delete' };
      const next = map[raw] || (['warn', 'mute', 'kick', 'delete'].includes(raw) ? raw : '');
      if (!next) return { ok: false, message: '违规处置只能是：警告 / 禁言 / 移出群聊 / 删除消息。' };
      const r = await save({ moderation: { action: next } }, `违规处置：${ACTION_LABEL[next]}`);
      return r.ok ? { ok: true, message: `违规处置已改为「${ACTION_LABEL[next]}」。` } : r;
    }
    case 'set-welcome': {
      const text = unquote(args.text);
      if (!text) return { ok: false, message: '要改成什么欢迎语？例如：入群欢迎语改为 欢迎新朋友' };
      const r = await save({ join: { welcome: { enabled: true, template: text } } }, `入群欢迎语：${text.slice(0, 30)}`);
      return r.ok ? { ok: true, message: `入群欢迎语已更新（支持 {user} 占位）。` } : r;
    }
    case 'set-rule': {
      const text = unquote(args.text);
      if (!text) return { ok: false, message: '群规要改成什么？例如：群规改为 友善交流，禁止广告' };
      const r = await save({ commands: { ruleText: text } }, `群规：${text.slice(0, 30)}`);
      return r.ok ? { ok: true, message: '群规已更新。' } : r;
    }
    case 'set-prefix': {
      const text = unquote(args.text);
      if (!text || text.length > 3) return { ok: false, message: '前缀建议 1～3 个字符，例如：指令前缀改为 !' };
      const r = await save({ commands: { prefix: text } }, `指令前缀：${text}`);
      return r.ok ? { ok: true, message: `指令前缀已改为「${text}」。` } : r;
    }
    case 'toggle': {
      const feature = featureOf(args.feature) || TOGGLES.find((f) => f.match.test(args.feature || ''));
      if (!feature) return { ok: false, message: '要开关哪个功能？支持：自动审核、入群欢迎、群内指令、自然语言、闲聊、公告、AI 辅助、NapCat 成员目录。' };
      // 旧实现 `args.enabled !== false` 在模型没给 enabled 时会默认「开启」——
      // 用户说“关闭闲聊”却可能被静默打开。现在缺参数就明确要求说清楚。
      if (typeof args.enabled !== 'boolean') {
        const now = feature.get(s) ? '开启' : '关闭';
        return { ok: false, message: `「${feature.label}」当前是${now}状态。请说明要“开启”还是“关闭”，例如：关闭${feature.label}。` };
      }
      const on = args.enabled === true;
      if (feature.get(s) === on) {
        return { ok: true, message: `「${feature.label}」已经是${on ? '开启' : '关闭'}状态，无需重复操作。` };
      }
      const r = await save(feature.patch(on), `${on ? '开启' : '关闭'}${feature.label}`);
      return r.ok ? { ok: true, message: `已${on ? '开启' : '关闭'}「${feature.label}」。` } : r;
    }
    case 'announce': {
      const text = unquote(args.text);
      if (!text) return { ok: false, message: '公告内容是什么？例如：发公告 今晚八点开黑' };
      const items = store.announcements?.items || [];
      // 默认发到当前群；显式 targets 优先，其次设置里的默认目标群
      const targets = Array.isArray(args.targets) && args.targets.length
        ? args.targets.map(String)
        : (gid ? [gid] : (Array.isArray(s.announcements?.defaultTargets) ? s.announcements.defaultTargets.map(String) : []));
      // NapCat 可用时默认发“真·群公告”（_send_group_notice），否则回落普通消息
      let napcatReady = false;
      try { napcatReady = !!directory?.enabled?.(); } catch { napcatReady = false; }
      const mode = s.announcements?.mode || (napcatReady ? 'notice' : 'text');
      const now = new Date().toISOString();
      const item = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: '',
        content: text,
        createdAt: now,
        updatedAt: now,
        status: 'draft',
        mode,
        targets,
        pinned: args.pinned === true,
        confirmRequired: args.confirmRequired === true,
        by: name || '管理员',
      };
      items.unshift(item);
      store.saveAnnouncements?.();
      const sent = typeof deps.sendAnnouncement === 'function' ? await deps.sendAnnouncement(item) : null;
      if (!sent) return { ok: false, message: '公告已保存，但发送通道不可用（机器人未连接）。' };
      if (!sent.ok) {
        const why = sent.error || '未知原因';
        const hint = mode === 'notice' ? '（真·群公告需要 NapCat 在线、机器人是群管理员，并在设置里配置群号映射）' : '';
        return { ok: false, message: `公告发布失败：${why}${hint}` };
      }
      const how = mode === 'notice' ? '真·群公告' : '群消息';
      const results = Array.isArray(sent.item?.results) ? sent.item.results : [];
      const usedNotice = results.some((x) => x && x.mode === 'notice');
      const actual = results.length ? (usedNotice ? '真·群公告' : '群消息') : how;
      return { ok: true, message: `已发布${actual}到 ${sent.sent} 个群：${text.slice(0, 40)}` };
    }
    case 'del-announcement': {
      const items = store.announcements?.items || [];
      const key = String(target || args.target || '').trim();
      if (!items.length) return { ok: true, message: '还没有公告。' };
      const index = Number(key);
      let removed = null;
      if (Number.isInteger(index) && index > 0 && index <= items.length) {
        removed = items[index - 1];
      } else if (key) {
        removed = items.find((a) => String(a.content || '').includes(key)) || null;
      }
      if (!removed) return { ok: false, message: '没找到这条公告：可以说“删除公告 1”或公告开头几个字。' };
      store.announcements.items = items.filter((a) => a !== removed);
      store.saveAnnouncements?.();
      return { ok: true, message: `已删除公告：${String(removed.content || '').slice(0, 40)}` };
    }
    default:
      break;
  }
  // 兜底：交回 AI / 帮助
  if (ai && typeof ai.parseIntent === 'function') {
    // 交给调用方处理
  }
  return { ok: false, message: ADMIN_HELP_TEXT, unknown: true };
}
