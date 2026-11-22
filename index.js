/**
 * dsh-qqbot-guard：QQ 群管理插件（Host 半边）。
 *
 * 只做群管理：违规防护、入群审批、入群欢迎、公告发布与管理。
 * 不创建 AI 会话、不调用模型、不处理表情包/图片/语音。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from './lib/store.js';
import { BotManager } from './lib/bot.js';
import { Config, mergeSettings } from './lib/config.js';
import { buildSaveSettings, mountRoutes } from './lib/http.js';
import { createApi } from './lib/api.js';
import { AuthStore } from './lib/auth.js';
import { WebPanel } from './lib/webpanel.js';
import { checkCompat } from './lib/compat.js';
import { LIMITS } from './lib/defaults.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './lib/meta.js';

export { Config };
export const name = PLUGIN_NAME;
export const version = PLUGIN_VERSION;
export const inject = [];

function loggerOf(ctx) {
  const logger = ctx?.logger;
  if (logger && typeof logger.info === 'function') return logger;
  return console;
}

function safeName(v, fallback) {
  const s = String(v || '').trim().replace(/[^A-Za-z0-9_-]/gu, '_');
  return s || fallback;
}

function profileNameOf(ctx) {
  try {
    const pc = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
    if (pc?.name) return String(pc.name);
  } catch { /* ignore */ }
  return String(process.env.DSH_PROFILE || '_default');
}

function hasWebServer(ctx) {
  try {
    return !!ctx?.get?.('webServer');
  } catch {
    return false;
  }
}

function resolveDataDir(ctx, config) {
  if (config?.dataDir) return resolve(String(config.dataDir));
  const home = String(process.env.DSH_HOME || join(homedir(), '.dsh'));
  return join(home, 'qqbot-guard', safeName(profileNameOf(ctx), '_default'), safeName(config?.settingsNs, 'qqbot-guard'));
}

export function apply(ctx, config) {
  const logger = loggerOf(ctx);
  let runtime;
  try {
    runtime = createRuntime(ctx, config || {}, logger);
  } catch (error) {
    logger.error?.(`[qqbot-guard] 初始化失败，插件进入安全待机：${errorText(error)}`);
    return;
  }

  const dispose = () => {
    try { runtime.disposed = true; } catch { /* ignore */ }
    try { runtime.getBot()?.dispose?.(); } catch { /* ignore */ }
    try { runtime.panel?.dispose?.(); } catch { /* ignore */ }
    try { runtime.store.dispose(); } catch { /* ignore */ }
  };
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
    else if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
  } catch { /* 老宿主 */ }

  // 面板路由：优先立即挂载；宿主服务稍后就绪时，再通过 ctx.inject 兜底。
  let mounted = false;
  try {
    mounted = mountRoutes(ctx, runtime);
  } catch (error) {
    logger.warn?.(`[qqbot-guard] 面板路由挂载失败：${errorText(error)}`);
  }
  if (!mounted && typeof ctx.inject === 'function') {
    const timer = setTimeout(() => {
      try {
        ctx.inject(['webServer'], (serverCtx) => {
          try {
            mountRoutes(serverCtx, runtime);
          } catch (error) {
            logger.warn?.(`[qqbot-guard] 面板路由延迟挂载失败：${errorText(error)}`);
          }
        });
      } catch (error) {
        logger.warn?.(`[qqbot-guard] 面板路由注入失败：${errorText(error)}`);
      }
    }, 0);
    if (timer.unref) timer.unref();
  }

  if (runtime.store.settings.autoConnect) {
    void runtime.startBot();
  } else {
    logger.info?.('[qqbot-guard] 自动连接已关闭，可在面板里手动连接');
  }
}

function createRuntime(ctx, config, logger) {
  const dataDir = resolveDataDir(ctx, config);
  const store = new Store(dataDir);

  // 首次安装 / 自有设置为空时，用宿主配置里的凭据补位（不改宿主配置文件）。
  const seeded = mergeSettings(store.settings, {
    ...(store.settings.appId ? {} : { appId: String(config.appId || '') }),
    ...(store.settings.appSecret ? {} : { appSecret: String(config.appSecret || '') }),
  });
  if (seeded.appId !== store.settings.appId || seeded.appSecret !== store.settings.appSecret) {
    store.saveSettings(seeded);
  }

  let bot;
  let restarting = false;
  const auth = new AuthStore(dataDir);
  const runtime = {
    dataDir,
    store,
    logger,
    auth,
    version: PLUGIN_VERSION,
    disposed: false,
    challenges: new Map(),
    getBot: () => bot,
    getClient: () => bot?.client,
    getCompat: () => checkCompat({ dataDir, webAvailable: hasWebServer(ctx) }),
    saveSettings: null,
    restartBot,
    startBot,
  };
  runtime.api = createApi(runtime);
  const panel = new WebPanel(runtime);
  runtime.panel = panel;
  runtime.getPanelInfo = () => panel.info();
  runtime.applyPanelSettings = async () => {
    try {
      return await panel.restart();
    } catch (error) {
      logger.warn?.(`[qqbot-guard] 面板重启失败：${errorText(error)}`);
      return { ok: false, error: errorText(error) };
    }
  };
  runtime.notifySettingsChange = (info) => {
    const client = runtime.getClient();
    if (!client) return { queued: false, reason: '机器人未连接' };
    const groups = Object.keys(store.state.groups).slice(0, LIMITS.notifyMaxGroups);
    if (!groups.length) return { queued: false, reason: '还没有已加入的群' };
    const settings = store.settings;
    const roleLabel = info?.role === 'admin' ? '最高管理员' : '普通管理员';
    const notifyName = String(settings.panel.notifyName || '').trim();
    const notifyUid = String(settings.panel.notifyOpenid || '').trim();
    const lines = [
      '【设置变更通知】',
      `操作者：${roleLabel}`,
      `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      info?.ip ? `来源：${info.ip}` : '',
      ...(Array.isArray(info?.summary) ? info.summary : []),
    ].filter(Boolean).join('\n').slice(0, LIMITS.notifyMaxChars);
    void (async () => {
      for (const gid of groups) {
        try {
          // @ 仅对普通管理员生效；昵称与 openid 必须同时匹配同一位成员
          const target = info?.role === 'operator' && notifyName && notifyUid
            ? (store.findMemberByUidAndName(gid, notifyUid, notifyName)?.uid || '')
            : '';
          const text = (target ? `<@${target}> ` : '') + lines;
          const r = await client.sendGroupText(gid, text);
          store.appendAudit({
            kind: 'config', action: 'notify', groupId: gid,
            groupName: store.state.groups[gid]?.name || '',
            userId: target, userName: target ? notifyName : '',
            detail: r.ok ? '已发送设置变更通知' : `通知发送失败：${r.err?.human || ''}`,
            ok: r.ok, code: r.ok ? '' : r.err?.code || '', confidence: 1,
          });
        } catch (error) {
          logger.warn?.(`[qqbot-guard] 设置变更通知失败 ${gid}：${errorText(error)}`);
        }
      }
    })();
    return { queued: true, groups: groups.length, notifyName };
  };

  const compat = checkCompat({ dataDir });
  if (!compat.ok) {
    logger.warn?.(`[qqbot-guard] 兼容性自检未通过：${compat.requiredFailed.join(', ')}（Node ${compat.node} / ${compat.platform} ${compat.arch}）`);
  } else {
    logger.info?.(`[qqbot-guard] 兼容性自检通过（Node ${compat.node} / ${compat.platform} ${compat.arch}）`);
  }
  if (compat.warnings.length) {
    logger.warn?.(`[qqbot-guard] 兼容性提示：${compat.warnings.join(', ')}（可在面板“设置”查看详情）`);
  }

  runtime.saveSettings = buildSaveSettings(runtime);

  async function startBot() {
    if (runtime.disposed) return false;
    if (bot && (bot.state === 'online' || bot.state === 'connecting')) return true;
    if (!store.settings.appId || !store.settings.appSecret) {
      logger.info?.('[qqbot-guard] 尚未配置 AppID / AppSecret，等待面板填写');
      return false;
    }
    const next = new BotManager({
      store,
      logger,
      appId: store.settings.appId,
      appSecret: store.settings.appSecret,
      watchJoinRequests: store.settings.watchJoinRequests,
    });
    bot = next;
    try {
      const okStart = await next.start();
      if (!okStart) logger.warn?.('[qqbot-guard] 连接未成功，已进入自动重连');
      return okStart;
    } catch (error) {
      logger.warn?.(`[qqbot-guard] 启动连接异常：${errorText(error)}`);
      return false;
    }
  }

  async function restartBot() {
    if (restarting) return;
    restarting = true;
    try {
      const old = bot;
      bot = undefined;
      try { await old?.stop(); } catch { /* ignore */ }
      if (!store.settings.autoConnect) return;
      await startBot();
    } finally {
      restarting = false;
    }
  }

  logger.info?.(`[qqbot-guard] 数据目录：${dataDir}`);
  void panel.start().catch((error) => {
    logger.warn?.(`[qqbot-guard] 独立面板启动异常：${errorText(error)}`);
  });
  return runtime;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
