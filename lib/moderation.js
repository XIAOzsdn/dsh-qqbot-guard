/** 违规防护：本地词表/正则/模糊变体/图片广告/观察期 + 降级执行链（全程不调用模型）。 */
import { CONFIDENCE, FUZZY_ALIASES, LIMITS, RULE_ID } from './defaults.js';
import { effectiveJoin, effectiveModeration } from './config.js';
import { mention } from './qq-api.js';
import { handleNaturalCommand } from './natural.js';
import { handleGuestMessage, classifyGuestIntent } from './guest.js';
import { readDeviceInfo, formatDeviceInfo } from './device.js';
import { formatBalanceText } from './ai.js';

/** 指令别名：中英文与常见说法都能触发 */
const COMMAND_ALIASES = Object.freeze({
  device: 'device', 设备: 'device', 设备信息: 'device', 信息: 'device', 状态: 'device', 主机: 'device',
  sysinfo: 'device', status: 'device',
  balance: 'balance', 余额: 'balance', api: 'balance', api余额: 'balance', apibalance: 'balance',
  额度: 'balance', 余额查询: 'balance', 剩余额度: 'balance', 钱包: 'balance', quota: 'balance',
  credits: 'balance',
  restart: 'restart', 重启: 'restart', 重载: 'restart', reboot: 'restart', reload: 'restart',
  confirm: 'confirm', 确认: 'confirm', yes: 'confirm', y: 'confirm', 是: 'confirm',
});

function normalizeCommand(raw) {
  const key = String(raw || '').toLowerCase().trim();
  return COMMAND_ALIASES[key] || key;
}

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
    /** AI 辅助审核（可选）：本地词表没命中时的第二道判断 */
    this.ai = deps.ai;
    /** 信任成员触发高风险行为时的全群通告（可选） */
    this.notifyTrustedAbuse = deps.notifyTrustedAbuse;
    /** 重启插件服务（连接 + 面板，由 Host 注入） */
    this.restartService = deps.restartService;
    this.spam = new SpamWindow();
    this.lastActionAt = new Map();
    /** 免 @ 续聊：gid|uid → 到期时间戳（只在成员真正 @ 机器人时刷新） */
    this.followUp = new Map();
    /** 重启二次确认：gid|uid → 到期时间戳 */
    this.pendingRestart = new Map();
  }

  /** 记录/刷新免 @ 续聊窗口（秒数为 0 表示关闭） */
  noteFollowUp(key, seconds, now = Date.now()) {
    const sec = Math.max(0, Number(seconds) || 0);
    if (!sec) {
      this.followUp.delete(key);
      return;
    }
    this.followUp.set(key, now + sec * 1000);
    if (this.followUp.size > LIMITS.violationUsers) {
      const keys = [...this.followUp.keys()];
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.followUp.delete(k);
    }
  }

  /** 当前是否处于免 @ 续聊窗口内 */
  followUpActive(key, now = Date.now()) {
    const until = this.followUp.get(key) || 0;
    if (until > now) return true;
    if (until) this.followUp.delete(key);
    return false;
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
    // 免 @ 续聊：真正 @ 过机器人后，followUpSec 秒内该成员继续说话也算“对着机器人说”。
    // 窗口只在真正 @ 时刷新，避免被无限续期。先算出来，指令与闲聊都要用。
    const followKey = input.gid + '|' + input.uid;
    if (input.mentionsBot) this.noteFollowUp(followKey, settings.commands?.followUpSec);
    const followUp = !input.mentionsBot && this.followUpActive(followKey);

    const command = await this.handleCommand({ ...input, followUp }, settings);
    if (command.handled) return command;

    const mod = effectiveModeration(settings, input.gid);
    const trusted = this.isTrusted(mod, input.uid);
    const naturalOn = settings.commands?.naturalEnabled !== false;
    const mentionUids = Array.isArray(input.mentionUids) ? input.mentionUids : [];
    const atBot = !!input.mentionsBot || followUp;
    if (input.mentionsBot) {
      // 诊断用：确认 @ 消息确实到达，以及是否被识别为信任成员
      this.store.appendAudit({
        kind: 'command', action: 'at-received', groupId: input.gid,
        groupName: this.store.state.groups[input.gid]?.name || '',
        userId: input.uid, userName: input.name || '',
        detail: `收到 @机器人 消息（${trusted ? '信任成员' : '非信任成员'}，自然语言${naturalOn ? '已开启' : '已关闭'}）`,
        ok: true, confidence: 1,
      });
    }

    // 只要消息指向机器人，就必须给回复，绝不静默。
    if (atBot) {
      if (!trusted) {
        // 普通用户通道：只有闲聊能力；管理操作与越权请求在本地拦截，绝不交给模型执行
        const guest = settings.guest || {};
        if (guest.enabled) {
          const result = await handleGuestMessage({
            gid: input.gid,
            uid: input.uid,
            name: input.name || '',
            text: input.text,
            msgId: input.msgId,
            followUp,
          }, {
            store: this.store,
            getClient: this.getClient,
            ai: this.ai,
            logger: this.logger,
          });
          if (result.handled) {
            return {
              handled: true,
              action: `guest-${result.action || 'handled'}`,
              ruleId: RULE_ID.command,
              confidence: 1,
            };
          }
        }
        await this.replyText(input, guest.disabledText || '我是群管理机器人，暂未开启闲聊功能。如需管理权限请联系群主。');
        this.store.appendAudit({
          kind: 'command', action: 'guest-disabled', groupId: input.gid,
          groupName: this.store.state.groups[input.gid]?.name || '',
          userId: input.uid, userName: input.name || '',
          detail: '普通用户通道未开启，已回复固定提示', ok: false, code: 'GUEST_DISABLED', confidence: 1,
        });
        return { handled: true, action: 'guest-disabled', ruleId: RULE_ID.command, confidence: 1 };
      }
      // 信任成员触发了“感情牌夹带恶意指令”：可能是在做安全测试。
      // 不禁言，但必须警告，并把情况通告所有已管理的群、@ 之前设置的通知对象。
      const guard = classifyGuestIntent(input.text, settings.guest?.guardKeywords);
      if (guard.kind === 'emotional') {
        await this.replyText(input, `${mention(input.uid)} 已拦截：检测到感情牌夹带越权或管理指令，本次不会执行。该行为已同步告知管理员。`);
        this.store.appendAudit({
          kind: 'command', action: 'trusted-alert', groupId: input.gid,
          groupName: this.store.state.groups[input.gid]?.name || '',
          userId: input.uid, userName: input.name || '',
          detail: `信任成员触发感情牌夹带指令（${guard.reason}）：${String(input.text || '').slice(0, 60)}`,
          ok: false, code: 'EMOTIONAL_ATTACK', confidence: 1,
        });
        try {
          this.notifyTrustedAbuse?.({
            gid: input.gid,
            groupName: this.store.state.groups[input.gid]?.name || '',
            uid: input.uid,
            name: input.name || '',
            text: input.text,
            reason: guard.reason,
          });
        } catch { /* 通知失败不影响拦截 */ }
        return { handled: true, action: 'trusted-alert', ruleId: RULE_ID.command, confidence: 1 };
      }
      if (!naturalOn) {
        await this.replyText(input, `${mention(input.uid)} 自然语言指令已在面板关闭：设置 → 违规防护 → 勾选「允许受信任成员 @机器人 用自然语言下指令」并保存后即可使用。`);
        this.store.appendAudit({
          kind: 'command', action: 'natural-disabled', groupId: input.gid,
          groupName: this.store.state.groups[input.gid]?.name || '',
          userId: input.uid, userName: input.name || '',
          detail: '自然语言指令已关闭', ok: false, code: 'NATURAL_DISABLED', confidence: 1,
        });
        return { handled: true, action: 'natural-disabled', ruleId: RULE_ID.command, confidence: 1 };
      }
      // 有待确认的重启时，直接回“确认 / 确定 / 继续”也能执行，不必再打指令
      if (this.pendingRestartArmed(input.gid, input.uid)) {
        const prefix = String(settings.commands?.prefix || '/');
        let bare = sanitizeContent(input.text).trim();
        if (bare.startsWith(prefix)) bare = bare.slice(prefix.length).trim();
        if (/^(确认|确定|继续|执行|好的?|可以|是的?|ok|okay|yes|y)$/iu.test(bare)) {
          const r = await this.handleOpsCommand('confirm', input, settings);
          if (r.handled) {
            return { handled: true, action: `natural-${r.action}`, ruleId: RULE_ID.command, confidence: 1 };
          }
        }
      }
      const natural = await handleNaturalCommand({
        gid: input.gid,
        uid: input.uid,
        name: input.name || '',
        text: input.text,
        msgId: input.msgId,
        mentionUids,
        settings,
        store: this.store,
        client: this.getClient(),
        ai: this.ai,
        logger: this.logger,
        handleOps: (action) => this.handleOpsCommand(action, input, settings),
      });
      if (natural.handled) {
        return {
          handled: true,
          action: `natural-${natural.action || 'command'}`,
          ruleId: RULE_ID.command,
          confidence: 1,
        };
      }
    }

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
    let decision = decideAction(hits, prior, mod);
    let aiNote = '';
    // 本地词表/正则没命中时，再交给 AI 补漏（失败自动回退，不影响处置链）
    if (!decision.hit) {
      const byAi = await this.evaluateWithAi(input, mod);
      if (byAi?.decision) {
        decision = byAi.decision;
        aiNote = byAi.note;
      }
    }
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
        userName: input.name, detail: decision.reason + aiNote + '（机器人未连接，仅记录）',
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
      detail: decision.reason + aiNote + (result.degraded ? `（原动作 ${decision.action} 失败，已降级：${result.error || ''}）` : ''),
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

  /**
   * AI 补漏：只处理“本地没命中”的消息。
   * suggest 模式只写审计；auto 模式达到置信度阈值后按配置动作处置。
   * @returns {Promise<{decision: object, note: string}|null>}
   */
  async evaluateWithAi(input, mod) {
    const ai = this.ai;
    const cfg = this.store.settings.ai;
    if (!ai || !cfg?.enabled || !cfg?.moderation?.enabled) return null;
    try {
      const r = await ai.judgeMessage({
        gid: input.gid,
        uid: input.uid,
        name: input.name || '',
        text: input.text,
        groupName: this.store.state.groups[input.gid]?.name || '',
        images: Array.isArray(input.images) ? input.images : [],
      });
      if (!r?.ok) return null;
      const confidence = Number(r.confidence) || 0;
      if (r.verdict === 'ok' || confidence < Number(cfg.minConfidence || 0)) return null;
      const label = { abuse: '辱骂', ad: '广告', spam: '刷屏', other: '其他违规' }[r.verdict] || '违规';
      const imageNote = r.images ? `，图片 ${r.images} 张` : '';
      const detail = `AI 判定：${label}（置信度 ${confidence.toFixed(2)}${imageNote}，${r.provider}/${r.model}${r.cached ? '，命中缓存' : ''}）${r.reason ? '；' + r.reason : ''}`;
      const audit = {
        kind: 'ai',
        groupId: input.gid,
        groupName: this.store.state.groups[input.gid]?.name || '',
        userId: input.uid,
        userName: input.name || '',
        detail,
        ok: true,
        confidence,
      };
      if (cfg.moderation.mode !== 'auto') {
        this.store.appendAudit({ ...audit, action: 'ai-suggest' });
        return null;
      }
      this.store.appendAudit({ ...audit, action: 'ai-detect' });
      return {
        decision: {
          hit: true,
          ruleId: RULE_ID.ai,
          pattern: `AI 判定：${label}`,
          confidence,
          action: mod.action,
          reason: `AI 判定：${label}${r.reason ? '（' + r.reason + '）' : ''}`,
        },
        note: `（模型 ${r.provider}/${r.model}，置信度 ${confidence.toFixed(2)}）`,
      };
    } catch (error) {
      this.logger.warn?.('[qqbot-guard] AI 判定异常，已回退本地规则：' + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }

  /** 信任成员：豁免处置，同时允许使用群指令 */
  isTrusted(mod, uid) {
    return (mod?.trustedUsers || []).some((x) => String(x.uid) === String(uid));
  }

  /**
   * 统一群回复：无论成功失败都写审计。
   * 之前的实现把发送结果丢掉了，一旦平台拒发就会表现为“无任何回复”。
   */
  async replyText(input, text) {
    const groupName = this.store.state.groups[input.gid]?.name || '';
    const client = this.getClient();
    if (!client) {
      this.store.appendAudit({
        kind: 'command', action: 'reply-skipped', groupId: input.gid, groupName,
        userId: input.uid, userName: input.name || '',
        detail: '机器人未连接，无法回复', ok: false, code: 'NOT_CONNECTED', confidence: 1,
      });
      return { ok: false, err: { code: 'NOT_CONNECTED', human: '机器人未连接' } };
    }
    try {
      const r = await client.sendGroupText(input.gid, text, { msgId: input.msgId });
      if (!r?.ok) {
        this.logger.warn?.(`[qqbot-guard] 群回复发送失败：${r?.err?.human || r?.err?.code || '未知原因'}`);
        this.store.appendAudit({
          kind: 'command', action: 'reply-failed', groupId: input.gid, groupName,
          userId: input.uid, userName: input.name || '',
          detail: `回复发送失败：${r?.err?.human || '未知原因'}`,
          ok: false, code: r?.err?.code || '', confidence: 1,
        });
      }
      return r;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.(`[qqbot-guard] 群回复异常：${message}`);
      this.store.appendAudit({
        kind: 'command', action: 'reply-error', groupId: input.gid, groupName,
        userId: input.uid, userName: input.name || '',
        detail: `回复异常：${message}`, ok: false, code: 'REPLY_ERROR', confidence: 1,
      });
      return { ok: false, err: { code: 'REPLY_ERROR', human: message } };
    }
  }

  /**
   * 群内管理员指令：/warn /mute /kick /rule /help /设备 /余额 /重启
   * 只有 commands.allowUsers 或信任成员可用；其他人发指令会被当成普通消息。
   * /设备 /余额 /重启 属于运维指令，不受“启用指令”开关限制，但同样只认白名单。
   */
  async handleCommand(input, settings) {
    const cfg = settings.commands;
    if (!cfg) return { handled: false };
    // 指令必须真正 @ 机器人；运维指令额外允许在免 @ 续聊窗口内使用
    if (!input.mentionsBot && !input.followUp) return { handled: false };
    const prefix = String(cfg.prefix || '/');
    // 平台可能把 @ 标签拼在正文前面，先清洗再判断前缀
    const rawText = String(input.text || '');
    const text = sanitizeContent(rawText);
    if (!text.startsWith(prefix)) return { handled: false };
    const body = text.slice(prefix.length).trim();
    const [rawCmd, ...rest] = body.split(/\s+/u);
    const cmd = normalizeCommand(rawCmd);
    const args = rest.join(' ');
    const ops = cmd === 'device' || cmd === 'balance' || cmd === 'restart' || cmd === 'confirm';
    if (!ops && !input.mentionsBot) return { handled: false };
    if (!ops && !cfg.enabled) return { handled: false };
    const groupMod = effectiveModeration(settings, input.gid);
    const allowed = new Set([
      ...(cfg.allowUsers || []).map(String),
      ...((settings.moderation?.trustedUsers || []).map((x) => String(x.uid))),
      ...((groupMod.trustedUsers || []).map((x) => String(x.uid))),
    ]);
    if (!allowed.has(String(input.uid))) return { handled: false };

    const client = this.getClient();
    if (!client) return { handled: false };

    // 运维指令与帮助/群规：与自然语言路径共用同一套实现
    if (ops || cmd === 'help' || cmd === 'rule') {
      const r = await this.handleOpsCommand(cmd, input, settings);
      if (!r.handled) return { handled: false };
      return { ...r, action: `command-${r.action || 'ops'}` };
    }

    // 执行其它指令时撤销尚未确认的重启，避免“随口一句话”误触
    this.pendingRestart.delete(input.gid + '|' + input.uid);

    const target = findMentionUid(rawText);
    const mod = effectiveModeration(settings, input.gid);
    const reply = (content) => client.sendGroupText(input.gid, content, { msgId: input.msgId });

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

  /**
   * 运维指令统一实现：device / balance / restart / confirm / help / rule。
   * 斜杠指令与自然语言（AI 判定）都走这里，保证行为完全一致。
   * @returns {Promise<{handled: boolean, action?: string, ok?: boolean}>}
   */
  async handleOpsCommand(cmd, input, settings) {
    const client = this.getClient();
    if (!client) return { handled: false };
    const prefix = String(settings.commands?.prefix || '/');
    const reply = (content) => client.sendGroupText(input.gid, content, { msgId: input.msgId });
    const audit = (action, detail, ok = true, code = '') => this.store.appendAudit({
      kind: 'command', action, groupId: input.gid,
      groupName: this.store.state.groups[input.gid]?.name || '',
      userId: input.uid, userName: input.name || '',
      detail, ok, code, confidence: 1,
    });

    // 除重启/确认外，其它指令一律撤销待确认的重启
    if (cmd !== 'restart' && cmd !== 'confirm') this.pendingRestart.delete(input.gid + '|' + input.uid);

    if (cmd === 'device') {
      // 第一次采样只用来建立基准，隔一小段时间再采一次才能算出真实占用
      readDeviceInfo();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, LIMITS.deviceSampleMs);
        if (timer.unref) timer.unref();
      });
      await reply(formatDeviceInfo(readDeviceInfo()));
      audit('device', `查询设备信息（${input.name || input.uid}）`);
      return { handled: true, action: 'device', ok: true };
    }

    if (cmd === 'balance') {
      let r;
      try {
        r = this.ai?.queryBalance ? await this.ai.queryBalance() : { ok: false, error: '未配置 AI 接口' };
      } catch (error) {
        r = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await reply(formatBalanceText(r));
      audit(
        'balance',
        r.ok
          ? `API 余额查询成功：${r.host || ''}${r.endpoint || ''} 剩余 ${r.remaining} ${r.currency || ''}`
          : `API 余额查询失败：${r.error || '未知原因'}`,
        !!r.ok, r.ok ? '' : (r.code || 'BALANCE_FAILED'),
      );
      return { handled: true, action: 'balance', ok: !!r.ok };
    }

    if (cmd === 'restart' || cmd === 'confirm') {
      const key = input.gid + '|' + input.uid;
      const confirmSec = Math.max(0, Number(settings.commands?.restartConfirmSec) || 0);
      const pending = this.pendingRestart.get(key);
      const armed = !!(pending && pending.expiresAt > Date.now());
      if (!armed) this.pendingRestart.delete(key);

      // 只发“确认”但没有待确认的重启 → 明确告知，不执行
      if (cmd === 'confirm' && !armed) {
        await reply(`${mention(input.uid)} 当前没有待确认的重启操作。如需重启，请先发送 ${prefix}重启。`);
        audit('restart-confirm', '没有待确认的重启操作', false, 'NO_PENDING');
        return { handled: true, action: 'restart-expired', ok: false };
      }

      // 第一次触发：进入确认窗口，不重启
      if (!armed && confirmSec > 0) {
        this.pendingRestart.set(key, { expiresAt: Date.now() + confirmSec * 1000 });
        if (this.pendingRestart.size > LIMITS.violationUsers) {
          const keys = [...this.pendingRestart.keys()];
          for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.pendingRestart.delete(k);
        }
        await reply(`${mention(input.uid)} 即将重启插件服务：请在 ${confirmSec} 秒内再次发送 ${prefix}重启（或 ${prefix}确认）以执行，超时自动取消。`);
        audit('restart-confirm', `已请求二次确认（${confirmSec} 秒）`);
        return { handled: true, action: 'restart-confirm', ok: true };
      }

      // 已确认（或配置为 0 秒免确认）：执行完整重启
      this.pendingRestart.delete(key);
      await reply(`${mention(input.uid)} 已确认，正在完整重启插件服务（QQ / 控制面板 / 数据），完成后会再回复结果。`);
      audit('restart', `管理员确认重启插件服务（${input.name || input.uid}）`);
      const timer = setTimeout(() => {
        Promise.resolve()
          .then(() => this.restartService?.({ gid: input.gid, uid: input.uid, name: input.name || '' }))
          .catch((error) => {
            this.logger.warn?.('[qqbot-guard] 重启插件服务失败：' + (error instanceof Error ? error.message : String(error)));
          });
      }, LIMITS.restartDelayMs);
      if (timer.unref) timer.unref();
      return { handled: true, action: 'restart', ok: true };
    }

    if (cmd === 'help') {
      await reply([
        '可用指令：',
        `${prefix}warn @成员 [原因]`,
        `${prefix}mute 10m @成员`,
        `${prefix}kick @成员`,
        `${prefix}rule 查看群规`,
        `${prefix}设备 查看设备与资源占用`,
        `${prefix}余额 查询 AI 接口余额`,
        `${prefix}重启 完整重启插件服务`,
        `${prefix}确认 确认待执行的重启`,
      ].join('\n'));
      return { handled: true, action: 'help', ok: true };
    }

    if (cmd === 'rule') {
      await reply(String(settings.commands?.ruleText || '暂无群规').slice(0, LIMITS.warnMaxChars));
      return { handled: true, action: 'rule', ok: true };
    }

    return { handled: false };
  }

  /** 是否有待确认的重启（供自然语言“确认”识别） */
  pendingRestartArmed(gid, uid, now = Date.now()) {
    const hit = this.pendingRestart.get(String(gid) + '|' + String(uid));
    const armed = !!(hit && hit.expiresAt > now);
    if (!armed && hit) this.pendingRestart.delete(String(gid) + '|' + String(uid));
    return armed;
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
    this.followUp.clear();
    this.pendingRestart.clear();
  }
}
