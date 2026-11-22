/**
 * dsh 内置面板适配层：把宿主 webServer 的 req/res 转成共享 API 调度器。
 * 独立局域网面板使用 lib/webpanel.js，业务逻辑完全一致。
 */
import { createApi, createSaveSettings, PREFIX } from './api.js';
import { fail } from './envelope.js';

/** 同一实例只挂载一次 */
const mounted = new Set();

function writeJson(res, status, envelope) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(envelope));
}

function isTrusted(req) {
  const host = String(req.headers?.host || '');
  const origin = String(req.headers?.origin || '');
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
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

function queryOf(url) {
  const out = {};
  try {
    const u = new URL(url || '/', 'http://x');
    for (const [key, value] of u.searchParams) out[key] = value;
  } catch { /* ignore */ }
  return out;
}

/**
 * 注册所有路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} runtime
 * @returns {boolean}
 */
export function mountRoutes(ctx, runtime) {
  const server = typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer;
  if (!server || typeof server.register !== 'function') return false;
  const key = runtime.dataDir + '|' + PREFIX;
  if (mounted.has(key)) return true;

  const api = runtime.api || (runtime.api = createApi(runtime));
  const disposers = [];
  for (const route of api.routes) {
    try {
      const dispose = server.register({
        kind: 'exact',
        path: PREFIX + route.path,
        handler: async (req, res) => {
          if (!isTrusted(req)) return writeJson(res, 403, fail('FORBIDDEN', '仅允许同源访问'));
          const method = String(req.method || 'GET').toUpperCase();
          if (!route.methods.includes(method)) {
            return writeJson(res, 405, fail('METHOD_NOT_ALLOWED', '方法不允许'));
          }
          if (method !== 'GET' && String(req.headers?.['x-qqbot-guard'] || '') !== '1') {
            return writeJson(res, 403, fail('FORBIDDEN', '缺少写接口校验头'));
          }
          let body = {};
          if (method !== 'GET') {
            const parsed = await readBody(req);
            if (!parsed.ok) return writeJson(res, 400, fail('BAD_BODY', parsed.error));
            body = parsed.value;
          }
          const envelope = await api.dispatch({
            method,
            path: route.path,
            query: queryOf(req.url),
            body,
            headers: req.headers || {},
            auth: { role: 'admin', via: 'dsh', ip: req.socket?.remoteAddress || '' },
            ip: req.socket?.remoteAddress || '',
          });
          writeJson(res, envelope.ok ? 200 : 400, envelope);
        },
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      runtime.logger?.warn?.(`[qqbot-guard] 路由注册失败 ${route.path}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  mounted.add(key);
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose(); } catch { /* ignore */ }
        }
        mounted.delete(key);
      });
    }
  } catch {
    // 老宿主没有 effect 时，路由随进程存活，不影响功能
  }
  return disposers.length > 0;
}

/** 供 index.js 使用的保存入口（会触发重连 / 面板重启） */
export function buildSaveSettings(runtime) {
  return createSaveSettings(runtime);
}
