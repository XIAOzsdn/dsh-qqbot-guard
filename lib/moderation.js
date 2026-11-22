/** 违规防护：本地词表/正则/刷屏检测 + 降级执行链（全程不调用模型）。 */
import { CONFIDENCE, LIMITS, RULE_ID } from './defaults.js';
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
 * @param {object} moderation 设置里的 moderation 段
 * @param {{spamCount?: number}} [extra]
 */
export function matchRules(text, moderation, extra = {}) {
  const clean = normalize(text);
  const hits = [];
  if (!clean) return hits;

  for (const word of moderation.keywords || []) {
    const w = String(word || '').trim().toLowerCase();
    if (w && clean.includes(w)) hits.push({ ruleId: RULE_ID.keyword, pattern: word, confidence: CONFIDENCE.keyword });
  }
  for (const pattern of moderation.regexes || []) {
    try {
      const re = new RegExp(pattern, 'iu');
      if (re.test(clean)) hits.push({ ruleId: RULE_ID.regex, pattern, confidence: CONFIDENCE.regex });
    } catch {
      // 装载时已剔除坏正则；这里是双保险
    }
  }
  if (moderation.detectLinks) {
    const link = findUnsafeLink(clean, moderation.linkWhitelist);
    if (link) hits.push({ ruleId: RULE_ID.link, pattern: link.host, confidence: CONFIDENCE.link });
  }
  if (moderation.spam?.enabled && Number(extra.spamCount || 0) >= Number(moderation.spam.maxMessages || 0)) {
    hits.push({
      ruleId: RULE_ID.spam,
      pattern: `${extra.spamCount} 条 / ${moderation.spam.windowSec}s`,
      confidence: CONFIDENCE.spam,
    });
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
  let action = moderation.action;
  let reason = `命中${labelOf(top.ruleId)}：${top.pattern}`;
  const esc = moderation.escalation;
  if (esc?.enabled && Number(priorViolations) + 1 >= Number(esc.violations || Infinity)) {
    action = esc.action;
    reason += `；窗口内已第 ${Number(priorViolations) + 1} 次违规，升级处理`;
  }
  return { hit: true, ruleId: top.ruleId, pattern: top.pattern, confidence: top.confidence, action, reason };
}

function labelOf(ruleId) {
  return { keyword: '违规词', regex: '正则规则', link: '可疑链接', spam: '刷屏规则' }[ruleId] || '规则';
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
   * @param {{gid: string, uid: string, name?: string, text: string, msgId?: string}} input
   * @returns {Promise<{handled: boolean, action?: string, ruleId?: string, confidence?: number, error?: string}>}
   */
  async handleMessage(input) {
    const settings = this.store.settings;
    const mod = settings.moderation;
    if (!mod.enabled) return { handled: false };
    if (!input.gid || !input.uid) return { handled: false };
    if ((mod.exemptGroups || []).includes(input.gid)) return { handled: false };

    const key = input.gid + '|' + input.uid;
    const spamWindowMs = Math.max(1, Number(mod.spam?.windowSec || 1)) * 1000;
    const spamCount = mod.spam?.enabled ? this.spam.note(key, spamWindowMs) : 0;
    const hits = matchRules(input.text, mod, { spamCount });
    const prior = this.store.countViolations(input.gid, input.uid, Math.max(1, Number(mod.escalation?.windowHours || 24)) * 3600_000);
    const decision = decideAction(hits, prior, mod);
    if (!decision.hit) return { handled: false };
    if (!this.cooldownOk(key, mod.cooldownSec)) {
      return { handled: true, action: 'cooldown', ruleId: decision.ruleId, confidence: decision.confidence };
    }

    this.store.noteViolation(input.gid, input.uid);
    this.store.incCounter('blocked');
    const client = this.getClient();
    if (!client) {
      this.store.appendAudit({
        kind: 'moderation', action: decision.action, groupId: input.gid, userId: input.uid,
        userName: input.name, detail: decision.reason + '（机器人未连接，仅记录）',
        ok: false, code: 'NOT_CONNECTED', confidence: decision.confidence,
      });
      return { handled: true, action: 'record-only', ruleId: decision.ruleId, confidence: decision.confidence };
    }

    const result = await this.execute(client, decision, input, mod);
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

  /** 按 warn → mute → kick 的降级链执行；任何一步失败都不会抛异常 */
  async execute(client, decision, input, mod) {
    const wanted = decision.action;
    if (wanted === 'warn') {
      return this.warn(client, input, decision, false);
    }
    if (wanted === 'mute') {
      const r = await client.setMemberMute(input.gid, input.uid, mod.muteSeconds);
      if (r.ok) {
        this.store.incCounter('mutes');
        return { ok: true, action: 'mute' };
      }
      const w = await this.warn(client, input, decision, true);
      return { ...w, degraded: true, error: r.err?.code || 'MUTE_FAILED' };
    }
    // kick
    const r = await client.removeMembers(input.gid, [input.uid]);
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
    const w = await this.warn(client, input, decision, true);
    return { ...w, degraded: true, error: r.err?.code || 'KICK_FAILED' };
  }

  async warn(client, input, decision, degraded) {
    const mod = this.store.settings.moderation;
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
