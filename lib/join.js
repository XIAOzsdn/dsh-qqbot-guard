/** 入群审批、入群欢迎、观察期与入群答题。群事件由官方 GROUP_JOIN_REQUEST / GROUP_MEMBER_ADD 驱动。 */
import { CONFIDENCE, LIMITS } from './defaults.js';
import { effectiveJoin, effectiveModeration } from './config.js';
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

  const join = effectiveJoin(store.settings, gid);
  let decision = 'pending';
  let reason = '等待管理员处理';
  let confidence = CONFIDENCE.manual;

  if (store.isBlacklisted(gid, uid)) {
    decision = 'decline';
    reason = '该成员在黑名单中';
    confidence = CONFIDENCE.risk;
  } else if (item.riskTips && join.autoDeclineRisk) {
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
 * 入群欢迎 + 观察期 + 入群答题。
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
  const join = effectiveJoin(store.settings, gid);

  // 观察期：默认 10 分钟，按群可覆盖
  if (join.observation?.enabled && Number(join.observation.minutes) > 0) {
    store.setObserved(gid, uid, Date.now() + Number(join.observation.minutes) * 60_000);
  }

  const client = getClient();
  if (!client) return { handled: false, reason: '机器人未连接' };

  const quiz = join.quiz;
  if (quiz?.enabled && Array.isArray(quiz.questions) && quiz.questions.length) {
    const seedText = [
      join.welcome?.seedSalt || 'qqbot-guard', deps.appId || '', gid, uid, dayKeyUtc8(), 'quiz',
    ].join('|');
    const question = pickSeeded(quiz.questions, seedText) || quiz.questions[0];
    const timeoutSec = Math.max(30, Math.min(LIMITS.quizMaxTimeoutSec, Number(quiz.timeoutSec) || 180));
    store.setQuiz(gid, uid, {
      q: question.q,
      a: question.a,
      askedAt: new Date().toISOString(),
      expiresAt: Date.now() + timeoutSec * 1000,
      attempts: 0,
      maxAttempts: Number(quiz.maxAttempts) || 3,
      action: quiz.action || 'kick',
      name: username,
    });
    const askText = `${mention(uid)} 欢迎入群！请在 ${timeoutSec} 秒内回答下面的问题完成验证：\n${question.q}`;
    const r = await client.sendGroupText(gid, askText);
    store.appendAudit({
      kind: 'join', action: 'quiz-ask', groupId: gid, groupName: store.state.groups[gid]?.name || '',
      userId: uid, userName: username, detail: r.ok ? `入群答题：${question.q}` : `答题发送失败：${r.err?.human || ''}`,
      ok: r.ok, code: r.ok ? '' : r.err?.code || '', confidence: 1,
    });
    if (!quiz.askBeforeWelcome) {
      await sendWelcome({ store, client, gid, uid, username, appId: deps.appId, join });
    }
    return { handled: true, quiz: true, ok: r.ok };
  }

  const r = await sendWelcome({ store, client, gid, uid, username, appId: deps.appId, join });
  return { handled: true, ok: r.ok };
}

/** 发送入群欢迎（按群的 welcome 覆盖生效） */
async function sendWelcome({ store, client, gid, uid, username, appId, join }) {
  const welcome = join?.welcome || store.settings.join.welcome;
  if (!welcome?.enabled) return { ok: false, skipped: true };
  const list = (welcome.variants || []).length ? welcome.variants : [welcome.template];
  const seedText = [welcome.seedSalt || 'qqbot-guard', appId || '', gid, uid, dayKeyUtc8()].join('|');
  const raw = pickSeeded(list, seedText) || welcome.template;
  const groupName = store.state.groups[gid]?.name || '本群';
  const text = String(raw || '')
    .replace(/\{user\}/gu, mention(uid))
    .replace(/\{name\}/gu, username || '新朋友')
    .replace(/\{group\}/gu, groupName)
    .slice(0, LIMITS.warnMaxChars);
  if (!text.trim()) return { ok: false, skipped: true };
  const r = await client.sendGroupText(gid, text);
  store.appendAudit({
    kind: 'join', action: 'welcome', groupId: gid, groupName, userId: uid, userName: username,
    detail: r.ok ? '已发送入群欢迎' : `欢迎发送失败：${r.err?.human || ''}`,
    ok: r.ok, code: r.ok ? '' : r.err?.code || '', confidence: 1,
  });
  if (r.ok) store.incCounter('welcomes');
  return r;
}

/** 答案比对：去空白/标点、大小写无关；支持用 | / , 分隔多个可接受答案 */
export function answerMatches(text, answer) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
  const given = norm(text);
  if (!given) return false;
  return String(answer || '')
    .split(/[|/,，;；]+/u)
    .map((x) => norm(x))
    .filter(Boolean)
    .some((x) => given === x || (x.length >= 2 && given.includes(x)));
}

/**
 * 入群答题的答案处理（在普通违规检测之前调用）。
 * @param {{gid: string, uid: string, name?: string, text: string, msgId?: string}} input
 */
export async function handleQuizAnswer(input, deps) {
  const { store, getClient } = deps;
  const quiz = store.getQuiz(input.gid, input.uid);
  if (!quiz) return { handled: false };
  if (Date.now() > Number(quiz.expiresAt || 0)) {
    await failQuiz(quiz, deps, '答题超时');
    return { handled: true, action: 'quiz-timeout' };
  }
  const client = getClient();
  if (answerMatches(input.text, quiz.a)) {
    store.clearQuiz(input.gid, input.uid);
    store.appendAudit({
      kind: 'join', action: 'quiz-pass', groupId: input.gid, userId: input.uid,
      userName: quiz.name || input.name, detail: '入群答题通过', ok: true, confidence: 1,
    });
    if (client) {
      const join = effectiveJoin(store.settings, input.gid);
      await sendWelcome({
        store, client, gid: input.gid, uid: input.uid, username: quiz.name || input.name, appId: undefined, join,
      });
    }
    return { handled: true, action: 'quiz-pass' };
  }

  const attempts = Number(quiz.attempts || 0) + 1;
  const max = Math.max(1, Number(quiz.maxAttempts) || 3);
  if (attempts >= max) {
    await failQuiz({ ...quiz, attempts }, deps, `答题错误 ${attempts} 次`);
    return { handled: true, action: 'quiz-fail' };
  }
  store.setQuiz(input.gid, input.uid, { ...quiz, attempts });
  if (client) {
    await client.sendGroupText(
      input.gid,
      `${mention(input.uid)} 答案不正确，请重试（剩余 ${max - attempts} 次）`,
      { msgId: input.msgId },
    );
  }
  return { handled: true, action: 'quiz-retry' };
}

async function failQuiz(quiz, deps, reason) {
  const { store, getClient } = deps;
  store.clearQuiz(quiz.gid, quiz.uid);
  const client = getClient();
  const action = ['warn', 'mute', 'kick'].includes(quiz.action) ? quiz.action : 'kick';
  let ok = false;
  let code = 'NOT_CONNECTED';
  if (client) {
    let result;
    if (action === 'kick') {
      result = await client.removeMembers(quiz.gid, [quiz.uid]);
    } else if (action === 'mute') {
      const mod = effectiveModeration(store.settings, quiz.gid);
      result = await client.setMemberMute(quiz.gid, quiz.uid, mod.muteSeconds);
    } else {
      const mod = effectiveModeration(store.settings, quiz.gid);
      const text = String(mod.warnTemplate || '{user} 请注意群规。')
        .replace(/\{user\}/gu, mention(quiz.uid))
        .replace(/\{group\}/gu, store.state.groups[quiz.gid]?.name || '本群')
        .replace(/\{rule\}/gu, '入群答题');
      result = await client.sendGroupText(quiz.gid, text.slice(0, LIMITS.warnMaxChars));
    }
    ok = !!result?.ok;
    code = ok ? '' : result?.err?.code || 'ACTION_FAILED';
  }
  store.appendAudit({
    kind: 'join', action: 'quiz-fail', groupId: quiz.gid, userId: quiz.uid, userName: quiz.name || '',
    detail: `${reason}，已执行 ${action}`, ok, code, confidence: 1,
  });
  return { ok, action };
}

/** 调度器：清理超时的入群答题 */
export async function tickQuizzes(deps) {
  const { store } = deps;
  const expired = store.listExpiredQuizzes();
  let count = 0;
  for (const quiz of expired) {
    const current = store.getQuiz(quiz.gid, quiz.uid);
    if (!current) continue;
    await failQuiz(current, deps, '答题超时');
    count += 1;
  }
  return { count };
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
