/**
 * Web 面板的 HTTP 接口。所有响应都经过统一信封校验；任何异常都转成安全失败 JSON。
 */
import { LIMITS } from './defaults.js';
import { assertEnvelope, fail, ok } from './envelope.js';
import { normalizeSettings } from './config.js';
import {
  createAnnouncement, deleteAnnouncement, listAnnouncements, pauseAnnouncement, publishAnnouncement, updateAnnouncement,
} from './announcements.js';
import { actOnJoinRequest, syncJoinRequests } from './join.js';
import { probeNetwork } from './compat.js';

const PREFIX = '/api/qqbot-guard';

/** 同一实例只挂载一次 */
const mounted = new Set();

function writeJson(res, status, envelope) {
  let body;
  try {
    assertEnvelope(envelope);
    body = envelope;
  } catch {
    body = fail('ENVELOPE_INVALID', '内部响应格式异常，已返回安全兜底结果');
  }
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(text);
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
      if (size > LIMITS.httpBodyBytes) {
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
        if (!value || typeof value !== 'object' || Array.isArray(value)) return resolve({ ok: false, error: '请求体必须是 JSON 对象' });
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, error: 'JSON 解析失败' });
      }
    });
    req.on('error', () => resolve({ ok: false, error: '读取请求失败' }));
  });
}

function maskSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  const secretSet = !!copy.appSecret;
  copy.appSecret = secretSet ? '••••••••' : '';
  copy.secretSet = secretSet;
  return copy;
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

  const routes = [];
  const add = (path, methods, handler) => routes.push({ path: PREFIX + path, methods, handler });

  add('/bootstrap', ['GET'], async () => {
    const bot = runtime.getBot();
    const snap = runtime.store.snapshot();
    return ok({
      version: runtime.version,
      dataDir: runtime.dataDir,
      status: bot?.snapshot() || { configured: false, state: 'unconfigured' },
      settings: maskSettings(runtime.store.settings),
      groups: snap.groups,
      counts: {
        groupCount: snap.groupCount,
        memberCount: snap.memberCount,
        pendingCount: snap.pendingCount,
        counters: snap.counters,
      },
      pending: runtime.store.listPending(),
      announcements: listAnnouncements(runtime.store),
      audit: runtime.store.readAudit(60),
      compat: runtime.getCompat ? runtime.getCompat() : null,
    });
  });

  add('/compat', ['GET'], async (req) => {
    const url = new URL(req.url || '/', 'http://x');
    const base = runtime.getCompat ? runtime.getCompat() : null;
    if (!base) return fail('COMPAT_UNAVAILABLE', '兼容性自检不可用');
    if (url.searchParams.get('network') === '1') {
      base.network = await probeNetwork();
    }
    return ok(base, { confidence: 1 });
  });

  add('/status', ['GET'], async () => {
    const bot = runtime.getBot();
    return ok({
      status: bot?.snapshot() || { configured: false, state: 'unconfigured' },
      counts: runtime.store.snapshot().counters,
    });
  });

  add('/health', ['GET'], async () => ok({ alive: true, uptimeMs: process.uptime() * 1000 }));

  add('/settings', ['POST'], async (req) => {
    if (!(await trustedPost(req))) return fail('FORBIDDEN', '仅允许同源面板调用');
    const body = await readBody(req);
    if (!body.ok) return fail('BAD_BODY', body.error);
    const patch = body.value.patch;
    if (!patch || typeof patch !== 'object') return fail('BAD_PATCH', '缺少 patch');
    return runtime.saveSettings(patch);
  });

  add('/announcements', ['POST'], async (req) => {
    if (!(await trustedPost(req))) return fail('FORBIDDEN', '仅允许同源面板调用');
    const body = await readBody(req);
    if (!body.ok) return fail('BAD_BODY', body.error);
    const { action, id, input, patch } = body.value;
    const store = runtime.store;
    const client = runtime.getClient();
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
      const r = await publishAnnouncement({ store, client, id });
      return r.ok
        ? ok({ item: r.item, sent: r.sent, total: r.total }, { confidence: 1 })
        : fail('PUBLISH_FAILED', r.error || '发布失败', { extra: { item: r.item || null } });
    }
    return fail('BAD_ACTION', '未知操作');
  });

  add('/join', ['POST'], async (req) => {
    if (!(await trustedPost(req))) return fail('FORBIDDEN', '仅允许同源面板调用');
    const body = await readBody(req);
    if (!body.ok) return fail('BAD_BODY', body.error);
    const { action, gid, uid, jid, reason } = body.value;
    const client = runtime.getClient();
    if (!client) return fail('NOT_CONNECTED', '机器人未连接，请先在设置里填写 AppID/Secret');
    if (!gid) return fail('BAD_GID', '缺少群 openid');
    if (action === 'refresh') {
      const r = await syncJoinRequests(client, runtime.store, String(gid));
      return r.ok ? ok(r) : fail('REFRESH_FAILED', r.error || '刷新失败');
    }
    if (!uid) return fail('BAD_UID', '缺少成员 openid');
    const r = await actOnJoinRequest({
      client, store: runtime.store, gid: String(gid), uid: String(uid), jid: String(jid || ''), action, reason,
    }, runtime.logger);
    return r.ok ? ok(r) : fail('JOIN_ACTION_FAILED', r.error || '审批失败', { extra: { code: r.code } });
  });

  add('/members', ['GET'], async (req) => {
    const url = new URL(req.url || '/', 'http://x');
    const gid = String(url.searchParams.get('gid') || '').trim();
    const q = String(url.searchParams.get('q') || '').trim();
    const members = runtime.store.searchMembers(gid, q, LIMITS.memberSearchLimit);
    return ok({ members, total: members.length }, { confidence: 0.9 });
  });

  add('/members/action', ['POST'], async (req) => {
    if (!(await trustedPost(req))) return fail('FORBIDDEN', '仅允许同源面板调用');
    const body = await readBody(req);
    if (!body.ok) return fail('BAD_BODY', body.error);
    const { action, gid, uid, seconds } = body.value;
    const client = runtime.getClient();
    if (!client) return fail('NOT_CONNECTED', '机器人未连接');
    if (!gid || !uid) return fail('BAD_TARGET', '缺少群或成员标识');
    if (action === 'mute') {
      const secs = Math.max(1, Math.min(30 * 24 * 3600, Number(seconds) || runtime.store.settings.moderation.muteSeconds));
      const r = await client.setMemberMute(String(gid), String(uid), secs);
      return r.ok ? ok({ muted: true, seconds: secs }) : fail('MUTE_FAILED', r.err?.human || '禁言失败');
    }
    if (action === 'unmute') {
      const r = await client.setMemberMute(String(gid), String(uid), null);
      return r.ok ? ok({ muted: false }) : fail('UNMUTE_FAILED', r.err?.human || '解除禁言失败');
    }
    if (action === 'kick') {
      const r = await client.removeMembers(String(gid), [String(uid)]);
      return r.ok ? ok({ kicked: true }) : fail('KICK_FAILED', r.err?.human || '移出失败');
    }
    return fail('BAD_ACTION', '未知操作');
  });

  add('/groups', ['POST'], async (req) => {
    if (!(await trustedPost(req))) return fail('FORBIDDEN', '仅允许同源面板调用');
    const body = await readBody(req);
    if (!body.ok) return fail('BAD_BODY', body.error);
    const { action, gid, name } = body.value;
    const id = String(gid || '').trim();
    if (!id) return fail('BAD_GID', '缺少群 openid');
    if (action === 'add' || action === 'rename') {
      runtime.store.upsertGroup(id, { name: String(name || '').trim().slice(0, LIMITS.groupNameMaxChars) });
      if (action === 'add') {
        void runtime.getBot()?.refreshGroupInfo?.(id);
      }
      return ok(runtime.store.state.groups[id]);
    }
    if (action === 'remove') {
      const existed = runtime.store.removeGroup(id);
      return existed ? ok({ removed: id }) : fail('NOT_FOUND', '群不在注册表里');
    }
    return fail('BAD_ACTION', '未知操作');
  });

  add('/audit', ['GET'], async (req) => {
    const url = new URL(req.url || '/', 'http://x');
    const limit = Number(url.searchParams.get('limit') || 50);
    return ok({ items: runtime.store.readAudit(limit) });
  });

  async function trustedPost(req) {
    if (!isTrusted(req)) return false;
    if (String(req.headers?.['x-qqbot-guard'] || '') !== '1') return false;
    const ct = String(req.headers?.['content-type'] || '');
    return ct.includes('application/json');
  }

  const disposers = [];
  for (const route of routes) {
    try {
      const dispose = server.register({
        kind: 'exact',
        path: route.path,
        handler: async (req, res) => {
          if (!isTrusted(req)) return writeJson(res, 403, fail('FORBIDDEN', '仅允许同源访问'));
          const method = String(req.method || 'GET').toUpperCase();
          if (!route.methods.includes(method)) return writeJson(res, 405, fail('METHOD_NOT_ALLOWED', '方法不允许'));
          try {
            const envelope = await route.handler(req, res);
            writeJson(res, envelope.ok ? 200 : 400, envelope);
          } catch (error) {
            runtime.logger?.warn?.('[qqbot-guard] HTTP 处理异常：' + (error instanceof Error ? error.message : String(error)));
            writeJson(res, 500, fail('INTERNAL', '服务器内部错误，已安全降级'));
          }
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

/** 供 index.js 使用的保存入口（会触发重连） */
export function buildSaveSettings(runtime) {
  return (patch) => {
    const merged = mergeSettingsSafe(runtime.store.settings, patch);
    const { value, errors } = normalizeSettings(merged);
    const hardErrors = errors.filter((x) => !x.includes('已忽略'));
    if (hardErrors.length) {
      return fail('INVALID_SETTINGS', hardErrors.join('；'), { extra: { errors } });
    }
    const before = { appId: runtime.store.settings.appId, appSecret: runtime.store.settings.appSecret };
    runtime.store.saveSettings(value);
    runtime.store.appendAudit({
      kind: 'config', action: 'update', detail: '面板保存设置', confidence: 1,
    });
    if (before.appId !== value.appId || before.appSecret !== value.appSecret) {
      runtime.restartBot();
    } else if (!value.autoConnect) {
      void runtime.getBot()?.stop?.();
    } else {
      const bot = runtime.getBot();
      if (value.appId && value.appSecret && (!bot || !bot.configured?.() || bot.state === 'error' || bot.state === 'disconnected')) {
        void runtime.startBot?.();
      }
    }
    return ok(maskSettings(value), { extra: { warnings: errors } });
  };
}

function mergeSettingsSafe(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (key === 'appSecret' && (val === '' || /^[•*]+$/u.test(String(val)))) continue;
    if (val && typeof val === 'object' && !Array.isArray(val) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeSettingsSafe(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}
