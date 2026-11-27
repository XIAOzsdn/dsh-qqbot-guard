/** 入群审批、入群欢迎、观察期与入群答题。群事件由官方 GROUP_JOIN_REQUEST / GROUP_MEMBER_ADD 驱动。 */
import { CONFIDENCE, LIMITS } from './defaults.js';
import { effectiveJoin, effectiveModeration } from './config.js';
import { createSeeded, dayKeyUtc8, pickSeeded } from './rng.js';
import { mention } from './mention.js';

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

/** 入群审批 AI 是否在启用时段（北京时间；active = 群内最近有活跃） */
export function aiJoinActive(cfg, store, gid, now = Date.now()) {
  const schedule = cfg?.join?.schedule || {};
  const mode = schedule.mode || 'always';
  if (mode === 'always') return true;
  const hour = new Date(now + 8 * 3600_000).getUTCHours();
  const start = Number(schedule.dayStart ?? 8);
  const end = Number(schedule.dayEnd ?? 22);
  const inDay = start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
  if (mode === 'day') return inDay;
  if (mode === 'night') return !inDay;
  if (mode === 'active') {
    const seen = Date.parse(store?.state?.groups?.[gid]?.lastSeenAt || '');
    return Number.isFinite(seen) && now - seen <= Math.max(1, Number(schedule.idleMinutes) || 30) * 60_000;
  }
  return true;
}

/** 成员主动说“换题 / 太难了 / 不会”时触发换题 */
const CHANGE_WORDS = /换题|换一题|下一题|太难|不会|不知道|不清楚|跳过|skip/iu;

/** 本地兜底：种子驱动的简单算术题 */
function localEasyArithmetic(seedText) {
  const rng = createSeeded(seedText + '|easy-arithmetic');
  const op = rng.pick(['+', '-', '×']);
  if (op === '×') {
    const a = rng.int(1, 6);
    const b = rng.int(1, 6);
    return { q: `${a}×${b}=?`, a: String(a * b), qType: 'arithmetic', source: 'local' };
  }
  const a = rng.int(1, 10);
  const b = rng.int(1, 10);
  if (op === '-') {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return { q: `${hi}-${lo}=?`, a: String(hi - lo), qType: 'arithmetic', source: 'local' };
  }
  return { q: `${a}+${b}=?`, a: String(a + b), qType: 'arithmetic', source: 'local' };
}

/** 统一的提问文案：带上“换题”命令，照顾老人和小孩 */
function askTextOf(uid, question, timeoutSec) {
  const tail = timeoutSec ? `（${timeoutSec} 秒内有效）` : '';
  return `${mention(uid)} 请回答该问题以便验证是否为人机【若不会或不清楚答案是否正确时可输入“换题”】\n问：${question}${tail}`;
}

/**
 * 换一道题（优先 AI，失败回退本地题库 / 本地简单算术），并重新提问。
 * @returns {Promise<boolean>} 是否成功换题
 */
async function switchQuiz(quiz, deps, opts = {}) {
  const { store, getClient } = deps;
  const client = getClient();
  if (!client) return false;
  const join = effectiveJoin(store.settings, quiz.gid);
  const cfg = store.settings.ai;
  const switches = Number(quiz.switches || 0);
  const seed = `${quiz.seed || ''}|switch|${switches + 1}`;
  let next = null;
  if (deps.ai && cfg?.enabled && cfg.quiz?.enabled) {
    const r = await deps.ai.generateQuiz({
      gid: quiz.gid,
      uid: quiz.uid,
      seed,
      groupName: store.state.groups[quiz.gid]?.name || '',
      mode: opts.mode,
      easy: opts.easy === true,
    });
    if (r.ok) next = { q: r.question, a: r.answer, qType: r.type, source: 'ai' };
  }
  if (!next && opts.mode === 'arithmetic') {
    next = localEasyArithmetic(seed);
  }
  if (!next) {
    const pool = (join.quiz?.questions || []).filter((x) => x.q && x.q !== quiz.q);
    const picked = pickSeeded(pool, seed);
    if (picked) next = { q: picked.q, a: picked.a, qType: 'daily', source: 'local' };
  }
  if (!next && opts.easy === true) {
    next = localEasyArithmetic(seed);
  }
  if (!next) return false;
  const timeoutSec = Math.max(30, Math.min(LIMITS.quizMaxTimeoutSec, Number(join.quiz?.timeoutSec) || 180));
  store.setQuiz(quiz.gid, quiz.uid, {
    ...quiz,
    q: next.q,
    a: next.a,
    qType: next.qType,
    source: next.source,
    seed,
    attempts: 0,
    switches: switches + 1,
    askedAt: new Date().toISOString(),
    expiresAt: Date.now() + timeoutSec * 1000,
  });
  const sent = await client.sendGroupText(quiz.gid, askTextOf(quiz.uid, next.q, timeoutSec));
  store.appendAudit({
    kind: 'ai', action: 'quiz-switch', groupId: quiz.gid, userId: quiz.uid, userName: quiz.name || '',
    detail: `${opts.reason || '换题'}：${next.q}`,
    ok: sent.ok, code: sent.ok ? '' : sent.err?.code || '', confidence: 1,
  });
  return true;
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
  // 部分版本的事件不带 join_request_id，用成员 openid 兜底，避免整条申请被丢弃
  const requestKey = jid || `uid:${uid}`;
  if (!gid || !uid) return { handled: false, reason: '事件字段不完整' };

  // 自动审批下行：只记审计，不重复处理
  if (ev?.auto_approved?.strategy_id) {
    store.appendAudit({
      kind: 'join', action: 'auto-approved', groupId: gid, userId: uid, userName: ev.username || '',
      detail: '平台自动审批已通过（下行通知）', confidence: 1,
    });
    return { handled: false, reason: '平台已自动审批' };
  }

  const existing = store.listPending(true).find((x) => x.groupId === gid && x.joinRequestId === requestKey);
  if (existing && existing.status === 'done') {
    return { handled: false, reason: '重复事件' };
  }

  const verify = verifyHuman(ev?.verify_info);
  const item = {
    joinRequestId: requestKey,
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
  // 入群申请里带了昵称，先记进成员台账，方便面板按昵称搜索
  if (item.username) store.upsertMember(gid, uid, { name: item.username });

  const join = effectiveJoin(store.settings, gid);
  let decision = 'pending';
  let reason = '等待管理员处理';
  let confidence = CONFIDENCE.manual;
  // 拒绝时给申请人看的理由：默认用面板里设置的那条（以前从未传给官方接口，导致设置不生效）
  let rejectReason = String(join.rejectReason || '').trim();

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

  // AI 审批：只有明确且达标的结论才覆盖本地规则；AI 不确定/失败时保留本地决策，
  // 避免“验证答案正确却因为 AI 复核被卡成待审批”
  const aiCfg = store.settings.ai;
  const aiActive = !!deps.ai && aiCfg?.enabled && aiCfg.join?.enabled
    && decision !== 'decline' && aiJoinActive(aiCfg, store, gid);
  if (aiActive) {
    const byAi = await deps.ai.judgeJoin({
      gid,
      uid,
      name: item.username,
      verify,
      source: item.applySource,
      riskTips: item.riskTips,
      groupName: store.state.groups[gid]?.name || '',
    });
    if (byAi?.ok) {
      const aiConfidence = Math.max(0, Math.min(1, Number(byAi.confidence) || 0));
      if (byAi.verdict === 'review') {
        store.appendAudit({
          kind: 'ai', action: 'ai-join', groupId: gid, userId: uid, userName: item.username,
          detail: `AI 建议人工复核${byAi.reason ? '；' + byAi.reason : ''}`,
          ok: true, confidence: aiConfidence,
        });
        if (decision === 'pending') {
          item.aiVerdict = 'review';
          item.aiConfidence = aiConfidence;
          item.aiReason = byAi.reason || '';
          store.putPending(gid, item);
        }
      } else {
        const label = byAi.verdict === 'approve' ? '通过' : '拒绝';
        store.appendAudit({
          kind: 'ai', action: 'ai-join', groupId: gid, userId: uid, userName: item.username,
          detail: `AI 建议${label}（置信度 ${aiConfidence.toFixed(2)}，${byAi.provider}/${byAi.model}${byAi.cached ? '，命中缓存' : ''}）${byAi.reason ? '；' + byAi.reason : ''}`,
          ok: true, confidence: aiConfidence,
        });
        const confident = aiConfidence >= Number(aiCfg.minConfidence || 0);
        if (aiCfg.join.mode === 'auto' && confident) {
          decision = byAi.verdict === 'approve' ? 'approve' : 'decline';
          reason = `AI 判定：${byAi.reason || label}`;
          confidence = Math.max(confidence, aiConfidence);
          if (decision === 'decline') {
            // 本次是 AI 拍板的拒绝：由 AI 自己写简短说明，不再套用面板里的固定理由
            const aiText = String(byAi.rejectReason || byAi.reason || '')
              .replace(/\s+/gu, '').trim();
            if (aiText) rejectReason = aiText.slice(0, LIMITS.aiRejectReasonMaxChars);
          }
        } else if (decision === 'pending') {
          item.aiVerdict = byAi.verdict;
          item.aiConfidence = aiConfidence;
          item.aiReason = byAi.reason || '';
          store.putPending(gid, item);
        }
      }
    }
  }

  const client = getClient();
  if (decision !== 'pending' && client) {
    const r = await client.approveJoinRequest(gid, uid, decision, {
      joinRequestId: jid || undefined,
      ...(decision === 'decline' && rejectReason
        ? { rejectReason: rejectReason.slice(0, LIMITS.reasonMaxChars) }
        : {}),
    });
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
  const aiCfg = store.settings.ai;
  const useAiQuiz = !!deps.ai && aiCfg?.enabled && aiCfg.quiz?.enabled;
  const localQuestions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  if (useAiQuiz || (quiz?.enabled && localQuestions.length > 0)) {
    const seedText = [
      join.welcome?.seedSalt || 'qqbot-guard', deps.appId || '', gid, uid, dayKeyUtc8(), 'quiz',
    ].join('|');
    let question = null;
    if (useAiQuiz) {
      const generated = await deps.ai.generateQuiz({
        gid, uid, seed: seedText, groupName: store.state.groups[gid]?.name || '',
      });
      if (generated.ok) {
        question = {
          q: generated.question, a: generated.answer, qType: generated.type, source: 'ai',
        };
        store.appendAudit({
          kind: 'ai', action: 'ai-quiz', groupId: gid, userId: uid, userName: username,
          detail: `AI 出题（${generated.type === 'arithmetic' ? '算术' : '日常'}，${generated.provider}/${generated.model}）：${generated.question}`,
          ok: true, confidence: 1,
        });
      } else {
        store.appendAudit({
          kind: 'ai', action: 'ai-quiz', groupId: gid, userId: uid, userName: username,
          detail: `AI 出题失败${localQuestions.length ? '，回退本地题库' : '，本轮跳过验证'}：${generated.error || generated.code || ''}`,
          ok: false, code: generated.code || '', confidence: 0,
        });
      }
    }
    if (!question && localQuestions.length) {
      const picked = pickSeeded(localQuestions, seedText) || localQuestions[0];
      question = {
        q: picked.q, a: picked.a, qType: 'daily', source: 'local',
      };
    }
    if (!question) {
      const sent = await sendWelcome({
        store, client, gid, uid, username, appId: deps.appId, join,
      });
      return { handled: true, quiz: false, ok: sent.ok };
    }
    const timeoutSec = Math.max(30, Math.min(LIMITS.quizMaxTimeoutSec, Number(quiz.timeoutSec) || 180));
    store.setQuiz(gid, uid, {
      q: question.q,
      a: question.a,
      qType: question.qType,
      source: question.source,
      seed: seedText,
      askedAt: new Date().toISOString(),
      expiresAt: Date.now() + timeoutSec * 1000,
      attempts: 0,
      switches: 0,
      maxAttempts: Number(quiz.maxAttempts) || 3,
      action: quiz.action || 'kick',
      name: username,
    });
    const askText = askTextOf(uid, question.q, timeoutSec);
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
  const aiCfg = store.settings.ai;
  const text = String(input.text || '').trim();
  const maxSwitches = Math.max(0, Number(aiCfg?.quiz?.maxSwitches ?? 2));
  const switches = Number(quiz.switches || 0);

  // 主动换题：输入“换题 / 太难了 / 不会”时，换一道更简单的
  if (client && aiCfg?.quiz?.allowChange && CHANGE_WORDS.test(text) && switches < maxSwitches) {
    const switched = await switchQuiz(quiz, deps, {
      reason: '成员申请换题', mode: 'daily', easy: true,
    });
    if (switched) return { handled: true, action: 'quiz-switch' };
  }

  let passed = answerMatches(text, quiz.a);
  if (!passed && deps.ai && aiCfg?.enabled && aiCfg.quiz?.judge) {
    const graded = await deps.ai.gradeQuiz({
      question: quiz.q,
      expected: quiz.a,
      answer: text,
    });
    if (graded.ok && graded.correct) {
      passed = true;
      store.appendAudit({
        kind: 'ai', action: 'ai-grade', groupId: input.gid, userId: input.uid,
        userName: quiz.name || input.name,
        detail: `AI 判卷通过：${String(input.text || '').slice(0, 40)}（${graded.provider}/${graded.model}）`,
        ok: true, confidence: 0.9,
      });
    }
  }
  if (passed) {
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
  const switchAfter = Math.max(1, Number(aiCfg?.quiz?.switchAfterFails) || 2);
  // 日常题连续答错到阈值：换成算术题，照顾反应慢或确实不会的成员
  if (client && quiz.qType === 'daily' && attempts >= switchAfter && switches < maxSwitches) {
    const switched = await switchQuiz({ ...quiz, attempts }, deps, {
      reason: `日常题连续答错 ${attempts} 次，换成算术题`,
      mode: 'arithmetic',
    });
    if (switched) return { handled: true, action: 'quiz-switch' };
  }
  if (attempts >= max) {
    await failQuiz({ ...quiz, attempts }, deps, `答题错误 ${attempts} 次`);
    return { handled: true, action: 'quiz-fail' };
  }
  store.setQuiz(input.gid, input.uid, { ...quiz, attempts });
  if (client) {
    await client.sendGroupText(
      input.gid,
      `${mention(input.uid)} 答案不正确，请重试（剩余 ${max - attempts} 次）；实在不会可以输入“换题”`,
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
