/**
 * 自然语言“快捷关键词”管理（v1.9.0）。
 *
 * 定位：从 v1.9.0 起，**所有自然语言指令都先交给 AI 决策**；关键词只在
 *   1) 模型超时 / 不可用 / 返回不合规时兜底执行；
 *   2) 作为“用户最近常用动作”的快照，方便部署方一眼看懂当前生效的快捷词。
 *
 * 关键词数量上限 15 个；默认每 3 周按最近使用记录重排一次（最多 10 周），
 * 最近 7 天用得够多（默认 100 次）也会提前提醒并重排。
 */

export const KEYWORD_LIMIT = 15;
export const STARTER_KEYWORD_COUNT = 8;
export const DEFAULT_REVIEW_WEEKS = 3;
export const MAX_REVIEW_WEEKS = 10;
/** 兼容旧配置的“天数”视图：3 周 = 21 天 */
export const DEFAULT_REVIEW_DAYS = DEFAULT_REVIEW_WEEKS * 7;
export const DEFAULT_WEEKLY_COMMANDS = 100;
export const WEEK_DAYS = 7;

/** 把设置里的重排周期折算成周：优先 reviewWeeks，老配置 reviewDays 自动换算并夹到 1-10 周 */
export function reviewWeeksOf(nat = {}) {
  const weeks = Number(nat?.reviewWeeks);
  if (Number.isFinite(weeks) && weeks > 0) {
    return Math.min(MAX_REVIEW_WEEKS, Math.max(1, Math.round(weeks)));
  }
  const days = Number(nat?.reviewDays);
  if (Number.isFinite(days) && days > 0) {
    return Math.min(MAX_REVIEW_WEEKS, Math.max(1, Math.ceil(days / WEEK_DAYS)));
  }
  return DEFAULT_REVIEW_WEEKS;
}

/** 新手默认保留的常用关键词：名字短、歧义小 */
export const STARTER_KEYWORDS = Object.freeze([
  { phrase: '列出群成员', action: 'list-members' },
  { phrase: '禁言', action: 'mute' },
  { phrase: '解禁', action: 'unmute' },
  { phrase: '全体禁言', action: 'whole-ban' },
  { phrase: '解除全体禁言', action: 'whole-unban' },
  { phrase: '踢人', action: 'kick' },
  { phrase: '查人数', action: 'count' },
  { phrase: '警告', action: 'warn' },
]);

/** 由动作反推“最像人话”的默认说法，用于按使用习惯重排 */
export const ACTION_PHRASES = Object.freeze({
  'list-members': '列出群成员',
  'list-blacklist': '查看黑名单',
  'list-whitelist': '查看白名单',
  'list-trusted': '查看信任成员',
  'list-keywords': '查看违规词',
  'list-settings': '当前设置',
  'list-pending': '查看待审批',
  'list-announcements': '查看公告',
  'sync-directory': '同步花名册',
  'add-keyword': '添加违规词',
  'del-keyword': '删除违规词',
  'add-whitelist': '加入白名单',
  'del-whitelist': '移出白名单',
  'add-trusted': '设为信任成员',
  'del-trusted': '取消信任成员',
  'add-blacklist': '加入黑名单',
  'del-blacklist': '移出黑名单',
  'set-mute-seconds': '默认禁言时长',
  'set-action': '违规处置',
  'set-welcome': '入群欢迎语',
  'set-rule': '群规',
  'set-prefix': '指令前缀',
  toggle: '开关功能',
  announce: '发公告',
  'del-announcement': '删除公告',
  mute: '禁言',
  unmute: '解禁',
  'whole-ban': '全体禁言',
  'whole-unban': '解除全体禁言',
  kick: '踢人',
  warn: '警告',
  blacklist: '拉黑',
  unblacklist: '移出黑名单',
  info: '查成员信息',
  count: '查人数',
  device: '设备状态',
  balance: '查余额',
  restart: '重启插件',
  help: '帮助',
  rule: '群规',
});

function normalizePhrase(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, '')
    .trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 只保留 {phrase, action} 合法项，去重并截断到上限 */
export function normalizeKeywords(list, limit = KEYWORD_LIMIT) {
  const max = Math.max(1, Math.min(KEYWORD_LIMIT, Number(limit) || KEYWORD_LIMIT));
  const out = [];
  const seenPhrase = new Set();
  const seenAction = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item)) continue;
    const phrase = String(item.phrase || '').trim().slice(0, 20);
    const action = String(item.action || '').trim().slice(0, 60);
    if (!phrase || !action) continue;
    const key = normalizePhrase(phrase);
    if (!key || seenPhrase.has(key) || seenAction.has(action)) continue;
    seenPhrase.add(key);
    seenAction.add(action);
    out.push({ phrase, action });
    if (out.length >= max) break;
  }
  return out;
}

/** 当前生效的关键词：设置里维护过的优先，否则用新手默认 */
export function currentKeywords(settings) {
  const list = normalizeKeywords(settings?.natural?.keywords);
  return list.length ? list : normalizeKeywords(STARTER_KEYWORDS);
}

export function keywordLimitOf(settings) {
  const n = Number(settings?.natural?.keywordLimit) || KEYWORD_LIMIT;
  return Math.max(1, Math.min(KEYWORD_LIMIT, n));
}

/** 最近 N 天的使用次数 */
export function countSince(records, days, now = Date.now()) {
  const from = Number(now) - Number(days) * 86_400_000;
  return (Array.isArray(records) ? records : []).filter((r) => Number(r?.at || 0) >= from).length;
}

/** 按动作聚合最近使用次数（最近 days 天），返回 [{action,count}] 降序 */
export function usageByAction(records, days = DEFAULT_REVIEW_DAYS, now = Date.now()) {
  const from = Number(now) - Number(days) * 86_400_000;
  const counts = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (Number(r?.at || 0) < from) continue;
    const action = String(r?.action || '');
    if (!action) continue;
    counts.set(action, (counts.get(action) || 0) + 1);
  }
  return [...counts]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
}

/**
 * 根据使用记录生成关键词表：常用的排前面，不足的部分用新手默认补齐。
 * @param {{records?: any[], limit?: number, days?: number, now?: number}} input
 */
export function buildKeywordSet({ records = [], limit = KEYWORD_LIMIT, days = DEFAULT_REVIEW_DAYS, now = Date.now() } = {}) {
  const max = Math.max(1, Math.min(KEYWORD_LIMIT, Number(limit) || KEYWORD_LIMIT));
  const top = usageByAction(records, days, now);
  const out = [];
  const used = new Set();
  for (const { action } of top) {
    const phrase = ACTION_PHRASES[action];
    if (!phrase || used.has(action)) continue;
    used.add(action);
    out.push({ phrase, action });
    if (out.length >= max) break;
  }
  for (const item of STARTER_KEYWORDS) {
    if (out.length >= max) break;
    if (used.has(item.action)) continue;
    used.add(item.action);
    out.push({ ...item });
  }
  return out;
}

/** 是否到了重排关键词的时候：满了周期，或最近一周用得多 */
export function reviewState({ settings, store, now = Date.now() } = {}) {
  const usage = store?.naturalUsage?.() || { records: [], lastReviewAt: 0 };
  const records = Array.isArray(usage.records) ? usage.records : [];
  const weekly = Number(settings?.natural?.weeklyCommands) || DEFAULT_WEEKLY_COMMANDS;
  const reviewWeeks = reviewWeeksOf(settings?.natural);
  const reviewDays = reviewWeeks * WEEK_DAYS;
  const weekCount = countSince(records, WEEK_DAYS, now);
  const lastReviewAt = Number(usage.lastReviewAt) || 0;
  const daysSince = lastReviewAt ? (Number(now) - lastReviewAt) / 86_400_000 : 0;
  let reason = '';
  if (lastReviewAt && daysSince >= reviewDays) reason = 'period';
  else if (weekCount >= weekly) reason = 'volume';
  return {
    due: !!reason,
    reason,
    weekCount,
    weekly,
    reviewWeeks,
    maxWeeks: MAX_REVIEW_WEEKS,
    reviewDays,
    daysSince: Math.floor(daysSince),
    lastReviewAt,
    total: records.length,
  };
}

/**
 * 到点就重排关键词。返回 {reviewed, keywords, reason, weekCount, topped}
 * 首次使用（从未记录过重排时间）时只“起算”，避免新装当天就把默认词换掉。
 */
export function maybeReviewKeywords({ settings, store, now = Date.now() } = {}) {
  const state = reviewState({ settings, store, now });
  const usage = store?.naturalUsage?.() || { records: [], lastReviewAt: 0 };
  if (!state.lastReviewAt) {
    store?.touchNaturalReview?.(now);
    return { reviewed: false, started: true, ...state };
  }
  if (!state.due) return { reviewed: false, ...state };
  const keywords = buildKeywordSet({
    records: usage.records,
    limit: keywordLimitOf(settings),
    days: Math.max(WEEK_DAYS, reviewWeeksOf(settings?.natural) * WEEK_DAYS),
    now,
  });
  return { reviewed: true, keywords, topped: usageByAction(usage.records, WEEK_DAYS, now).slice(0, 3), ...state };
}

/**
 * 关键词兜底匹配：只用来在 AI 失败时决定“这句话最像哪个动作”。
 * @returns {{action: string, phrase: string}|null}
 */
export function matchKeyword(text, keywords = STARTER_KEYWORDS) {
  const plain = normalizePhrase(text);
  if (!plain) return null;
  let best = null;
  for (const item of Array.isArray(keywords) ? keywords : []) {
    const phrase = normalizePhrase(item?.phrase);
    if (!phrase || phrase.length < 2) continue;
    if (!plain.includes(phrase)) continue;
    if (!best || phrase.length > normalizePhrase(best.phrase).length) best = item;
  }
  return best ? { action: String(best.action), phrase: String(best.phrase) } : null;
}

export default {
  KEYWORD_LIMIT,
  STARTER_KEYWORDS,
  ACTION_PHRASES,
  DEFAULT_REVIEW_WEEKS,
  MAX_REVIEW_WEEKS,
  DEFAULT_REVIEW_DAYS,
  DEFAULT_WEEKLY_COMMANDS,
  reviewWeeksOf,
  normalizeKeywords,
  currentKeywords,
  keywordLimitOf,
  buildKeywordSet,
  reviewState,
  maybeReviewKeywords,
  matchKeyword,
  usageByAction,
  countSince,
};
