/** 违规防护：本地词表/正则/模糊变体/图片广告/观察期 + 降级执行链（全程不调用模型）。 */
import { CONFIDENCE, FUZZY_ALIASES, LIMITS, RULE_ID } from './defaults.js';
import { effectiveJoin, effectiveModeration } from './config.js';
import { mention } from './qq-api.js';

/** 去掉 @、表情标签、零宽字符，便于匹配 */
export function sanitizeContent(text) {
  return String(text || '')
    .replace(/<qqbot-at-user[^>]*\/>/giu, ' ')
    .replace(/<@!?[A-Za-z0-9_-]+>/gu, ' ')
    .replace(/<emoji:[^>]+>/giu, ' ')
    .replace(/<#\d+>/gu, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalize(text) {
  return sanitizeContent(text).toLowerCase();
}

/** 模糊归一化：全角转半角、去掉所有分隔符与符号，只留字母/数字/汉字 */
export function normalizeFuzzy(text) {
  return normalize(text).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** ASCII 短词需要词边界，避免 sb 命中普通英文单词内部 */
function asciiTokenHit(text, token) {
  const t = String(token || '').toLowerCase();
  if (!/^[a-z0-9]+$/u.test(t)) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'iu').test(text);
}

/** 解析“别名=标准词”格式的额外模糊规则 */
function parseExtras(extras) {
  const out = [];
  for (const raw of Array.isArray(extras) ? extras : []) {
    const [from, to] = String(raw || '').split('=').map((x) => x.trim());
    if (from && to) out.push({ from, to });
  }
  return out;
}

/** 是否命中模糊变体（只在标准词仍在词表里时生效） */
function fuzzyHits(text, moderation) {
  if (!moderation?.fuzzy?.enabled) return [];
  const compact = normalizeFuzzy(text);
  if (!compact) return [];
  const keywords = new Set((moderation.keywords || []).map((x) => String(x).toLowerCase()));
  const hits = [];
  const push = (canonical, alias) => {
    if (!keywords.has(String(canonical).toLowerCase())) return;
    if (hits.some((x) => x.pattern === canonical)) return;
    hits.push({ ruleId: RULE_ID.fuzzy, pattern: `${canonical}（变体：${alias}）`, confidence: CONFIDENCE.fuzzy });
  };
  for (const group of FUZZY_ALIASES) {
    if (!keywords.has(group.canonical.toLowerCase())) continue;
    for (const alias of group.aliases) {
      const a = alias.toLowerCase();
      const hit = /^[a-z0-9]+$/u.test(a) ? asciiTokenHit(text.toLowerCase(), a) : compact.includes(normalizeFuzzy(a));
      if (hit) {
        push(group.canonical, alias);
        break;
      }
    }
  }
  for (const { from, to } of parseExtras(moderation.fuzzy.extras)) {
    const hit = /^[a-z0-9]+$/u.test(from.toLowerCase())
      ? asciiTokenHit(text.toLowerCase(), from.toLowerCase())
      : compact.includes(normalizeFuzzy(from));
    if (hit) push(to, from);
  }
  return hits;
}

/** 链接检测：提取域名并与白名单比对 */
export function findUnsafeLink(text, whitelist) {
  const list = Array.isArray(whitelist) ? whitelist : [];
  const urls = String(text || '').match(/(?:https?:\/\/|www\.)[^\s<>"']+/giu) || [];
  for (const raw of urls) {
    let host = '';
    try {
      host = new URL(/^www\./iu.test(raw) ? 'http://' + raw : raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    const allowed = list.some((domain) => {
      const d = String(domain || '').trim().toLowerCase();
      return d && (host === d || host.endsWith('.' + d));
    });
    if (!allowed) return { url: raw, host };
  }
  return null;
}

/**
 * 规则匹配（纯函数，便于单测与复现）。
 * @param {string} text 原始消息
 * @param {object} moderation 生效的违规设置
 * @param {{spamCount?: number, hasImage?: boolean, hasCard?: boolean, observed?: boolean, observation?: object}} [extra]
 */
export function matchRules(text, moderation, extra = {}) {
  const clean = normalize(text);
  const hits = [];
  if (moderation?.media?.detectCards && extra.hasCard) {
    hits.push({ ruleId: RULE_ID.media, pattern: '卡片/名片消息', confidence: CONFIDENCE.media, action: moderation.action });
  }
  if (moderation?.media?.detectImages && extra.hasImage) {
    const adHit = (moderation.media.adKeywords || []).find((w) => clean.includes(String(w || '').toLowerCase()));
    if (adHit) {
      hits.push({
        ruleId: RULE_ID.media, pattern: `图片广告（${adHit}）`, confidence: CONFIDENCE.media, action: moderation.action,
      });
    } else if (extra.observed && extra.observation?.blockImages) {
      hits.push({
        ruleId: RULE_ID.observe, pattern: '观察期内发送图片', confidence: CONFIDENCE.observe,
        action: extra.observation.action,
      });
    }
  }
  const link = findUnsafeLink(clean, moderation.linkWhitelist);
  if (link && (moderation.detectLinks || (extra.observed && extra.observation?.blockLinks))) {
    hits.push({
      ruleId: extra.observed && extra.observation?.blockLinks ? RULE_ID.observe : RULE_ID.link,
      pattern: extra.observed && extra.observation?.blockLinks ? `观察期内发送链接 ${link.host}` : link.host,
      confidence: extra.observed ? CONFIDENCE.observe : CONFIDENCE.link,
      action: extra.observed && extra.observation?.blockLinks ? extra.observation.action : moderation.action,
    });
  }
  if (!clean) return hits;

  for (const word of moderation.keywords || []) {
    const w = String(word || '').trim().toLowerCase();
    if (!w) continue;
    let hit;
    if (/^[a-z0-9]+$/u.test(w) && w.length <= 4) {
      hit = asciiTokenHit(clean, w);
    } else if (moderation.fuzzy?.enabled && normalizeFuzzy(w).length >= 2) {
      hit = normalizeFuzzy(text).includes(normalizeFuzzy(w));
    } else {
      hit = clean.includes(w);
    }
    if (hit) {
      hits.push({ ruleId: RULE_ID.keyword, pattern: word, confidence: CONFIDENCE.keyword, action: moderation.action });
    }
  }
  for (const pattern of moderation.regexes || []) {
    try {
      const re = new RegExp(pattern, 'iu');
      if (re.test(clean)) {
        hits.push({ ruleId: RULE_ID.regex, pattern, confidence: CONFIDENCE.regex, action: moderation.action });
      }
    } catch {
      // 装载时已剔除坏正则；这里是双保险
    }
  }
  for (const hit of fuzzyHits(text, moderation)) hits.push({ ...hit, action: moderation.action });
  if (moderation.spam?.enabled) {
    const threshold = extra.observed
      ? Math.max(2, Math.floor(Number(moderation.spam.maxMessages || 2) / 2))
      : Number(moderation.spam.maxMessages || 0);
    if (Number(extra.spamCount || 0) >= threshold) {
      hits.push({
        ruleId: RULE_ID.spam,
        pattern: `${extra.spamCount} 条 / ${moderation.spam.windowSec}s${extra.observed ? '（观察期）' : ''}`,
        confidence: CONFIDENCE.spam,
        action: extra.observed ? extra.observation?.action || moderation.action : moderation.action,
      });
    }
  }
  return hits;
}

/**
 * 决定动作：基础动作 + 升权（多次违规）。
 * @returns {{hit: boolean, ruleId?: string, pattern?: string, confidence: number, action: string, reason: string}}
 */
export function decideAction(hits, priorViolations, moderation) {
  if (!hits.length) {
    return { hit: false, confidence: 0, action: 'none', reason: '未命中规则' };
  }
  const top = hits[0];
  let action = top.action || moderation.action;
  let reason = `命中${labelOf(top.ruleId)}：${top.pattern}`;
  const esc = moderation.escalation;
  if (esc?.enabled && Number(priorViolations) + 1 >= Number(esc.violations || Infinity)) {
    action = esc.action;
    reason += `；窗口内已第 ${Number(priorViolations) + 1} 次违规，升级处理`;
  }
  return { hit: true, ruleId: top.ruleId, pattern: top.pattern, confidence: top.confidence, action, reason };
}

function labelOf(ruleId) {
  return {
    keyword: '违规词',
    regex: '正则规则',
    link: '可疑链接',
    spam: '刷屏规则',
    fuzzy: '模糊变体',
    media: '图片/卡片',
    observe: '观察期规则',
  }[ruleId] || '规则';
}

/** 从消息内容里提取被 @ 的 openid（兼容官方两种标签） */
export function findMentionUid(text) {
  const s = String(text || '');
  let m = s.match(/<qqbot-at-user[^>]*\bid=["']([^"']+)["'][^>]*\/>/u);
  if (m) return m[1];
  m = s.match(/<@!?([^>]+)>/u);
  return m ? m[1].trim() : '';
}

/** 解析指令时长：10m / 1h / 30s / 600 */
export function parseDuration(text, fallbackSec = 600) {
  const m = String(text || '').match(/(\d+)\s*(m|min|分钟|h|小时|s|秒)?/iu);
  if (!m) return Math.max(1, Number(fallbackSec) || 600);
  const n = Number(m[1]);
  const unit = String(m[2] || 's').toLowerCase();
  if (['m', 'min', '分钟'].includes(unit)) return n * 60;
  if (['h', '小时'].includes(unit)) return n * 3600;
  return n;
}

/** 刷屏计数器（内存级，按群+用户；超过上限整体清理最旧的一半） */
export class SpamWindow {
  constructor() {
    this.map = new Map();
  }

  note(key, windowMs, now = Date.now()) {
    const list = (this.map.get(key) || []).filter((t) => now - t <= windowMs);
    list.push(now);
    this.map.set(key, list);
    if (this.map.size > LIMITS.violationUsers) {
      const keys = [...this.map.keys()];
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.map.delete(k);
    }
    return list.length;
  }

  forget(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

export class Moderation {
  /**
   * @param {{store: import('./store.js').Store, getClient: () => import('./qq-api.js').QQClient|undefined, logger: Console}} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.getClient = deps.getClient;
    this.logger = deps.logger || console;
    this.spam = new SpamWindow();
    this.lastActionAt = new Map();
  }

  /** 冷却检查：0 表示不限制 */
  cooldownOk(key, cooldownSec, now = Date.now()) {
    const gap = Math.max(0, Number(cooldownSec) || 0) * 1000;
    if (!gap) return true;
    const last = this.lastActionAt.get(key) || 0;
    if (now - last < gap) return false;
    this.lastActionAt.set(key, now);
    if (this.lastActionAt.size > LIMITS.violationUsers) {
      const keys = [...this.lastActionAt.keys()];
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.lastActionAt.delete(k);
    }
    return true;
  }

  /**
   * 处理一条群消息。
   * @param {{gid: string, uid: string, name?: string, text: string, msgId?: string, hasImage?: boolean, hasCard?: boolean}} input
   * @returns {Promise<{handled: boolean, action?: string, ruleId?: string, confidence?: number, error?: string}>}
   */
  async handleMessage(input) {
    if (!input.gid || !input.uid) return { handled: false };
    const settings = this.store.settings;

    const command = await this.handleCommand(input, settings);
    if (command.handled) return command;

    const mod = effectiveModeration(settings, input.gid);
    if (!mod.enabled) return { handled: false };
    if ((mod.exemptGroups || []).includes(input.gid)) return { handled: false };
    if (this.isTrusted(mod, input.uid)) return { handled: false, reason: 'trusted' };

    const joinCfg = effectiveJoin(settings, input.gid);
    const observed = !!joinCfg.observation?.enabled && this.store.isObserved(input.gid, input.uid);
    const observation = observed ? joinCfg.observation : null;

    const key = input.gid + '|' + input.uid;
    const spamWindowMs = Math.max(1, Number(mod.spam?.windowSec || 1)) * 1000;
    const spamCount = (mod.spam?.enabled || observed) ? this.spam.note(key, spamWindowMs) : 0;
    const hits = matchRules(input.text, mod, {
      spamCount,
      hasImage: !!input.hasImage,
      hasCard: !!input.hasCard,
      observed,
      observation,
    });
    const prior = this.store.countViolations(input.gid, input.uid, Math.max(1, Number(mod.escalation?.windowHours || 24)) * 3600_000);
    const decision = decideAction(hits, prior, mod);
    if (!decision.hit) return { handled: false };
    if (!this.cooldownOk(key, mod.cooldownSec)) {
      return { handled: true, action: 'cooldown', ruleId: decision.ruleId, confidence: decision.confidence };
    }

    // 违规累计达到阈值 → 强制踢出并拉黑
    let blacklist = false;
    if (mod.blacklist?.enabled) {
      const windowMs = Math.max(1, Number(mod.blacklist.windowDays || 7)) * 86400_000;
      const count = this.store.countViolations(input.gid, input.uid, windowMs) + 1;
      if (count >= Number(mod.blacklist.threshold || 3) && !this.store.isBlacklisted(input.gid, input.uid)) {
        decision.action = 'kick';
        decision.reason += `；累计违规 ${count} 次，触发黑名单`;
        decision.ruleId = RULE_ID.escalation;
        decision.confidence = Math.max(decision.confidence, CONFIDENCE.manual);
        blacklist = true;
      }
    }

    this.store.noteViolation(input.gid, input.uid);
    this.store.incCounter('blocked');
    const client = this.getClient();
    if (!client) {
      if (blacklist) {
        this.store.addBlacklist(input.gid, input.uid, {
          name: input.name, reason: decision.reason, by: 'auto',
        });
      }
      this.store.appendAudit({
        kind: 'moderation', action: decision.action, groupId: input.gid, userId: input.uid,
        userName: input.name, detail: decision.reason + '（机器人未连接，仅记录）',
        ok: false, code: 'NOT_CONNECTED', confidence: decision.confidence,
      });
      return { handled: true, action: 'record-only', ruleId: decision.ruleId, confidence: decision.confidence };
    }

    const result = await this.execute(client, decision, input, mod, { addToBlacklist: blacklist });
    if (blacklist && result.ok) {
      this.store.addBlacklist(input.gid, input.uid, {
        name: input.name, reason: decision.reason, by: 'auto',
      });
    }
    this.store.appendAudit({
      kind: 'moderation',
      action: result.action,
      groupId: input.gid,
      groupName: this.store.state.groups[input.gid]?.name || '',
      userId: input.uid,
      userName: input.name || '',
      detail: decision.reason + (result.degraded ? `（原动作 ${decision.action} 失败，已降级：${result.error || ''}）` : ''),
      ok: result.ok,
      code: result.error || '',
      confidence: decision.confidence,
    });
    return {
      handled: true,
      action: result.action,
      ruleId: decision.ruleId,
      confidence: decision.confidence,
      error: result.error,
    };
  }

  /** 信任成员：豁免处置，同时允许使用群指令 */
  isTrusted(mod, uid) {
    return (mod?.trustedUsers || []).some((x) => String(x.uid) === String(uid));
  }

  /**
   * 群内管理员指令：/warn /mute /kick /rule /help
   * 只有 commands.allowUsers 或信任成员可用；其他人发指令会被当成普通消息。
   */
  async handleCommand(input, settings) {
    const cfg = settings.commands;
    if (!cfg?.enabled) return { handled: false };
    const prefix = String(cfg.prefix || '/');
    const text = String(input.text || '').trim();
    if (!text.startsWith(prefix)) return { handled: false };
    const groupMod = effectiveModeration(settings, input.gid);
    const allowed = new Set([
      ...(cfg.allowUsers || []).map(String),
      ...((settings.moderation?.trustedUsers || []).map((x) => String(x.uid))),
      ...((groupMod.trustedUsers || []).map((x) => String(x.uid))),
    ]);
    if (!allowed.has(String(input.uid))) return { handled: false };

    const client = this.getClient();
    if (!client) return { handled: false };

    const body = text.slice(prefix.length).trim();
    const [rawCmd, ...rest] = body.split(/\s+/u);
    const cmd = String(rawCmd || '').toLowerCase();
    const args = rest.join(' ');
    const target = findMentionUid(text);
    const mod = effectiveModeration(settings, input.gid);
    const reply = (content) => client.sendGroupText(input.gid, content, { msgId: input.msgId });

    if (cmd === 'help') {
      await reply([
        '可用指令：',
        `${prefix}warn @成员 [原因]`,
        `${prefix}mute 10m @成员`,
        `${prefix}kick @成员`,
        `${prefix}rule 查看群规`,
      ].join('\n'));
      return { handled: true, action: 'command', ruleId: RULE_ID.command, confidence: 1 };
    }
    if (cmd === 'rule') {
      await reply(String(cfg.ruleText || '暂无群规').slice(0, LIMITS.warnMaxChars));
      return { handled: true, action: 'command', ruleId: RULE_ID.command, confidence: 1 };
    }
    if (!['warn', 'mute', 'kick'].includes(cmd)) return { handled: false };
    if (!target) {
      await reply(`用法：${prefix}${cmd} ${cmd === 'mute' ? '10m ' : ''}@成员`);
      return { handled: true, action: 'command', ruleId: RULE_ID.command, confidence: 1 };
    }
    if (target === input.uid) {
      await reply('不能对自己执行该指令。');
      return { handled: true, action: 'command', ruleId: RULE_ID.command, confidence: 1 };
    }

    let result;
    if (cmd === 'warn') {
      const reason = args.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim() || '违反群规';
      result = await reply(`${mention(target)} 警告：${reason.slice(0, LIMITS.warnMaxChars)}`);
    } else if (cmd === 'mute') {
      const seconds = parseDuration(args, mod.muteSeconds);
      result = await client.setMemberMute(input.gid, target, seconds);
    } else {
      result = await client.removeMembers(input.gid, [target]);
    }
    const ok = !!result?.ok;
    this.store.appendAudit({
      kind: 'command',
      action: cmd,
      groupId: input.gid,
      groupName: this.store.state.groups[input.gid]?.name || '',
      userId: input.uid,
      userName: input.name || '',
      detail: `指令 ${cmd} 目标 ${target}${ok ? '' : `；失败：${result?.err?.human || ''}`}`,
      ok,
      code: ok ? '' : result?.err?.code || '',
      confidence: 1,
    });
    if (!ok) {
      await reply(`操作失败：${result?.err?.human || '请稍后重试'}`);
    }
    return {
      handled: true,
      action: `command-${cmd}`,
      ruleId: RULE_ID.command,
      confidence: 1,
      error: ok ? undefined : result?.err?.code,
    };
  }

  /** 按 warn → mute → kick 的降级链执行；任何一步失败都不会抛异常 */
  async execute(client, decision, input, mod, opts = {}) {
    const wanted = decision.action;
    if (wanted === 'warn') {
      return this.warn(client, input, decision, false, mod);
    }
    if (wanted === 'mute') {
      const r = await client.setMemberMute(input.gid, input.uid, mod.muteSeconds);
      if (r.ok) {
        this.store.incCounter('mutes');
        return { ok: true, action: 'mute' };
      }
      const w = await this.warn(client, input, decision, true, mod);
      return { ...w, degraded: true, error: r.err?.code || 'MUTE_FAILED' };
    }
    // kick
    const r = await client.removeMembers(input.gid, [input.uid], !!opts.addToBlacklist);
    if (r.ok) {
      this.store.incCounter('kicks');
      this.spam.forget(input.gid + '|' + input.uid);
      return { ok: true, action: 'kick' };
    }
    const mute = await client.setMemberMute(input.gid, input.uid, mod.muteSeconds);
    if (mute.ok) {
      this.store.incCounter('mutes');
      return { ok: true, action: 'mute', degraded: true, error: r.err?.code || 'KICK_FAILED' };
    }
    const w = await this.warn(client, input, decision, true, mod);
    return { ...w, degraded: true, error: r.err?.code || 'KICK_FAILED' };
  }

  async warn(client, input, decision, degraded, mod) {
    const groupName = this.store.state.groups[input.gid]?.name || '本群';
    const text = String(mod.warnTemplate || '')
      .replace(/\{user\}/gu, mention(input.uid))
      .replace(/\{group\}/gu, groupName)
      .replace(/\{rule\}/gu, decision.pattern || '群规')
      .slice(0, LIMITS.warnMaxChars);
    const r = await client.sendGroupText(input.gid, text, { msgId: input.msgId });
    if (r.ok) {
      this.store.incCounter('warns');
      return { ok: true, action: 'warn', degraded };
    }
    return { ok: false, action: 'warn', degraded, error: r.err?.code || 'WARN_FAILED' };
  }

  reset() {
    this.spam.clear();
    this.lastActionAt.clear();
  }
}
