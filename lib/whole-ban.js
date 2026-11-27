/**
 * 全员禁言（官方 API 实现，不依赖 NapCat / QQ 客户端登录）。
 *
 * 事实：官方开放平台只开放"读取"全员禁言规则（restrict_chat_setting 的 global_rule），
 * 写入 global_rule 会被服务端忽略（实测 POST 返回成功但 GET 状态不变）。
 * 因此这里用官方明确支持的"成员禁言"接口实现等价效果：
 *   - 开启：把全体现有成员逐批禁言（群主 / 管理员 / 机器人不可禁言，官方会拒绝）；
 *   - 解除：优先读取官方禁言状态里的成员列表批量解禁，读不到时退回台账。
 * "何时禁言、改到几点"全部由插件自己的 Scheduler 控制（见 lib/scheduler.js）。
 */
import { LIMITS } from './defaults.js';

const CHUNK = 20;          // 官方单次最多 20 个成员
const MAX_TARGETS = 200;   // 单次全员禁言最多处理 200 人

/** 把数组按 size 切块 */
export function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 执行全员禁言 / 解除。
 * @param {{store: import('./store.js').Store, client: import('./qq-api.js').QQClient|undefined,
 *          gid: string, enable: boolean, seconds?: number, logger?: Console}} args
 * @returns {Promise<{ok: boolean, done: number, failed: number, via: string, error?: string, empty?: boolean}>}
 */
export async function applyWholeBan({ store, client, gid, enable, seconds = 600, logger } = {}) {
  const group = String(gid || '').trim();
  if (!client) return { ok: false, done: 0, failed: 0, via: 'none', error: '机器人未连接（请检查协议端是否在线）' };
  if (!group) return { ok: false, done: 0, failed: 0, via: 'none', error: '缺少群号' };
  const rows = typeof store?.listMembers === 'function' ? store.listMembers(group) : [];
  const safeLog = (msg) => { try { logger?.warn?.(`[qqbot-guard] ${msg}`); } catch { /* ignore */ } };

  // NapCat（普通 QQ 账号）有原生“全员禁言”接口，优先使用。
  // 注意：原生接口是群级开关，不逐个禁言，done 只能表示“已下发”而不是“禁言了几人”；
  // 旧代码返回 rows.length 会让回执把台账人数误报成禁言成功数。
  if (typeof client.setWholeBan === 'function') {
    const r = await client.setWholeBan(group, !!enable);
    if (r?.ok) return { ok: true, done: 0, failed: 0, via: 'napcat', groupLevel: true };
    safeLog(`NapCat 全员禁言失败，退回逐人禁言：${r?.err?.human || r?.error || ''}`);
  }

  if (!enable) {
    // 解除：优先按官方禁言状态解禁（最准），读不到再用台账兜底
    let ids = [];
    let via = 'official';
    const st = await client.getGroupMuteSetting?.(group);
    const muted = st?.ok && Array.isArray(st.data?.members) ? st.data.members : null;
    if (muted) {
      ids = muted.map((m) => String(m?.member_openid || '').trim()).filter(Boolean);
    } else {
      via = 'ledger';
      ids = rows.map((r) => String(r.uid || '').trim()).filter(Boolean);
      if (!st?.ok) safeLog(`读取官方禁言状态失败，退回台账解禁：${st?.err?.human || st?.error || ''}`);
    }
    ids = [...new Set(ids)].slice(0, MAX_TARGETS);
    if (!ids.length) return { ok: true, done: 0, failed: 0, via, empty: true };
    let done = 0;
    let failed = 0;
    for (const part of chunks(ids)) {
      const r = await client.setMemberMute(group, part, null);
      if (r?.ok) done += part.length;
      else failed += part.length;
    }
    return { ok: done > 0, done, failed, via };
  }

  // 开启：仅禁言普通成员（官方不允许操作群主 / 管理员 / 机器人）
  const targets = rows
    .filter((r) => r.uid && r.role !== 'owner' && r.role !== 'admin')
    .map((r) => String(r.uid))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, MAX_TARGETS);
  if (!targets.length) {
    return { ok: false, done: 0, failed: 0, via: 'official', error: '台账里没有可禁言的普通成员（先让成员发过言，或同步一次花名册）' };
  }
  let done = 0;
  let failed = 0;
  for (const uid of targets) {
    const r = await client.setMemberMute(group, [uid], seconds);
    if (r?.ok) done += 1;
    else failed += 1;
  }
  return { ok: done > 0, done, failed, via: 'official' };
}
