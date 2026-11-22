/** 入群审批与入群欢迎。群事件由官方 GROUP_JOIN_REQUEST / GROUP_MEMBER_ADD 驱动。 */
import { CONFIDENCE, LIMITS } from './defaults.js';
import { dayKeyUtc8, pickSeeded } from './rng.js';
import { mention } from './qq-api.js';

const METHOD_HUMAN = Object.freeze({
  admin_review_qa: '问题验证（需管理员审核）',
  admin_review: '管理员审核',
  free_join: '自由进群',
  qa: '问题验证',
});

/** 把 verify_info 翻成人话 */
export function verifyHuman(verifyInfo) {
  const qa = Array.isArray(verifyInfo?.review_qa_list)
    ? verifyInfo.review_qa_list.filter((x) => x && (x.question || x.answer))
    : [];
  if (qa.length) return qa.map((x) => `${x.question || '问题'}「${x.answer || '(未填)'}」`).join('；');
  if (verifyInfo?.verify_message) return String(verifyInfo.verify_message);
  if (verifyInfo?.method) return METHOD_HUMAN[verifyInfo.method] || `验证方式：${verifyInfo.method}`;
  return '';
}

function includesAny(text, words) {
  const t = String(text || '').toLowerCase();
  return (Array.isArray(words) ? words : []).some((w) => {
    const s = String(w || '').trim().toLowerCase();
    return s && t.includes(s);
  });
}

/**
 * 处理一条入群申请事件。
 * @param {Record<string, any>} ev
 * @param {{store: import('./store.js').Store, getClient: () => import('./qq-api.js').QQClient|undefined}} deps
 */
export async function handleJoinRequest(ev, deps) {
  const { store, getClient } = deps;
  const gid = String(ev?.group_openid || '').trim();
  const uid = String(ev?.member_openid || '').trim();
  const jid = String(ev?.join_request_id || '').trim();
  if (!gid || !uid || !jid) return { handled: false, reason: '事件字段不完整' };

  // 自动审批下行：只记审计，不重复处理
  if (ev?.auto_approved?.strategy_id) {
    store.appendAudit({
      kind: 'join', action: 'auto-approved', groupId: gid, userId: uid, userName: ev.username || '',
      detail: '平台自动审批已通过（下行通知）', confidence: 1,
    });
    return { handled: false, reason: '平台已自动审批' };
  }

  const existing = store.listPending(true).find((x) => x.groupId === gid && x.joinRequestId === jid);
  if (existing && existing.status === 'done') {
    return { handled: false, reason: '重复事件' };
  }

  const verify = verifyHuman(ev?.verify_info);
  const item = {
    joinRequestId: jid,
    memberOpenid: uid,
    username: String(ev?.username || ''),
    verifyMessage: verify,
    applySource: String(ev?.apply_source || ''),
    riskTips: String(ev?.risk_tips || ''),
    seenAt: new Date().toISOString(),
    status: 'pending',
    decision: '',
  };
  store.putPending(gid, item);

  const join = store.settings.join;
  let decision = 'pending';
  let reason = '等待管理员处理';
  let confidence = CONFIDENCE.manual;

  if (item.riskTips && join.autoDeclineRisk) {
    decision = 'decline';
    reason = `风险提示：${item.riskTips}`;
    confidence = CONFIDENCE.risk;
  } else if (includesAny(verify, join.declineKeywords)) {
    decision = 'decline';
    reason = '验证信息命中拒绝关键词';
    confidence = CONFIDENCE.keyword;
  } else if (join.autoApprove) {
    const allow = (join.approveKeywords || []).length === 0 || includesAny(verify, join.approveKeywords);
    if (allow && !item.riskTips) {
      decision = 'approve';
      reason = '命中自动通过策略';
      confidence = CONFIDENCE.keyword;
    }
  }

  const client = getClient();
  if (decision !== 'pending' && client) {
    const r = await client.approveJoinRequest(gid, uid, decision, { joinRequestId: jid });
    if (r.ok) {
      item.status = 'done';
      item.decision = decision;
      store.putPending(gid, item);
      store.incCounter(decision === 'approve' ? 'approvals' : 'declines');
      store.appendAudit({
        kind: 'join', action: decision, groupId: gid, userId: uid, userName: item.username,
        detail: reason, ok: true, confidence,
      });
      return { handled: true, decision, reason, confidence };
    }
    item.status = 'pending';
    item.decision = 'failed';
    item.error = r.err?.human || '审批调用失败';
    store.putPending(gid, item);
    store.appendAudit({
      kind: 'join', action: decision, groupId: gid, userId: uid, userName: item.username,
      detail: `${reason}；调用失败：${item.error}`, ok: false, code: r.err?.code || '', confidence,
    });
    return { handled: true, decision: 'pending', reason: `自动${decision === 'approve' ? '通过' : '拒绝'}失败：${item.error}`, confidence };
  }

  store.appendAudit({
    kind: 'join', action: 'pending', groupId: gid, userId: uid, userName: item.username,
    detail: `${reason}${verify ? `；验证「${verify}」` : ''}${item.riskTips ? `；风险：${item.riskTips}` : ''}`,
    confidence,
  });
  return { handled: true, decision, reason, confidence };
}

/**
 * 入群欢迎。
 * @param {Record<string, any>} ev
 * @param {{store: import('./store.js').Store, getClient: () => import('./qq-api.js').QQClient|undefined, appId?: string}} deps
 */
export async function handleMemberAdd(ev, deps) {
  const { store, getClient } = deps;
  const gid = String(ev?.group_openid || '').trim();
  const uid = String(ev?.member_openid || '').trim();
  if (!gid || !uid) return { handled: false };
  const username = String(ev?.username || '');
  store.upsertMember(gid, uid, { name: username || undefined });

  const welcome = store.settings.join.welcome;
  if (!welcome.enabled) return { handled: false };
  const client = getClient();
  if (!client) return { handled: false, reason: '机器人未连接' };

  const list = (welcome.variants || []).length ? welcome.variants : [welcome.template];
  const seedText = [
    welcome.seedSalt || 'qqbot-guard',
    deps.appId || '',
    gid,
    uid,
    dayKeyUtc8(),
  ].join('|');
  const raw = pickSeeded(list, seedText) || welcome.template;
  const groupName = store.state.groups[gid]?.name || '本群';
  const text = String(raw || '')
    .replace(/\{user\}/gu, mention(uid))
    .replace(/\{name\}/gu, username || '新朋友')
    .replace(/\{group\}/gu, groupName)
    .slice(0, LIMITS.warnMaxChars);
  if (!text.trim()) return { handled: false };

  const r = await client.sendGroupText(gid, text);
  store.appendAudit({
    kind: 'join', action: 'welcome', groupId: gid, groupName, userId: uid, userName: username,
    detail: r.ok ? '已发送入群欢迎' : `欢迎发送失败：${r.err?.human || ''}`,
    ok: r.ok, code: r.ok ? '' : r.err?.code || '', confidence: 1,
  });
  if (r.ok) store.incCounter('welcomes');
  return { handled: true, ok: r.ok };
}

/**
 * 从官方接口拉取某群待审批列表并合并到本地（面板“刷新”按钮用）。
 * @param {import('./qq-api.js').QQClient} client
 * @param {import('./store.js').Store} store
 * @param {string} gid
 */
export async function syncJoinRequests(client, store, gid) {
  const r = await client.listJoinRequests(gid, '', 50);
  if (!r.ok) return { ok: false, error: r.err?.human || '拉取失败', count: 0 };
  const list = Array.isArray(r.data?.list) ? r.data.list : [];
  let added = 0;
  for (const ev of list) {
    const jid = String(ev?.join_request_id || '').trim();
    const uid = String(ev?.member_openid || '').trim();
    if (!jid || !uid) continue;
    const existing = store.listPending(true).find((x) => x.groupId === gid && x.joinRequestId === jid);
    if (existing?.status === 'done') continue;
    store.putPending(gid, {
      joinRequestId: jid,
      memberOpenid: uid,
      username: String(ev?.username || ''),
      verifyMessage: verifyHuman(ev?.verify_info),
      applySource: String(ev?.apply_source || ''),
      riskTips: String(ev?.risk_tips || ''),
      seenAt: new Date().toISOString(),
      status: 'pending',
      decision: '',
    });
    added += 1;
  }
  return { ok: true, count: added, total: list.length };
}

/** 面板手动审批 */
export async function actOnJoinRequest({ client, store, gid, uid, jid, action, reason }, logger = console) {
  const op = action === 'approve' ? 'approve' : 'decline';
  const r = await client.approveJoinRequest(gid, uid, op, {
    joinRequestId: jid,
    rejectReason: op === 'decline' ? String(reason || '').slice(0, LIMITS.reasonMaxChars) : undefined,
  });
  if (r.ok) {
    store.removePending(gid, jid);
    store.incCounter(op === 'approve' ? 'approvals' : 'declines');
    store.appendAudit({
      kind: 'join', action: op, groupId: gid, userId: uid,
      detail: reason ? String(reason).slice(0, LIMITS.reasonMaxChars) : '管理员手动审批', ok: true, confidence: 1,
    });
    return { ok: true, action: op };
  }
  logger.warn?.('[qqbot-guard] 审批失败', r.err);
  store.appendAudit({
    kind: 'join', action: op, groupId: gid, userId: uid,
    detail: `审批失败：${r.err?.human || ''}`, ok: false, code: r.err?.code || '', confidence: 1,
  });
  return { ok: false, error: r.err?.human || '审批失败', code: r.err?.code || '' };
}
