/**
 * 普通用户通道：非信任成员 @机器人 时的轻量闲聊。
 *
 * 安全边界完全在本地：管理操作、提示词泄露、越狱/角色扮演套设定等请求
 * 一律在调用模型之前拦下，模型只负责生成普通文本，永远拿不到任何执行能力。
 * 参考 OWASP LLM01（提示词注入）与 LLM07（系统提示泄露）的输入过滤思路。
 */
import { LIMITS } from './defaults.js';

/** 管理操作意图：命中即拒绝 */
const COMMAND_RE = /(踢出|踢人|踢掉|移出群|请出群|移除成员|禁言|解禁|解除禁言|拉黑|加入?黑名单|移出黑名单|取消黑名单|撤回消息|撤回|发公告|发布公告|改群规|修改群规|改设置|改配置|修改设置|信任名单|授权|给.{0,6}权限|@全体|@所有人|\/warn|\/mute|\/kick|\/rule|\/help|(查看|查询|看看|看一下|告诉我).{0,10}(群人数|多少(人|成员)|成员(数|列表)|黑名单|白名单|待审批|入群申请|设置|配置|公告|群规|违规记录|信任成员)|多少(人|成员))/iu;

/** 提示词越权 / 越狱 / 索要系统设定 */
const ATTACK_RE = /(system\s*prompt|系统提示词|系统提示|你的(设定|规则|提示词|指令|配置)|告诉我你的(设定|规则|提示词|配置)|忽略(之前|以上|前面)(的)?(所有)?(指令|规则|要求|提示)|无视(之前|以上|指令|规则|限制)|开发者模式|developer\s*mode|越狱|jailbreak|do\s*anything\s*now|dan\s*mode|base64|十六进制|解码后|(扮演|假装|roleplay|cosplay).{0,30}(奶奶|爷爷|外婆|外公|亲人|管理员|开发者|系统|机器人)|(奶奶|爷爷|外婆|外公|已故|去世).{0,40}(念|说|告诉|提示词|prompt|设定|规则))/iu;

/**
 * 感情牌 / 情感勒索：单独出现不算越权（正常倾诉会交给模型安慰），
 * 只有与恶意指令同时出现时才升级为高风险。
 */
const EMOTION_RE = /(奶奶|爷爷|外婆|外公|妈妈|爸爸|父亲|母亲|亲人|家人|好友|朋友).{0,30}(去世|死了|离世|临终|生前|遗愿|最后的心愿|病重|住院)|(我|我的).{0,10}(遗愿|最后的心愿)|(我很|我特别|我真的|我现在).{0,8}(难过|痛苦|悲伤|崩溃|抑郁|想哭|伤心|绝望)|(求求你|求你了|可怜可怜|救救我|帮帮我|行行好)|(如果你|你要是|你不).{0,12}(不帮我|不答应|不配合|拒绝我).{0,12}(我就|我会|我活着)|(假装|扮演|cosplay).{0,20}(亲人|奶奶|爷爷|已故|去世)/iu;

/** 超长 Base64 块：常见的编码绕过手法 */
const BASE64_BLOCK_RE = new RegExp(`[A-Za-z0-9+/]{${LIMITS.guestBase64MinLength},}={0,2}`, 'u');

const minuteBuckets = new Map();
const cooldownAt = new Map();

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/<qqbot-at-user[^>]*\/>/giu, ' ')
    .replace(/<@!?[A-Za-z0-9_-]+>/gu, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function matchKeyword(text, keywords) {
  const lower = text.toLowerCase();
  for (const raw of Array.isArray(keywords) ? keywords : []) {
    const word = String(raw || '').trim().toLowerCase();
    if (word && lower.includes(word)) return word;
  }
  return '';
}

/**
 * 判断一条普通成员消息属于哪类。
 * emotional = 感情牌/情感勒索 + 恶意指令，属于最高风险，直接禁言。
 * @returns {{kind: 'safe'|'command'|'attack'|'emotional', reason: string}}
 */
export function classifyGuestIntent(text, keywords = []) {
  const t = normalize(text);
  if (!t) return { kind: 'safe', reason: '' };
  const keywordHit = matchKeyword(t, keywords);
  const attack = ATTACK_RE.test(t) || BASE64_BLOCK_RE.test(t) || !!keywordHit;
  const command = COMMAND_RE.test(t);
  if (!attack && !command) return { kind: 'safe', reason: '' };
  if (EMOTION_RE.test(t)) {
    return {
      kind: 'emotional',
      reason: attack ? '感情牌夹带提示词越权' : '感情牌夹带管理指令',
    };
  }
  return attack
    ? { kind: 'attack', reason: keywordHit ? `命中拦截词「${keywordHit}」` : '提示词越权' }
    : { kind: 'command', reason: '管理操作' };
}

/** 模型输出净化：去掉标签/代码块/链接，疑似泄露系统提示的直接丢弃 */
export function sanitizeGuestReply(text, maxChars = 200) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([，。！？、；：,.!?;:])/gu, '$1')
    .trim();
  if (!s) return '';
  if (/(system\s*prompt|系统提示词|我的规则|我的设定|developer\s*mode)/iu.test(s)) return '';
  if (/(https?:\/\/|www\.|二维码|加微信|加QQ|扫码)/iu.test(s)) return '';
  return s.slice(0, Math.max(20, Number(maxChars) || 200)).trim();
}

function allowPerMinute(gid, limit, now = Date.now()) {
  const max = Math.max(1, Number(limit) || 6);
  const minute = Math.floor(now / 60_000);
  const hit = minuteBuckets.get(gid);
  if (!hit || hit.minute !== minute) {
    if (minuteBuckets.size > 500) minuteBuckets.clear();
    minuteBuckets.set(gid, { minute, count: 1 });
    return true;
  }
  if (hit.count >= max) return false;
  hit.count += 1;
  return true;
}

function cooldownOk(key, seconds, now = Date.now()) {
  const gap = Math.max(0, Number(seconds) || 0) * 1000;
  if (!gap) return true;
  const last = cooldownAt.get(key) || 0;
  if (now - last < gap) return false;
  cooldownAt.set(key, now);
  if (cooldownAt.size > 2000) cooldownAt.clear();
  return true;
}

/**
 * 普通用户通道主流程。
 * @returns {Promise<{handled: boolean, action: string, ok: boolean}>}
 */
export async function handleGuestMessage(input, deps) {
  const { store, getClient, ai, logger } = deps;
  const cfg = store.settings.guest || {};
  const gid = String(input.gid || '');
  const uid = String(input.uid || '');
  const name = String(input.name || '');
  const client = getClient();
  const groupName = store.state.groups[gid]?.name || '';
  const audit = (action, detail, ok = true, code = '') => store.appendAudit({
    kind: 'command', action, groupId: gid, groupName, userId: uid, userName: name,
    detail, ok, code, confidence: 1,
  });
  const reply = async (text) => {
    const content = String(text || '').replace(/\s+/gu, ' ').trim();
    if (!client || !content) return { ok: false };
    try {
      const r = await client.sendGroupText(gid, content, { msgId: input.msgId });
      if (!r?.ok) {
        audit('guest-reply-failed', `回复发送失败：${r?.err?.human || ''}`, false, r?.err?.code || '');
        logger?.warn?.(`[qqbot-guard] 普通用户通道回复失败：${r?.err?.human || ''}`);
      }
      return r || { ok: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit('guest-reply-failed', `回复异常：${message}`, false, 'REPLY_ERROR');
      return { ok: false };
    }
  };

  const muteMinutes = Math.max(1, Math.round((Number(cfg.muteSeconds) || 300) / 60));
  const fill = (tpl, mins) => String(tpl || '').replace(/\{minutes\}/gu, String(mins == null ? muteMinutes : mins));

  // 1) 越权/管理操作：本地拦截，绝不调用模型
  const verdict = classifyGuestIntent(input.text, cfg.guardKeywords);
  if (verdict.kind !== 'safe') {
    const windowMs = Math.max(1, Number(cfg.abuseWindowHours) || 24) * 3600_000;
    const prior = store.countGuestAbuse(gid, uid, windowMs);
    store.noteGuestAbuse(gid, uid);
    // 感情牌夹带恶意指令：最高风险，直接禁言（默认 1 小时），不给警告机会
    if (verdict.kind === 'emotional' && Number(cfg.emotionalMuteSeconds) > 0) {
      const seconds = Number(cfg.emotionalMuteSeconds) || 3600;
      const mins = Math.max(1, Math.round(seconds / 60));
      let muted = false;
      let failReason = '';
      if (client) {
        const r = await client.setMemberMute(gid, uid, seconds);
        muted = !!r?.ok;
        failReason = r?.err?.human || '';
      }
      await reply(fill(cfg.emotionalMuteText || cfg.muteText, mins));
      audit(
        'guest-emotion-mute',
        `感情牌夹带恶意指令，禁言 ${mins} 分钟${muted ? '' : `失败：${failReason || '未知原因'}`}`,
        muted, muted ? '' : 'MUTE_FAILED',
      );
      return { handled: true, action: 'emotion-mute', ok: muted };
    }
    if (prior >= 1 && Number(cfg.muteSeconds) > 0) {
      let muted = false;
      let failReason = '';
      if (client) {
        const r = await client.setMemberMute(gid, uid, Number(cfg.muteSeconds));
        muted = !!r?.ok;
        failReason = r?.err?.human || '';
      }
      await reply(fill(cfg.muteText, muteMinutes));
      audit(
        'guest-mute',
        `越权 ${prior + 1} 次（${verdict.reason}），禁言 ${muteMinutes} 分钟${muted ? '' : `失败：${failReason || '未知原因'}`}`,
        muted, muted ? '' : 'MUTE_FAILED',
      );
      return { handled: true, action: 'mute', ok: muted };
    }
    await reply(fill(cfg.warnText, muteMinutes));
    audit('guest-warn', `拦截${verdict.reason}：${String(input.text || '').slice(0, 40)}`, true);
    return { handled: true, action: 'warn', ok: true };
  }

  // 2) 正常内容：先做本地限流，再决定是否调用模型
  const text = String(input.text || '').trim();
  if (text.length > Math.max(20, Number(cfg.maxInputChars) || 300)) {
    await reply(cfg.limitText);
    return { handled: true, action: 'too-long', ok: false };
  }
  if (!cfg.aiEnabled || !ai || !store.settings.ai?.enabled) {
    await reply(cfg.aiOffText || cfg.disabledText);
    audit('guest-ai-off', '普通用户通道未启用 AI，未调用模型', false, 'AI_OFF');
    return { handled: true, action: 'ai-off', ok: false };
  }
  if (!allowPerMinute(gid, cfg.perMinute)) {
    await reply(cfg.limitText);
    audit('guest-limit', '超过每群每分钟上限，未调用模型', false, 'RATE_LIMIT');
    return { handled: true, action: 'limit', ok: false };
  }
  if (!cooldownOk(`${gid}|${uid}`, cfg.cooldownSec)) {
    await reply(cfg.limitText);
    audit('guest-cooldown', '同一成员冷却中，未调用模型', false, 'COOLDOWN');
    return { handled: true, action: 'cooldown', ok: false };
  }

  const r = await ai.chatReply({
    text,
    groupName,
    persona: cfg.persona,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
  });
  const safe = r?.ok ? sanitizeGuestReply(r.text, cfg.replyMaxChars) : '';
  if (!safe) {
    await reply(cfg.fallbackText);
    audit('guest-fallback', `模型失败或输出被过滤：${r?.error || r?.code || '空输出'}`, false, r?.code || 'EMPTY');
    return { handled: true, action: 'fallback', ok: false };
  }
  await reply(safe);
  audit('guest-reply', `普通用户通道回复（${r.provider}/${r.model}，${safe.length} 字）`, true);
  return { handled: true, action: 'reply', ok: true };
}

/** 供测试或诊断重置内存限流状态 */
export function resetGuestLimits() {
  minuteBuckets.clear();
  cooldownAt.clear();
}
