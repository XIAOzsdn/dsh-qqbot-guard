/**
 * dsh-qqbot-guard：QQ 群管理插件（Host 半边）。
 *
 * 只做群管理：违规防护、入群审批、入群欢迎、公告发布与管理。
 * 不创建 AI 会话、不调用模型、不处理表情包/图片/语音。
 */
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { Store } from './lib/store.js';
import { BotManager } from './lib/bot.js';
import { Config, mergeSettings } from './lib/config.js';
import { buildSaveSettings, mountRoutes } from './lib/http.js';
import { createApi } from './lib/api.js';
import { AuthStore } from './lib/auth.js';
import { WebPanel } from './lib/webpanel.js';
import { checkCompat } from './lib/compat.js';
import { mention } from './lib/mention.js';
import { AiGuard } from './lib/ai.js';
import { MemberDirectory } from './lib/napcat.js';
import { NapCatWebUi } from './lib/napcat-webui.js';
import { Scheduler, SCHEDULE_KIND_LABEL } from './lib/scheduler.js';
import { applyWholeBan } from './lib/whole-ban.js';
import { BRIDGE_PROVIDER, createLlmBridge } from './lib/llm-bridge.js';
import {
  PAY_METHODS, RECHARGE_PROGRESS_MILESTONES, RECHARGE_TIMEOUTS, buildAgentPrompt, estimateRechargeProgress,
  formatRechargeProgress, inferRechargeErrorCode, isAbandonReply, isContinueReply, maskOrderId, rechargeDir,
  rechargeErrorText, rechargeWorkspace, removeFile, scanAgentFiles, takeResultFile, updateRequest,
} from './lib/recharge.js';
import { LIMITS } from './lib/defaults.js';
import { PLUGIN_NAME, getPluginVersion } from './lib/meta.js';

export { Config };
export const name = PLUGIN_NAME;
/** Cordis 元数据版本：模块加载时读盘一次（此时磁盘即最新，无需宿主持久内存副本） */
export const version = getPluginVersion();
// 充值功能需要：agents（创建/驱动会话）+ agentPresets（系统提示/工具）+ agentDefaultModel（兜底模型）
// + llm（注册“插件 API”中转 provider）
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'llm'];

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
    try { runtime.disposeRecharge?.(); } catch { /* ignore */ }
    try { runtime.disposeLlmBridge?.(); } catch { /* ignore */ }
    try {
      for (const entry of runtime.rechargeWorkers?.values?.() || []) void entry?.handle?.dispose?.();
    } catch { /* ignore */ }
    try { runtime.getBot()?.dispose?.(); } catch { /* ignore */ }
    try { runtime.panel?.dispose?.(); } catch { /* ignore */ }
    try { runtime.ai?.dispose?.(); } catch { /* ignore */ }
    try { runtime.scheduler?.stop?.(); } catch { /* ignore */ }
  try { runtime.directory?.dispose?.(); } catch { /* ignore */ }
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

  // v2.1.0 起不再使用官方 QQBot 凭据（AppID/AppSecret）；连接只走普通 QQ 账号（NapCat）

  let bot;
  let restarting = false;
  let auth = new AuthStore(dataDir);

  /**
   * 首次部署必须先选语言（settings.language === ''）。
   * 既有部署（已初始化密码或已有群数据）自动迁移成简体中文，避免升级后被锁死。
   */
  function migrateLanguage() {
    if (store.settings.language) return;
    let initialized = false;
    try { initialized = !!auth.status()?.initialized; } catch { /* ignore */ }
    const hasData = Object.keys(store.state?.groups || {}).length > 0
      || Object.keys(store.state?.members || {}).length > 0;
    if (initialized || hasData) {
      store.saveSettings(mergeSettings(store.settings, { language: 'zh-CN' }));
      logger.info?.('[qqbot-guard] 既有部署：界面语言默认为简体中文');
    }
  }
  migrateLanguage();

  let directory = new MemberDirectory({ store, logger });
  let ai = new AiGuard({ store, logger, dsh: llmSeamOf(ctx), getDirectory: () => directory });
  const runtime = {
    dataDir,
    store,
    logger,
    auth,
    ai,
    directory,
    /** 对外版本号：每次实时读盘（package.json），磁盘一换、接口即换，无需重启宿主 */
    get version() { return getPluginVersion(); },
    disposed: false,
    challenges: new Map(),
    getBot: () => bot,
    getClient: () => bot?.client,
    getCompat: () => checkCompat({ dataDir, webAvailable: hasWebServer(ctx) }),
    saveSettings: null,
    /** 首次部署尚未选择语言时为 true：面板只开放“选语言”，QQ 服务也不启动 */
    needsLanguage: () => !store.settings.language,
    restartBot,
    startBot,
    restartPlugin,
  };
  /**
   * 协议端 WebUI 客户端（登录状态 / 扫码登录 / 快速登录）。
   * 设置一变就重建，保证面板改完地址或令牌立即生效。
   */
  let webuiClient = null;
  let webuiKey = '';
  runtime.getNapcatWebui = () => {
    const n = store.settings.napcat || {};
    const key = [n.webuiUrl || '', n.webuiToken || '', n.startCommand || ''].join('|');
    if (!webuiClient || webuiKey !== key) {
      webuiClient = new NapCatWebUi({
        baseUrl: n.webuiUrl,
        token: n.webuiToken,
        startCommand: n.startCommand,
        logger,
      });
      webuiKey = key;
    }
    return webuiClient;
  };
  /**
   * 执行一条到点的定时任务：全员禁言走官方 API 批量禁言（不依赖 NapCat / QQ 登录），
   * 成员禁言优先 NapCat（按 QQ 号），否则退回官方 API（按 openid）。失败只记审计，不影响其它任务。
   */
  const runSchedule = async (item) => {
    const gid = item.gid;
    const client = runtime.getClient();
    const dir = runtime.directory;
    const audit = (ok, detail) => {
      store.appendAudit?.({
        at: new Date().toISOString(),
        kind: 'command',
        action: `schedule-${item.kind}`,
        gid,
        ok,
        detail,
      });
    };
    try {
      if (item.kind === 'whole-ban' || item.kind === 'whole-unban') {
        const enable = item.kind === 'whole-ban';
        const r = await applyWholeBan({ store, client, gid, enable, seconds: item.seconds || 600 });
        if (r.ok) {
          audit(true, `${SCHEDULE_KIND_LABEL[item.kind]}（官方 API 批量：成功 ${r.done} / 失败 ${r.failed}）`);
          return r;
        }
        audit(false, `${SCHEDULE_KIND_LABEL[item.kind]}失败：${r.error || '未知原因'}`);
        return r;
      }
      if (item.kind === 'mute' || item.kind === 'unmute') {
        const enable = item.kind === 'mute';
        const seconds = Math.max(1, Number(item.seconds) || 600);
        if (item.qq) {
          const r = await dir?.act?.({ gid, qq: item.qq, action: enable ? 'mute' : 'unmute', seconds });
          audit(!!r?.ok, `${SCHEDULE_KIND_LABEL[item.kind]} QQ ${item.qq}`);
          return r || { ok: false, error: 'NapCat 不可用' };
        }
        if (item.uid && client?.setMemberMute) {
          const r = await client.setMemberMute(gid, [item.uid], enable ? seconds : null);
          audit(!!r?.ok, `${SCHEDULE_KIND_LABEL[item.kind]} openid ${item.uid}`);
          return r || { ok: false, error: '官方接口不可用' };
        }
        return { ok: false, error: '没有可用的目标' };
      }
      return { ok: false, error: '未知的定时动作' };
    } catch (error) {
      audit(false, errorText(error));
      return { ok: false, error: errorText(error) };
    }
  };
  const scheduler = new Scheduler({ store, logger, executor: runSchedule });
  runtime.scheduler = scheduler;
  runtime.runSchedule = runSchedule;
  scheduler.start();
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
   * 充值协作桥：插件管理**自己的专用工作区**，并为**每个充值任务新建独立会话**，
   * 任务结束立即销毁会话——不复用会话，避免 AI 带着上一个任务的上下文执行新任务。
   * - 工作区：<数据目录>/recharge-workspace（插件加载时创建）
   * - 并发上限：同时最多 3 个任务会话，超出返回 E_BUSY
   */
  /** 桥接诊断日志（写在 <数据目录>/recharge/bridge.log，便于排查） */
  const bridgeLog = (line) => {
    try {
      appendFileSync(join(rechargeDir(dataDir), 'bridge.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch { /* ignore */ }
  };
  const promptMessage = (text) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  const agentRegistry = () => {
    try {
      return ctx?.agents || (typeof ctx?.get === 'function' ? ctx.get('agents') : undefined);
    } catch (error) {
      bridgeLog(`agents lookup error: ${String(error)}`);
      return undefined;
    }
  };
  /** 充值专用工作区（插件安装/加载时即创建并注册到 DSH 工作区表，便于在 UI 里看到会话） */
  const rechargeWs = rechargeWorkspace(dataDir);
  try {
    ctx?.inject?.(['workspaceRegistry'], (scope) => {
      const registry = scope?.workspaceRegistry;
      if (!registry || typeof registry.create !== 'function') return;
      void registry.create(rechargeWs, '充值工作区').then((ws) => {
        bridgeLog(`workspace ready: ${ws?.id || ''}`);
      }).catch((error) => {
        bridgeLog(`workspace register failed: ${String(error)}`);
      });
    });
  } catch (error) {
    bridgeLog(`workspace inject failed: ${String(error)}`);
  }
  // 启动自检：确认注入的 agents / agentPresets 服务可用
  try {
    const reg = agentRegistry();
    bridgeLog(`agents service: ${reg ? 'ok' : 'unavailable'}`);
    let presets;
    try { presets = ctx?.agentPresets || (typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined); } catch { presets = undefined; }
    bridgeLog(`agentPresets service: ${presets ? 'ok' : 'unavailable'}`);
    try {
      const dflt = ctx?.agentDefaultModel || (typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined);
      const sel = dflt?.currentSelection?.();
      bridgeLog(`agentDefaultModel: ${sel ? `${sel.provider}/${sel.model}` : 'unavailable'}`);
    } catch { bridgeLog('agentDefaultModel: unavailable'); }
  } catch (error) {
    bridgeLog(`service self-check failed: ${String(error)}`);
  }
  /** 活跃任务会话：sessionId → { handle, requestId, createdAt } */
  const activeWorkers = new Map();
  const MAX_WORKERS = 3;

  /** 注册“插件 API”中转 provider：DSH 的模型请求经插件转发到插件配置的 API */
  const RECHARGE_LLM_TIMEOUT_MS = 300_000;
  let bridgeHandle = null;
  try {
    const llm = ctx?.llm || (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined);
    if (llm && typeof llm.registerAdapter === 'function') {
      const adapter = createLlmBridge({
        getConfig: () => ({
          baseUrl: store.settings?.ai?.baseUrl,
          apiKey: store.settings?.ai?.apiKey,
          model: store.settings?.ai?.model,
          // 注意：设置里的 ai.timeoutMs（如 8s）只用于轻量意图解析，
          // 专用会话的模型请求要跑完整轮工具调用，必须用独立的长超时。
          timeoutMs: RECHARGE_LLM_TIMEOUT_MS,
        }),
        logger: { warn: (msg) => bridgeLog(String(msg)), info: (msg) => bridgeLog(String(msg)) },
      });
      bridgeHandle = llm.registerAdapter([BRIDGE_PROVIDER], adapter);
      bridgeLog(`llm bridge registered: ${BRIDGE_PROVIDER} (${String(store.settings?.ai?.baseUrl || '')})`);
    } else {
      bridgeLog('llm service unavailable: bridge not registered');
    }
  } catch (error) {
    bridgeLog(`llm bridge register failed: ${String(error)}`);
  }
  runtime.disposeLlmBridge = () => { try { bridgeHandle?.(); } catch { /* ignore */ } };
  bridgeLog(`plugin loaded v${getPluginVersion()} · qr delivery: local-image -> base64 -> group-file (serial per request)`);

  /** 选择专用会话使用的模型：优先插件配置的 API 路由，其次 DSH 默认模型 */
  const resolveWorkerModel = () => {
    const pluginModel = String(store.settings?.ai?.model || '').trim();
    const route = BRIDGE_PROVIDER;
    let routeReady = false;
    try {
      const llm = ctx?.llm || (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined);
      const list = llm?.listProviders?.() || [];
      routeReady = list.some((p) => String(p?.id || '') === route);
    } catch (error) {
      bridgeLog(`llm.listProviders failed: ${String(error)}`);
    }
    if (routeReady && pluginModel) {
      bridgeLog(`worker model: ${route}/${pluginModel} (plugin api)`);
      return { provider: route, model: pluginModel };
    }
    try {
      const svc = ctx?.agentDefaultModel || (typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined);
      const def = svc?.currentSelection?.();
      if (def) {
        bridgeLog(`worker model: ${def.provider}/${def.model} (dsh default)`);
        return { provider: def.provider, model: def.model, ...(def.reasoningEffort ? { reasoningEffort: def.reasoningEffort } : {}) };
      }
    } catch { /* ignore */ }
    return undefined;
  };

  /** 为单个充值任务新建独立会话（不复用；必须带 preset 与模型，否则 pre-step 会被拒绝） */
  const spawnWorker = async (requestId) => {
    const reg = agentRegistry();
    if (!reg || typeof reg.create !== 'function') throw new Error('agents service unavailable');
    if (activeWorkers.size >= MAX_WORKERS) {
      const error = new Error('busy');
      error.code = 'E_BUSY';
      throw error;
    }
    const presets = (() => {
      try { return ctx?.agentPresets || (typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined); } catch { return undefined; }
    })();
    const agentOptions = resolveWorkerModel();
    if (!agentOptions) throw new Error('no usable model (plugin api bridge and agentDefaultModel both unavailable)');
    const sessionId = randomUUID();
    const handle = await reg.create({
      sessionId,
      meta: { cwd: rechargeWs },
      agentOptions,
      setup: async (agentCtx) => {
        if (!presets || typeof presets.mount !== 'function') {
          throw new Error('agentPresets service unavailable');
        }
        const mounted = await presets.mount(agentCtx);
        bridgeLog(`worker ${sessionId} preset mounted: ${mounted?.id || 'default'}`);
      },
    });
    activeWorkers.set(sessionId, { handle, requestId, createdAt: Date.now() });
    bridgeLog(`worker created ${sessionId} for ${requestId} at ${rechargeWs}`);
    return handle.agent;
  };

  /** 任务结束销毁会话（等它把结果写完再关，最多等 15 秒） */
  const disposeWorkerFor = (requestId) => {
    for (const [sessionId, entry] of activeWorkers) {
      if (entry.requestId !== requestId) continue;
      activeWorkers.delete(sessionId);
      void (async () => {
        try { await Promise.race([entry.handle.agent.whenIdle?.() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 15_000))]); } catch { /* ignore */ }
        try { await entry.handle.dispose(); bridgeLog(`worker disposed ${sessionId} (${requestId})`); } catch (error) { bridgeLog(`worker dispose failed ${sessionId}: ${String(error)}`); }
      })();
      return;
    }
  };

  /** 把充值请求投递给**新会话**；返回是否投递成功 */
  const requestRecharge = async (item) => {
    let delivered = false;
    let reason = '';
    let busy = false;
    try {
      const agent = await spawnWorker(item.id);
      const message = promptMessage(buildAgentPrompt(item, dataDir));
      try {
        agent.followup(message);
        delivered = true;
        bridgeLog(`request ${item.id} -> ${agent.id}`);
      } catch (error) {
        try { agent.steer?.(message); delivered = true; bridgeLog(`request ${item.id} -> steer ${agent.id}`); } catch (error2) {
          reason = String(error2);
        }
      }
    } catch (error) {
      reason = String(error);
      busy = error?.code === 'E_BUSY';
    }
    if (!delivered) {
      bridgeLog(`request ${item.id} failed: ${reason}`);
      if (item?.id) disposeWorkerFor(item.id);
    }
    try {
      store.appendAudit?.({
        kind: 'command', action: 'recharge-dispatch', groupId: item.gid,
        groupName: store.state.groups?.[item.gid]?.name || '',
        detail: `${item.amount} 元 ${PAY_METHODS[item.method] || item.method}（${item.id}）；独立会话投递=${delivered ? '成功' : `失败${busy ? '（并发已满）' : ''}`}`,
        ok: delivered, confidence: 1,
      });
    } catch { /* ignore */ }
    if (delivered) return true;
    return busy ? 'E_BUSY' : 'E_AGENT_UNAVAILABLE';
  };
  runtime.requestRecharge = requestRecharge;
  runtime.rechargeWorkers = activeWorkers;
  runtime.rechargeWorkspace = rechargeWs;

  /**
   * 同一请求的二维码发送不允许并发：旧实现每个 tick 都 `void sendRechargeQr(file)`，
   * 一次尝试要 4~30 秒，于是几十个尝试叠在一起 —— 群被失败回执刷屏，
   * 协议端的 sendMsg 通道也被压垮（NapCat 日志里满屏 onMsgInfoListUpdate Timeout）。
   */
  const qrInFlight = new Set();
  const QR_MAX_ATTEMPTS = 3;

  /** 链路类错误（没连上/超时）重试不计次，等重连后再发 */
  const isLinkError = (result) => {
    if (!result || result.ok !== false) return false;
    const text = String(result.err?.human || '');
    return /未连接|连接已关闭|WebSocket is not open|ECONNREFUSED|socket hang up|调用超时：send_group_msg/iu.test(text);
  };

  /**
   * 二维码投递：图片（file:/// 本地 URI）→ base64 图片 → 群文件兜底。
   * 只对「仍在等二维码」的请求发送；同一请求同时只有一次尝试；
   * 失败累计 3 次才判 E_QR_SEND_FAILED，且只在状态真正翻转时回执一次。
   */
  const sendRechargeQr = async (file) => {
    const id = basename(file).replace(/^qr-/u, '').replace(/\.png$/u, '');
    const item = (store.state.recharge || []).find((x) => x.id === id);
    const client = runtime.getClient();
    if (!item || !client) return;
    // 只有仍在等待二维码的请求才发；已出码 / 已失败 / 已支付的旧文件直接清掉，避免反复重试
    if (item.status !== 'dispatched') {
      removeFile(file);
      return;
    }
    if (client.connected === false) return; // 离线不发也不计次
    if (qrInFlight.has(id) || qrInFlight.size >= 2) return;
    qrInFlight.add(id);
    try {
      const failOnce = (result) => {
        if (item.status !== 'dispatched') return; // 已经被处理过，别重复回执
        if (isLinkError(result)) { bridgeLog(`qr link error ${id}, retry later: ${result?.err?.human || ''}`); return; }
        const attempts = (Number(item.qrAttempts) || 0) + 1;
        updateRequest(store, id, { qrAttempts: attempts });
        bridgeLog(`qr attempt ${attempts}/${QR_MAX_ATTEMPTS} failed ${id}: ${result?.err?.human || result || ''}`);
        if (attempts < QR_MAX_ATTEMPTS) return;
        removeFile(file);
        updateRequest(store, id, { status: 'failed', error: 'E_QR_SEND_FAILED' });
        void sendToGroup(
          item.gid,
          `${mention(item.uid)} ${rechargeErrorText('QR_SEND_FAILED', result?.err?.human || '')}（请求编号 ${item.id}）`,
          item.msgId,
        );
      };

      let sent = typeof client.sendGroupImageFile === 'function'
        ? await client.sendGroupImageFile(item.gid, file)
        : null;
      if (!sent?.ok) {
        if (sent) bridgeLog(`qr image(file) failed ${id}: ${sent?.err?.human || ''}`);
        let bytes = null;
        try { bytes = readFileSync(file); } catch { bytes = null; }
        const up = bytes ? await client.uploadGroupImage(item.gid, bytes, 'pay-qr.png') : null;
        const info = up?.data?.file_info;
        if (up?.ok && info) sent = await client.sendGroupMedia(item.gid, info);
      }
      // 图片通道不可用时，兜底把二维码作为群文件上传
      let viaFile = false;
      let lastError = sent;
      if (!sent?.ok && typeof client.sendGroupFile === 'function') {
        bridgeLog(`qr image unavailable, fallback to group file: ${sent?.err?.human || ''}`);
        const up2 = await client.sendGroupFile(item.gid, file, 'pay-qr.png');
        if (up2?.ok) {
          sent = { ok: true };
          viaFile = true;
        } else {
          lastError = up2;
          bridgeLog(`qr file fallback failed: ${up2?.err?.human || ''}`);
        }
      }
      if (!sent?.ok) {
        failOnce(lastError);
        return;
      }
      if (item.status !== 'dispatched') return; // 并发路径已处理
      updateRequest(store, id, {
        status: 'qr-sent',
        qrSentAt: new Date().toISOString(),
        payDeadline: new Date(Date.now() + RECHARGE_TIMEOUTS.payWaitMs).toISOString(),
      });
      removeFile(file);
      const how = viaFile ? '支付二维码已作为群文件发送（pay-qr.png），请点开文件扫码支付' : '支付二维码已发送，请扫码支付';
      void sendToGroup(
        item.gid,
        `${mention(item.uid)} ${how}，请在 3 分钟内完成；支付完成后会自动回执订单号。`,
        item.msgId,
      );
      bridgeLog(`qr sent ${id}${viaFile ? ' (via group file)' : ''}`);
    } catch (error) {
      // 保留文件，下个 tick 重试（读取失败等异常不计次）
      bridgeLog(`qr send error ${id}: ${String(error?.message || error)}`);
    } finally {
      qrInFlight.delete(id);
    }
  };

  /** 充值结果：回执到群里（成功带脱敏订单号；失败按错误码给专业提示 + 建议） */
  const sendRechargeResult = (file) => {
    const id = basename(file).replace(/^res-/u, '').replace(/\.json$/u, '');
    const data = takeResultFile(file);
    if (!data) return;
    const item = (store.state.recharge || []).find((x) => x.id === id);
    if (!item) return;
    const ok = data.ok === true;
    const orderId = String(data.orderId || '').trim();
    const masked = maskOrderId(orderId);
    const balance = data.balanceAfter ? `，当前余额 ${data.balanceAfter}` : '';
    const method = PAY_METHODS[item.method] || item.method;
    const code = ok ? '' : (String(data.code || '').toUpperCase() || inferRechargeErrorCode(data.error));
    const text = ok
      ? `充值成功：${item.amount} 元（${method}），订单号 ${masked || '已脱敏'}${balance}。`
      : `${rechargeErrorText(code, data.error)}（请求编号 ${item.id}）`;
    updateRequest(store, id, ok ? { status: 'paid', orderId } : { status: 'failed', error: code });
    bridgeLog(`result ${id}: ok=${ok} code=${code || '-'}`);
    void sendToGroup(item.gid, `${mention(item.uid)} ${text}`, item.msgId);
    // 任务结束：销毁该任务的独立会话（不复用）
    disposeWorkerFor(id);
  };

  /** 统计某任务会话已发生的工具调用次数（只读会话事件，不干预 agent） */
  const workerToolCalls = (requestId) => {
    for (const entry of activeWorkers.values()) {
      if (entry.requestId !== requestId) continue;
      try {
        const events = entry.handle?.agent?.session?.events || [];
        let calls = 0;
        for (const e of events) if (String(e?.type || '').startsWith('tool/')) calls += 1;
        return calls;
      } catch { return 0; }
    }
    return 0;
  };

  /** 进度推送：20s / 60s / 120s 三个里程碑，最多 3 条，不刷屏 */
  const rechargeProgress = () => {
    const list = Array.isArray(store.state.recharge) ? store.state.recharge : [];
    const client = runtime.getClient();
    if (!client) return;
    const now = Date.now();
    for (const item of list) {
      if (item.status !== 'dispatched') continue;
      const started = Date.parse(item.createdAt || '');
      if (!Number.isFinite(started)) continue;
      const elapsed = now - started;
      const sent = Number(item.progressSent) || 0;
      const next = RECHARGE_PROGRESS_MILESTONES[sent];
      if (next === undefined || elapsed < next * 1000) continue;
      const progress = estimateRechargeProgress(elapsed, workerToolCalls(item.id));
      updateRequest(store, item.id, { progressSent: sent + 1 });
      void sendToGroup(
        item.gid,
        `${mention(item.uid)} ${formatRechargeProgress(item, progress)}`,
        item.msgId,
      );
      bridgeLog(`progress ${item.id}: ${progress.stage} (${progress.elapsedSec}s, ${progress.percent}%)`);
    }
  };

  /**
   * 看门狗（三段计时，合计最多 10 分钟）：
   * 1) 未出二维码：投递后 5 分钟强制中断（E_QR_TIMEOUT）
   * 2) 二维码已发出：3 分钟等待支付，到点先询问用户是否继续（不中断会话）
   * 3) 询问后 2 分钟内未回复 → 按放弃处理并结束会话；回复继续 → 再延长 2 分钟
   */
  const rechargeWatchdog = () => {
    const list = Array.isArray(store.state.recharge) ? store.state.recharge : [];
    const now = Date.now();
    const client = runtime.getClient();
    if (!client) return;
    for (const item of list) {
      if (item.status === 'dispatched') {
        const started = Date.parse(item.createdAt || '');
        if (Number.isFinite(started) && now - started >= RECHARGE_TIMEOUTS.qrWaitMs) {
          updateRequest(store, item.id, { status: 'failed', error: 'E_QR_TIMEOUT' });
          bridgeLog(`timeout ${item.id}: no QR in ${Math.round((now - started) / 1000)}s, worker interrupted`);
          void sendToGroup(
            item.gid,
            `${mention(item.uid)} ${rechargeErrorText('QR_TIMEOUT')}（请求编号 ${item.id}）`,
            item.msgId,
          );
          disposeWorkerFor(item.id);
        }
        continue;
      }
      if (item.status === 'qr-sent') {
        const deadline = Date.parse(item.payDeadline || '');
        if (Number.isFinite(deadline) && now >= deadline) {
          updateRequest(store, item.id, { status: 'awaiting_user', askedAt: new Date(now).toISOString() });
          bridgeLog(`payment timeout ${item.id}: ask user whether to continue`);
          void sendToGroup(
            item.gid,
            `${mention(item.uid)} 支付二维码已发出 3 分钟，暂未检测到到账。是否继续等待？\n`
            + '请 @机器人 回复「继续」（再等 2 分钟）或「放弃」（立即结束本次充值）。',
            item.msgId,
          );
        }
        continue;
      }
      if (item.status === 'awaiting_user') {
        const askedAt = Date.parse(item.askedAt || '');
        if (Number.isFinite(askedAt) && now - askedAt >= RECHARGE_TIMEOUTS.askReplyMs) {
          updateRequest(store, item.id, { status: 'failed', error: 'E_PAYMENT_TIMEOUT' });
          void sendToGroup(
            item.gid,
            `${mention(item.uid)} 未收到回复，已结束本次充值等待。（请求编号 ${item.id}）`,
            item.msgId,
          );
          disposeWorkerFor(item.id);
        }
      }
    }
  };

  /** 用户对“是否继续等待”的回复（继续 / 放弃）；返回是否已处理 */
  const rechargeReply = (gid, uid, text) => {
    const list = Array.isArray(store.state.recharge) ? store.state.recharge : [];
    const item = list.find((x) => x.status === 'awaiting_user' && x.gid === gid && x.uid === uid);
    if (!item) return { handled: false };
    const client = runtime.getClient();
    if (!client) return { handled: false };
    const say = (msg) => void sendToGroup(item.gid, `${mention(item.uid)} ${msg}`, item.msgId);
    if (isContinueReply(text)) {
      const deadline = new Date(Date.now() + RECHARGE_TIMEOUTS.extendMs).toISOString();
      updateRequest(store, item.id, { status: 'qr-sent', payDeadline: deadline, askedAt: '' });
      say('已延长 2 分钟，请尽快完成支付；支付成功后会自动回执订单号。');
      bridgeLog(`user continues ${item.id}, extended 2min`);
      return { handled: true };
    }
    if (isAbandonReply(text)) {
      updateRequest(store, item.id, { status: 'failed', error: 'E_ABANDONED' });
      say('已按你的选择结束本次充值等待。若已完成支付，请稍后到平台账单查看订单。');
      disposeWorkerFor(item.id);
      bridgeLog(`user abandoned ${item.id}`);
      return { handled: true };
    }
    return { handled: false };
  };
  runtime.rechargeReply = rechargeReply;

  /** 发群消息：优先被动回复（msgId），失败自动转主动消息，确保 QQ 一定收到 */
  const sendToGroup = async (gid, text, msgId = '') => {
    const client = runtime.getClient();
    if (!client) return { ok: false, error: 'bot not ready' };
    let r = null;
    try {
      r = await client.sendGroupText(gid, text, { msgId: msgId || '' });
    } catch (error) {
      r = { ok: false, err: { human: String(error) } };
    }
    if (!r?.ok && msgId) {
      bridgeLog(`passive reply failed (${gid}), retry proactive: ${r?.err?.human || r?.error || ''}`);
      try {
        r = await client.sendGroupText(gid, text);
      } catch (error) {
        r = { ok: false, err: { human: String(error) } };
      }
    }
    if (!r?.ok) bridgeLog(`send failed (${gid}): ${r?.err?.human || r?.error || 'unknown'}`);
    return r;
  };

  /**
   * 一次性补发：旧版超时逻辑把“已出二维码/已支付”的任务提前中断，
   * 用户没收到回执。这里对最近一笔超时请求补发一条说明（只发一次）。
   */
  const makeupTimedOutOnce = async () => {
    if (store.state.rechargeMakeup) return;
    const client = runtime.getClient();
    if (!client) return;
    const list = Array.isArray(store.state.recharge) ? store.state.recharge : [];
    const now = Date.now();
    const candidate = [...list].reverse().find((x) => {
      if (!x || x.makeupSent) return false;
      if (!['E_QR_TIMEOUT', 'E_PAYMENT_TIMEOUT'].includes(String(x.error || ''))) return false;
      const at = Date.parse(x.createdAt || '');
      return Number.isFinite(at) && now - at < 6 * 3600_000;
    });
    if (!candidate) return;
    const method = PAY_METHODS[candidate.method] || candidate.method;
    const text = `补发：感谢支持！您刚才的充值（${candidate.amount} 元，${method}）已完成。`
      + '非常抱歉，本次因超时逻辑提前中断了任务，导致没有及时回执；该问题已修复，后续充值会正常返回脱敏订单号。';
    const r = await sendToGroup(candidate.gid, `${mention(candidate.uid)} ${text}`, candidate.msgId || '');
    if (!r?.ok) { bridgeLog(`makeup send failed for ${candidate.id}, will retry`); return; }
    updateRequest(store, candidate.id, { makeupSent: true });
    store.state.rechargeMakeup = { id: candidate.id, at: new Date().toISOString() };
    store.saveState();
    store.appendAudit?.({
      kind: 'command', action: 'recharge-makeup', groupId: candidate.gid,
      groupName: store.state.groups?.[candidate.gid]?.name || '',
      detail: `补发充值回执：${candidate.amount} 元 ${method}（${candidate.id}）`, ok: true, confidence: 1,
    });
    bridgeLog(`makeup sent for ${candidate.id}`);
  };

  const rechargeTimer = setInterval(() => {
    if (runtime.disposed) return;
    try {
      const { qrs, results } = scanAgentFiles(dataDir);
      for (const file of qrs) void sendRechargeQr(file);
      for (const r of results) sendRechargeResult(r.path);
      rechargeProgress();
      rechargeWatchdog();
      void makeupTimedOutOnce();
    } catch { /* 目录读取失败忽略 */ }
  }, 1500);
  if (rechargeTimer.unref) rechargeTimer.unref();
  runtime.disposeRecharge = () => { try { clearInterval(rechargeTimer); } catch { /* ignore */ } };

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
    if (!store.settings.language) {
      logger.info?.('[qqbot-guard] 尚未选择界面语言，插件服务暂不启动（打开面板选择语言后自动恢复）');
      return false;
    }
    if (bot && (bot.state === 'online' || bot.state === 'connecting')) return true;
    if (!store.settings.napcat?.enabled || !store.settings.napcat?.wsUrl) {
      logger.info?.('[qqbot-guard] 请先启用 NapCat 并填写 WS 地址（ws://127.0.0.1:3001）');
      return false;
    }
    const next = new BotManager({
      store,
      logger,
      watchJoinRequests: store.settings.watchJoinRequests,
      ai: runtime.ai,
      getDirectory: () => runtime.directory,
      saveSettings: (patch, meta) => runtime.saveSettings(patch, meta),
      scheduler: () => runtime.scheduler,
      notifyTrustedAbuse: runtime.notifyTrustedAbuse,
      restartService: runtime.restartService,
      requestRecharge: (item) => runtime.requestRecharge?.(item) ?? false,
      rechargeReply: (gid, uid, text) => runtime.rechargeReply?.(gid, uid, text) ?? { handled: false },
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
      try {
        directory.dispose();
        try { runtime.scheduler?.stop?.(); } catch { /* ignore */ }
      } catch { /* ignore */ }

      // 4) 从磁盘重新加载数据层（启动数据库）
      store = new Store(dataDir);
      runtime.store = store;
      auth = new AuthStore(dataDir);
      runtime.auth = auth;
      migrateLanguage();
      ai = new AiGuard({ store, logger, dsh: llmSeamOf(ctx), getDirectory: () => directory });
      runtime.ai = ai;
      directory = new MemberDirectory({ store, logger });
      runtime.directory = directory;
      try { runtime.scheduler?.stop?.(); } catch { /* ignore */ }
      {
        const sched = new Scheduler({ store, logger, executor: runSchedule });
        runtime.scheduler = sched;
        sched.start();
      }
      void directory.autoConfigure().catch(() => { /* 自动探测失败不影响重启 */ });
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
  // 新用户零配置：默认已启用 NapCat 成员目录，若默认地址连不上就自动探测本机协议端
  void directory.autoConfigure().catch((error) => {
    logger.warn?.(`[qqbot-guard] NapCat 自动探测异常：${errorText(error)}`);
  });
  void panel.start().catch((error) => {
    logger.warn?.(`[qqbot-guard] 独立面板启动异常：${errorText(error)}`);
  });
  return runtime;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
