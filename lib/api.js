/**
 * 共享 API 调度器：dsh 内置面板与独立局域网面板共用同一套路由与业务逻辑。
 * 认证 / 同源 / CSRF 由适配层负责；这里只做权限分级与业务处理。
 */
import { randomBytes } from 'node:crypto';
import { LIMITS } from './defaults.js';
import { normalizeSettings } from './config.js';
import { ok, fail } from './envelope.js';
import {
  createAnnouncement, deleteAnnouncement, listAnnouncements, pauseAnnouncement,
  publishAnnouncement, updateAnnouncement,
} from './announcements.js';
import { actOnJoinRequest, syncJoinRequests } from './join.js';
import { probeNetwork } from './compat.js';
import { readDeviceInfo } from './device.js';
import { mergeMemberRows } from './napcat.js';
import { applyWholeBan } from './whole-ban.js';
import { qrSvg } from './qr.js';

const PREFIX = '/api/qqbot-guard';

/** 统一把异常转成可读文案（面板直接展示） */
function errorTextOf(error) {
  return String(error?.message || error || '未知错误');
}

export function maskSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  // 官方 QQBot 已移除，不再回显 AppSecret
  if (copy.ai && typeof copy.ai === 'object') {
    const keySet = !!copy.ai.apiKey;
    copy.ai.apiKey = keySet ? '••••••••' : '';
    copy.ai.apiKeySet = keySet;
  }
  if (copy.napcat && typeof copy.napcat === 'object') {
    const tokenSet = !!copy.napcat.token;
    copy.napcat.token = tokenSet ? '••••••••' : '';
    copy.napcat.tokenSet = tokenSet;
    const webuiTokenSet = !!copy.napcat.webuiToken;
    copy.napcat.webuiToken = webuiTokenSet ? '••••••••' : '';
    copy.napcat.webuiTokenSet = webuiTokenSet;
  }
  return copy;
}

/** 设置补丁里只有“词/欢迎语”属于普通管理员可改的基础项 */
export function isBasicPatch(patch, prefix = '') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  const entries = Object.entries(patch);
  if (!entries.length) return false;
  return entries.every(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return isBasicPatch(value, path);
    }
    if (/^moderation\.(keywords|fuzzy\.extras)$/u.test(path)) return true;
    if (/^join\.welcome\.(template|variants)$/u.test(path)) return true;
    if (/^groups\.[^.]+\.moderation\.(keywords|fuzzy\.extras)$/u.test(path)) return true;
    if (/^groups\.[^.]+\.join\.welcome\.(template|variants)$/u.test(path)) return true;
    if (/^groups\.[^.]+\.__replace$/u.test(path) && value === true) return true;
    return false;
  });
}

export function createApi(runtime) {
  if (!runtime.challenges) runtime.challenges = new Map();
  const routes = [];
  const add = (path, methods, handler, opts = {}) => {
    routes.push({ path, methods, handler, role: opts.role || 'operator', public: !!opts.public });
  };

  const saveSettings = createSaveSettings(runtime);

  add('/health', ['GET'], async () => ok({ alive: true, uptimeMs: process.uptime() * 1000 }), { public: true });

  add('/bootstrap', ['GET'], async ({ auth }) => {
    const bot = runtime.getBot();
    const snap = runtime.store.snapshot();
    return ok({
      version: runtime.version,
      language: runtime.store.settings.language || '',
      needsLanguage: !runtime.store.settings.language,
      dataDir: runtime.dataDir,
      status: bot?.snapshot() || { configured: false, state: 'unconfigured' },
      settings: maskSettings(runtime.store.settings),
      groups: snap.groups,
      counts: {
        groupCount: snap.groupCount,
        memberCount: snap.memberCount,
        directoryCount: snap.directoryCount,
        scheduleCount: runtime.scheduler?.list?.().length || 0,
        pendingCount: snap.pendingCount,
        counters: snap.counters,
      },
      pending: runtime.store.listPending(),
      schedules: runtime.scheduler?.list?.() || [],
      announcements: listAnnouncements(runtime.store),
      audit: runtime.store.readAudit(60),
      blacklist: runtime.store.listBlacklist(),
      quizzes: runtime.store.listQuizzes(),
      compat: runtime.getCompat ? runtime.getCompat() : null,
      device: readDeviceInfo(),
      ai: runtime.ai?.status ? runtime.ai.status() : null,
      napcat: runtime.directory?.status ? runtime.directory.status() : null,
      security: runtime.auth ? runtime.auth.status() : null,
      panel: runtime.getPanelInfo ? runtime.getPanelInfo() : null,
      me: auth ? { role: auth.role, via: auth.via, ip: auth.ip || '' } : null,
    });
  });

  add('/compat', ['GET'], async ({ query }) => {
    const base = runtime.getCompat ? runtime.getCompat() : null;
    if (!base) return fail('COMPAT_UNAVAILABLE', '兼容性自检不可用');
    if (String(query.network || '') === '1') base.network = await probeNetwork();
    return ok(base, { confidence: 1 });
  });

  /**
   * 首次部署的语言选择：只允许在尚未选择语言时调用，
   * 选完立即生效并恢复插件服务（QQ 连接 / 面板登录）。
   */
  add('/language', ['POST'], async ({ body }) => {
    if (!runtime.needsLanguage?.()) {
      return fail('LANGUAGE_LOCKED', '界面语言已经选过了，可在设置 → 界面语言里修改');
    }
    const language = String(body?.language || '').trim();
    if (language !== 'zh-CN' && language !== 'en') {
      return fail('BAD_LANGUAGE', '语言只能是 zh-CN 或 en');
    }
    runtime.store.saveSettings({ ...runtime.store.settings, language });
    runtime.store.appendAudit({
      kind: 'config',
      action: 'set-language',
      userName: '首次部署',
      userId: '',
      detail: `界面语言：${language}`,
      confidence: 1,
    });
    void runtime.restartBot?.();
    return ok({ language });
  }, { public: true });

  add('/status', ['GET'], async () => {
    const bot = runtime.getBot();
    return ok({
      status: bot?.snapshot() || { configured: false, state: 'unconfigured' },
      counts: runtime.store.snapshot().counters,
      device: readDeviceInfo(),
      ai: runtime.ai?.status ? runtime.ai.status() : null,
      panel: runtime.getPanelInfo ? runtime.getPanelInfo() : null,
    });
  });

  add('/settings/challenge', ['POST'], async ({ auth }) => {
    if (auth.via !== 'panel') return ok({ step: 3, token: 'trusted-host' });
    const sid = auth.sessionId || 'anonymous';
    const now = Date.now();
    let item = runtime.challenges.get(sid);
    if (!item || item.expiresAt < now) item = { count: 0, token: '', expiresAt: now + 10 * 60_000 };
    item.count += 1;
    if (item.count >= 3) {
      item.token = randomBytes(24).toString('base64url');
      item.expiresAt = now + 10 * 60_000;
    }
    runtime.challenges.set(sid, item);
    return ok({ step: Math.min(item.count, 3), token: item.count >= 3 ? item.token : '' });
  });

  add('/settings', ['POST'], async ({ auth, body }) => {
    const patch = body?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail('BAD_PATCH', '缺少 patch');
    const basic = isBasicPatch(patch);
    if (auth.via === 'panel' && auth.role === 'operator' && !basic) {
      if (!consumeChallenge(runtime, auth, body?.confirmToken)) {
        return fail('CONFIRM_REQUIRED', '修改机器人设置需要完成三次确认', { extra: { needConfirm: 3 } });
      }
    }
    const result = saveSettings(patch, {
      actor: auth.via === 'panel'
        ? (auth.role === 'admin' ? '最高管理员' : '普通管理员')
        : '宿主设置页',
      ip: auth.ip || '',
      summary: summarizePatch(patch),
    });
    if (result.ok && auth.via === 'panel' && auth.role === 'operator' && !basic) {
      const summary = summarizePatch(patch);
      const queued = runtime.notifySettingsChange
        ? runtime.notifySettingsChange({ summary, role: auth.role, ip: auth.ip || '' })
        : null;
      result.data.notify = queued ? { queued: true, ...queued } : { queued: false, reason: '通知未启用' };
      result.data.summary = summary;
    }
    return result;
  });

  /** 校验通知对象：昵称必填；openid 可留空，留空时按昵称唯一匹配 */
  add('/notify/verify', ['POST'], async ({ body }) => {
    const name = String(body?.name || '').trim();
    const uid = String(body?.uid || '').trim();
    if (!name) {
      return ok({ matched: false, definite: false, reason: '请填写昵称' }, { confidence: 0.8 });
    }
    const store = runtime.store;

    // 没填 openid：按昵称找，群内唯一才 @
    if (!uid) {
      const list = store.findMembersByName('', name);
      const byUid = new Map(list.map((m) => [m.uid, m]));
      if (byUid.size === 1) {
        const hit = [...byUid.values()][0];
        return ok({ matched: true, nickname: hit.name, openid: hit.uid, source: 'name' }, { confidence: 1 });
      }
      const candidates = [...byUid.values()].slice(0, 5)
        .map((m) => ({ name: m.name, uid: m.uid, gid: m.gid }));
      if (byUid.size > 1) {
        return ok({
          matched: false, definite: true, nickname: name, openid: '', source: '', candidates,
          reason: `群里有 ${byUid.size} 位同名成员，请从成员列表选择，或补填 openid`,
        }, { confidence: 0.9 });
      }
      return ok({
        matched: false, definite: false, nickname: name, openid: '', source: '', candidates: [],
        reason: '成员台账里没有这个昵称；让该成员在群里发一句话后再试，或直接从成员列表选择',
      }, { confidence: 0.8 });
    }

    // 填了 openid：昵称与 openid 必须同时匹配同一位成员
    const ledger = store.findMembersByUid(uid);
    const expect = name.normalize('NFKC').toLowerCase();
    const ledgerHit = ledger.find((m) => String(m.name || '').normalize('NFKC').trim().toLowerCase() === expect);
    if (ledgerHit) {
      return ok({ matched: true, nickname: ledgerHit.name, openid: uid, source: 'ledger' }, { confidence: 1 });
    }
    let nickname = String(ledger.find((m) => m.name)?.name || '').trim();
    const client = runtime.getClient?.();
    if (client) {
      const r = await client.getUserInfo(uid);
      const official = String(r?.ok ? (r.data?.username || r.data?.nickname || '') : '').trim();
      if (official) nickname = official;
      if (official && official.normalize('NFKC').toLowerCase() === expect) {
        return ok({ matched: true, nickname: official, openid: uid, source: 'api' }, { confidence: 1 });
      }
    }
    const numeric = /^\d{5,12}$/u.test(uid);
    const candidates = store.searchMembersByName(name, 5)
      .map((m) => ({ name: m.name, uid: m.uid, gid: m.gid }));
    let reason;
    let definite = false;
    if (nickname) {
      reason = `openid 对应当前昵称「${nickname}」，与填写的「${name}」不一致`;
      definite = true;
    } else if (numeric) {
      reason = 'QQ 官方 Bot API 不提供 QQ 号，无法用 QQ 号 @ 成员；可以留空这一项按昵称匹配，或填写该成员的 openid';
      definite = !ledger.length;
    } else if (ledger.length) {
      reason = '台账里该成员没有昵称记录，机器人连接后才能向官方校验';
    } else {
      reason = '成员台账里没有该 openid；可以留空这一项按昵称匹配';
    }
    return ok({
      matched: false, nickname, openid: uid, source: '', candidates, reason, definite,
    }, { confidence: 0.9 });
  });

  /** 测试当前模型配置：用一条示例广告消息试跑（无视总开关，便于保存前验证） */
  add('/ai/test', ['POST'], async () => {
    const ai = runtime.ai;
    if (!ai || typeof ai.probe !== 'function') return fail('AI_OFF', 'AI 模块未初始化');
    const r = await ai.probe();
    if (!r.ok) {
      return fail('AI_TEST_FAILED', r.error || '模型测试失败', {
        extra: { code: r.code || '', status: r.status || null },
      });
    }
    return ok(r, { confidence: Number(r.confidence) || 0.9 });
  });

  add('/security/password', ['POST'], async ({ auth, body }) => {
    if (auth.role !== 'admin') return fail('FORBIDDEN', '只有最高管理员可以修改密码');
    if (!runtime.auth) return fail('AUTH_OFF', '认证模块未启用');
    const target = body?.target === 'operator' ? 'operator' : 'admin';
    const current = String(body?.currentPassword || '');
    const next = String(body?.newPassword || '');
    if (!runtime.auth.verify(current, 'admin')) return fail('BAD_PASSWORD', '当前最高管理员密码不正确');
    const r = runtime.auth.changePassword(target, next);
    if (!r.ok) return fail('PASSWORD_FAILED', r.error || '密码修改失败');
    runtime.store.appendAudit({
      kind: 'config', action: 'password',
      userName: auth.role === 'admin' ? '最高管理员' : '普通管理员',
      userId: auth.ip || '',
      detail: `修改${target === 'admin' ? '最高管理员' : '普通管理员'}密码`, confidence: 1,
    });
    return ok({ changed: target, security: runtime.auth.status() });
  }, { role: 'admin' });

  add('/announcements', ['POST'], async ({ body }) => {
    const { action, id, input, patch } = body || {};
    const store = runtime.store;
    const client = runtime.getClient();
    const directory = runtime.directory;
    if (action === 'create') {
      const r = createAnnouncement({ store, input });
      return r.ok ? ok(r.item) : fail('CREATE_FAILED', r.error);
    }
    if (action === 'update') {
      const r = updateAnnouncement({ store, id, patch });
      return r.ok ? ok(r.item) : fail('UPDATE_FAILED', r.error);
    }
    if (action === 'delete') {
      const r = deleteAnnouncement({ store, id });
      return r.ok ? ok({ deleted: id }) : fail('DELETE_FAILED', r.error);
    }
    if (action === 'pause') {
      const r = pauseAnnouncement({ store, id });
      return r.ok ? ok(r.item) : fail('PAUSE_FAILED', r.error);
    }
    if (action === 'publish') {
      const r = await publishAnnouncement({ store, client, directory, id });
      return r.ok
        ? ok({ item: r.item, sent: r.sent, total: r.total }, { confidence: 1 })
        : fail('PUBLISH_FAILED', r.error || '发布失败', { extra: { item: r.item || null } });
    }
    return fail('BAD_ACTION', '未知操作');
  }, { role: 'admin' });

  /**
   * 真·群公告（QQ 群公告）：需要 NapCat 协议端，且机器人是目标群管理员/群主。
   * list  -> 拉取指定群的公告（含“群规/发给新成员”类）
   * send  -> 发布一条群公告
   * delete-> 删除一条群公告（noticeId 必须来自 list）
   */
  add('/group-notices', ['POST'], async ({ body }) => {
    const { action, gid, content, image, pinned, confirmRequired, type, noticeId } = body || {};
    const directory = runtime.directory;
    if (!directory) return fail('NAPCAT_UNAVAILABLE', 'NapCat 成员目录不可用（真·群公告依赖协议端）');
    if (!directory.enabled()) return fail('NAPCAT_DISABLED', '请先在设置里启用 NapCat 成员目录并填写地址');
    if (!gid) return fail('BAD_GID', '缺少群 openid');
    if (action === 'list') {
      const r = await directory.getGroupNotices(String(gid));
      if (!r.ok) return fail('NOTICE_LIST_FAILED', r.error || '拉取公告失败');
      return ok({ notices: r.all || [], via: r.via, qqGroupId: r.qqGroupId });
    }
    if (action === 'send') {
      const r = await directory.sendGroupNotice({
        gid: String(gid),
        content: String(content || ''),
        image: String(image || ''),
        pinned: !!pinned,
        confirmRequired: !!confirmRequired,
        type: String(type || 'notice'),
      });
      if (!r.ok) return fail('NOTICE_SEND_FAILED', r.error || '发布公告失败');
      runtime.store.appendAudit({
        kind: 'announce', action: 'send-group-notice', groupId: String(gid),
        groupName: runtime.store.state.groups?.[String(gid)]?.name || '',
        detail: String(content || '').slice(0, LIMITS.auditSnippetChars),
        ok: true, confidence: 1,
      });
      return ok({ via: r.via, qqGroupId: r.qqGroupId });
    }
    if (action === 'delete') {
      const r = await directory.deleteGroupNotice({ gid: String(gid), noticeId: String(noticeId || '') });
      if (!r.ok) return fail('NOTICE_DELETE_FAILED', r.error || '删除公告失败');
      runtime.store.appendAudit({
        kind: 'announce', action: 'delete-group-notice', groupId: String(gid),
        groupName: runtime.store.state.groups?.[String(gid)]?.name || '',
        detail: `删除群公告 ${String(noticeId || '')}`,
        ok: true, confidence: 1,
      });
      return ok({ via: r.via, qqGroupId: r.qqGroupId, noticeId: r.noticeId });
    }
    return fail('BAD_ACTION', '未知操作');
  }, { role: 'admin' });

  add('/join', ['POST'], async ({ body }) => {
    const { action, gid, uid, jid, reason } = body || {};
    const client = runtime.getClient();
    if (!client) return fail('NOT_CONNECTED', '机器人未连接，请先检查 NapCat 是否在线、WS 地址是否正确');
    if (!gid) return fail('BAD_GID', '缺少群 openid');
    if (action === 'refresh') {
      const r = await syncJoinRequests(client, runtime.store, String(gid));
      return r.ok ? ok(r) : fail('REFRESH_FAILED', r.error || '刷新失败');
    }
    if (!uid) return fail('BAD_UID', '缺少成员 openid');
    const fallbackReason = String(runtime.store.settings.join.rejectReason || '').trim();
    const r = await actOnJoinRequest({
      client,
      store: runtime.store,
      gid: String(gid),
      uid: String(uid),
      jid: String(jid || ''),
      action,
      reason: String(reason || '').trim() || fallbackReason,
    }, runtime.logger);
    return r.ok ? ok(r) : fail('JOIN_ACTION_FAILED', r.error || '审批失败', { extra: { code: r.code } });
  }, { role: 'admin' });

  add('/members', ['GET'], async ({ query }) => {
    const gid = String(query.gid || '').trim();
    const q = String(query.q || '').trim();
    const directory = runtime.directory;
    // 协议端可用时顺手补全花名册（带缓存与失败退避，不会拖死面板）
    if (directory?.enabled?.()) {
      try {
        await directory.ensureFresh(gid ? [gid] : undefined);
      } catch { /* 目录不可用时保持本地台账可用 */ }
    }
    const merged = mergeMemberRows({
      ledger: runtime.store.listMembers(gid),
      directories: runtime.store.listDirectories(gid),
      query: q,
      limit: LIMITS.memberSearchLimit,
      selfQQ: directory?.selfQQ || '',
      allowUsers: runtime.store.settings?.commands?.allowUsers || [],
      trustedUsers: runtime.store.settings?.moderation?.trustedUsers || [],
    });
    const members = merged.rows;
    let total = merged.total;
    const seen = new Set(members.map((m) => `${m.gid}|${m.uid || 'qq:' + m.qq}`));
    // 待审批申请里也有昵称，一起返回方便按昵称找人
    const needle = q.normalize('NFKC').toLowerCase();
    for (const p of runtime.store.listPending()) {
      if (gid && p.groupId !== gid) continue;
      const key = `${p.groupId}|${p.memberOpenid}`;
      if (seen.has(key)) continue;
      const name = String(p.username || '');
      const uid = String(p.memberOpenid || '');
      if (needle && !name.normalize('NFKC').toLowerCase().includes(needle) && !uid.toLowerCase().includes(needle)) {
        continue;
      }
      total += 1;
      if (members.length >= LIMITS.memberSearchLimit) continue;
      members.push({
        gid: p.groupId,
        uid,
        name,
        lastSeenAt: p.seenAt || '',
        msgCount: 0,
        pending: true,
        source: 'official',
      });
      seen.add(key);
    }
    // 统一出口字段：台账里存的是 msgCount，前端历史上读的是 messageCount。
    // 在这里一次性补齐，避免两套前端各自猜字段名。
    for (const m of members) {
      if (m.messageCount === undefined) m.messageCount = Number(m.msgCount) || 0;
      if (m.msgCount === undefined) m.msgCount = m.messageCount;
    }
    return ok({
      members,
      total,
      napcat: directory?.status ? directory.status() : null,
    }, { confidence: 0.9 });
  });

  add('/members/sync', ['POST'], async ({ body }) => {
    const directory = runtime.directory;
    if (!directory) return fail('NAPCAT_UNAVAILABLE', 'NapCat 成员目录不可用');
    if (!directory.enabled()) return fail('NAPCAT_DISABLED', '请先在设置里启用 NapCat 成员目录并填写地址');
    const gid = String(body?.gid || '').trim();
    const result = await directory.sync(gid ? [gid] : undefined);
    if (result?.ok === false) return fail('NAPCAT_SYNC_FAILED', result.error || '同步失败');
    return ok(result);
  });

  /**
   * QQ 账号登录（普通账号，走协议端 WebUI）：
   * 面板不再要求填 AppID/AppSecret，也不用去开 QQ 客户端 ——
   * 这里直接读协议端的登录状态，未登录时给出二维码，扫码即登录。
   */
  add('/napcat/login', ['GET'], async () => {
    const webui = runtime.getNapcatWebui?.();
    if (!webui) return fail('NAPCAT_UNAVAILABLE', '协议端 WebUI 客户端不可用（请更新插件）');
    const state = await webui.status();
    const snap = runtime.getBot()?.snapshot?.() || {};
    let quick = [];
    if (state.configured && state.reachable && !state.isLogin) {
      try { quick = await webui.quickList(); } catch { quick = []; }
    }
    return ok({
      webui: state,
      account: { selfId: String(snap.selfId || state.uin || ''), nickname: state.nick || '' },
      quick,
    });
  });

  /** 取一张登录二维码；refresh=true 让协议端换一张（二维码约 2 分钟过期） */
  add('/napcat/login/qr', ['POST'], async ({ body }) => {
    const webui = runtime.getNapcatWebui?.();
    if (!webui) return fail('NAPCAT_UNAVAILABLE', '协议端 WebUI 客户端不可用（请更新插件）');
    try {
      const data = body?.refresh ? await webui.refreshQrcode() : await webui.qrcode();
      if (data.restarting) return fail('NAPCAT_RESTARTING', '协议端正在重启，请稍等几秒再取二维码');
      const svg = qrSvg(data.qrcodeUrl);
      if (!svg) return fail('QR_RENDER_FAILED', '二维码渲染失败，请重试');
      // dataUrl 让两套前端都能直接 <img src>，不用各自再引二维码库
      const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
      return ok({ qrcodeUrl: data.qrcodeUrl, svg, dataUrl });
    } catch (error) {
      return fail('NAPCAT_LOGIN_QR_FAILED', errorTextOf(error));
    }
  }, { role: 'admin' });

  /** 用协议端登录过的账号直接登录（不扫码、不开 QQ） */
  add('/napcat/login/quick', ['POST'], async ({ body }) => {
    const webui = runtime.getNapcatWebui?.();
    if (!webui) return fail('NAPCAT_UNAVAILABLE', '协议端 WebUI 客户端不可用（请更新插件）');
    const uin = String(body?.uin || '').trim();
    if (!uin) return fail('BAD_TARGET', '缺少 QQ 号');
    try {
      await webui.quickLogin(uin);
      return ok({ uin });
    } catch (error) {
      return fail('NAPCAT_QUICK_LOGIN_FAILED', errorTextOf(error));
    }
  }, { role: 'admin' });

  add('/napcat/test', ['POST'], async () => {
    const directory = runtime.directory;
    if (!directory) return fail('NAPCAT_UNAVAILABLE', 'NapCat 成员目录不可用');
    const result = await directory.test();
    if (!result.ok) return fail('NAPCAT_TEST_FAILED', result.error || '连接失败');
    return ok(result);
  });

  // 自动探测本机 NapCat / LLOneBot：找到就写回设置，新用户不用手填端口/token
  add('/napcat/discover', ['POST'], async () => {
    const directory = runtime.directory;
    if (!directory) return fail('NAPCAT_UNAVAILABLE', 'NapCat 成员目录不可用');
    const result = await directory.discover({ persist: true });
    if (!result.ok) return fail('NAPCAT_DISCOVER_FAILED', result.error || '没有发现可用的协议端');
    // token 已经写进设置，不回传给前端，避免明文出现在响应里
    const { token, ...safe } = result;
    return ok({ ...safe, tokenSet: !!token });
  });

  add('/members/action', ['POST'], async ({ body }) => {
    const { action, gid, uid, qq, seconds } = body || {};
    if (!gid) return fail('BAD_TARGET', '缺少群标识');
    if (action !== 'mute' && action !== 'unmute' && action !== 'kick') return fail('BAD_ACTION', '未知操作');
    const targetUid = String(uid || '').trim();
    const targetQQ = String(qq || '').trim();
    if (!targetUid && !targetQQ) return fail('BAD_TARGET', '缺少群或成员标识');

    if (targetUid) {
      const client = runtime.getClient();
      if (!client) return fail('NOT_CONNECTED', '机器人未连接');
      if (action === 'mute') {
        const secs = Math.max(1, Math.min(30 * 24 * 3600, Number(seconds) || runtime.store.settings.moderation.muteSeconds));
        const r = await client.setMemberMute(String(gid), String(targetUid), secs);
        return r.ok ? ok({ muted: true, seconds: secs }) : fail('MUTE_FAILED', r.err?.human || '禁言失败');
      }
      if (action === 'unmute') {
        const r = await client.setMemberMute(String(gid), String(targetUid), null);
        return r.ok ? ok({ muted: false }) : fail('UNMUTE_FAILED', r.err?.human || '解除禁言失败');
      }
      const r = await client.removeMembers(String(gid), [String(targetUid)]);
      return r.ok ? ok({ kicked: true }) : fail('KICK_FAILED', r.err?.human || '移出失败');
    }

    // 只有 QQ 号、没有 openid：走 NapCat/OneBot 的群管理接口兜底
    const directory = runtime.directory;
    if (!directory) return fail('NAPCAT_UNAVAILABLE', 'NapCat 成员目录不可用');
    const result = await directory.act({ gid: String(gid), qq: targetQQ, action, seconds });
    if (!result.ok) return fail('MEMBER_ACTION_FAILED', result.error || '操作失败');
    runtime.store.appendAudit({
      kind: 'moderation',
      action,
      groupId: String(gid),
      groupName: runtime.store.state.groups[gid]?.name || '',
      userId: 'qq:' + targetQQ,
      userName: directoryMemberName(runtime, String(gid), targetQQ),
      detail: `通过 NapCat 按 QQ 号执行${action === 'mute' ? `（${result.seconds} 秒）` : ''}`,
      ok: true,
      confidence: 1,
    });
    return ok(result);
  }, { role: 'admin' });

  add('/groups', ['POST'], async ({ body }) => {
    const { action, gid, name } = body || {};
    const id = String(gid || '').trim();
    if (!id) return fail('BAD_GID', '缺少群 openid');
    if (action === 'add' || action === 'rename') {
      runtime.store.upsertGroup(id, { name: String(name || '').trim().slice(0, LIMITS.groupNameMaxChars) });
      if (action === 'add') void runtime.getBot()?.refreshGroupInfo?.(id);
      return ok(runtime.store.state.groups[id]);
    }
    if (action === 'remove') {
      const existed = runtime.store.removeGroup(id);
      return existed ? ok({ removed: id }) : fail('NOT_FOUND', '群不在注册表里');
    }
    return fail('BAD_ACTION', '未知操作');
  }, { role: 'admin' });

  add('/blacklist', ['GET'], async ({ query }) => ok({ items: runtime.store.listBlacklist(String(query.gid || '')) }));

  add('/blacklist', ['POST'], async ({ body }) => {
    const { action, gid, uid, reason, name } = body || {};
    if (!gid || !uid) return fail('BAD_TARGET', '缺少群或成员标识');
    if (action === 'add') {
      runtime.store.addBlacklist(gid, uid, { reason, name, by: 'manual' });
      runtime.store.appendAudit({
        kind: 'config', action: 'blacklist-add', groupId: gid, userId: uid, userName: name || '',
        detail: `手动加入黑名单：${reason || '未填写原因'}`, confidence: 1,
      });
      return ok({ added: true });
    }
    if (action === 'remove') {
      const removed = runtime.store.removeBlacklist(gid, uid);
      runtime.store.appendAudit({
        kind: 'config', action: 'blacklist-remove', groupId: gid, userId: uid,
        detail: '手动移出黑名单', ok: removed, confidence: 1,
      });
      return removed ? ok({ removed: true }) : fail('NOT_FOUND', '黑名单里没有该成员');
    }
    return fail('BAD_ACTION', '未知操作');
  }, { role: 'admin' });

  add('/audit', ['GET'], async ({ query }) => {
    const items = runtime.store.queryAudit({
      kind: String(query.kind || ''),
      groupId: String(query.groupId || ''),
      userId: String(query.userId || ''),
      limit: Number(query.limit || 100),
    });
    return ok({ items });
  });

  /** 修改日志：只保留设置保存 / 密码修改 / 配置导入，不含群内通知投递结果 */
  add('/changelog', ['GET'], async ({ query }) => {
    const keyword = String(query.keyword || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(LIMITS.auditMemory, Number(query.limit) || 200));
    const items = runtime.store.queryAudit({ kind: 'config', limit: LIMITS.auditMemory })
      .filter((x) => x.action !== 'notify')
      .filter((x) => !keyword || [x.detail, x.userName, x.userId, x.action]
        .some((v) => String(v || '').toLowerCase().includes(keyword)))
      .slice(0, limit);
    return ok({ items, limit, max: LIMITS.auditMemory });
  });

  /** 立即全员禁言 / 解除（优先 NapCat 群级开关，否则逐人禁言） */
  add('/whole-ban', ['POST'], async ({ body }) => {
    const gid = String(body?.gid || '').trim();
    if (!gid) return fail('BAD_GID', '缺少群号');
    const enable = body?.enable !== false;
    const client = runtime.getClient();
    if (!client) return fail('BOT_NOT_READY', '机器人未连接');
    const seconds = Math.max(1, Number(body?.seconds) || runtime.store.settings.moderation.muteSeconds);
    const r = await applyWholeBan({ store: runtime.store, client, gid, enable, seconds });
    if (!r?.ok) return fail('WHOLE_BAN_FAILED', r?.error || '执行失败');
    if (enable && seconds > 0 && runtime.scheduler) {
      runtime.scheduler.add({
        gid, kind: 'whole-unban', at: Date.now() + seconds * 1000, seconds: 0, createdBy: 'panel',
      });
    }
    const detail = r.groupLevel
      ? `${enable ? '开启' : '解除'}全员禁言（协议端群级开关）`
      : `${enable ? '逐人禁言' : '逐人解禁'} ${r.done} 人（失败 ${r.failed}）`;
    runtime.store.appendAudit({
      kind: 'command', action: enable ? 'whole-ban' : 'whole-unban', groupId: gid,
      groupName: runtime.store.state.groups?.[gid]?.name || '',
      detail,
      ok: true, confidence: 1,
    });
    return ok({ via: r.via, done: r.done, failed: r.failed, groupLevel: !!r.groupLevel });
  });

  add('/schedules', ['GET'], async () => ok({ schedules: runtime.scheduler?.list?.() || [] }));

  /** 新增一条定时任务：{ gid, kind, at, repeat?, time?, uid?, qq?, seconds? } */
  add('/schedules', ['POST'], async ({ body }) => {
    const sch = runtime.scheduler;
    if (!sch) return fail('SCHEDULER_UNAVAILABLE', '定时任务引擎未启动');
    const gid = String(body?.gid || '').trim();
    if (!gid) return fail('BAD_GID', '缺少群号');
    const kind = String(body?.kind || '').trim();
    const at = Number(body?.at);
    const r = sch.add({
      gid,
      kind,
      at,
      repeat: body?.repeat === 'daily' ? 'daily' : 'once',
      time: String(body?.time || ''),
      uid: String(body?.uid || ''),
      qq: String(body?.qq || ''),
      seconds: Number(body?.seconds) || 0,
      createdBy: String(body?.createdBy || 'panel'),
    });
    if (!r.ok) return fail('SCHEDULE_REJECTED', r.error);
    return ok({ schedule: r.item });
  });

  add('/schedules/cancel', ['POST'], async ({ body }) => {
    const sch = runtime.scheduler;
    if (!sch) return fail('SCHEDULER_UNAVAILABLE', '定时任务引擎未启动');
    const id = String(body?.id || '').trim();
    const r = sch.cancel(id);
    if (!r.ok) return fail('SCHEDULE_NOT_FOUND', r.error);
    return ok({ removed: r.removed });
  });

  add('/config/export', ['GET'], async ({ query }) => {
    const includeSecrets = String(query.secrets || '') === '1';
    const settings = JSON.parse(JSON.stringify(runtime.store.settings));
    if (!includeSecrets) {
      if (settings.napcat) {
        delete settings.napcat.token;
        delete settings.napcat.webuiToken;
      }
      if (settings.ai) delete settings.ai.apiKey;
    }
    return ok({
      version: runtime.version,
      exportedAt: new Date().toISOString(),
      settings,
      announcements: runtime.store.announcements.items,
      blacklist: runtime.store.listBlacklist(),
      groups: runtime.store.state.groups,
      includeSecrets,
    }, { confidence: 1 });
  }, { role: 'admin' });

  add('/config/import', ['POST'], async ({ auth, body }) => {
    if (auth.via === 'panel' && !consumeChallenge(runtime, auth, body?.confirmToken)) {
      return fail('CONFIRM_REQUIRED', '导入配置需要完成三次确认', { extra: { needConfirm: 3 } });
    }
    const data = body?.data;
    if (!data || typeof data !== 'object') return fail('BAD_IMPORT', '导入数据格式不正确');
    const merged = mergeSettingsSafe(runtime.store.settings, data.settings || {});
    const { value, errors } = normalizeSettings(merged);
    const hardErrors = errors.filter((x) => !x.includes('已忽略'));
    if (hardErrors.length) return fail('INVALID_SETTINGS', hardErrors.join('；'), { extra: { errors } });
    runtime.store.saveSettings(value);
    if (Array.isArray(data.announcements)) {
      runtime.store.announcements.items = data.announcements.slice(0, LIMITS.announcementHistory);
      runtime.store.saveAnnouncements();
    }
    if (Array.isArray(data.blacklist)) {
      for (const item of data.blacklist.slice(0, LIMITS.blacklistMax)) {
        if (item?.gid && item?.uid) runtime.store.addBlacklist(item.gid, item.uid, item);
      }
    }
    runtime.store.appendAudit({
      kind: 'config', action: 'import',
      userName: auth.via === 'panel' ? '最高管理员' : '宿主设置页',
      userId: auth.ip || '',
      detail: '导入配置与数据', confidence: 1,
    });
    runtime.applyPanelSettings?.();
    runtime.restartBot?.();
    return ok({ imported: true, warnings: errors });
  }, { role: 'admin' });

  return {
    routes,
    saveSettings,
    async dispatch(req) {
      const method = String(req.method || 'GET').toUpperCase();
      const path = String(req.path || '/').replace(/\/+$/u, '') || '/';
      const candidates = routes.filter((r) => r.path === path);
      if (!candidates.length) return fail('NOT_FOUND', '接口不存在');
      const route = candidates.find((r) => r.methods.includes(method));
      if (!route) return fail('METHOD_NOT_ALLOWED', '方法不允许');
      const auth = req.auth || { role: 'operator', via: 'unknown' };
      const needsLanguage = !!runtime.needsLanguage?.();
      // 首次部署未选语言：除 bootstrap / 选语言 / 健康检查外，其余接口一律拒绝
      if (needsLanguage && !['/bootstrap', '/language', '/health'].includes(path)) {
        return fail('LANGUAGE_REQUIRED', '请先选择界面语言，首次部署不允许绕过');
      }
      // 选语言前允许匿名读 bootstrap（只返回语言状态与脱敏设置），否则前端无法知道该选语言
      if (!route.public && !auth.role && !(needsLanguage && path === '/bootstrap')) {
        return fail('UNAUTHORIZED', '请先登录');
      }
      if (route.role === 'admin' && auth.role !== 'admin') return fail('FORBIDDEN', '需要最高管理员权限');
      try {
        return await route.handler({
          method,
          path,
          query: req.query || {},
          body: req.body === undefined ? {} : req.body,
          headers: req.headers || {},
          auth,
          ip: req.ip || '',
        });
      } catch (error) {
        runtime.logger?.warn?.('[qqbot-guard] API 处理异常：' + (error instanceof Error ? error.message : String(error)));
        return fail('INTERNAL', '服务器内部错误，已安全降级');
      }
    },
  };
}

/** 供 index.js 使用的保存入口（会触发重连 / 面板重启） */
export function createSaveSettings(runtime) {
  return (patch, meta = {}) => {
    const merged = mergeSettingsSafe(runtime.store.settings, patch);
    const { value, errors } = normalizeSettings(merged);
    const hardErrors = errors.filter((x) => !x.includes('已忽略'));
    if (hardErrors.length) {
      return fail('INVALID_SETTINGS', hardErrors.join('；'), { extra: { errors } });
    }
    const before = {
      panel: JSON.stringify(runtime.store.settings.panel),
      napcat: JSON.stringify(runtime.store.settings.napcat),
    };
    runtime.store.saveSettings(value);
    const summary = Array.isArray(meta.summary) ? meta.summary : summarizePatch(patch);
    runtime.store.appendAudit({
      kind: 'config',
      action: 'update',
      userName: meta.actor || '宿主设置页',
      userId: meta.ip || '',
      detail: summary.length ? summary.join('；') : '保存设置',
      confidence: 1,
    });
    if (before.transport !== value.transport) {
      runtime.restartBot();
    } else if (!value.autoConnect) {
      void runtime.getBot()?.stop?.();
    } else {
      const bot = runtime.getBot();
      if (value.napcat?.enabled && value.napcat?.wsUrl) {
        if (!bot || !bot.configured?.() || bot.state === 'error' || bot.state === 'disconnected') {
          void runtime.startBot?.();
        }
      }
    }
    if (before.panel !== JSON.stringify(value.panel)) {
      // 让当前 HTTP 响应先返回，再重启面板，避免浏览器拿到断开的连接
      const timer = setTimeout(() => { void runtime.applyPanelSettings?.(); }, 400);
      if (timer.unref) timer.unref();
    }
    if (before.napcat !== JSON.stringify(value.napcat)) {
      runtime.directory?.reconfigure?.();
    }
    return ok(maskSettings(value), { extra: { warnings: errors } });
  };
}

function mergeSettingsSafe(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (key === 'apiKey' && (val === '' || /^[•*]+$/u.test(String(val)))) continue;
    // NapCat token 与密钥一样：面板拿到的是掩码，留空/掩码都表示不修改
    if (key === 'token' && (val === '' || /^[•*]+$/u.test(String(val)))) continue;
    // 协议端 WebUI 令牌同理：不回显，留空或掩码表示保持原值
    if (key === 'webuiToken' && (val === '' || /^[•*]+$/u.test(String(val)))) continue;
    // 按群覆盖采用“整群替换”：传 null 即可删除该群覆盖
    if (key === 'groups' && val && typeof val === 'object' && !Array.isArray(val)) {
      const current = out.groups && typeof out.groups === 'object' && !Array.isArray(out.groups) ? out.groups : {};
      const next = { ...current };
      for (const [gid, override] of Object.entries(val)) {
        if (override === null) {
          delete next[gid];
        } else if (override && typeof override === 'object' && override.__replace === true) {
          const copy = { ...override };
          delete copy.__replace;
          next[gid] = copy;
        } else {
          next[gid] = mergeSettingsSafe(current[gid] || {}, override);
        }
      }
      out.groups = next;
      continue;
    }
    // napcat.groupMap 是“整张映射表”：面板里删掉一行就必须真的删掉，不能深合并留旧键
    if (key === 'napcat' && val && typeof val === 'object' && !Array.isArray(val)) {
      const current = out.napcat && typeof out.napcat === 'object' && !Array.isArray(out.napcat) ? out.napcat : {};
      const nextNapcat = mergeSettingsSafe(current, val);
      if (val.groupMap && typeof val.groupMap === 'object' && !Array.isArray(val.groupMap)) {
        nextNapcat.groupMap = { ...val.groupMap };
      }
      out.napcat = nextNapcat;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeSettingsSafe(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function directoryMemberName(runtime, gid, qq) {
  const entry = runtime.store.getDirectory(gid);
  const member = (entry?.members || []).find((x) => x.qq === String(qq));
  return String(member?.card || member?.nickname || '').slice(0, 100);
}

function consumeChallenge(runtime, auth, token) {
  if (!auth || auth.via !== 'panel') return true;
  const sid = auth.sessionId || 'anonymous';
  const item = runtime.challenges.get(sid);
  if (!item || item.expiresAt < Date.now() || !item.token || !token) return false;
  if (String(item.token) !== String(token)) return false;
  runtime.challenges.delete(sid);
  return true;
}

/** 把设置补丁转成可读的变更摘要（不包含密钥） */
export function summarizePatch(patch, prefix = '', out = []) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('__')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      summarizePatch(value, path, out);
    } else if (/secret|token|apiKey/iu.test(path)) {
      out.push(`${prettyPath(path)}：已更新（已隐藏）`);
    } else {
      const text = Array.isArray(value) ? value.join('、') : String(value);
      out.push(`${prettyPath(path)}：${prettyValue(path, value).slice(0, 80)}${text.length > 80 ? '…' : ''}`);
    }
    if (out.length >= 12) break;
  }
  return out;
}

const PATH_LABELS = Object.freeze({
  'napcat.autoStart': '协议端自动启动',
  'napcat.startCommand': '协议端启动命令',
  'napcat.webuiUrl': '协议端 WebUI 地址',
  'napcat.webuiToken': '协议端 WebUI 令牌',
  'autoConnect': '自动连接',
  'watchJoinRequests': '轮询入群申请',
  'moderation.enabled': '违规防护开关',
  'moderation.action': '违规动作',
  'moderation.muteSeconds': '禁言时长',
  'moderation.cooldownSec': '处置冷却',
  'moderation.keywords': '违规词',
  'moderation.regexes': '正则规则',
  'moderation.detectLinks': '链接检测',
  'moderation.linkWhitelist': '链接白名单',
  'moderation.exemptGroups': '豁免群',
  'moderation.trustedUsers': '信任成员',
  'moderation.fuzzy.enabled': '模糊匹配',
  'moderation.fuzzy.extras': '模糊别名',
  'moderation.media.detectImages': '图片广告检测',
  'moderation.media.detectCards': '卡片检测',
  'moderation.media.adKeywords': '图片广告词',
  'moderation.blacklist.enabled': '累计黑名单',
  'moderation.blacklist.threshold': '黑名单触发次数',
  'moderation.blacklist.windowDays': '黑名单统计天数',
  'moderation.spam.enabled': '刷屏检测',
  'moderation.spam.windowSec': '刷屏窗口',
  'moderation.spam.maxMessages': '刷屏条数',
  'moderation.escalation.enabled': '违规升级',
  'moderation.escalation.violations': '升级触发次数',
  'moderation.escalation.action': '升级动作',
  'join.autoApprove': '关键词自动通过',
  'join.autoDeclineRisk': '风险自动拒绝',
  'join.approveKeywords': '通过关键词',
  'join.declineKeywords': '拒绝关键词',
  'join.rejectReason': '拒绝理由',
  'guest.enabled': '普通用户通道',
  'guest.aiEnabled': '普通用户通道调用 AI',
  'guest.perMinute': '普通用户通道每分钟上限',
  'guest.cooldownSec': '普通用户通道冷却',
  'guest.replyMaxChars': '普通用户通道回复字数',
  'guest.muteSeconds': '普通用户通道越权禁言',
  'guest.emotionalMuteSeconds': '感情牌夹带指令禁言',
  'guest.persona': '普通用户通道人设',
  'guest.guardKeywords': '普通用户通道拦截词',
  'join.welcome.enabled': '入群欢迎',
  'join.welcome.template': '欢迎模板',
  'join.welcome.variants': '欢迎语变体',
  'join.observation.enabled': '观察期开关',
  'join.observation.minutes': '观察时长（分钟）',
  'join.observation.action': '观察期动作',
  'join.observation.blockLinks': '观察期禁链接',
  'join.observation.blockImages': '观察期禁图片',
  'join.quiz.enabled': '入群答题',
  'join.quiz.timeoutSec': '答题超时',
  'join.quiz.maxAttempts': '答题次数',
  'join.quiz.action': '答题失败动作',
  'commands.enabled': '群指令开关',
  'commands.naturalEnabled': '自然语言指令',
  'commands.followUpSec': '免@续聊窗口（秒）',
  'commands.restartConfirmSec': '重启二次确认（秒）',
  'commands.prefix': '指令前缀',
  'commands.allowUsers': '指令白名单',
  'commands.ruleText': '群规文本',
  'panel.enabled': '面板开关',
  'panel.host': '面板监听地址',
  'panel.port': '面板端口',
  'panel.notifyName': '变更通知对象昵称',
  'panel.notifyOpenid': '变更通知对象 openid',
  'announcements.enabled': '公告开关',
  'ai.master': 'AI 总开关',
  'guest.stickers': '表情包图片',
  'guest.stickerChance': '表情包概率',
  'guest.emojis': '兜底 emoji',
    'ai.enabled': 'AI 审核开关',
  'ai.provider': 'AI 接入方式',
  'ai.baseUrl': 'AI 接口地址',
  'ai.apiKey': 'AI 密钥',
  'ai.model': 'AI 模型',
  'ai.timeoutMs': 'AI 超时',
  'ai.maxTokens': 'AI 最大输出',
  'ai.minConfidence': 'AI 最低置信度',
  'ai.vision.enabled': 'AI 图片分析',
  'ai.vision.maxImages': '单条图片上限',
  'ai.vision.maxBytes': '单张图片大小上限',
  'ai.moderation.enabled': '违规防护 AI',
  'ai.moderation.mode': '违规防护 AI 模式',
  'ai.moderation.analyzeImages': '违规防护图片分析',
  'ai.moderation.minChars': 'AI 最短检测字数',
  'ai.moderation.maxPerMinute': 'AI 每分钟上限',
  'ai.join.enabled': '入群审批 AI',
  'ai.join.mode': '入群审批 AI 模式',
  'ai.join.schedule.mode': 'AI 审批时段',
  'ai.join.schedule.dayStart': '白天开始小时',
  'ai.join.schedule.dayEnd': '白天结束小时',
  'ai.join.schedule.idleMinutes': '活跃判定分钟',
  'ai.quiz.enabled': 'AI 入群出题',
  'ai.quiz.mode': 'AI 出题类型',
  'ai.quiz.judge': 'AI 判卷',
  'ai.quiz.switchAfterFails': '答错换题阈值',
  'ai.quiz.allowChange': '允许成员换题',
  'ai.quiz.maxSwitches': '最多换题次数',
  'napcat.enabled': 'NapCat 成员目录',
  'napcat.wsUrl': 'NapCat WebSocket 地址',
  'napcat.token': 'NapCat token',
  'napcat.autoSync': '成员页自动同步',
  'napcat.noCache': '绕过协议端缓存',
  'napcat.cacheTtlMs': '成员目录缓存时长',
  'napcat.timeoutMs': 'NapCat 调用超时',
  'napcat.groupMap': '官方群与 QQ 群映射',
});

function prettyPath(path) {
  if (PATH_LABELS[path]) return PATH_LABELS[path];
  const group = path.match(/^groups\.([^.]+)\.(.+)$/u);
  if (group) return `群 ${group[1]} · ${prettyPath(group[2])}`;
  return path;
}

function prettyValue(path, value) {
  if (/action$/u.test(path)) {
    return ({ warn: '警告', mute: '禁言', kick: '移出' })[value] || String(value);
  }
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return String(value);
}

export { PREFIX };
