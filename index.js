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
import { mention } from './lib/qq-api.js';
import { AiGuard } from './lib/ai.js';
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

/** 取 DSH 宿主的模型接缝（按需读取，服务晚加载也能拿到；拿不到就回退） */
function llmSeamOf(ctx) {
  const get = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    get llm() { return get('llm'); },
    get agentDefaultModel() { return get('agentDefaultModel'); },
    get attachments() { return get('attachments'); },
  };
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
    try { runtime.ai?.dispose?.(); } catch { /* ignore */ }
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
  // store / auth / ai / panel 都要能在“完整重启”时整体替换，因此用 let
  let store = new Store(dataDir);

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
  let auth = new AuthStore(dataDir);
  let ai = new AiGuard({ store, logger, dsh: llmSeamOf(ctx) });
  const runtime = {
    dataDir,
    store,
    logger,
    auth,
    ai,
    version: PLUGIN_VERSION,
    disposed: false,
    challenges: new Map(),
    getBot: () => bot,
    getClient: () => bot?.client,
    getCompat: () => checkCompat({ dataDir, webAvailable: hasWebServer(ctx) }),
    saveSettings: null,
    restartBot,
    startBot,
    restartPlugin,
  };
  runtime.api = createApi(runtime);
  let panel = new WebPanel(runtime);
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
  /**
   * 向所有已管理的群广播通知；可选 @ 面板里设置的通知对象。
   * forceMention=true 时不限制角色（安全告警必须叫到人）。
   */
  const broadcast = (lines, info = {}) => {
    const client = runtime.getClient();
    if (!client) return { queued: false, reason: '机器人未连接' };
    const groups = Object.keys(store.state.groups).slice(0, LIMITS.notifyMaxGroups);
    if (!groups.length) return { queued: false, reason: '还没有已加入的群' };
    const settings = store.settings;
    const notifyName = String(settings.panel.notifyName || '').trim();
    const notifyUid = String(settings.panel.notifyOpenid || '').trim();
    const forceMention = info?.forceMention === true;
    void (async () => {
      // @ 默认仅对普通管理员生效；有 openid 时要求昵称与 openid 同时匹配。
      // 没填 openid 时按昵称匹配：群内该昵称唯一才会 @，同名则不猜。
      let apiVerified;
      const resolveTarget = async (gid) => {
        if (!forceMention && info?.role !== 'operator') return '';
        if (!notifyName) return '';
        if (notifyUid) {
          const member = store.findMemberByUidAndName(gid, notifyUid, notifyName);
          if (member) return member.uid;
          if (apiVerified === undefined) {
            const r = await client.getUserInfo?.(notifyUid);
            const nickname = String(r?.ok ? (r.data?.username || r.data?.nickname || '') : '').trim();
            apiVerified = !!nickname && nickname.normalize('NFKC').toLowerCase() === notifyName.normalize('NFKC').toLowerCase();
            if (!apiVerified) {
              logger.warn?.(`[qqbot-guard] 通知对象未通过校验：昵称「${notifyName}」与 openid 对应的官方昵称「${nickname || '未知'}」不一致`);
            }
          }
          return apiVerified ? notifyUid : '';
        }
        const list = store.findMembersByName(gid, notifyName);
        const uids = new Set(list.map((x) => x.uid));
        if (uids.size === 1) return list[0].uid;
        if (uids.size > 1) {
          logger.warn?.(`[qqbot-guard] 群 ${gid} 里有 ${uids.size} 位同名成员「${notifyName}」，跳过 @`);
        }
        return '';
      };
      for (const gid of groups) {
        try {
          const target = await resolveTarget(gid);
          const text = (target ? mention(target) + ' ' : '') + lines;
          const r = await client.sendGroupText(gid, text);
          store.appendAudit({
            kind: info?.auditKind || 'config', action: info?.auditAction || 'notify', groupId: gid,
            groupName: store.state.groups[gid]?.name || '',
            userId: target, userName: target ? notifyName : '',
            detail: r.ok ? (info?.okText || '已发送通知') : `通知发送失败：${r.err?.human || ''}`,
            ok: r.ok, code: r.ok ? '' : r.err?.code || '', confidence: 1,
          });
        } catch (error) {
          logger.warn?.(`[qqbot-guard] 群通知发送失败 ${gid}：${errorText(error)}`);
        }
      }
    })();
    return { queued: true, groups: groups.length, notifyName };
  };
  runtime.broadcast = broadcast;

  runtime.notifySettingsChange = (info) => {
    const roleLabel = info?.role === 'admin' ? '最高管理员' : '普通管理员';
    const lines = [
      '【设置变更通知】',
      `操作者：${roleLabel}`,
      `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      info?.ip ? `来源：${info.ip}` : '',
      ...(Array.isArray(info?.summary) ? info.summary : []),
    ].filter(Boolean).join('\n').slice(0, LIMITS.notifyMaxChars);
    return broadcast(lines, { ...info, okText: '已发送设置变更通知' });
  };

  /** 信任成员触发感情牌夹带指令：通告所有群，并 @ 面板设置的通知对象（不禁言） */
  runtime.notifyTrustedAbuse = (info) => {
    const lines = [
      '【安全告警】',
      `群：${info?.groupName || '未知群'}（${info?.gid || ''}）`,
      `成员：${info?.name || '未备注'}（${info?.uid || ''}）`,
      `类型：${info?.reason || '感情牌夹带越权指令'}`,
      `内容：${String(info?.text || '').slice(0, 100)}`,
      '处理：已拦截并警告，未禁言（信任成员，可能是安全测试）',
    ].join('\n').slice(0, LIMITS.notifyMaxChars);
    return broadcast(lines, {
      ...info,
      forceMention: true,
      auditKind: 'command',
      auditAction: 'trusted-alert-notify',
      okText: '已通告安全告警',
    });
  };

  /**
   * 群内 /重启 指令的入口：完整重启插件运行时（见 restartPlugin）。
   * @param {{gid?: string, uid?: string, name?: string}} [info] 指令发起人与所在群
   */
  runtime.restartService = (info = {}) => restartPlugin(info);

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
      ai: runtime.ai,
      notifyTrustedAbuse: runtime.notifyTrustedAbuse,
      restartService: runtime.restartService,
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

  async function restartBot(force = false) {
    if (restarting) return false;
    restarting = true;
    try {
      const old = bot;
      bot = undefined;
      try { await old?.stop(); } catch { /* ignore */ }
      // force=true 用于群内 /重启 指令：即使关掉了“自动连接”也强制登录
      if (!force && !store.settings.autoConnect) return false;
      return await startBot();
    } finally {
      restarting = false;
    }
  }

  /**
   * 完整重启插件运行时（等价于“插件进程重启”，但不杀死 dsh 宿主进程）：
   *   1. 断开 QQ 连接（WebSocket、调度器、HTTP 客户端缓存）
   *   2. 断开控制面板（停止 HTTP 服务）
   *   3. 断开数据层（flush 落盘、清理定时器）与 AI 引擎
   *   4. 从磁盘重新创建 Store / AuthStore（相当于“启动数据库”）
   *   5. 重建并启动控制面板
   *   6. 重新连接 QQ（不受“自动连接”开关影响）
   *   7. 回到发起群 @ 发起人回复重启结果
   * 之所以不真的结束进程：插件运行在 dsh 宿主内，杀掉进程会连同 dsh 一起退出，
   * 既无法回报结果，也可能导致插件不再被拉起。这里做的是“运行时级完整重建”。
   * @param {{gid?: string, uid?: string, name?: string}} [info]
   */
  async function restartPlugin(info = {}) {
    if (restarting) return false;
    restarting = true;
    let botOk = false;
    let panelOk = false;
    let panelError = '';
    try {
      // 1) 断开 QQ 连接
      const oldBot = bot;
      bot = undefined;
      try {
        await oldBot?.stop();
      } catch (error) {
        logger.warn?.(`[qqbot-guard] 重启：断开 QQ 连接异常 ${errorText(error)}`);
      }

      // 2) 断开控制面板
      try {
        await panel.stop();
      } catch (error) {
        logger.warn?.(`[qqbot-guard] 重启：断开控制面板异常 ${errorText(error)}`);
      }

      // 3) 断开数据层与 AI（落盘并释放定时器/缓存）
      try {
        store.dispose();
      } catch (error) {
        logger.warn?.(`[qqbot-guard] 重启：关闭数据层异常 ${errorText(error)}`);
      }
      try {
        ai.dispose();
      } catch { /* ignore */ }

      // 4) 从磁盘重新加载数据层（启动数据库）
      store = new Store(dataDir);
      runtime.store = store;
      auth = new AuthStore(dataDir);
      runtime.auth = auth;
      ai = new AiGuard({ store, logger, dsh: llmSeamOf(ctx) });
      runtime.ai = ai;
      runtime.challenges = new Map();
      runtime.saveSettings = buildSaveSettings(runtime);

      // 5) 重建并启动控制面板
      panel = new WebPanel(runtime);
      runtime.panel = panel;
      runtime.getPanelInfo = () => panel.info();
      try {
        const r = await panel.start();
        panelOk = !!r?.ok;
        if (!panelOk) panelError = String(r?.error || '监听失败');
      } catch (error) {
        panelError = errorText(error);
        logger.warn?.(`[qqbot-guard] 重启：控制面板启动异常 ${panelError}`);
      }

      // 6) 重新连接 QQ（强制，不受自动连接开关影响）
      botOk = await startBot();
    } finally {
      restarting = false;
    }

    // 7) 回报结果
    const gid = String(info?.gid || '');
    if (!gid) return botOk;
    const uid = String(info?.uid || '');
    const head = `${uid ? mention(uid) : ''}`.trim();
    let text;
    if (botOk && panelOk) {
      text = `${head} 插件服务已完整重启成功（QQ、控制面板、数据均已重新加载）。`.trim();
    } else if (botOk && !panelOk) {
      text = `${head} 插件已重启，QQ 已重新连接，但控制面板未能启动（${panelError || '未知原因'}），请检查端口占用后在面板或 dsh 重启。`.trim();
    } else if (!botOk && panelOk) {
      text = `${head} 插件已重启，控制面板已恢复，但 QQ 连接未成功，正在自动重连。`.trim();
    } else {
      text = `${head} 插件已重启，但 QQ 连接与控制面板都未成功，正在自动重连，请检查 AppID/AppSecret 与端口占用。`.trim();
    }
    let notified = false;
    try {
      const client = runtime.getClient();
      if (client) {
        const r = await client.sendGroupText(gid, text);
        notified = !!r?.ok;
        if (!notified) {
          logger.warn?.(`[qqbot-guard] 重启结果通知发送失败：${r?.err?.human || r?.err?.code || '未知原因'}`);
        }
      } else {
        logger.warn?.('[qqbot-guard] 重启后没有可用连接，无法发送重启结果通知');
      }
    } catch (error) {
      logger.warn?.(`[qqbot-guard] 重启结果通知异常：${errorText(error)}`);
    }
    store.appendAudit({
      kind: 'command', action: 'restart-result',
      groupId: gid, groupName: store.state.groups[gid]?.name || '',
      userId: uid, userName: String(info?.name || ''),
      detail: `完整重启：QQ ${botOk ? '成功' : '失败'}，面板 ${panelOk ? '成功' : `失败（${panelError || '未知原因'}）`}，数据已重新加载；结果通知${notified ? '已发送' : '未发送'}`,
      ok: botOk && panelOk && notified, confidence: 1,
    });
    return botOk && panelOk;
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
