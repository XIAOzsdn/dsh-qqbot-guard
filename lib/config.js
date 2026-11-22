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

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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

/** 信任成员列表：[{uid, name, note}] */
function trustedList(v, fallback) {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    const item = isPlain(raw) ? raw : {};
    const uid = String(item.uid || '').trim().slice(0, 128);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      uid,
      name: String(item.name || '').trim().slice(0, 100),
      note: String(item.note || '').trim().slice(0, 200),
    });
    if (out.length >= 500) break;
  }
  return out;
}

/** 入群答题题目：[{q, a}] */
function questionList(v, fallback) {
  if (!Array.isArray(v)) return fallback;
  const out = [];
  for (const raw of v) {
    const item = isPlain(raw) ? raw : {};
    const q = String(item.q || '').trim().slice(0, 500);
    const a = String(item.a || '').trim().slice(0, 200);
    if (!q || !a) continue;
    out.push({ q, a });
    if (out.length >= 50) break;
  }
  return out;
}

/** 按群覆盖：只保留显式写了的字段，并按全局默认值归一化 */
function normalizeGroupOverride(raw) {
  const src = isPlain(raw) ? raw : {};
  const out = {};
  const modFull = normalizeSettings({ moderation: src.moderation }).value.moderation;
  if (isPlain(src.moderation)) {
    const picked = pickNormalized(src.moderation, modFull);
    if (Object.keys(picked).length) out.moderation = picked;
  }
  const joinFull = normalizeSettings({ join: src.join }).value.join;
  if (isPlain(src.join)) {
    const picked = pickNormalized(src.join, joinFull);
    if (Object.keys(picked).length) out.join = picked;
  }
  return out;
}

/** 只保留用户显式写了的字段（值已归一化），避免“设为默认值”被误判成继承 */
function pickNormalized(raw, full) {
  if (!isPlain(raw) || !isPlain(full)) return full;
  const out = {};
  for (const key of Object.keys(raw)) {
    if (full[key] === undefined) continue;
    out[key] = isPlain(raw[key]) && isPlain(full[key]) ? pickNormalized(raw[key], full[key]) : full[key];
  }
  return out;
}

function normalizeGroups(raw) {
  if (!isPlain(raw)) return {};
  const out = {};
  let count = 0;
  for (const [gid, value] of Object.entries(raw)) {
    const id = String(gid || '').trim().slice(0, 128);
    if (!id) continue;
    const normalized = normalizeGroupOverride(value);
    if (Object.keys(normalized).length) out[id] = normalized;
    count += 1;
    if (count >= 500) break;
  }
  return out;
}

/** 取某群生效的违规防护配置（全局 + 群覆盖） */
export function effectiveModeration(settings, gid) {
  const base = settings?.moderation || DEFAULT_SETTINGS.moderation;
  const override = gid && settings?.groups?.[gid]?.moderation;
  return override ? mergeSettings(base, override) : base;
}

/** 取某群生效的入群配置（全局 + 群覆盖） */
export function effectiveJoin(settings, gid) {
  const base = settings?.join || DEFAULT_SETTINGS.join;
  const override = gid && settings?.groups?.[gid]?.join;
  return override ? mergeSettings(base, override) : base;
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
  const fuzzy = isPlain(m.fuzzy) ? m.fuzzy : {};
  const media = isPlain(m.media) ? m.media : {};
  const black = isPlain(m.blacklist) ? m.blacklist : {};
  const join = isPlain(src.join) ? src.join : {};
  const welcome = isPlain(join.welcome) ? join.welcome : {};
  const obs = isPlain(join.observation) ? join.observation : {};
  const quiz = isPlain(join.quiz) ? join.quiz : {};
  const cmd = isPlain(src.commands) ? src.commands : {};
  const guest = isPlain(src.guest) ? src.guest : {};
  const panel = isPlain(src.panel) ? src.panel : {};
  const ai = isPlain(src.ai) ? src.ai : {};
  const aiMod = isPlain(ai.moderation) ? ai.moderation : {};
  const aiJoin = isPlain(ai.join) ? ai.join : {};
  const aiSchedule = isPlain(aiJoin.schedule) ? aiJoin.schedule : {};
  const aiVision = isPlain(ai.vision) ? ai.vision : {};
  const aiQuiz = isPlain(ai.quiz) ? ai.quiz : {};
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
      trustedUsers: trustedList(m.trustedUsers, d.moderation.trustedUsers),
      fuzzy: {
        enabled: bool(fuzzy.enabled, d.moderation.fuzzy.enabled),
        extras: strList(fuzzy.extras, d.moderation.fuzzy.extras, 200, 200),
      },
      media: {
        detectImages: bool(media.detectImages, d.moderation.media.detectImages),
        detectCards: bool(media.detectCards, d.moderation.media.detectCards),
        adKeywords: strList(media.adKeywords, d.moderation.media.adKeywords, 200, 50),
      },
      blacklist: {
        enabled: bool(black.enabled, d.moderation.blacklist.enabled),
        threshold: int(black.threshold, d.moderation.blacklist.threshold, 1, 100),
        windowDays: int(black.windowDays, d.moderation.blacklist.windowDays, 1, 365),
        addToGroupBlacklist: bool(black.addToGroupBlacklist, d.moderation.blacklist.addToGroupBlacklist),
      },
    },
    join: {
      autoApprove: bool(join.autoApprove, d.join.autoApprove),
      autoDeclineRisk: bool(join.autoDeclineRisk, d.join.autoDeclineRisk),
      approveKeywords: strList(join.approveKeywords, d.join.approveKeywords, 100, 100),
      declineKeywords: strList(join.declineKeywords, d.join.declineKeywords, 100, 100),
      rejectReason: str(join.rejectReason, d.join.rejectReason, 200).trim(),
      welcome: {
        enabled: bool(welcome.enabled, d.join.welcome.enabled),
        template: str(welcome.template, d.join.welcome.template),
        variants: strList(welcome.variants, d.join.welcome.variants, 20, 2000),
        seedSalt: str(welcome.seedSalt, d.join.welcome.seedSalt, 100),
      },
      observation: {
        enabled: bool(obs.enabled, d.join.observation.enabled),
        minutes: int(obs.minutes, d.join.observation.minutes, 0, 1440),
        action: enumOf(obs.action, d.join.observation.action, ['warn', 'mute', 'kick']),
        blockLinks: bool(obs.blockLinks, d.join.observation.blockLinks),
        blockImages: bool(obs.blockImages, d.join.observation.blockImages),
      },
      quiz: {
        enabled: bool(quiz.enabled, d.join.quiz.enabled),
        timeoutSec: int(quiz.timeoutSec, d.join.quiz.timeoutSec, 30, 3600),
        maxAttempts: int(quiz.maxAttempts, d.join.quiz.maxAttempts, 1, 20),
        action: enumOf(quiz.action, d.join.quiz.action, ['warn', 'mute', 'kick']),
        askBeforeWelcome: bool(quiz.askBeforeWelcome, d.join.quiz.askBeforeWelcome),
        questions: questionList(quiz.questions, d.join.quiz.questions),
      },
    },
    announcements: {
      enabled: bool(ann.enabled, d.announcements.enabled),
      defaultTargets: strList(ann.defaultTargets, d.announcements.defaultTargets, 500, 64),
    },
    commands: {
      enabled: bool(cmd.enabled, d.commands.enabled),
      naturalEnabled: bool(cmd.naturalEnabled, d.commands.naturalEnabled),
      followUpSec: int(cmd.followUpSec, d.commands.followUpSec, 0, 600),
      prefix: str(cmd.prefix, d.commands.prefix, 3) || '/',
      allowUsers: strList(cmd.allowUsers, d.commands.allowUsers, 500, 128),
      ruleText: str(cmd.ruleText, d.commands.ruleText, 2000),
    },
    guest: {
      enabled: bool(guest.enabled, d.guest.enabled),
      aiEnabled: bool(guest.aiEnabled, d.guest.aiEnabled),
      perMinute: int(guest.perMinute, d.guest.perMinute, 1, 120),
      cooldownSec: int(guest.cooldownSec, d.guest.cooldownSec, 0, 3600),
      maxInputChars: int(guest.maxInputChars, d.guest.maxInputChars, 20, 2000),
      replyMaxChars: int(guest.replyMaxChars, d.guest.replyMaxChars, 20, 1000),
      maxTokens: int(guest.maxTokens, d.guest.maxTokens, 16, 1000),
      timeoutMs: int(guest.timeoutMs, d.guest.timeoutMs, 1000, 30_000),
      abuseWindowHours: int(guest.abuseWindowHours, d.guest.abuseWindowHours, 1, 720),
      muteSeconds: int(guest.muteSeconds, d.guest.muteSeconds, 0, 86_400),
      emotionalMuteSeconds: int(guest.emotionalMuteSeconds, d.guest.emotionalMuteSeconds, 0, 86_400),
      emotionalMuteText: str(guest.emotionalMuteText, d.guest.emotionalMuteText, 300),
      persona: str(guest.persona, d.guest.persona, 500).trim(),
      guardKeywords: strList(guest.guardKeywords, d.guest.guardKeywords, 200, 50),
      warnText: str(guest.warnText, d.guest.warnText, 300),
      muteText: str(guest.muteText, d.guest.muteText, 300),
      disabledText: str(guest.disabledText, d.guest.disabledText, 300),
      aiOffText: str(guest.aiOffText, d.guest.aiOffText, 300),
      fallbackText: str(guest.fallbackText, d.guest.fallbackText, 200),
      limitText: str(guest.limitText, d.guest.limitText, 200),
    },
    panel: {
      enabled: bool(panel.enabled, d.panel.enabled),
      host: str(panel.host, d.panel.host, 100).trim() || d.panel.host,
      port: int(panel.port, d.panel.port, 0, 65535),
      notifyName: str(panel.notifyName, d.panel.notifyName, 100).trim(),
      notifyOpenid: str(panel.notifyOpenid, d.panel.notifyOpenid, 128).trim(),
    },
    ai: {
      enabled: bool(ai.enabled, d.ai.enabled),
      provider: enumOf(ai.provider, d.ai.provider, ['dsh', 'openai']),
      baseUrl: str(ai.baseUrl, d.ai.baseUrl, 400).trim().replace(/\/+$/u, ''),
      apiKey: str(ai.apiKey, d.ai.apiKey, 500).trim(),
      model: str(ai.model, d.ai.model, 200).trim(),
      timeoutMs: int(ai.timeoutMs, d.ai.timeoutMs, 1000, 60_000),
      maxTokens: int(ai.maxTokens, d.ai.maxTokens, 32, 2000),
      minConfidence: num(ai.minConfidence, d.ai.minConfidence, 0, 1),
      vision: {
        enabled: bool(aiVision.enabled, d.ai.vision.enabled),
        maxImages: int(aiVision.maxImages, d.ai.vision.maxImages, 1, 5),
        maxBytes: int(aiVision.maxBytes, d.ai.vision.maxBytes, 64 * 1024, 8 * 1024 * 1024),
      },
      moderation: {
        enabled: bool(aiMod.enabled, d.ai.moderation.enabled),
        mode: enumOf(aiMod.mode, d.ai.moderation.mode, ['suggest', 'auto']),
        analyzeImages: bool(aiMod.analyzeImages, d.ai.moderation.analyzeImages),
        minChars: int(aiMod.minChars, d.ai.moderation.minChars, 1, 200),
        maxPerMinute: int(aiMod.maxPerMinute, d.ai.moderation.maxPerMinute, 1, 600),
      },
      join: {
        enabled: bool(aiJoin.enabled, d.ai.join.enabled),
        mode: enumOf(aiJoin.mode, d.ai.join.mode, ['suggest', 'auto']),
        schedule: {
          mode: enumOf(aiSchedule.mode, d.ai.join.schedule.mode, ['always', 'day', 'night', 'active']),
          dayStart: int(aiSchedule.dayStart, d.ai.join.schedule.dayStart, 0, 23),
          dayEnd: int(aiSchedule.dayEnd, d.ai.join.schedule.dayEnd, 1, 24),
          idleMinutes: int(aiSchedule.idleMinutes, d.ai.join.schedule.idleMinutes, 1, 1440),
        },
      },
      quiz: {
        enabled: bool(aiQuiz.enabled, d.ai.quiz.enabled),
        mode: enumOf(aiQuiz.mode, d.ai.quiz.mode, ['mixed', 'arithmetic', 'daily']),
        judge: bool(aiQuiz.judge, d.ai.quiz.judge),
        switchAfterFails: int(aiQuiz.switchAfterFails, d.ai.quiz.switchAfterFails, 1, 10),
        allowChange: bool(aiQuiz.allowChange, d.ai.quiz.allowChange),
        maxSwitches: int(aiQuiz.maxSwitches, d.ai.quiz.maxSwitches, 0, 10),
      },
    },
    groups: normalizeGroups(src.groups),
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
