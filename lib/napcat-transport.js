/**
 * NapCat / OneBot v11 正向 WebSocket 传输层。
 *
 * 与官方开放平台 Bot 的差别：
 * - 以“普通 QQ 账号”（协议端登录）收发消息，支持全量群消息、@、成员列表、禁言、
 *   踢人、全员禁言、真·群公告等，限制少很多；
 * - 因此消息里的 id 是 QQ 号 / 群号，而不是 openid。
 *
 * 本模块只做传输：连接、调用 API、派发事件；业务仍在 BotManager/Moderation。
 */

function errorText(error) {
  return String(error?.message || error || '未知错误');
}

/** 拼接 access_token 查询参数（NapCat 支持 ?access_token=xxx） */
export function withToken(url, token = '') {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  const t = String(token || '').trim();
  if (!t) return raw;
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}access_token=${encodeURIComponent(t)}`;
}

export class NapCatTransport {
  /**
   * @param {{url: string, token?: string, logger?: any, timeoutMs?: number,
   *          reconnectMinMs?: number, reconnectMaxMs?: number, onState?: (state: string, detail?: string) => void}} options
   */
  constructor(options = {}) {
    // NapCat 默认只监听 IPv4；localhost 在部分环境解析到 ::1 会连不上，统一改 127.0.0.1
    this.url = String(options.url || '').trim().replace(/:\/\/localhost(?=[/:]|$)/iu, '://127.0.0.1');
    this.token = String(options.token || '');
    this.logger = options.logger || console;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
    this.reconnectMinMs = Math.max(500, Number(options.reconnectMinMs) || 1000);
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, Number(options.reconnectMaxMs) || 30000);
    this.onState = typeof options.onState === 'function' ? options.onState : () => {};
    this.ws = null;
    this.echo = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.stopped = false;
    this.reconnectDelay = this.reconnectMinMs;
    this.reconnectTimer = null;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** 订阅事件（OneBot 原始 JSON） */
  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event) {
    for (const handler of this.handlers) {
      try { handler(event); } catch (error) { this.logger.warn?.(`[qqbot-guard] NapCat 事件处理异常：${errorText(error)}`); }
    }
  }

  /** 建立连接；失败时 reject（调用方决定是否退避重试） */
  connect() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        reject(new Error('当前 Node 不支持全局 WebSocket，请升级到 Node 22+'));
        return;
      }
      if (!this.url) {
        reject(new Error('NapCat WS 地址为空（设置 → NapCat 里填写 ws://127.0.0.1:3001）'));
        return;
      }
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      let ws;
      try {
        ws = new WebSocket(withToken(this.url, this.token));
      } catch (error) {
        reject(new Error(`NapCat 地址无效：${errorText(error)}`));
        return;
      }
      this.ws = ws;
      this.onState?.('connecting');
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        done(reject, new Error(`连接 NapCat 超时（${this.url}）`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      ws.addEventListener('open', () => {
        this.reconnectDelay = this.reconnectMinMs;
        this.onState?.('online');
        done(resolve);
      });
      ws.addEventListener('error', () => {
        done(reject, new Error(`无法连接 NapCat（${this.url}），请确认协议端已启动并开启 WebSocket 服务`));
      });
      ws.addEventListener('close', () => {
        this.ws = null;
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error('NapCat 连接已关闭'));
        }
        this.pending.clear();
        this.onState?.('offline');
        if (!this.stopped) this.scheduleReconnect();
      });
      ws.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          return;
        }
        if (!data || typeof data !== 'object') return;
        if (data.echo) {
          const item = this.pending.get(String(data.echo));
          if (!item) return;
          this.pending.delete(String(data.echo));
          clearTimeout(item.timer);
          if (data.status === 'failed' || (data.retcode !== undefined && Number(data.retcode) !== 0)) {
            item.reject(new Error(String(data.wording || data.message || `OneBot 返回 retcode ${data.retcode}`).slice(0, 300)));
          } else {
            item.resolve(data.data);
          }
          return;
        }
        if (data.post_type) this.emit(data);
      });
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectMaxMs, Math.round(delay * 1.8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().catch((error) => {
        this.logger.warn?.(`[qqbot-guard] NapCat 重连失败：${errorText(error)}`);
      });
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
    this.logger.warn?.(`[qqbot-guard] NapCat 连接断开，${Math.round(delay / 1000)} 秒后重连`);
  }

  call(action, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('NapCat 未连接（请确认协议端在线）'));
        return;
      }
      const echo = `qqg-${Date.now().toString(36)}-${++this.echo}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`NapCat 调用超时：${action}`));
      }, Math.max(1000, Number(timeoutMs) || this.timeoutMs));
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new Error(`NapCat 发送失败：${errorText(error)}`));
      }
    });
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('NapCat 连接已关闭'));
    }
    this.pending.clear();
  }
}
