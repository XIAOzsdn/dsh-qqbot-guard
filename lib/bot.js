/**
 * 连接管理：一条 QQ WebSocket 连接，只订阅群事件。
 * 不含任何会话/模型逻辑；所有业务处理都是事件驱动 + 有上限的内存缓存。
 */
import { LIMITS } from './defaults.js';
import { NapCatClient } from './napcat-client.js';
import { NapCatTransport } from './napcat-transport.js';
import { probeTcp, spawnBackend, wsTarget } from './onebot-backend.js';
import { Moderation } from './moderation.js';
import { handleJoinRequest, handleMemberAdd, handleQuizAnswer, tickQuizzes } from './join.js';
import { publishAnnouncement, tickAnnouncements } from './announcements.js';
import { extractMentionUids } from './natural.js';

export class BotManager {
  /**
   * @param {{store: import('./store.js').Store, logger: any, watchJoinRequests: boolean}} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.logger = deps.logger || console;
    // v2.1.0 起只使用普通 QQ 账号（NapCat / OneBot）；官方 QQBot 服务已移除
    this.appId = '';
    this.watchJoinRequests = !!deps.watchJoinRequests;
    this.getDirectory = deps.getDirectory;
    this.transportMode = 'napcat';
    this.client = undefined;
    this.napcatTransport = undefined;
    this.napcatClient = undefined;
    this.ai = deps.ai;
    this.moderation = new Moderation({
      store: this.store, getClient: () => this.client, logger: this.logger, ai: this.ai,
      getDirectory: deps.getDirectory,
      getScheduler: deps.getScheduler,
      saveSettings: deps.saveSettings,
      requestRecharge: deps.requestRecharge,
      rechargeReply: deps.rechargeReply,
      sendAnnouncement: (item) => publishAnnouncement({
        store: this.store,
        client: this.client,
        id: item?.id,
        directory: this.getDirectory?.(),
      }),
      notifyTrustedAbuse: deps.notifyTrustedAbuse,
      restartService: deps.restartService,
    });
    this.bot = undefined;
    this.state = 'disconnected';
    this.lastError = '';
    this.connectedAt = 0;
    this.startedAt = Date.now();
    this.degraded = false;
    this.usedExtraIntent = false;
    this.reconnectTimer = undefined;
    this.reconnectDelay = LIMITS.reconnectMinMs;
    this.schedulerTimer = undefined;
    this.groupRefresh = new Map();
    this.userRefresh = new Map();
    this.backendSpawnedAt = 0;
    this.stopping = false;
  }

  configured() {
    const cfg = this.store?.settings?.napcat || {};
    return !!(cfg.enabled && cfg.wsUrl);
  }

  /** 启动连接（失败自动退避重连，绝不抛给调用方） */
  async start() {
    if (!this.configured()) {
      this.state = 'unconfigured';
      return false;
    }
    if (this.bot || this.state === 'connecting') return true;
    this.stopping = false;
    this.state = 'connecting';
    this.lastError = '';
    try {
      await this.startOnce();
      return true;
    } catch (error) {
      const text = errorText(error);
      // 失败的 NapCat 传输层要关掉，避免它自己的重连与 BotManager 的重连叠加
      try { this.napcatTransport?.close(); } catch { /* ignore */ }
      this.napcatTransport = undefined;
      // 入群申请 intent 未授权时，降级为普通群事件再试一次，避免整条连接不可用。
      if (this.watchJoinRequests && /4914|4915|intent/iu.test(text)) {
        this.watchJoinRequests = false;
        this.degraded = true;
        this.logger.warn?.('[qqbot-guard] 入群申请 intent 未授权，降级为普通群事件后重试');
        try {
          await this.startOnce();
          return true;
        } catch (error2) {
          this.state = 'error';
          this.lastError = errorText(error2);
          this.scheduleReconnect();
          return false;
        }
      }
      this.state = 'error';
      this.lastError = text;
      this.logger.warn?.(`[qqbot-guard] 连接失败：${this.lastError}`);
      this.scheduleReconnect();
      return false;
    }
  }

  /** 只保留 QQ 普通账号（NapCat / OneBot）通路；官方 QQBot 已移除 */
  async startOnce() {
    return this.startNapcat();
  }


  /**
   * NapCat 模式：用普通 QQ 账号（协议端）收发与管理。
   * 事件是 OneBot v11；这里转成内部统一的 mCtx 后走同一套业务逻辑。
   */
  async startNapcat() {
    const cfg = this.store?.settings?.napcat || {};
    await this.ensureBackend(cfg);
    this.napcatTransport = new NapCatTransport({
      url: cfg.wsUrl,
      token: cfg.token,
      logger: this.logger,
      timeoutMs: Math.max(2000, Number(cfg.timeoutMs) || 5000),
      onState: (state) => {
        if (state === 'online') {
          this.state = 'online';
          this.connectedAt = Date.now();
          this.reconnectDelay = LIMITS.reconnectMinMs;
          this.startScheduler();
          this.logger.info?.(`[qqbot-guard] NapCat 已连接（QQ 账号 ${this.napcatClient?.selfId || '识别中'}）`);
        } else if (state === 'connecting') {
          this.state = 'connecting';
        } else if (state === 'offline') {
          this.state = 'disconnected';
        }
      },
    });
    this.napcatClient = new NapCatClient({ transport: this.napcatTransport, logger: this.logger });
    this.client = this.napcatClient;
    this.napcatTransport.onEvent((event) => {
      void this.onNapcatEvent(event).catch((error) => {
        this.logger.warn?.('[qqbot-guard] NapCat 事件处理异常：' + errorText(error));
      });
    });
    await this.napcatTransport.connect();
    await this.napcatClient.identify();
    this.startScheduler();
    return true;
  }

  /**
   * 协议端不在线时由插件自己拉起（不需要用户先手动开 QQ）。
   * 支持 NapCat.Shell 无头版、计划任务、以及任何返回 OneBot WS 的后端。
   */
  async ensureBackend(cfg) {
    if (!cfg?.autoStart) return;
    const target = wsTarget(cfg.wsUrl);
    if (!target) return;
    if (await probeTcp(target.host, target.port)) return;
    const now = Date.now();
    if (this.backendSpawnedAt && now - this.backendSpawnedAt < 60_000) return;
    this.backendSpawnedAt = now;
    const result = spawnBackend(cfg.startCommand || '');
    this.logger.info?.(`[qqbot-guard] 协议端未运行，尝试自动启动：${result.ok ? `已执行（pid ${result.pid}）` : result.error}`);
    if (!result.ok) return;
    // 等协议端就绪（最多约 25 秒），连上后由调用方继续
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => { const t = setTimeout(resolve, 1000); if (t.unref) t.unref(); });
      if (await probeTcp(target.host, target.port)) {
        this.logger.info?.('[qqbot-guard] 协议端已就绪');
        return;
      }
    }
  }

  /** OneBot 事件 → 内部事件（群消息 / 入群 / 入群申请 / 生命周期） */
  async onNapcatEvent(event) {
    const type = String(event?.post_type || '');
    if (type === 'message' && event.message_type === 'group') {
      await this.onNapcatMessage(event);
      return;
    }
    if (type === 'notice' && event.notice_type === 'group_increase') {
      const gid = String(event.group_id || '');
      const uid = String(event.user_id || '');
      if (!gid || !uid) return;
      this.store.upsertGroup(gid, {});
      this.maybeRefreshGroup(gid);
      await handleMemberAdd({
        group_openid: gid,
        member_openid: uid,
        username: String(event.sender?.nickname || event.sender?.card || ''),
      }, { store: this.store, getClient: () => this.client, appId: '', ai: this.ai });
      return;
    }
    if (type === 'request' && event.request_type === 'group') {
      const gid = String(event.group_id || '');
      const uid = String(event.user_id || '');
      const flag = String(event.flag || '');
      if (!gid || !uid) return;
      if (this.napcatClient) {
        // 保留 OneBot 的 sub_type（add / invite），审批时原样回传；不记录会被默认成 add
        this.napcatClient.joinRequests.push({
          flag,
          uid,
          gid,
          subType: String(event.sub_type || 'add'),
          nickname: String(event.sender?.nickname || ''),
          comment: String(event.comment || ''),
        });
      }
      await handleJoinRequest({
        group_openid: gid,
        member_openid: uid,
        username: String(event.sender?.nickname || event.comment || ''),
        join_request_id: flag,
        apply_source: flag,
      }, { store: this.store, getClient: () => this.client, ai: this.ai });
      return;
    }
    if (type === 'meta_event' && event.meta_event_type === 'lifecycle') {
      this.state = 'online';
      this.connectedAt = Date.now();
    }
  }

  /** 把 OneBot 群消息转成内部 mCtx（与官方 SDK 的消息对象同形） */
  async onNapcatMessage(event) {
    const botQQ = String(this.napcatClient?.selfId || '');
    const segments = Array.isArray(event?.message) ? event.message : [];
    let text = '';
    let mentioned = false;
    const mentions = [];
    const attachments = [];
    for (const segment of segments) {
      const segType = String(segment?.type || '');
      if (segType === 'text') {
        text += String(segment.data?.text || '');
      } else if (segType === 'at') {
        const qq = String(segment.data?.qq || '');
        text += `<qqbot-at-user id="${qq}" />`;
        if (qq === botQQ) {
          mentioned = true;
          mentions.push({ id: qq, is_you: true });
        } else if (qq && qq !== 'all') {
          mentions.push({ id: qq, is_you: false });
        }
      } else if (segType === 'image') {
        text += '[图片]';
        const url = String(segment.data?.url || segment.data?.file || '');
        if (/^https?:\/\//iu.test(url)) attachments.push({ content_type: 'image/png', url });
      } else if (segType === 'face') {
        text += '[表情]';
      } else if (segType === 'mface') {
        text += '[表情]';
      }
    }
    const mCtx = {
      message: {
        kind: 'group',
        groupOpenid: String(event.group_id || ''),
        senderId: String(event.user_id || ''),
        senderName: String(event.sender?.card || event.sender?.nickname || ''),
        content: text,
        messageId: String(event.message_id || ''),
        rawEventType: 'GROUP_MESSAGE',
        mentions,
        attachments,
      },
      state: { mention: { wasMentioned: mentioned } },
    };
    await this.onMessage(mCtx);
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(LIMITS.reconnectMaxMs, this.reconnectDelay);
    this.reconnectDelay = Math.min(LIMITS.reconnectMaxMs, Math.round(delay * 1.8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      this.state = 'disconnected';
      void this.start();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  startScheduler() {
    if (this.schedulerTimer) return;
    const run = async () => {
      try {
        await tickAnnouncements({ store: this.store, client: this.client, directory: this.getDirectory?.() });
      } catch (error) {
        this.logger.warn?.('[qqbot-guard] 公告调度异常：' + errorText(error));
      }
      try {
        await tickQuizzes({ store: this.store, getClient: () => this.client, logger: this.logger });
      } catch (error) {
        this.logger.warn?.('[qqbot-guard] 答题调度异常：' + errorText(error));
      }
    };
    void run();
    this.schedulerTimer = setInterval(() => { void run(); }, LIMITS.schedulerTickMs);
    if (this.schedulerTimer.unref) this.schedulerTimer.unref();
  }

  async stop() {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
    const bot = this.bot;
    this.bot = undefined;
    this.state = 'disconnected';
    this.connectedAt = 0;
    try { this.napcatTransport?.close(); } catch { /* ignore */ }
    this.napcatTransport = undefined;
    try { bot?.stop?.(); } catch { /* ignore */ }
  }

  /** 消息：记录台账 + 入群答题 + 违规防护 */
  async onMessage(mCtx) {
    const msg = mCtx?.message;
    if (!msg || msg.kind !== 'group') {
      const type = String(msg?.rawEventType || '');
      if (/GROUP/iu.test(type)) {
        this.store.appendAudit({
          kind: 'system', action: 'message-ignored',
          detail: `群事件 ${type} 未被识别为群消息（kind=${msg?.kind || '空'}）`,
          ok: false, code: 'KIND_MISMATCH', confidence: 1,
        });
      }
      return;
    }
    const gid = String(msg.groupOpenid || '').trim();
    const uid = String(msg.senderId || '').trim();
    if (!gid || !uid) {
      // 事件到了却缺字段：写审计，避免表现为“完全没反应”却查不到原因
      this.store.appendAudit({
        kind: 'system', action: 'message-dropped',
        detail: `群消息缺少 ${!gid ? 'groupOpenid' : 'member_openid'}（事件 ${msg.rawEventType || '未知'}）`,
        ok: false, code: 'MESSAGE_DROPPED', confidence: 1,
      });
      return;
    }
    const text = String(msg.content || '');
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const maxImages = Math.max(1, Math.min(
      LIMITS.aiImageMaxCount,
      Number(this.store.settings.ai?.vision?.maxImages) || 3,
    ));
    const images = attachments
      .filter((a) => /^image\//iu.test(String(a?.content_type || '')) && a?.url)
      .slice(0, maxImages)
      .map((a) => ({ url: String(a.url), contentType: String(a.content_type) }));
    const hasImage = images.length > 0 || /<(?:img|image)\b|\[图片\]/iu.test(text);
    const hasCard = /<qqbot-card|<json-card|<contact|<qqbot-contact/iu.test(text);
    // mentionGate 的判定结果最权威（SDK 已适配平台事件类型与 is_you 等字段）
    const mentioned = mCtx?.state?.mention?.wasMentioned === true;
    const mentionsBot = detectMentionsBot(msg, this.appId, mentioned);
    // 被 @ 的成员 openid：踢人/禁言时用它定位，比昵称可靠。
    // ⚠️ @机器人 的标签里可能是机器人 openid 而不是 AppID，只按 appId 过滤会把它当目标，
    // 导致“@机器人 禁言 1 分钟 <openid>”去禁机器人。这里以 SDK 的 mentions 为准，
    // 把所有 is_you 的 id（openid / AppID）都加入排除集，再解析正文标签兜底。
    const botIds = new Set();
    if (this.appId) botIds.add(String(this.appId));
    const sdkMentionUids = [];
    if (Array.isArray(msg.mentions)) {
      for (const item of msg.mentions) {
        if (!item) continue;
        const ids = [item.id, item.openid, item.user_openid, item.userOpenid, item.uid]
          .filter(Boolean)
          .map(String);
        if (item.is_you === true) {
          for (const id of ids) botIds.add(id);
          continue;
        }
        for (const id of ids) sdkMentionUids.push(id);
      }
    }
    const mentionUids = [...new Set([
      ...sdkMentionUids,
      ...extractMentionUids(text, this.appId).filter((id) => !botIds.has(String(id))),
    ])];
    this.store.upsertMember(gid, uid, {
      countMessage: true,
      ...(msg.senderName ? { name: String(msg.senderName) } : {}),
    });
    this.store.upsertGroup(gid, {});
    this.maybeRefreshGroup(gid);
    this.maybeRefreshUser(gid, uid);

    const quiz = await handleQuizAnswer({
      gid, uid, name: msg.senderName || '', text, msgId: msg.messageId,
    }, { store: this.store, getClient: () => this.client, logger: this.logger, ai: this.ai });
    if (quiz.handled) return;

    try {
      await this.moderation.handleMessage({
        gid,
        uid,
        name: this.store.state.members[gid + '|' + uid]?.name || '',
        text,
        msgId: msg.messageId,
        hasImage,
        hasCard,
        images,
        mentionsBot,
        mentionUids,
      });
    } catch (error) {
      this.store.appendAudit({
        kind: 'system', action: 'message-error', groupId: gid, userId: uid,
        userName: msg.senderName || '',
        detail: `消息处理异常：${errorText(error)}`,
        ok: false, code: 'MESSAGE_ERROR', confidence: 1,
      });
      throw error;
    }
  }

  /** 原始事件：入群申请 / 新成员 / 机器人加群 */
  async onRawEvent(rawCtx) {
    const type = String(rawCtx?.eventType || '');
    const data = rawCtx?.data || {};
    if (type === 'GROUP_JOIN_REQUEST') {
      const r = await handleJoinRequest(data, { store: this.store, getClient: () => this.client, ai: this.ai });
      if (r.handled) this.logger.info?.(`[qqbot-guard] 入群申请：${r.decision} ${r.reason || ''}`);
      return;
    }
    if (type === 'GROUP_MEMBER_ADD') {
      const gid = String(data.group_openid || '');
      if (gid) {
        this.store.upsertGroup(gid, {});
        this.maybeRefreshGroup(gid);
      }
      await handleMemberAdd(data, {
        store: this.store,
        getClient: () => this.client,
        appId: this.appId,
        ai: this.ai,
      });
      return;
    }
    if (type === 'GROUP_ADD_ROBOT') {
      const gid = String(data.group_openid || '');
      if (gid) {
        this.store.upsertGroup(gid, {});
        await this.refreshGroupInfo(gid);
        this.store.appendAudit({
          kind: 'group', action: 'add', groupId: gid,
          detail: '机器人被加入群聊', confidence: 1,
        });
      }
      return;
    }
    if (type === 'GROUP_DEL_ROBOT') {
      const gid = String(data.group_openid || '');
      if (gid) {
        const name = this.store.state.groups[gid]?.name || '';
        this.store.removeGroup(gid);
        this.store.appendAudit({ kind: 'group', action: 'remove', groupId: gid, groupName: name, detail: '机器人被移出群聊', confidence: 1 });
      }
    }
  }

  maybeRefreshGroup(gid) {
    const ttl = Number(this.store.settings.groupInfoTtlMs || LIMITS.schedulerTickMs);
    const last = this.groupRefresh.get(gid) || 0;
    if (Date.now() - last < ttl) return;
    this.groupRefresh.set(gid, Date.now());
    if (this.groupRefresh.size > LIMITS.members) this.groupRefresh.clear();
    void this.refreshGroupInfo(gid);
  }

  async refreshGroupInfo(gid) {
    if (!this.client) return;
    const r = await this.client.getGroupInfo(gid);
    if (!r.ok) return;
    const name = String(r.data?.group_name || this.store.state.groups[gid]?.name || '');
    // OneBot v11 的 get_group_info 返回 member_count；官方 Bot 时代叫 group_member_num。
    // 只有取到正数才写回，避免把 0 写成 undefined 覆盖掉已知人数。
    const raw = r.data?.member_count ?? r.data?.group_member_num;
    const count = Number(raw);
    const patch = { name };
    if (Number.isFinite(count) && count > 0) patch.memberCount = count;
    this.store.upsertGroup(gid, patch);
  }

  maybeRefreshUser(gid, uid) {
    const member = this.store.state.members[gid + '|' + uid];
    if (member?.name) return;
    const last = this.userRefresh.get(uid) || 0;
    if (Date.now() - last < LIMITS.schedulerTickMs * 10) return;
    this.userRefresh.set(uid, Date.now());
    if (this.userRefresh.size > LIMITS.members) this.userRefresh.clear();
    void (async () => {
      if (!this.client) return;
      const r = await this.client.getUserInfo(uid);
      if (r.ok && r.data?.username) this.store.upsertMember(gid, uid, { name: String(r.data.username) });
    })();
  }

  snapshot() {
    return {
      configured: this.configured(),
      state: this.state,
      selfId: String(this.napcatClient?.selfId || ''),
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : '',
      startedAt: new Date(this.startedAt).toISOString(),
      lastError: this.lastError,
      degraded: this.degraded,
      extraIntent: this.usedExtraIntent,
      uptimeMs: Date.now() - this.startedAt,
      api: this.client?.stats() || null,
    };
  }

  dispose() {
    void this.stop();
    this.moderation.reset();
    try { this.store.flush(); } catch { /* ignore */ }
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 是否 @ 了机器人。
 *
 * 判定优先级：
 * 1. SDK mentionGate 的 ctx.state.mention.wasMentioned（权威，已适配平台事件变更）
 * 2. 事件类型 GROUP_AT_MESSAGE_CREATE（平台只在真正 @ 时下发）
 * 3. mentions[].is_you === true（官方语义：mentions 不含机器人自身，不能用 id 比较；
 *    也不能只看 bot=true，否则多机器人同群会一起响应）
 * 4. 正文标签 <@!appId> / <@appId> / <qqbot-at-user id="appId">
 */
export function detectMentionsBot(msg, appId, sdkMentioned = false) {
  if (sdkMentioned) return true;
  if (/GROUP_AT_MESSAGE_CREATE/u.test(String(msg?.rawEventType || ''))) return true;
  if (Array.isArray(msg?.mentions) && msg.mentions.some((m) => m?.is_you === true)) return true;
  const text = String(msg?.content || '');
  const id = String(appId || '');
  if (!id) return false;
  const safeId = escapeRegExp(id);
  if (new RegExp(`<@!?${safeId}>`, 'u').test(text)) return true;
  return new RegExp(`<qqbot-at-user[^>]*id=["']?${safeId}["']?`, 'iu').test(text);
}
