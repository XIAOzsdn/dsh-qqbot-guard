/**
 * 群内自然语言管理指令：受信任成员 @ 机器人即可操作。
 * - 目标成员优先取“被 @ 的那个人的 openid”，比昵称更准确
 * - 先用本地关键词规则（零模型开销）；匹配不到再交给 AI 判断意图
 * - 昵称必须精确命中台账，绝不猜人；找不到就回复候选成员
 */
import { LIMITS } from './defaults.js';
import { effectiveModeration } from './config.js';
import { mention } from './qq-api.js';

const HELP_TEXT = [
  '没听懂你的意思。可以这样说：',
  '“看看群里有多少人”',
  '“把‘某某’踢出群聊并拉黑”',
  '“禁言‘某某’10分钟”',
  '“解除‘某某’的禁言”',
  '“警告‘某某’”',
  '“查询‘某某’的信息”',
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
  const t = stripMentions(text);
  if (!t) return null;
  const mentionUids = Array.isArray(opts?.mentionUids) ? opts.mentionUids.filter(Boolean) : [];
  // 只 @ 了一个人时，用 openid 定位，避免改名/重名导致误伤
  const mentioned = mentionUids.length === 1 ? String(mentionUids[0]) : '';
  const target = mentioned || extractTarget(t);
  if (/多少\s*(人|成员)|成员.{0,4}(数|数量)|人数|几个人/u.test(t)) {
    return { action: 'count', target: '', seconds: 0, blacklist: false };
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

/**
 * 处理一条自然语言指令。
 * @returns {Promise<{handled: boolean, action?: string, ok?: boolean}>}
 */
export async function handleNaturalCommand(deps) {
  const {
    gid, uid, name, text, msgId, settings, store, client, ai, logger, localOnly,
    mentionUids = [],
  } = deps;
  if (!client) return { handled: false };

  const reply = async (message) => {
    const content = `${mention(uid)} ${String(message).slice(0, LIMITS.warnMaxChars)}`;
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

  try {
    // 1) 先用本地关键词规则：命中即执行，零模型开销
    let intent = parseNaturalIntent(text, { mentionUids });
    // 2) 本地没匹配到说法，或匹配到动作但认不出目标时，交给 AI 再判断一次
    const needAi = !intent || (!intent.target && intent.action !== 'count');
    if (needAi && !localOnly && ai && settings.ai?.enabled) {
      try {
        const members = store.searchMembers(gid, '', LIMITS.aiIntentCandidates)
          .filter((m) => m.name || m.uid)
          .map((m) => ({ name: m.name || '', uid: m.uid }));
        const last = lastTargetFor(gid);
        const r = await ai.parseIntent({
          text: stripMentions(text),
          groupName: store.state.groups[gid]?.name || '',
          mentionUids,
          members,
          // 省略目标的续指令（“禁言 1 分钟”）靠它接上下文
          lastTarget: last ? { name: last.name, uid: last.uid } : null,
        });
        if (r?.ok && r.intent && r.intent.action !== 'none') {
          if (!intent) intent = r.intent;
          else if (r.intent.action === intent.action) {
            if (r.intent.target) intent.target = r.intent.target;
            // 本地没解析出时长时，用模型给出的时长
            if (!intent.seconds && r.intent.seconds) intent.seconds = r.intent.seconds;
            if (r.intent.blacklist) intent.blacklist = true;
          }
        }
      } catch { /* AI 不可用：按未识别处理 */ }
    }
    if (!intent) {
      await reply(HELP_TEXT);
      audit('help', '未识别的自然语言指令', false, 'UNKNOWN_INTENT');
      return { handled: true, action: 'help', ok: false };
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
      const message = info?.ok
        ? `本群官方显示 ${official || '未知'} 人；机器人台账记录 ${ledger} 人。`
        : `机器人台账记录 ${ledger} 人；官方成员数暂时取不到：${info?.err?.human || '无权限'}`;
      await reply(message);
      audit('count', message, !!info?.ok, info?.err?.code || '');
      return { handled: true, action: 'count', ok: !!info?.ok };
    }

    if (!intent.target) {
      await reply('请告诉我要操作哪位成员：可以直接 @ 他，或用完整昵称（例如：把“某某”移出群聊）。');
      audit(intent.action, '缺少操作目标', false, 'NO_TARGET');
      return { handled: true, action: intent.action, ok: false };
    }
    const found = resolveTarget(store, gid, intent.target);
    if (!found.ok) {
      // 目标是“上一次操作的成员”但已经不在台账里：清掉，避免后续续指令反复失败
      const last = lastTargetFor(gid);
      if (last && String(last.uid) === String(intent.target)) clearLastTarget(gid);
      const names = (Array.isArray(found.candidates) ? found.candidates : [])
        .filter((m) => m && (m.name || m.uid))
        .slice(0, LIMITS.intentCandidateLimit)
        .map((m) => (m.name ? `${m.name}（${m.uid}）` : String(m.uid)));
      const message = found.reason === 'ambiguous'
        ? `群里有 ${found.count} 位同名成员，为避免误操作已停止。请 @ 他，或用 openid 指定：${names.join('、')}。`
        : `没有找到昵称精确匹配「${intent.target}」的成员。${names.length ? `相近的成员：${names.join('、')}。` : '他需要先在群里发过言，机器人才能看到。'}建议直接 @ 他，或使用完整昵称/openid。`;
      await reply(message);
      audit(intent.action, message, false, 'TARGET_NOT_FOUND');
      return { handled: true, action: intent.action, ok: false };
    }
    const member = found.member;
    // 记住这一次明确解析到的成员：下一条“禁言 1 分钟”可以省略目标
    rememberTarget(gid, member);
    const label = member.name || member.uid;
    if (String(member.uid) === String(uid)) {
      await reply('不能对自己执行该操作。');
      audit(intent.action, '尝试对自己操作', false, 'SELF_TARGET');
      return { handled: true, action: intent.action, ok: false };
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
      await reply(message);
      audit('kick', message, r.ok, r.err?.code || '');
      return { handled: true, action: 'kick', ok: r.ok };
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
      await reply(message);
      audit(intent.action, message, r.ok, r.err?.code || '');
      return { handled: true, action: intent.action, ok: r.ok };
    }

    if (intent.action === 'warn') {
      const mod = effectiveModeration(settings, gid);
      const content = String(mod.warnTemplate || '{user} 请注意群规。')
        .replace(/\{user\}/gu, mention(member.uid))
        .replace(/\{group\}/gu, store.state.groups[gid]?.name || '本群')
        .replace(/\{rule\}/gu, '管理员警告');
      const r = await client.sendGroupText(gid, content.slice(0, LIMITS.warnMaxChars));
      const message = r.ok ? `已警告「${label}」。` : `警告「${label}」失败：${r.err?.human || '未知原因'}`;
      await reply(message);
      audit('warn', message, r.ok, r.err?.code || '');
      return { handled: true, action: 'warn', ok: r.ok };
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
      await reply(message);
      audit(intent.action, message);
      return { handled: true, action: intent.action, ok: true };
    }

    if (intent.action === 'info') {
      const message = [
        `「${member.name || '未备注'}」`,
        `openid：${member.uid}`,
        `最近发言：${timeText(member.lastSeenAt)}`,
        `台账发言：${member.msgCount || 0} 次`,
        `黑名单：${store.isBlacklisted(gid, member.uid) ? '是' : '否'}`,
      ].join('；');
      await reply(message);
      audit('info', message);
      return { handled: true, action: 'info', ok: true };
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
