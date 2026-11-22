/**
 * 连接管理：一条 QQ WebSocket 连接，只订阅群事件。
 * 不含任何会话/模型逻辑；所有业务处理都是事件驱动 + 有上限的内存缓存。
 */
import { LIMITS } from './defaults.js';
import { QQClient } from './qq-api.js';
import { Moderation } from './moderation.js';
import { handleJoinRequest, handleMemberAdd, handleQuizAnswer, tickQuizzes } from './join.js';
import { tickAnnouncements } from './announcements.js';

function maskId(id) {
  const s = String(id || '');
  if (s.length <= 6) return s ? s[0] + '***' : '';
  return s.slice(0, 3) + '***' + s.slice(-3);
}

export class BotManager {
  /**
   * @param {{store: import('./store.js').Store, logger: any, appId: string, appSecret: string, watchJoinRequests: boolean}} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.logger = deps.logger || console;
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.watchJoinRequests = !!deps.watchJoinRequests;
    this.client = this.appId && this.appSecret ? new QQClient(this.appId, this.appSecret) : undefined;
    this.ai = deps.ai;
    this.moderation = new Moderation({
      store: this.store, getClient: () => this.client, logger: this.logger, ai: this.ai,
      notifyTrustedAbuse: deps.notifyTrustedAbuse,
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
    this.stopping = false;
  }

  configured() {
    return !!(this.appId && this.appSecret);
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

  async startOnce() {
    const sdk = await import('@tencent-connect/qqbot-nodejs');
    const protocol = await import('@tencent-connect/qqbot-nodejs/protocol');
    const QQBot = sdk.QQBot;
    const FULL_INTENTS = protocol.FULL_INTENTS;
    if (typeof QQBot !== 'function') throw new Error('QQ SDK 未正确安装');

    const extra = this.watchJoinRequests ? 1 << 24 : 0;
    this.usedExtraIntent = extra !== 0;
    const intents = (Number(FULL_INTENTS) | extra) >>> 0;
    const bot = new QQBot({
      appId: this.appId,
      appSecret: this.appSecret,
      transport: 'websocket',
      intents,
      logger: this.logger,
    });
    this.bot = bot;

    bot.on('message', (mCtx) => {
      void this.onMessage(mCtx).catch((e) => this.logger.warn?.('[qqbot-guard] 消息处理异常：' + errorText(e)));
    });
    bot.on('rawEvent', (rawCtx) => {
      void this.onRawEvent(rawCtx).catch((e) => this.logger.warn?.('[qqbot-guard] 事件处理异常：' + errorText(e)));
    });
    bot.on('ready', () => {
      this.state = 'online';
      this.connectedAt = Date.now();
      this.reconnectDelay = LIMITS.reconnectMinMs;
      this.startScheduler();
      this.logger.info?.(`[qqbot-guard] 已连接（appId=${maskId(this.appId)}，群事件已订阅${this.usedExtraIntent ? '，含入群申请' : ''}）`);
    });
    bot.on('resumed', () => {
      this.state = 'online';
      this.connectedAt = Date.now();
      this.logger.info?.('[qqbot-guard] 连接已恢复');
    });
    bot.on('error', (error) => {
      this.lastError = errorText(error);
      this.logger.warn?.('[qqbot-guard] 连接错误：' + this.lastError);
      // 4914/4915 = intents 未授权。降级为不订阅入群申请事件，避免整条连接不可用。
      if (this.usedExtraIntent && /4914|4915|intent/iu.test(this.lastError)) {
        this.watchJoinRequests = false;
        this.degraded = true;
        this.logger.warn?.('[qqbot-guard] 入群申请 intent 未授权，已降级为普通群事件（可在面板关闭“订阅入群申请”后重启）');
      }
    });

    // SDK 的 start() 在连接存活期间会一直挂起（直到 stop 或连接终止）。
    // 绝不能 await：否则 startOnce / startBot / restartBot 会被永久卡住，
    // 面板改设置后无法再次重启，调度器也永远不会启动。
    Promise.resolve()
      .then(() => bot.start())
      .catch((error) => {
        const text = errorText(error);
        this.lastError = text;
        this.logger.warn?.(`[qqbot-guard] 连接中断：${text}`);
        if (this.bot === bot) this.bot = undefined;
        if (this.stopping) return;
        if (this.watchJoinRequests && /4914|4915|intent/iu.test(text)) {
          this.watchJoinRequests = false;
          this.degraded = true;
          this.logger.warn?.('[qqbot-guard] 入群申请 intent 未授权，降级为普通群事件后重连');
        }
        this.state = 'error';
        this.scheduleReconnect();
      });

    this.startScheduler();
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
        await tickAnnouncements({ store: this.store, client: this.client });
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
    const mentionsBot = detectMentionsBot(msg, this.appId);
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
    if (r.ok) {
      this.store.upsertGroup(gid, {
        name: String(r.data?.group_name || this.store.state.groups[gid]?.name || ''),
        memberCount: Number(r.data?.group_member_num || 0) || undefined,
      });
    }
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
      appIdMasked: maskId(this.appId),
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
 * 优先用事件类型与 mentions.is_you，正文标签只作兜底——
 * 部分平台版本会把正文里的 @ 标签清洗掉，只看标签会漏掉。
 */
export function detectMentionsBot(msg, appId) {
  if (/GROUP_AT_MESSAGE_CREATE/u.test(String(msg?.rawEventType || ''))) return true;
  if (Array.isArray(msg?.mentions) && msg.mentions.some((m) => m?.is_you === true || m?.bot === true)) return true;
  if (!appId) return false;
  return new RegExp(`<@!?${escapeRegExp(appId)}>`, 'u').test(String(msg?.content || ''));
}
