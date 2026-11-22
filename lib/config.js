/** Cordis 配置 schema 与“面板设置”的合并 / 校验 / 兜底逻辑。 */
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_SETTINGS } from './defaults.js';

/**
 * dsh 宿主读取的最小配置。其余业务设置保存在插件自己的数据目录里，
 * 由 Web 面板读写（这样改规则不需要重新加载插件）。
 */
export const Config = Schema.object({
  settingsNs: Schema.string().default('qqbot-guard').description('设置命名空间（多实例隔离用）'),
  appId: Schema.string().default('').description('QQ 机器人 AppID（留空则在面板里填写）'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret（留空则在面板里填写）'),
  dataDir: Schema.string().default('').description('数据目录（留空则使用 DSH_HOME/qqbot-guard/<profile>/<ns>）'),
});

/** 深合并一层（对象递归，数组整体替换；与面板语义一致）。 */
export function mergeSettings(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (!base || typeof base !== 'object' || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlain(value) && isPlain(current)) out[key] = mergeSettings(current, value);
    else out[key] = value;
  }
  return out;
}

function isPlain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v, fallback, maxLen = 2000) {
  if (typeof v !== 'string') return fallback;
  return v.slice(0, maxLen);
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function int(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function strList(v, fallback, maxItems = 500, maxLen = 200) {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().slice(0, maxLen);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function enumOf(v, fallback, allowed) {
  return allowed.includes(v) ? v : fallback;
}

/**
 * 用默认值作为模板，把任意输入校正成合法设置。
 * 非法字段不会让整个设置失效：会被替换为默认值，并收集到 errors 里返回给面板。
 * @param {unknown} input
 * @returns {{value: typeof DEFAULT_SETTINGS, errors: string[]}}
 */
export function normalizeSettings(input) {
  const errors = [];
  const src = isPlain(input) ? input : {};
  const d = DEFAULT_SETTINGS;
  const m = isPlain(src.moderation) ? src.moderation : {};
  const spam = isPlain(m.spam) ? m.spam : {};
  const esc = isPlain(m.escalation) ? m.escalation : {};
  const join = isPlain(src.join) ? src.join : {};
  const welcome = isPlain(join.welcome) ? join.welcome : {};
  const ann = isPlain(src.announcements) ? src.announcements : {};
  const ui = isPlain(src.ui) ? src.ui : {};

  if (src.appId !== undefined && typeof src.appId !== 'string') errors.push('appId 必须是字符串');
  if (src.appSecret !== undefined && typeof src.appSecret !== 'string') errors.push('appSecret 必须是字符串');

  const value = {
    appId: str(src.appId, d.appId, 200).trim(),
    appSecret: str(src.appSecret, d.appSecret, 500).trim(),
    autoConnect: bool(src.autoConnect, d.autoConnect),
    watchJoinRequests: bool(src.watchJoinRequests, d.watchJoinRequests),
    groupInfoTtlMs: int(src.groupInfoTtlMs, d.groupInfoTtlMs, 60_000, 24 * 3600_000),
    moderation: {
      enabled: bool(m.enabled, d.moderation.enabled),
      action: enumOf(m.action, d.moderation.action, ['warn', 'mute', 'kick']),
      muteSeconds: int(m.muteSeconds, d.moderation.muteSeconds, 0, 30 * 24 * 3600),
      cooldownSec: int(m.cooldownSec, d.moderation.cooldownSec, 0, 24 * 3600),
      warnTemplate: str(m.warnTemplate, d.moderation.warnTemplate),
      keywords: strList(m.keywords, d.moderation.keywords),
      regexes: strList(m.regexes, d.moderation.regexes, 100, 500),
      detectLinks: bool(m.detectLinks, d.moderation.detectLinks),
      linkWhitelist: strList(m.linkWhitelist, d.moderation.linkWhitelist, 100, 100),
      spam: {
        enabled: bool(spam.enabled, d.moderation.spam.enabled),
        windowSec: int(spam.windowSec, d.moderation.spam.windowSec, 1, 600),
        maxMessages: int(spam.maxMessages, d.moderation.spam.maxMessages, 2, 100),
      },
      escalation: {
        enabled: bool(esc.enabled, d.moderation.escalation.enabled),
        violations: int(esc.violations, d.moderation.escalation.violations, 1, 100),
        windowHours: int(esc.windowHours, d.moderation.escalation.windowHours, 1, 720),
        action: enumOf(esc.action, d.moderation.escalation.action, ['warn', 'mute', 'kick']),
      },
      exemptGroups: strList(m.exemptGroups, d.moderation.exemptGroups, 500, 64),
    },
    join: {
      autoApprove: bool(join.autoApprove, d.join.autoApprove),
      autoDeclineRisk: bool(join.autoDeclineRisk, d.join.autoDeclineRisk),
      approveKeywords: strList(join.approveKeywords, d.join.approveKeywords, 100, 100),
      declineKeywords: strList(join.declineKeywords, d.join.declineKeywords, 100, 100),
      welcome: {
        enabled: bool(welcome.enabled, d.join.welcome.enabled),
        template: str(welcome.template, d.join.welcome.template),
        variants: strList(welcome.variants, d.join.welcome.variants, 20, 2000),
        seedSalt: str(welcome.seedSalt, d.join.welcome.seedSalt, 100),
      },
    },
    announcements: {
      enabled: bool(ann.enabled, d.announcements.enabled),
      defaultTargets: strList(ann.defaultTargets, d.announcements.defaultTargets, 500, 64),
    },
    ui: {
      notice: str(ui.notice, d.ui.notice, 1000),
    },
  };

  // 正则先编译一遍：坏正则会在这里被剔除，避免运行期反复抛错。
  const goodRegex = [];
  for (const pattern of value.moderation.regexes) {
    try {
      new RegExp(pattern, 'iu');
      goodRegex.push(pattern);
    } catch {
      errors.push(`正则无效，已忽略：${pattern}`);
    }
  }
  value.moderation.regexes = goodRegex;

  return { value, errors };
}

/** 读取配置时的安全兜底：任何异常都退回默认值。 */
export function safeNormalize(input) {
  try {
    const r = normalizeSettings(input);
    return r.value;
  } catch {
    return normalizeSettings({}).value;
  }
}
