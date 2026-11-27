/**
 * 独立局域网 Web 面板：不依赖 dsh 设置页，浏览器直接访问。
 * 双密码登录（最高管理员 / 普通管理员）、会话 Cookie、登录限流、CSRF 校验。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { AuthStore, LoginGuard, SessionStore } from './auth.js';
import { createApi } from './api.js';
import { fail, ok } from './envelope.js';
import { LIMITS } from './defaults.js';

const ROOT = fileURLToPath(new URL('../webpanel/', import.meta.url));
const COOKIE = 'qqg_session';
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
});

export class WebPanel {
  constructor(runtime) {
    this.runtime = runtime;
    this.auth = runtime.auth || new AuthStore(runtime.dataDir);
    this.sessions = new SessionStore({ ttlMs: 12 * 3600_000 });
    this.guard = new LoginGuard();
    this.api = runtime.api || (runtime.api = createApi(runtime));
    this.server = undefined;
    this.port = 0;
    this.host = '';
    this.urls = [];
    this.running = false;
    this.lastError = '';
  }

  /** 是否信任 x-forwarded-for（仅当部署在反向代理后，且显式开启 panel.trustProxy） */
  get trustProxy() {
    return this.runtime.store?.settings?.panel?.trustProxy === true;
  }

  /** 统一取客户端 IP（登录限流与审计共用） */
  ipOf(req) {
    return clientIp(req, this.trustProxy);
  }

  async start() {
    await this.stop();
    const cfg = this.runtime.store.settings.panel;
    if (!cfg?.enabled) {
      this.host = cfg?.host || '';
      return { ok: true, enabled: false };
    }
    const host = cfg.host || '0.0.0.0';
    const port = Number.isFinite(Number(cfg.port)) ? Number(cfg.port) : LIMITS.panelDefaultPort;
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.runtime.logger?.warn?.('[qqbot-guard] 面板请求异常：' + (error instanceof Error ? error.message : String(error)));
        try {
          if (!res.headersSent) this.sendJson(res, 500, fail('INTERNAL', '面板内部错误，已安全降级'));
          else res.end();
        } catch { /* ignore */ }
      });
    });
    this.server.headersTimeout = 20_000;
    this.server.requestTimeout = 30_000;
    const result = await new Promise((resolve) => {
      const onError = (error) => {
        this.server = undefined;
        resolve({ ok: false, error: error?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : (error?.message || '监听失败') });
      };
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.off('error', onError);
        this.port = this.server.address().port;
        this.host = host;
        this.urls = buildUrls(host, this.port);
        this.running = true;
        resolve({ ok: true, enabled: true, port: this.port, urls: this.urls });
      });
    });
    if (!result.ok) {
      this.lastError = result.error || '监听失败';
      this.runtime.logger?.warn?.(`[qqbot-guard] 独立面板启动失败：${result.error}`);
      return result;
    }
    this.lastError = '';
    const security = this.auth.status();
    if (!security.initialized) {
      this.runtime.logger?.warn?.('[qqbot-guard] 面板尚未设置密码，请在首次访问时由部署方设置');
    }
    this.runtime.logger?.info?.(`[qqbot-guard] 独立面板已启动：${this.urls.join('  ')}`);
    return result;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.running = false;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      setTimeout(resolve, 1500).unref?.();
    });
  }

  async restart() {
    return this.start();
  }

  info() {
    return {
      enabled: !!this.runtime.store.settings.panel?.enabled,
      running: this.running,
      host: this.host,
      port: this.port,
      urls: this.urls,
      lastError: this.lastError,
      initialized: this.auth.status().initialized,
    };
  }

  dispose() {
    void this.stop();
    this.sessions.dispose();
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    setSecurityHeaders(res);
    if (path.startsWith('/api/qqg/')) return this.handleAuthApi(req, res, path);
    if (path.startsWith('/api/qqbot-guard/')) return this.handlePluginApi(req, res, url);
    if (path.startsWith('/api/')) return this.sendJson(res, 404, fail('NOT_FOUND', '接口不存在'));
    return this.serveStatic(req, res, path);
  }

  async handleAuthApi(req, res, path) {
    const method = String(req.method || 'GET').toUpperCase();
    // 首次部署：先选语言，之后才允许设置密码 / 登录 / 其它会话操作
    if (this.runtime.needsLanguage?.() && !(path === '/api/qqg/session' && method === 'GET')) {
      return this.sendJson(res, 409, fail('LANGUAGE_REQUIRED', '请先选择界面语言'));
    }
    if (path === '/api/qqg/setup' && method === 'POST') {
      if (this.auth.status().initialized) {
        return this.sendJson(res, 409, fail('ALREADY_INITIALIZED', '面板密码已设置，请直接登录'));
      }
      if (!this.csrfOk(req)) return this.sendJson(res, 403, fail('FORBIDDEN', 'CSRF 校验失败'));
      const body = await readJson(req);
      if (!body.ok) return this.sendJson(res, 400, fail('BAD_BODY', body.error));
      const result = this.auth.setup({
        adminPassword: String(body.value?.adminPassword || ''),
        operatorPassword: String(body.value?.operatorPassword || ''),
      });
      if (!result.ok) return this.sendJson(res, 400, fail('SETUP_FAILED', result.error || '初始化失败'));
      const ip = clientIp(req);
      this.runtime.store?.appendAudit?.({
        kind: 'config', action: 'password',
        userName: '最高管理员', userId: ip,
        detail: '首次初始化面板密码', confidence: 1,
      });
      this.guard.success(ip);
      const session = this.sessions.create('admin', ip);
      res.setHeader('set-cookie', `${COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessions.ttlMs / 1000)}`);
      return this.sendJson(res, 200, ok({
        role: 'admin',
        roleLabel: '最高管理员',
        initialized: true,
        security: this.auth.status(),
        expiresAt: new Date(session.expiresAt).toISOString(),
      }));
    }
    if (path === '/api/qqg/login' && method === 'POST') {
      if (!this.auth.status().initialized) {
        return this.sendJson(res, 409, fail('SETUP_REQUIRED', '请先设置面板密码'));
      }
      const ip = clientIp(req);
      const lock = this.guard.check(ip);
      if (!lock.ok) return this.sendJson(res, 429, fail('LOCKED', lock.reason || '请稍后再试'));
      const body = await readJson(req);
      if (!body.ok) return this.sendJson(res, 400, fail('BAD_BODY', body.error));
      const password = String(body.value?.password || '');
      const role = this.auth.verify(password);
      if (!role) {
        this.guard.fail(ip);
        return this.sendJson(res, 401, fail('BAD_PASSWORD', '密码不正确'));
      }
      this.guard.success(ip);
      const session = this.sessions.create(role, ip);
      res.setHeader('set-cookie', `${COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessions.ttlMs / 1000)}`);
      return this.sendJson(res, 200, ok({
        initialized: this.auth.status().initialized,
        role: role,
        roleLabel: role === 'admin' ? '最高管理员' : '普通管理员',
        security: this.auth.status(),
        expiresAt: new Date(session.expiresAt).toISOString(),
      }));
    }
    if (path === '/api/qqg/logout' && method === 'POST') {
      this.sessions.destroy(readCookie(req, COOKIE));
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return this.sendJson(res, 200, ok({ loggedOut: true }));
    }
    if (path === '/api/qqg/session' && method === 'GET') {
      const token = readCookie(req, COOKIE);
      const session = this.sessions.touch(token);
      return this.sendJson(res, 200, ok({
        initialized: this.auth.status().initialized,
        role: session?.role || null,
        roleLabel: session ? (session.role === 'admin' ? '最高管理员' : '普通管理员') : '',
        security: this.auth.status(),
      }));
    }
    if (path === '/api/qqg/password' && method === 'POST') {
      const token = readCookie(req, COOKIE);
      const session = this.sessions.get(token);
      if (!session || session.role !== 'admin') return this.sendJson(res, 403, fail('FORBIDDEN', '需要最高管理员权限'));
      if (!this.csrfOk(req)) return this.sendJson(res, 403, fail('FORBIDDEN', 'CSRF 校验失败'));
      const body = await readJson(req);
      if (!body.ok) return this.sendJson(res, 400, fail('BAD_BODY', body.error));
      const envelope = await this.api.dispatch({
        method: 'POST',
        path: '/security/password',
        body: body.value,
        auth: this.authOf(req, session, token),
        ip: clientIp(req),
      });
      if (envelope.ok) {
        // 改密后所有会话失效，强制重新登录
        this.sessions.sweep(Number.MAX_SAFE_INTEGER);
        this.sessions.destroy(token);
        res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      }
      return this.sendJson(res, envelope.ok ? 200 : 400, envelope);
    }
    return this.sendJson(res, 404, fail('NOT_FOUND', '接口不存在'));
  }

  async handlePluginApi(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const token = readCookie(req, COOKIE);
    const session = this.sessions.touch(token);
    const path = url.pathname.replace('/api/qqbot-guard', '').replace(/\/+$/u, '') || '/';
    const query = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    // 首次部署必须先选语言：只放行 bootstrap / 选语言 / 健康检查，其余一律拒绝
    const gateFree = ['/bootstrap', '/language', '/health'].includes(path);
    if (!session && !gateFree && !(path === '/health' && method === 'GET')) {
      return this.sendJson(res, 401, fail('UNAUTHORIZED', '请先登录'));
    }
    if (this.runtime.needsLanguage?.() && !gateFree) {
      return this.sendJson(res, 409, fail('LANGUAGE_REQUIRED', '请先选择界面语言，首次部署不允许绕过'));
    }
    if (method !== 'GET' && session && !this.csrfOk(req)) {
      return this.sendJson(res, 403, fail('FORBIDDEN', 'CSRF 校验失败'));
    }
    let body = {};
    if (method !== 'GET') {
      const parsed = await readJson(req);
      if (!parsed.ok) return this.sendJson(res, 400, fail('BAD_BODY', parsed.error));
      body = parsed.value;
    }
    const envelope = await this.api.dispatch({
      method,
      path,
      query,
      body,
      headers: req.headers,
      auth: session ? this.authOf(req, session, token) : { role: '', via: 'panel', ip: clientIp(req) },
      ip: clientIp(req),
    });
    return this.sendJson(res, envelope.ok ? 200 : (envelope.error?.code === 'METHOD_NOT_ALLOWED' ? 405 : 400), envelope);
  }

  authOf(req, session, token) {
    return {
      role: session.role,
      via: 'panel',
      sessionId: token,
      ip: clientIp(req),
    };
  }

  csrfOk(req) {
    const header = String(req.headers?.['x-qqg-csrf'] || '');
    if (header !== '1') return false;
    const origin = String(req.headers?.origin || '');
    if (!origin) return true;
    try {
      return new URL(origin).host === String(req.headers?.host || '');
    } catch {
      return false;
    }
  }

  async serveStatic(req, res, path) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return this.sendJson(res, 405, fail('METHOD_NOT_ALLOWED', '方法不允许'));
    let file = path === '/' ? 'index.html' : path.replace(/^\/+/u, '');
    if (file === 'favicon.ico' || file === 'icon.svg') file = 'icon.svg';
    const safe = normalize(file).replace(/^(\.\.[/\\])+/u, '');
    if (!/^(index\.html|app\.js|style\.css|icon\.svg)$/u.test(safe)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    try {
      // icon.svg 在包根目录（与 webpanel/ 同级），其它文件在 webpanel/ 下。
      // 旧实现统一从 ROOT 读，导致 /icon.svg 永远 404、favicon 请求一直失败。
      const full = safe === 'icon.svg' ? join(ROOT, '..', safe) : join(ROOT, safe);
      const data = await readFile(full);
      res.statusCode = 200;
      res.setHeader('content-type', MIME[extname(safe)] || 'application/octet-stream');
      res.setHeader('cache-control', safe === 'index.html' ? 'no-store' : 'no-cache');
      res.end(method === 'HEAD' ? undefined : data);
    } catch {
      res.statusCode = 404;
      res.end('Not Found');
    }
  }

  sendJson(res, status, envelope) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(envelope));
  }
}

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
}

function readCookie(req, name) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/**
 * 取客户端 IP。
 * ⚠️ 旧实现无条件信任 x-forwarded-for 的第一段：直连（没有反向代理）时
 * 攻击者每次换一个 XFF 就能绕过登录失败限流，同时污染审计日志里的来源 IP。
 * 现在只有显式开启 `panel.trustProxy` 才采信 XFF；否则一律用 TCP 对端地址。
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} [trustProxy]
 */
function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress || '');
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.panelBodyBytes) {
        resolve({ ok: false, error: '请求体过大' });
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({ ok: true, value: {} });
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return resolve({ ok: false, error: '请求体必须是 JSON 对象' });
        }
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, error: 'JSON 解析失败' });
      }
    });
    req.on('error', () => resolve({ ok: false, error: '读取请求失败' }));
  });
}

function buildUrls(host, port) {
  if (host && host !== '0.0.0.0' && host !== '::') return [`http://${host}:${port}/`];
  const out = new Set([`http://127.0.0.1:${port}/`]);
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === 'IPv4' && !item.internal) out.add(`http://${item.address}:${port}/`);
      }
    }
  } catch { /* ignore */ }
  return [...out];
}
