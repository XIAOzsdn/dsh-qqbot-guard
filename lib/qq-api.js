/**
 * QQ 开放平台 REST 客户端（只做群管理相关接口）。
 * 特点：token 缓存 + 并发单飞 + 超时 + 熔断 + 错误码人话化。
 * 不依赖任何 AI / 会话 / 媒体处理模块。
 */
import { Breaker } from './breaker.js';
import { LIMITS } from './defaults.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.bot.qq.com';

/** 官方错误码 → 人话 */
const ERROR_HUMAN = Object.freeze({
  11253: '该能力官方尚未开放或未授权（仅白名单机器人可用）',
  11703: '机器人没有该接口权限：需要是群管理员，且平台已开通对应能力',
  40103004: '不能操作该成员：群主/管理员/机器人不可被禁言',
  40103011: '机器人关闭了「移除群成员」权限，请到 QQ 开放平台管理端打开',
  40103012: '群主关闭了操作权限，请让群主在群设置里给机器人打开',
  11201: '机器人不在该群或参数错误',
  11202: '接口调用异常，请稍后重试',
  40101: '请求太频繁，请稍后再试',
  403: '机器人缺少群管理员身份或未授权',
  401: '访问凭证无效，请刷新后重试',
  11001: '接口路径或参数不正确',
  304103: '被动回复的 msg_id 已过期（5 分钟窗口），请改用主动消息',
  40034005: '回复的 msg_id 已过期，请改用主动消息',
  40034006: '内容违规，请调整措辞后重试',
  40034029: '键盘按钮超限（最多 5 行 × 每行 5 个）',
  304036: '机器人没有 Markdown 模板权限，请改用纯文本',
});

/**
 * 把官方错误码翻成可直接展示的人话。
 * @param {string|number} code
 */
export function humanError(code) {
  const c = String(code);
  if (ERROR_HUMAN[c]) return ERROR_HUMAN[c];
  if (!/^\d+$/u.test(c)) {
    if (/timeout|abort/iu.test(c)) return '请求超时，请检查网络后重试';
    if (/frequency|limit|太快/iu.test(c)) return '请求太频繁，请稍后再试';
  }
  return `调用失败（错误码 ${c}），请稍后重试`;
}

function err(code, human) {
  return { ok: false, err: { code: String(code), human: human || humanError(code) } };
}

function isApiFailure(payload) {
  if (!payload || typeof payload !== 'object') return true;
  const code = payload.code;
  return code !== undefined && Number(code) !== 0;
}

/** per-app token 缓存（并发单飞） */
class TokenCache {
  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
  }

  async get(appId, appSecret) {
    const hit = this.cache.get(appId);
    if (hit && Date.now() < hit.expireAt - LIMITS.tokenRefreshAheadMs) return hit.token;
    const running = this.inflight.get(appId);
    if (running) return running;
    const task = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: AbortSignal.timeout(LIMITS.apiTimeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!data || !data.access_token) {
        throw new Error(`获取访问凭证失败：${data?.code ?? res.status} ${data?.message ?? ''}`);
      }
      const ttl = Number(data.expires_in ?? 7200) * 1000;
      this.cache.set(appId, { token: String(data.access_token), expireAt: Date.now() + ttl });
      return String(data.access_token);
    })().finally(() => this.inflight.delete(appId));
    this.inflight.set(appId, task);
    return task;
  }

  clear(appId) {
    if (appId) this.cache.delete(appId);
    else this.cache.clear();
  }
}

/** 发送串行队列：所有群消息按最小间隔依次发出，避免触发频控 */
class SendQueue {
  constructor(gapMs) {
    this.gapMs = gapMs;
    this.chain = Promise.resolve();
    this.lastAt = 0;
  }

  push(fn) {
    const run = async () => {
      const wait = Math.max(0, this.lastAt + this.gapMs - Date.now());
      if (wait > 0) await new Promise((r) => { const t = setTimeout(r, wait); if (t.unref) t.unref(); });
      try {
        return await fn();
      } finally {
        this.lastAt = Date.now();
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

let seq = 0;
function nextMsgSeq() {
  const base = Date.now() % 1_000_000_000;
  seq = base > seq ? base : seq + 1;
  return seq;
}

function hasQqTag(content) {
  return /<qqbot-at-user|<qqbot-at-everyone|<qqbot-cmd-|<emoji:|<#/u.test(content);
}

/**
 * 兼容手写模板里的旧写法：把已弃用的 <@openid> 换成官方新标签。
 * 群聊 @ 只有 markdown 消息的 <qqbot-at-user id="..." /> 会渲染成可点的 @。
 */
function normalizeMentions(content) {
  return String(content || '').replace(/<@!?([^>\s]+)>/gu, (_all, id) => (
    `<qqbot-at-user id="${String(id).replace(/["<>]/gu, '')}" />`
  ));
}

/**
 * 北京时间 RFC3339（官方禁言接口要求带时区）。
 * @param {number|null} seconds 传 null 表示解除禁言
 */
export function muteExpireAt(seconds) {
  if (seconds === null) return null;
  const t = new Date(Date.now() + Math.max(0, Number(seconds) || 0) * 1000 + 8 * 3600_000);
  return t.toISOString().slice(0, 19) + '+08:00';
}

/**
 * @-openid 提及。
 * 官方文档：群聊 @用户只支持 markdown 消息，格式 `<qqbot-at-user id="member_openid" />`；
 * 旧的 `<@openid>` 已弃用，在群聊里不会渲染成 @。
 */
export function mention(openid) {
  const id = String(openid || '').trim().replace(/["<>]/gu, '');
  return id ? `<qqbot-at-user id="${id}" />` : '';
}

export class QQClient {
  /**
   * @param {string} appId
   * @param {string} appSecret
   */
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.tokens = new TokenCache();
    this.breaker = new Breaker({
      threshold: LIMITS.breakerThreshold,
      cooldownMs: LIMITS.breakerCooldownMs,
    });
    this.queue = new SendQueue(LIMITS.sendGapMs);
  }

  /**
   * 带 token 的底层调用。网络/5xx 失败会触发熔断；业务错误码不触发。
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async call(method, path, body) {
    return this.breaker.run(
      async () => {
        let token;
        try {
          token = await this.tokens.get(this.appId, this.appSecret);
        } catch (error) {
          return err('TOKEN_ERROR', error instanceof Error ? error.message : String(error));
        }
        let res;
        try {
          res = await fetch(API_BASE + path, {
            method,
            headers: {
              authorization: `QQBot ${token}`,
              'content-type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(LIMITS.apiTimeoutMs),
          });
        } catch (error) {
          throw error;
        }
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) this.tokens.clear(this.appId);
        if (res.ok && !isApiFailure(data)) {
          return { ok: true, data: data?.data ?? data };
        }
        const code = data?.code ?? res.status;
        return err(code, data?.message ? humanError(String(code)) : undefined);
      },
      {
        fallback: () => err('CIRCUIT_OPEN', '连续调用失败，已暂停请求，请稍后重试'),
        isFailure: (error) => {
          const text = error instanceof Error ? error.message : String(error);
          // 业务错误由 call 内部转成 {ok:false}，不会走到这里；这里只处理网络/超时
          return /timeout|abort|fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/iu.test(text);
        },
      },
    );
  }

  /** 主动群消息；传 msgId 时走被动回复（更稳，不占主动消息额度） */
  async sendGroupText(gid, content, opts = {}) {
    const text = normalizeMentions(content).trim();
    if (!text) return err('EMPTY', '消息内容为空');
    if (text.length > LIMITS.messageMaxChars) return err('TOO_LONG', `消息过长（上限 ${LIMITS.messageMaxChars} 字）`);
    const body = hasQqTag(text)
      ? { markdown: { content: text }, msg_type: 2, msg_seq: nextMsgSeq() }
      : { content: text, msg_type: 0, msg_seq: nextMsgSeq() };
    if (opts.msgId) body.msg_id = String(opts.msgId);
    const path = `/v2/groups/${encodeURIComponent(gid)}/messages`;
    return this.queue.push(async () => {
      const r = await this.call('POST', path, body);
      if (r.ok) return r;
      // 被动回复窗口过期 → 改用主动消息。
      if (body.msg_id && ['304103', '40034005'].includes(r.err?.code)) {
        const proactive = { ...body };
        delete proactive.msg_id;
        return this.call('POST', path, proactive);
      }
      // Markdown 未授权/内容违规时，降级为纯文本再试一次（去掉标签，保证消息能发出去）
      if (body.markdown && ['304036', '40034006'].includes(r.err?.code)) {
        const plain = text.replace(/<[^>]+>/gu, ' ').replace(/[ \t]+/gu, ' ').trim().slice(0, LIMITS.announcementMaxChars);
        if (!plain) return r;
        return this.call('POST', path, { content: plain, msg_type: 0, msg_seq: nextMsgSeq() });
      }
      return r;
    });
  }

  /** 群基本信息 */
  async getGroupInfo(gid) {
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/info`);
  }

  /** 用户基本信息（拿昵称；官方已开放） */
  async getUserInfo(openid) {
    return this.call('GET', `/v2/users/${encodeURIComponent(openid)}/info`);
  }

  /** 入群申请列表 */
  async listJoinRequests(gid, cursor = '', limit = 20) {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (limit && limit !== 20) q.set('limit', String(limit));
    const qs = q.toString() ? `?${q}` : '';
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/join_request_list${qs}`);
  }

  /** 审批入群申请 */
  async approveJoinRequest(gid, memberOpenid, op, opts = {}) {
    const body = { op };
    if (opts.joinRequestId) body.join_request_id = opts.joinRequestId;
    if (op === 'decline' && opts.rejectReason) body.reject_reason = opts.rejectReason;
    if (opts.addToBlacklist) body.add_to_member_blacklist = true;
    return this.call(
      'POST',
      `/v2/groups/${encodeURIComponent(gid)}/approval_join_request/${encodeURIComponent(memberOpenid)}`,
      body,
    );
  }

  /** 批量移除成员（踢人） */
  async removeMembers(gid, memberOpenids, addToBlacklist = false) {
    const ids = (Array.isArray(memberOpenids) ? memberOpenids : [memberOpenids])
      .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
    if (!ids.length) return err('EMPTY', '没有要移除的成员');
    return this.call('POST', `/v2/groups/${encodeURIComponent(gid)}/batch_remove_members`, {
      member_openids: ids,
      ...(addToBlacklist ? { add_to_member_blacklist: true } : {}),
    });
  }

  /**
   * 禁言 / 解除禁言。add 逐条发送（官方对多成员 add 不稳定），del 可批量。
   * @param {string} gid
   * @param {string|string[]} memberOpenids
   * @param {number|null} seconds null = 解除
   */
  async setMemberMute(gid, memberOpenids, seconds) {
    const ids = (Array.isArray(memberOpenids) ? memberOpenids : [memberOpenids])
      .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
    if (!ids.length) return err('EMPTY', '没有要操作的成员');
    const url = `/v2/groups/${encodeURIComponent(gid)}/restrict_chat_setting`;
    if (seconds === null) {
      return this.call('POST', url, {
        members: ids.map((id) => ({ op: 'del', member_openid: id, mute_expire_at: '' })),
      });
    }
    const expireAt = muteExpireAt(seconds);
    let last = { ok: true, data: {} };
    for (const id of ids) {
      last = await this.call('POST', url, {
        members: [{ op: 'add', member_openid: id, mute_expire_at: expireAt }],
      });
      if (!last.ok) return last;
    }
    return last;
  }

  /** 撤回机器人自己发的消息（2 分钟窗口） */
  async recallMessage(gid, msgId) {
    return this.call(
      'DELETE',
      `/v2/groups/${encodeURIComponent(gid)}/messages/${encodeURIComponent(msgId)}`,
    );
  }

  /** 熔断器快照（面板展示） */
  stats() {
    return {
      breaker: this.breaker.snapshot(),
      hasToken: this.tokens.cache.size > 0,
    };
  }
}
