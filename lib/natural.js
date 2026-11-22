/**
 * 群内自然语言管理指令：受信任成员 @ 机器人即可操作。
 * - 优先用 AI 解析意图；AI 未开启或失败时回退本地关键词规则
 * - 无论成功失败都必须回复，并说明原因
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
].join('\n');

const QUOTED = /[‘’“”"'「」『』]([^‘’“”"'「」『』]{1,40})[‘’“”"'「」『』]/u;

/** 去掉机器人/成员 @ 标签，只留正文 */
export function stripMentions(text) {
  return String(text || '')
    .replace(/<qqbot-at-user[^>]*\/>/giu, ' ')
    .replace(/<@!?[A-Za-z0-9_-]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 从一句话里提取要操作的成员名 */
export function extractTarget(text) {
  const s = String(text || '');
  const quoted = s.match(QUOTED);
  if (quoted) return quoted[1].trim();
  const patterns = [
    /(?:把|将)\s*([^\s，,。！!？?]{1,30}?)\s*(?:成员|踢|移出|请出|禁言|拉黑|警告)/u,
    /(?:踢出|移出|请出|禁言|解禁|警告|拉黑)\s*([^\s，,。！!？?]{1,30})/u,
    /(?:查询|查一下|看看)\s*([^\s，,。！!？?]{1,30})/u,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    const hit = m?.[1]?.trim();
    if (hit && !/^(群里|成员|黑名单|多少|人数)$/u.test(hit)) return hit;
  }
  return '';
}

/** 本地关键词回退解析 */
export function parseNaturalIntent(text) {
  const t = stripMentions(text);
  if (!t) return null;
  if (/多少\s*(人|成员)|成员.{0,4}(数|数量)|人数|几个人/u.test(t)) {
    return { action: 'count', target: '', seconds: 0, blacklist: false };
  }
  const target = extractTarget(t);
  if (/移出黑名单|解除黑名单|取消黑名单/u.test(t)) {
    return { action: 'unblacklist', target, seconds: 0, blacklist: false };
  }
  if (/黑名单|拉黑/u.test(t) && !/踢|移出群|请出/u.test(t)) {
    return { action: 'blacklist', target, seconds: 0, blacklist: false };
  }
  if (/解除[^。！？!?]{0,12}禁言|解禁|取消[^。！？!?]{0,12}禁言/u.test(t)) {
    return { action: 'unmute', target, seconds: 0, blacklist: false };
  }
  if (/禁言/u.test(t)) {
    const m = t.match(/(\d+)\s*(秒|s|分钟|分|小时|h|天)/iu);
    let seconds = 0;
    if (m) {
      const n = Number(m[1]);
      const unit = String(m[2]).toLowerCase();
      if (m[2].includes('天')) seconds = n * 86_400;
      else if (m[2].includes('小时') || unit === 'h') seconds = n * 3600;
      else if (unit === '秒' || unit === 's') seconds = n;
      else seconds = n * 60;
    }
    return { action: 'mute', target, seconds: Math.max(0, Math.min(86_400, seconds)), blacklist: false };
  }
  if (/踢出|移出群|请出|踢了|踢掉/u.test(t)) {
    return { action: 'kick', target, seconds: 0, blacklist: /黑名单|拉黑/u.test(t) };
  }
  if (/警告|提醒/u.test(t)) {
    return { action: 'warn', target, seconds: 0, blacklist: false };
  }
  if (/查询|查一下|资料|信息|看看/u.test(t)) {
    return { action: 'info', target, seconds: 0, blacklist: false };
  }
  return null;
}

/** 在台账里解析目标成员 */
export function resolveTarget(store, gid, target) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, reason: 'missing' };
  const direct = store.getMember(gid, t);
  if (direct) return { ok: true, member: direct };
  const exact = new Map(store.findMembersByName(gid, t).map((m) => [m.uid, m]));
  if (exact.size === 1) return { ok: true, member: [...exact.values()][0] };
  if (exact.size > 1) return { ok: false, reason: 'ambiguous', count: exact.size };
  const fuzzy = new Map(store.searchMembers(gid, t, 10).map((m) => [m.uid, m]));
  if (fuzzy.size === 1) return { ok: true, member: [...fuzzy.values()][0] };
  if (fuzzy.size > 1) return { ok: false, reason: 'ambiguous', count: fuzzy.size };
  return { ok: false, reason: 'notfound' };
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
    gid, uid, name, text, msgId, settings, store, client, ai, logger,
  } = deps;
  if (!client) return { handled: false };

  const reply = async (message) => {
    try {
      await client.sendGroupText(
        gid,
        `${mention(uid)} ${String(message).slice(0, LIMITS.warnMaxChars)}`,
        { msgId },
      );
    } catch (error) {
      logger?.warn?.('[qqbot-guard] 自然语言指令回复失败：' + (error instanceof Error ? error.message : String(error)));
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
    let intent = null;
    if (ai && settings.ai?.enabled) {
      try {
        const r = await ai.parseIntent({
          text: stripMentions(text),
          groupName: store.state.groups[gid]?.name || '',
        });
        if (r?.ok && r.intent && r.intent.action !== 'none') intent = r.intent;
      } catch { /* 回退到本地规则 */ }
    }
    if (!intent) intent = parseNaturalIntent(text);
    if (!intent) {
      await reply(HELP_TEXT);
      audit('help', '未识别的自然语言指令', false, 'UNKNOWN_INTENT');
      return { handled: true, action: 'help', ok: false };
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
      await reply(`请告诉我要操作哪位成员，例如：把“某某”${intent.action === 'kick' ? '移出群聊' : '处理一下'}。`);
      audit(intent.action, '缺少操作目标', false, 'NO_TARGET');
      return { handled: true, action: intent.action, ok: false };
    }
    const found = resolveTarget(store, gid, intent.target);
    if (!found.ok) {
      const message = found.reason === 'ambiguous'
        ? `群里有 ${found.count} 位叫「${intent.target}」的成员，请改用 openid 或更完整的昵称。`
        : `没有找到「${intent.target}」。他需要先在群里发过言，机器人才能看到。`;
      await reply(message);
      audit(intent.action, message, false, 'TARGET_NOT_FOUND');
      return { handled: true, action: intent.action, ok: false };
    }
    const member = found.member;
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
