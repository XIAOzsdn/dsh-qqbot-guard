/**
 * NapCat WebUI 客户端：让插件面板能直接看到 QQ 账号登录状态、扫码登录、快速登录，
 * 而不必去开 QQ 客户端或手动打开协议端后台。
 *
 * 登录协议（从协议端前端 bundle 里读出来的）：
 *   1) POST {base}/auth/login  { hash: sha256(token + ".napcat") }  -> { Credential }
 *   2) 其余接口带头 `authorization: Bearer <Credential>`
 *   3) QQ 登录相关：/QQLogin/CheckLoginStatus、/QQLogin/GetQQLoginInfo、
 *      /QQLogin/GetQQLoginQrcode、/QQLogin/RefreshQRcode、
 *      /QQLogin/GetQuickLoginListNew、/QQLogin/SetQuickLogin
 *
 * 这里只做协议适配与错误翻译，登录状态本身由协议端维护。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 协议端 WebUI 的登录口令算法：sha256(token + ".napcat") */
export function webuiHash(token) {
  return createHash('sha256').update(`${String(token || '')}.napcat`).digest('hex');
}

/** 从协议端目录里读出 WebUI 令牌（webui.json 的 token 字段） */
export function readWebuiToken(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const token = String(data?.token || '').trim();
    const port = Number(data?.port) || 0;
    if (!token) return null;
    return { token, port, host: String(data?.host || '') };
  } catch {
    return null;
  }
}

/**
 * 按启动命令推断协议端目录，找出 webui.json。
 * 例：`C:\napcat\napcat.bat -q 3634084829` -> C:\napcat\napcat\config\webui.json
 */
export function discoverWebui(startCommand) {
  const command = String(startCommand || '').trim();
  if (!command) return null;
  const first = command.match(/^"([^"]+)"|^(\S+)/u);
  const bin = String(first?.[1] || first?.[2] || '').trim();
  if (!bin) return null;
  let base = '';
  try {
    base = resolve(dirname(bin));
  } catch {
    return null;
  }
  const candidates = [
    join(base, 'napcat', 'config', 'webui.json'),
    join(base, 'config', 'webui.json'),
    join(base, 'webui.json'),
    join(dirname(base), 'napcat', 'config', 'webui.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const found = readWebuiToken(file);
    if (found) return { ...found, file, base };
  }
  return null;
}

/** 协议端 WebUI 返回失败时统一成可读文案 */
function explain(message) {
  const text = String(message || '').trim();
  if (!text) return '协议端返回失败';
  if (/unauthorized/iu.test(text)) return '协议端 WebUI 令牌不正确（可在 NapCat WebUI 设置里查看或重置）';
  if (/QQ Is Logined/iu.test(text)) return '当前已登录 QQ，无需扫码；换号请先在协议端退出登录';
  if (/QRCode Get Error/iu.test(text)) return '协议端还没生成二维码，稍等 1~2 秒再刷新';
  return text;
}

export class NapCatWebUi {
  /**
   * @param {{baseUrl?: string, token?: string, startCommand?: string, logger?: any, timeoutMs?: number}} options
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/u, '');
    this.token = String(options.token || '').trim();
    this.startCommand = String(options.startCommand || '');
    this.logger = options.logger || console;
    this.timeoutMs = Math.max(2000, Number(options.timeoutMs) || 8000);
    this.credential = '';
    this.credentialAt = 0;
    this.loginPromise = null;
    this.discovered = null;
  }

  /** 令牌留空时，按启动命令自动从协议端 webui.json 读取 */
  resolved() {
    if (this.token && this.baseUrl) return { baseUrl: this.baseUrl, token: this.token, source: 'settings' };
    if (!this.discovered) this.discovered = discoverWebui(this.startCommand);
    const auto = this.discovered;
    const baseUrl = this.baseUrl || (auto?.port ? `http://127.0.0.1:${auto.port}` : '');
    const token = this.token || auto?.token || '';
    const source = this.token ? 'settings' : (auto?.file ? 'auto' : '');
    return { baseUrl, token, source };
  }

  get configured() {
    const { baseUrl, token } = this.resolved();
    return !!(baseUrl && token);
  }

  get reason() {
    const { baseUrl, token } = this.resolved();
    if (!baseUrl) return '未填写协议端 WebUI 地址（如 http://127.0.0.1:6099）';
    if (!token) return '没有协议端 WebUI 令牌：请在协议端 webui.json 里取 token，或填在下面';
    return '';
  }

  async #login(force = false) {
    const { baseUrl, token } = this.resolved();
    if (!baseUrl || !token) throw new Error(this.reason || '协议端 WebUI 未配置');
    if (!force && this.credential && Date.now() - this.credentialAt < 30 * 60_000) return this.credential;
    // 并发调用时只登录一次，避免同时触发多条登录（状态接口会并发查两项）
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash: webuiHash(token) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = await r.json().catch(() => null);
      const credential = String(json?.data?.Credential || '');
      if (!r.ok || !credential) throw new Error(explain(json?.message) || `协议端 WebUI 登录失败（HTTP ${r.status}）`);
      this.credential = credential;
      this.credentialAt = Date.now();
      return credential;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async #call(path, { retry = true, body = {} } = {}) {
    const { baseUrl } = this.resolved();
    if (!baseUrl) throw new Error(this.reason || '协议端 WebUI 未配置');
    const credential = await this.#login();
    const r = await fetch(`${baseUrl}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await r.json().catch(() => null);
    if (json?.code === 0) return json.data;
    const message = String(json?.message || '');
    if (/unauthorized/iu.test(message) && retry) {
      this.credential = '';
      await this.#login(true);
      return this.#call(path, { retry: false });
    }
    throw new Error(explain(message));
  }

  /**
   * 登录状态总览：协议端可达 + 当前账号 + 登录阶段。
   * 任何一步失败都返回结构化结果，不抛异常（面板要能显示原因）。
   */
  async status() {
    const { baseUrl, token, source } = this.resolved();
    const base = {
      configured: !!(baseUrl && token),
      reachable: false,
      reason: this.reason,
      webuiUrl: baseUrl,
      tokenSource: source,
      isLogin: false,
      isOffline: false,
      loginPhase: '',
      loginError: '',
      qrcodeUrl: '',
      coreReady: false,
      uin: '',
      nick: '',
      online: false,
    };
    if (!base.configured) return base;
    try {
      const [state, info] = await Promise.all([
        this.#call('/QQLogin/CheckLoginStatus'),
        this.#call('/QQLogin/GetQQLoginInfo').catch(() => null),
      ]);
      return {
        ...base,
        reachable: true,
        reason: '',
        isLogin: state?.isLogin === true,
        isOffline: state?.isOffline === true,
        loginPhase: String(state?.loginPhase || ''),
        loginError: String(state?.loginError || ''),
        qrcodeUrl: String(state?.qrcodeurl || ''),
        coreReady: state?.coreReady === true,
        uin: String(info?.uin || ''),
        nick: String(info?.nick || ''),
        online: info?.online === true,
      };
    } catch (error) {
      return { ...base, reachable: false, reason: String(error?.message || error) };
    }
  }

  /** 取当前登录二维码（未登录时才有）；返回二维码内容，交给面板渲染 */
  async qrcode() {
    const data = await this.#call('/QQLogin/GetQQLoginQrcode');
    const url = String(data?.qrcode || '').trim();
    if (!url) throw new Error('协议端没有返回二维码内容，请稍后重试');
    return { qrcodeUrl: url };
  }

  /** 让协议端换一张二维码 */
  async refreshQrcode() {
    const data = await this.#call('/QQLogin/RefreshQRcode');
    if (data?.restarting) return { restarting: true, qrcodeUrl: '' };
    const url = String(data?.qrcodeurl || '').trim();
    if (!url) throw new Error('协议端正在重启，请稍后重试');
    return { restarting: false, qrcodeUrl: url };
  }

  /** 本机登录过的账号（快速登录） */
  async quickList() {
    const data = await this.#call('/QQLogin/GetQuickLoginListNew');
    const list = Array.isArray(data) ? data : [];
    return list.map((x) => ({
      uin: String(x?.uin || ''),
      nick: String(x?.nickName || x?.nick || ''),
      avatar: String(x?.faceUrl || ''),
      quick: x?.isQuickLogin === true,
    })).filter((x) => x.uin);
  }

  /** 用登录过的账号直接登录（不扫码、不开 QQ） */
  async quickLogin(uin) {
    const account = String(uin || '').trim();
    if (!/^\d{5,12}$/u.test(account)) throw new Error('QQ 号格式不对');
    await this.#call('/QQLogin/SetQuickLogin', { body: { uin: account } });
    return account;
  }
}
