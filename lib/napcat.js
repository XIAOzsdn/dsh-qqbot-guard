/**
 * NapCat / LLOneBot 成员目录桥。
 * ============================================================================
 * QQ 官方 Bot API 不提供“群成员列表”，也不返回 QQ 号：机器人只能看到在群里
 * 说过话或提交过入群申请的人，且身份是 32 位 openid。
 *
 * 如果本机（或局域网内）跑着 NapCat / LLOneBot，就能通过 OneBot v11 的
 * get_group_member_list 拉取完整花名册（含真实 QQ 号）。传 no_cache: true
 * 可以绕过协议端的本地缓存，强制从服务器取最新数据。
 *
 * 本模块只做“补全可见性”：
 *   - 只连一个正向 WebSocket，按需建立、用完即关，不驻留连接；
 *   - 只读花名册；管理操作由协议端按 QQ 号执行；
 *   - 协议端不可用时静默降级，面板照常显示本地台账。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from './defaults.js';

/** 官方群 openid -> QQ 群号 的手动映射里，QQ 群号只接受 5-12 位数字 */
export function isQQ(value) {
  return /^\d{5,12}$/u.test(String(value ?? '').trim());
}

/** 协议端 WebSocket 的常见地址（按出现频率排序，探测时逐个试） */
export const NAPCAT_WS_CANDIDATES = Object.freeze([
  'ws://127.0.0.1:3001', // NapCat 默认
  'ws://127.0.0.1:3000', // LLOneBot / NapCat 旧版常见
  'ws://127.0.0.1:6700', // OneBot 实现默认
  'ws://127.0.0.1:8080',
  'ws://localhost:3001',
  'ws://localhost:3000',
]);

/** 协议端配置目录的常见位置（只读，读不到就跳过） */
export function napcatConfigDirs(env = process.env, platform = process.platform) {
  const dirs = [];
  if (platform === 'win32') {
    const home = env.USERPROFILE || env.HOME || homedir();
    dirs.push(
      join(home, 'napcat', 'napcat', 'config'),
      'C:\\napcat\\napcat\\config',
      join(home, 'NapCat', 'config'),
      join(home, 'LLOneBot', 'data', 'config'),
      join(env.APPDATA || '', 'NapCatQQ', 'config'),
    );
  } else {
    const home = env.HOME || homedir();
    dirs.push(
      join(home, 'napcat', 'napcat', 'config'),
      join(home, 'napcat', 'config'),
      join(home, 'NapCat', 'config'),
      '/opt/napcat/config',
      '/root/napcat/config',
    );
  }
  return dirs.filter((d) => d && d.length > 6);
}

/**
 * 从 onebot11_<QQ>.json 里提取正向 WebSocket 的端口与 token。
 * NapCat 不同版本的字段层级不一样，这里把几种常见布局都认一遍。
 * @returns {{port:number, token:string}[]}
 */
export function parseNapcatConfig(raw) {
  const out = [];
  const servers = [];
  const add = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === 'object') servers.push(value);
  };
  add(raw?.websocketServers);
  add(raw?.network?.websocketServers);
  add(raw?.ws);
  add(raw?.network?.ws);
  for (const one of servers) {
    const port = intOf(one?.port);
    if (!port || port > 65535) continue;
    out.push({ port, token: text(one?.token, 500) });
  }
  return out;
}

/** 扫描本机协议端配置目录，返回发现到的 ws 地址与 token（失败一律当作没找到） */
export function scanNapcatConfigs({ dirs = napcatConfigDirs() } = {}) {
  const found = [];
  for (const dir of dirs) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => /^onebot11.*\.json$/iu.test(f));
    } catch {
      continue;
    }
    for (const file of files.slice(0, 5)) {
      let raw = null;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      for (const item of parseNapcatConfig(raw)) {
        found.push({ ...item, url: `ws://127.0.0.1:${item.port}`, source: join(dir, file) });
      }
    }
  }
  // 端口去重，保留第一个（配置里带 token 的优先于猜出来的空 token）
  const seen = new Set();
  return found.filter((x) => {
    if (seen.has(x.port)) return false;
    seen.add(x.port);
    return true;
  });
}

/** 名称归一化：全角转半角、压缩空白、小写（用于官方群名与 NapCat 群名匹配） */
export function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function text(value, max = 100) {
  return String(value ?? '').trim().slice(0, max);
}

function intOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function withToken(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('access_token', token);
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  }
}

/**
 * 极简 OneBot v11 正向 WebSocket 会话。
 * Node 22+ 自带全局 WebSocket，不需要任何 npm 依赖。
 */
export class OneBotSession {
  constructor({ url, token = '', timeoutMs = 4000, log } = {}) {
    this.url = String(url || '');
    this.token = String(token || '');
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 4000);
    this.log = log || console;
    this.ws = null;
    this.closed = false;
    this.echo = 0;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        reject(new Error('当前 Node 不支持全局 WebSocket，请升级到 Node 22+'));
        return;
      }
      let settled = false;
      const finish = (fn, value) => {
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
      const timer = setTimeout(() => {
        finish(reject, new Error(`连接 NapCat 超时（${this.url}），请确认协议端已启动并开启 WebSocket 服务`));
        try { ws.close(); } catch { /* ignore */ }
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      ws.addEventListener('open', () => finish(resolve));
      ws.addEventListener('error', () => {
        finish(reject, new Error(`无法连接 NapCat（${this.url}），请确认协议端已启动并开启 WebSocket 服务`));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error('NapCat 连接已关闭'));
        }
        this.pending.clear();
      });
      ws.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          return;
        }
        if (!data || !data.echo) return;
        const item = this.pending.get(data.echo);
        if (!item) return;
        this.pending.delete(data.echo);
        clearTimeout(item.timer);
        if (data.status === 'failed' || (data.retcode !== undefined && Number(data.retcode) !== 0)) {
          item.reject(new Error(text(data.wording || data.message || `OneBot 返回 retcode ${data.retcode}`, 300)));
        } else {
          item.resolve(data.data);
        }
      });
    });
  }

  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.closed || this.ws.readyState !== 1) {
        reject(new Error('NapCat 连接未就绪'));
        return;
      }
      const echo = 'qqg-' + (++this.echo);
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`NapCat 调用超时：${action}`));
      }, this.timeoutMs);
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

  async getGroupList() {
    // 返回 NapCat 原始数组，由调用方用 normalizeNapcatGroups 归一化
    return this.call('get_group_list', {});
  }

  async getGroupMemberList(groupId, noCache = true) {
    const params = { group_id: Number(groupId) };
    if (noCache) params.no_cache = true;
    return this.call('get_group_member_list', params);
  }

  close() {
    this.closed = true;
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

/** 把 get_group_list 的原始返回归一化 */
export function normalizeNapcatGroups(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const qqGroupId = String(raw?.group_id ?? '').trim();
    if (!isQQ(qqGroupId) || seen.has(qqGroupId)) continue;
    seen.add(qqGroupId);
    out.push({
      qqGroupId,
      name: text(raw?.group_name || raw?.group_remark, 100),
      memberCount: intOf(raw?.member_count),
      maxMemberCount: intOf(raw?.max_member_count),
    });
  }
  return out;
}

/** 把 get_group_member_list 的原始返回归一化（含真实 QQ 号） */
export function normalizeRoster(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const qq = String(raw?.user_id ?? raw?.userId ?? '').trim();
    if (!isQQ(qq) || seen.has(qq)) continue;
    seen.add(qq);
    out.push({
      qq,
      nickname: text(raw?.nickname, 100),
      card: text(raw?.card, 100),
      role: ['owner', 'admin', 'member'].includes(raw?.role) ? raw.role : 'member',
      joinTime: intOf(raw?.join_time),
      lastSentTime: intOf(raw?.last_sent_time),
      shutUpUntil: intOf(raw?.shut_up_timestamp),
      isRobot: raw?.is_robot === true,
    });
    if (out.length >= LIMITS.directoryMembersPerGroup) break;
  }
  return out;
}

/**
 * 官方群 -> NapCat 群 的映射。
 * 优先使用手动映射（groupMap），否则按归一化后的群名做唯一匹配。
 * @param {{official: Array<{gid:string,name:string}>, napcat: Array<{qqGroupId:string,name:string,memberCount:number}>, overrides?: Record<string,string>}} input
 */
export function resolveMappings({ official = [], napcat = [], overrides = {} } = {}) {
  const byId = new Map(napcat.map((g) => [g.qqGroupId, g]));
  const byName = new Map();
  for (const g of napcat) {
    const key = normalizeName(g.name);
    if (!key) continue;
    const list = byName.get(key) || [];
    list.push(g);
    byName.set(key, list);
  }
  const used = new Set();
  return official.map((g) => {
    const gid = String(g.gid || '').trim();
    const override = String(overrides?.[gid] ?? '').trim();
    let pick = null;
    let auto = false;
    let direct = false;
    if (isQQ(override)) {
      pick = byId.get(override) || { qqGroupId: override, name: '', memberCount: 0 };
      used.add(override);
    } else if (isQQ(gid)) {
      // 关键分支：v2.1.0 起 gid 本身就是 QQ 群号 → 恒等映射，直接取协议端里的群信息
      const live = byId.get(gid);
      pick = live || { qqGroupId: gid, name: '', memberCount: 0 };
      used.add(gid);
      direct = true;
    } else {
      const candidates = (byName.get(normalizeName(g.name)) || []).filter((x) => !used.has(x.qqGroupId));
      if (candidates.length === 1) {
        pick = candidates[0];
        auto = true;
        used.add(pick.qqGroupId);
      }
    }
    return {
      gid,
      name: g.name || '',
      qqGroupId: pick?.qqGroupId || '',
      qqGroupName: pick?.name || '',
      auto,
      direct,
      memberCount: pick?.memberCount || 0,
    };
  });
}

/**
 * 把协议端花名册里的 QQ 号贴回本地台账。
 * 只在“群内该昵称唯一 + 花名册里该昵称也唯一”时关联，避免同名误认。
 * @param {Array<{uid:string,name:string,qq?:string}>} ledger
 * @param {Array<{qq:string,nickname:string,card:string,role:string}>} roster
 */
export function planAttachments(ledger = [], roster = []) {
  const ledgerByName = new Map();
  for (const m of ledger) {
    const key = normalizeName(m.name);
    if (!key) continue;
    const list = ledgerByName.get(key) || [];
    list.push(m);
    ledgerByName.set(key, list);
  }
  const rosterByName = new Map();
  for (const r of roster) {
    const key = normalizeName(r.card || r.nickname);
    if (!key) continue;
    const list = rosterByName.get(key) || [];
    list.push(r);
    rosterByName.set(key, list);
  }
  const out = [];
  for (const [key, members] of ledgerByName) {
    const qqMembers = rosterByName.get(key) || [];
    if (qqMembers.length !== 1) continue;
    const r = qqMembers[0];
    const fresh = members.filter((m) => !m.qq);
    const target = members.length === 1 ? members[0] : (fresh.length === 1 ? fresh[0] : null);
    if (!target) continue;
    if (target.qq && target.qq !== r.qq) {
      // 同名但 QQ 变了：可能是改了昵称，也可能是换了人；没有更多证据时不改历史关联
      continue;
    }
    out.push({ uid: target.uid, qq: r.qq, card: r.card, role: r.role, name: r.nickname || r.card });
  }
  return out;
}

function isoFromSeconds(seconds) {
  const n = intOf(seconds);
  return n ? new Date(n * 1000).toISOString() : '';
}

/**
 * 合并本地台账 + 协议端目录，返回面板可直接渲染的成员行。
 * 去重按（群 + QQ）/（群 + openid）双键；目录条目缺少 gid 时退化为按 QQ 去重。
 * 台账行没有 QQ 时，会尝试用“群内唯一昵称/群名片”临时补上（仅用于展示，不写回 state）。
 * @param {{ledger?: any[], directories?: any[], query?: string, limit?: number, selfQQ?: string, allowUsers?: string[], trustedUsers?: any[]}} input
 * @returns {{rows: any[], total: number}}
 */
export function mergeMemberRows({
  ledger = [],
  directories = [],
  query = '',
  limit = LIMITS.memberSearchLimit,
  selfQQ = '',
  allowUsers = [],
  trustedUsers = [],
} = {}) {
  const whitelist = new Set((allowUsers || []).map((u) => String(u)));
  const trusted = new Set((trustedUsers || []).map((u) => String(u?.uid || u)));
  const dirs = [];
  for (const dir of directories) {
    const dgid = String(dir?.gid || '');
    const at = String(dir?.at || '');
    for (const r of dir?.members || []) {
      if (!r?.qq) continue;
      dirs.push({ dgid, at, r, claimed: false });
    }
  }
  const findDirByQq = (gid, qq) => dirs.find((x) => !x.claimed
    && String(x.r.qq) === String(qq)
    && (!x.dgid || !gid || x.dgid === String(gid)));

  const rows = [];
  const seen = new Set();
  for (const m of ledger) {
    if (!m) continue;
    // 同一群同一个人：uid 相同（官方 openid）或 QQ 相同都只保留一行
    const key = m.uid ? `${m.gid || ''}|uid|${m.uid}` : `${m.gid || ''}|qq|${m.qq || ''}|${normalizeName(m.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { ...m };
    if (row.qq) {
      const hit = findDirByQq(row.gid, row.qq);
      if (hit) {
        hit.claimed = true;
        row.card = row.card || hit.r.card || '';
        row.role = row.role || hit.r.role || 'member';
        row.isRobot = hit.r.isRobot === true;
      }
    }
    rows.push(row);
  }

  // 台账缺 QQ：按“群内唯一昵称 / 群名片”补一个仅展示用的 QQ（不覆盖、不落盘）
  for (const row of rows) {
    if (row.qq) continue;
    const nameKey = normalizeName(row.name || row.nickname);
    if (!nameKey) continue;
    const candidates = dirs.filter((x) => !x.claimed
      && (!x.dgid || !row.gid || x.dgid === String(row.gid))
      && (normalizeName(x.r.nickname) === nameKey || normalizeName(x.r.card) === nameKey));
    if (candidates.length !== 1) continue;
    const hit = candidates[0];
    hit.claimed = true;
    row.qq = hit.r.qq;
    row.card = hit.r.card || row.card || '';
    row.role = hit.r.role || row.role || 'member';
    row.isRobot = hit.r.isRobot === true;
    row.qqMatched = true;
  }

  // 剩下的目录成员：本地台账里没有对应行，按 QQ 单独成行
  for (const hit of dirs) {
    if (hit.claimed) continue;
    hit.claimed = true;
    const r = hit.r;
    rows.push({
      gid: hit.dgid,
      uid: '',
      qq: r.qq,
      name: r.card || r.nickname || `QQ ${r.qq}`,
      nickname: r.nickname || '',
      card: r.card || '',
      role: r.role || 'member',
      isRobot: r.isRobot === true,
      source: 'napcat',
      lastSeenAt: isoFromSeconds(r.lastSentTime) || hit.at,
      msgCount: 0,
      pending: false,
      inGroup: true,
    });
  }

  for (const m of rows) {
    m.source = m.uid && m.qq ? 'official+napcat' : (m.uid ? 'official' : 'napcat');
    m.role = ['owner', 'admin', 'member'].includes(m.role) ? m.role : 'member';
    m.isBot = m.isRobot === true || (!!selfQQ && String(m.qq || '') === String(selfQQ));
    m.whitelisted = !!(m.uid && whitelist.has(String(m.uid)));
    m.trusted = !!(m.uid && trusted.has(String(m.uid)));
  }

  const needle = normalizeName(query);
  const filtered = needle
    ? rows.filter((m) => [m.name, m.nickname, m.card, m.uid, m.qq]
      .some((v) => normalizeName(v).includes(needle)))
    : rows;
  const time = (m) => {
    const t = Date.parse(m.lastSeenAt || '');
    return Number.isFinite(t) ? t : 0;
  };
  filtered.sort((a, b) => time(b) - time(a) || String(a.name || '').localeCompare(String(b.name || '')));
  return {
    rows: filtered.slice(0, Math.max(1, Math.min(LIMITS.memberSearchLimit, Number(limit) || LIMITS.memberSearchLimit))),
    total: filtered.length,
  };
}

/**
 * 自动发现本机协议端：先读配置目录拿端口/token，再逐个探测，返回第一个能登录的地址。
 * 这是“新用户零配置”的关键：默认设置已经指向 NapCat 的 3001，但端口/token 常被改过。
 */
export async function discoverNapcat({ timeoutMs = 1500, log } = {}) {
  const candidates = [];
  for (const item of scanNapcatConfigs()) {
    candidates.push({ url: item.url, token: item.token, source: item.source });
  }
  for (const url of NAPCAT_WS_CANDIDATES) {
    if (!candidates.some((c) => c.url === url)) candidates.push({ url, token: '', source: '常见默认地址' });
  }
  const errors = [];
  for (const candidate of candidates) {
    const session = new OneBotSession({ url: candidate.url, token: candidate.token, timeoutMs });
    try {
      await session.open();
      const login = await session.call('get_login_info', {}).catch(() => null);
      const groups = normalizeNapcatGroups(await session.getGroupList().catch(() => []));
      return {
        ok: true,
        wsUrl: candidate.url,
        token: candidate.token,
        tokenSet: !!candidate.token,
        source: candidate.source,
        selfId: String(login?.user_id ?? ''),
        nickname: text(login?.nickname, 100),
        groups,
      };
    } catch (error) {
      errors.push(`${candidate.url}${candidate.token ? '（带 token）' : ''}: ${errorText(error)}`);
    } finally {
      try { session.close(); } catch { /* ignore */ }
    }
  }
  log?.warn?.(`[qqbot-guard] NapCat 自动发现失败：${errors.slice(0, 3).join('；')}`);
  return {
    ok: false,
    error: '没有发现可用的 NapCat / LLOneBot 协议端',
    tried: candidates.map((c) => c.url),
  };
}

/** NapCat 成员目录服务：同步、状态、按 QQ 号执行管理操作 */
export class MemberDirectory {
  constructor({ store, logger } = {}) {
    this.store = store;
    this.log = logger || console;
    this.lastGroups = [];
    this.mappings = [];
    this.lastError = '';
    this.lastSyncAt = 0;
    this.failureAt = 0;
    this.connected = false;
    this.syncing = null;
    /** 群公告接口频控：QQ 对公告类接口有 1–2 秒/次 的限制，连续调用时主动加延迟 */
    this.noticeGapMs = 1500;
    this.lastNoticeAt = 0;
  }

  config() {
    return this.store?.settings?.napcat || {};
  }

  enabled() {
    const cfg = this.config();
    return !!(cfg.enabled && cfg.wsUrl);
  }

  session() {
    const cfg = this.config();
    return new OneBotSession({
      url: cfg.wsUrl,
      token: cfg.token,
      timeoutMs: cfg.timeoutMs,
      log: this.log,
    });
  }

  officialGroups(gids) {
    const wanted = Array.isArray(gids) && gids.length ? new Set(gids) : null;
    return Object.values(this.store.state.groups || {})
      .filter((g) => g?.gid && (!wanted || wanted.has(g.gid)))
      .slice(0, LIMITS.napcatSyncGroups)
      .map((g) => ({ gid: g.gid, name: String(g.name || '') }));
  }

  /**
   * 本次同步要处理哪些群。
   * ⚠️ 旧实现只取本地台账里的群：新装插件还没收到任何群事件时台账是空的，
   * 于是“同步花名册”什么都不做、回执 0 个群，用户完全不知道该先发一句话。
   * 现在按以下优先级补齐：
   *   1) 显式传入的 gids（面板选中群 / 群内指令所在群）
   *   2) 本地台账里的群
   *   3) 协议端 get_group_list 返回的群（首次同步的关键来源）
   * 全程仍受 napcatSyncGroups 上限约束。
   */
  targetGroups(gids) {
    const wanted = Array.isArray(gids) && gids.length ? new Set(gids) : null;
    const out = [];
    const push = (gid, name) => {
      const id = String(gid || '').trim();
      if (!isQQ(id)) return;
      if (wanted && !wanted.has(id)) return;
      if (out.some((x) => x.gid === id)) return;
      if (out.length >= LIMITS.napcatSyncGroups) return;
      out.push({ gid: id, name: String(name || '') });
    };
    for (const g of this.officialGroups(gids)) push(g.gid, g.name);
    for (const g of this.lastGroups || []) push(g.qqGroupId, g.name);
    return out;
  }

  computeMappings(gids) {
    // 进程刚启动时 lastGroups 为空，用已持久化的目录兜底，重启后仍能自动对上号
    const stored = typeof this.store?.listDirectories === 'function'
      ? this.store.listDirectories().map((d) => ({
        qqGroupId: d.qqGroupId || '',
        name: d.qqGroupName || '',
        memberCount: Array.isArray(d.members) ? d.members.length : 0,
      }))
      : [];
    const napcat = this.lastGroups.length ? this.lastGroups : stored;
    return resolveMappings({
      official: this.targetGroups(gids),
      napcat,
      overrides: this.config().groupMap,
    });
  }

  status() {
    const cfg = this.config();
    const mappings = this.computeMappings();
    // 协议端实时群列表只在本次进程连过时存在；进程重启后回落到已持久化的目录，
    // 否则面板会显示成“从没同步过”，而实际数据还在 state.json 里。
    const stored = typeof this.store?.listDirectories === 'function' ? this.store.listDirectories() : [];
    // 还没连过协议端、也没填手动映射时，不展示一串“未匹配”，避免误导
    const showMappings = this.lastGroups.length || stored.length || Object.keys(cfg.groupMap || {}).length;
    const liveByQQ = new Map(this.lastGroups.map((g) => [g.qqGroupId, g]));
    const groups = stored.length
      ? stored.map((d) => {
        const live = liveByQQ.get(d.qqGroupId);
        return {
          qqGroupId: d.qqGroupId || '',
          name: d.qqGroupName || live?.name || '',
          memberCount: live?.memberCount ?? (Array.isArray(d.members) ? d.members.length : 0),
          maxMemberCount: live?.maxMemberCount ?? 0,
          gid: d.gid,
          at: d.at || '',
        };
      })
      : this.lastGroups.map((g) => ({ ...g }));
    const storedAt = stored.reduce((max, d) => Math.max(max, Date.parse(d.at || '') || 0), 0);
    const lastSyncAt = this.lastSyncAt || storedAt;
    return {
      enabled: !!cfg.enabled,
      url: cfg.wsUrl || '',
      connected: this.connected,
      autoSync: !!cfg.autoSync,
      noCache: cfg.noCache !== false,
      cacheTtlMs: Number(cfg.cacheTtlMs) || 0,
      syncing: !!this.syncing,
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : '',
      lastError: this.lastError,
      groups,
      mappings: (showMappings ? mappings : []).map((m) => ({
        ...m,
        directoryCount: this.store.countDirectory(m.gid),
        at: this.store.getDirectory(m.gid)?.at || '',
      })),
      directoryMembers: this.store.countDirectory(),
    };
  }

  /** 缓存过期 / 失败退避判断；过期才真正同步，避免每次打开面板都连 NapCat */
  async ensureFresh(gids) {
    const cfg = this.config();
    if (!this.enabled() || !cfg.autoSync) return this.status();
    if (this.syncing) {
      await this.syncing.catch(() => {});
      return this.status();
    }
    const now = Date.now();
    if (this.failureAt && now - this.failureAt < LIMITS.napcatFailureBackoffMs) return this.status();
    // 显式指定群就直接用；否则先把台账里的群和协议端群列表合起来（新装时台账是空的）
    const wanted = Array.isArray(gids) && gids.length
      ? gids
      : this.targetGroups().map((g) => g.gid);
    if (!wanted.length) return this.status();
    const ttl = Math.max(0, Number(cfg.cacheTtlMs) || 0);
    const fresh = wanted.every((gid) => {
      const entry = this.store.getDirectory(gid);
      const at = Date.parse(entry?.at || '');
      return Number.isFinite(at) && now - at < ttl;
    });
    if (fresh) return this.status();
    await this.sync(wanted);
    return this.status();
  }

  /** 拉取花名册；同一时间只允许一个同步任务 */
  async sync(gids) {
    const cfg = this.config();
    if (!cfg.wsUrl) {
      return { ...this.status(), ok: false, error: '未填写 NapCat WebSocket 地址' };
    }
    if (this.syncing) return this.syncing;
    const run = this.#runSync(gids).finally(() => { this.syncing = null; });
    this.syncing = run;
    return run;
  }

  async #runSync(gids) {
    const cfg = this.config();
    const session = this.session();
    let partial = '';
    let syncedGroups = 0;
    let syncedMembers = 0;
    let skippedGroups = 0;
    try {
      await session.open();
      this.connected = true;
      const login = await session.call('get_login_info', {}).catch(() => null);
      this.selfQQ = String(login?.user_id ?? this.selfQQ ?? '');
      this.lastGroups = normalizeNapcatGroups(await session.getGroupList());
      const mappings = this.computeMappings(gids);
      this.mappings = mappings;
      for (const map of mappings) {
        if (!map.qqGroupId) {
          skippedGroups += 1;
          continue;
        }
        try {
          const roster = normalizeRoster(await session.getGroupMemberList(map.qqGroupId, cfg.noCache !== false))
            .map((r) => (this.selfQQ && r.qq === this.selfQQ ? { ...r, isRobot: true } : r));
          const at = new Date().toISOString();
          this.store.setDirectory(map.gid, {
            at,
            qqGroupId: map.qqGroupId,
            qqGroupName: map.qqGroupName,
            members: roster,
          });
          const plan = planAttachments(this.store.listMembers(map.gid), roster);
          for (const item of plan) {
            this.store.patchMember(map.gid, item.uid, {
              qq: item.qq,
              card: item.card,
              role: item.role,
              qqName: item.name,
              qqAt: at,
            });
          }
          this.store.upsertGroup(map.gid, {
            qqGroupId: map.qqGroupId,
            qqGroupName: map.qqGroupName,
            directoryCount: roster.length,
            directoryAt: at,
          });
          syncedGroups += 1;
          syncedMembers += roster.length;
        } catch (error) {
          partial = `群「${map.name || map.gid}」同步失败：${errorText(error)}`;
          this.log?.warn?.(`[qqbot-guard] NapCat ${partial}`);
        }
      }
      this.lastSyncAt = Date.now();
      this.failureAt = 0;
      this.lastError = partial;
      return {
        ...this.status(),
        syncing: false,
        ok: !partial || syncedGroups > 0,
        syncedGroups,
        syncedMembers,
        skippedGroups,
        error: syncedGroups === 0 && partial ? partial : '',
        warning: skippedGroups && syncedGroups
          ? `有 ${skippedGroups} 个群没有匹配到 QQ 群号，可在设置里手动填写映射`
          : '',
      };
    } catch (error) {
      const message = errorText(error);
      this.connected = false;
      this.lastError = message;
      this.failureAt = Date.now();
      this.log?.warn?.(`[qqbot-guard] NapCat 同步失败：${message}`);
      return { ...this.status(), syncing: false, ok: false, error: message };
    } finally {
      session.close();
    }
  }

  /**
   * 自动发现本机协议端并写回设置。
   * 新用户最常见的卡点是：NapCat 实际端口/token 与默认值不同 —— 这里主动探测，
   * 找到就直接落盘，面板与群内查询立刻可用；找不到也不报错，只留一句提示。
   */
  async discover({ persist = true } = {}) {
    const cfg = this.config();
    const found = await discoverNapcat({
      timeoutMs: Math.min(2000, Number(cfg.timeoutMs) || 2000),
      log: this.log,
    });
    if (!found.ok) {
      this.lastError = found.error;
      return found;
    }
    let updated = false;
    if (persist) {
      const before = this.store.settings?.napcat || {};
      if (before.wsUrl !== found.wsUrl || String(before.token || '') !== String(found.token || '')) {
        const next = JSON.parse(JSON.stringify(this.store.settings || {}));
        next.napcat = { ...(next.napcat || {}), enabled: true, wsUrl: found.wsUrl, token: found.token };
        this.store.saveSettings(next);
        updated = true;
        this.log?.info?.(`[qqbot-guard] NapCat 自动发现：${found.wsUrl}${found.token ? '（带 token）' : ''}，已写入设置`);
      }
    }
    this.selfQQ = String(found.selfId || this.selfQQ || '');
    this.lastGroups = found.groups || [];
    this.connected = true;
    this.lastError = '';
    this.failureAt = 0;
    return { ...found, updated };
  }

  /**
   * 启动自愈：当前地址能连上就什么都不做；连不上且允许自动探测时，找一次并写回。
   * 整个过程失败也只记日志，绝不阻塞插件启动。
   */
  async autoConfigure() {
    const cfg = this.config();
    if (!cfg.enabled || cfg.autoDetect === false || !cfg.wsUrl) {
      return { ok: false, skipped: !cfg.enabled ? 'disabled' : cfg.autoDetect === false ? 'autoDetect off' : 'no url' };
    }
    try {
      const probe = await this.test();
      if (probe.ok) return { ...probe, updated: false };
    } catch { /* 探测失败就走自动发现 */ }
    this.log?.info?.('[qqbot-guard] NapCat 未连接，开始自动发现协议端…');
    const found = await this.discover({ persist: true });
    if (found.ok) {
      this.log?.info?.(
        `[qqbot-guard] NapCat 自动发现成功：${found.wsUrl}（QQ ${found.selfId} ${found.nickname}，${found.groups?.length ?? 0} 个群）`,
      );
    }
    return found;
  }

  /** 测试连接：返回登录账号与 NapCat 群列表（不写入花名册） */
  async test() {
    const cfg = this.config();
    if (!cfg.wsUrl) return { ok: false, error: '未填写 NapCat WebSocket 地址' };
    const session = this.session();
    try {
      await session.open();
      const login = await session.call('get_login_info', {}).catch(() => null);
      this.selfQQ = String(login?.user_id ?? this.selfQQ ?? '');
      this.lastGroups = normalizeNapcatGroups(await session.getGroupList());
      this.connected = true;
      this.lastError = '';
      this.failureAt = 0;
      const status = this.status();
      return {
        ok: true,
        selfId: String(login?.user_id ?? ''),
        nickname: text(login?.nickname, 100),
        groups: status.groups,
        mappings: status.mappings,
        directoryMembers: status.directoryMembers,
      };
    } catch (error) {
      const message = errorText(error);
      this.connected = false;
      this.lastError = message;
      this.failureAt = Date.now();
      return { ok: false, error: message };
    } finally {
      session.close();
    }
  }

  /** 解析官方 gid 对应的 QQ 群号；顺带补齐映射 */
  async qqGroupIdOf(gid, session) {
    let qqGroupId = this.store.getDirectory(gid)?.qqGroupId
      || this.store.state.groups?.[gid]?.qqGroupId
      || '';
    if (qqGroupId) return qqGroupId;
    this.lastGroups = normalizeNapcatGroups(await session.getGroupList());
    const mapping = this.computeMappings([gid]).find((x) => x.gid === gid);
    qqGroupId = mapping?.qqGroupId || '';
    if (qqGroupId) {
      this.store.upsertGroup(gid, { qqGroupId, qqGroupName: mapping.qqGroupName });
    }
    return qqGroupId;
  }

  /** 用 QQ 号执行管理操作（官方 openid 不可用时的兜底） */
  async act({ gid, qq, action, seconds } = {}) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.wsUrl) return { ok: false, error: 'NapCat 成员目录未启用' };
    if (!isQQ(qq)) return { ok: false, error: 'QQ 号不合法' };
    const session = this.session();
    try {
      await session.open();
      this.connected = true;
      const qqGroupId = await this.qqGroupIdOf(gid, session);
      if (!qqGroupId) {
        return { ok: false, error: '没有找到该群对应的 QQ 群号，请先在设置里填写群映射' };
      }
      const groupId = Number(qqGroupId);
      const userId = Number(qq);
      if (!Number.isFinite(groupId) || !Number.isFinite(userId)) {
        return { ok: false, error: '群号或 QQ 号不是合法数字' };
      }
      if (action === 'mute') {
        const secs = Math.max(1, Math.min(30 * 24 * 3600, Number(seconds) || 600));
        await session.call('set_group_ban', { group_id: groupId, user_id: userId, duration: secs });
        return { ok: true, via: 'napcat', action, qqGroupId, qq, seconds: secs };
      }
      if (action === 'unmute') {
        await session.call('set_group_ban', { group_id: groupId, user_id: userId, duration: 0 });
        return { ok: true, via: 'napcat', action, qqGroupId, qq };
      }
      if (action === 'kick') {
        await session.call('set_group_kick', { group_id: groupId, user_id: userId, reject_add_request: false });
        return { ok: true, via: 'napcat', action, qqGroupId, qq };
      }
      return { ok: false, error: '未知操作' };
    } catch (error) {
      const message = errorText(error);
      this.lastError = message;
      return { ok: false, error: message };
    } finally {
      session.close();
    }
  }

  /** 全体禁言 / 解除全体禁言（NapCat set_group_whole_ban） */
  async wholeBan({ gid, enable = true } = {}) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.wsUrl) return { ok: false, error: 'NapCat 成员目录未启用（官方 Bot API 不支持全员禁言）' };
    const session = this.session();
    try {
      await session.open();
      this.connected = true;
      const qqGroupId = await this.qqGroupIdOf(gid, session);
      if (!qqGroupId) return { ok: false, error: '没有找到该群对应的 QQ 群号，请先在设置里填写群映射' };
      await session.call('set_group_whole_ban', { group_id: Number(qqGroupId), enable: !!enable });
      return { ok: true, via: 'napcat', action: enable ? 'whole-ban' : 'whole-unban', qqGroupId };
    } catch (error) {
      const message = errorText(error);
      this.lastError = message;
      // NapCat / OneBot 在机器人不是管理员时会返回 1287（或同类权限错误）
      if (/1287|权限|permission|not admin|管理员/iu.test(message)) {
        return { ok: false, error: '机器人不是本群管理员 / 群主，QQ 不允许执行全员禁言（先把机器人设成群管理员）' };
      }
      return { ok: false, error: message };
    } finally {
      session.close();
    }
  }

  /** 在群里发一张图片（表情包），NapCat 可用时走 OneBot；否则失败由调用方兜底 */
  async sendImage({ gid, image, text = '' } = {}) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.wsUrl) return { ok: false, error: 'NapCat 成员目录未启用' };
    const file = String(image || '').trim();
    if (!file) return { ok: false, error: '图片地址为空' };
    const session = this.session();
    try {
      await session.open();
      this.connected = true;
      const qqGroupId = await this.qqGroupIdOf(gid, session);
      if (!qqGroupId) return { ok: false, error: '没有找到该群对应的 QQ 群号' };
      const message = [];
      if (text) message.push({ type: 'text', data: { text } });
      message.push({ type: 'image', data: { file } });
      const result = await session.call('send_group_msg', { group_id: Number(qqGroupId), message });
      return { ok: true, via: 'napcat', messageId: result?.message_id ?? null };
    } catch (error) {
      const message = errorText(error);
      this.lastError = message;
      return { ok: false, error: message };
    } finally {
      session.close();
    }
  }

  /** 发送真·群公告（QQ 群公告，非普通消息）。需要机器人是本群管理员/群主。 */
  async sendGroupNotice({ gid, content, image = '', pinned = false, confirmRequired = false, type = 'notice' } = {}) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.wsUrl) return { ok: false, error: 'NapCat 成员目录未启用（官方 Bot API 不支持设置群公告）' };
    const body = String(content || '').trim();
    if (!body) return { ok: false, error: '公告内容不能为空' };
    if (body.length > 600) return { ok: false, error: '公告内容过长（最多 600 字）' };
    const session = this.session();
    try {
      await session.open();
      this.connected = true;
      await this.noticeThrottle();
      const qqGroupId = await this.qqGroupIdOf(gid, session);
      if (!qqGroupId) return { ok: false, error: '没有找到该群对应的 QQ 群号，请先在设置里填写群映射' };
      const params = {
        group_id: Number(qqGroupId),
        content: body,
        pinned: !!pinned,
        confirm_required: !!confirmRequired,
        type: String(type || 'notice').slice(0, 20),
      };
      const img = String(image || '').trim();
      if (img) params.image = img;
      await session.call('_send_group_notice', params);
      return { ok: true, via: 'napcat', action: 'send-group-notice', qqGroupId };
    } catch (error) {
      return this.noticeError(error);
    } finally {
      session.close();
    }
  }

  /** 拉取群公告列表。返回统一的 data[]（含 inst 里的“群规/发给新成员”类公告） */
  async getGroupNotices(gid) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.wsUrl) return { ok: false, error: 'NapCat 成员目录未启用' };
    const session = this.session();
    try {
      await session.open();
      this.connected = true;
      await this.noticeThrottle();
      const qqGroupId = await this.qqGroupIdOf(gid, session);
      if (!qqGroupId) return { ok: false, error: '没有找到该群对应的 QQ 群号，请先在设置里填写群映射' };
      const result = await session.call('_get_group_notice', { group_id: Number(qqGroupId) });
      // NapCat 不同版本返回结构不同：
      // - 无头版：直接是数组 [ {notice_id, message:{text,image}, ...}, ... ]
      // - 部分版本：{ data: [...], inst: [...] }
      const flat = Array.isArray(result)
        ? result
        : [...(Array.isArray(result?.data) ? result.data : []), ...(Array.isArray(result?.inst) ? result.inst : [])];
      const notices = flat;
      return { ok: true, via: 'napcat', action: 'list-group-notices', qqGroupId, notices, all: notices };
    } catch (error) {
      return this.noticeError(error);
    } finally {
      session.close();
    }
  }

  /** 删除一条群公告。noticeId 必须来自 getGroupNotices，不能猜。 */
  async deleteGroupNotice({ gid, noticeId }) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.wsUrl) return { ok: false, error: 'NapCat 成员目录未启用' };
    const id = String(noticeId || '').trim();
    if (!id) return { ok: false, error: '缺少公告 ID（需从公告列表中选择）' };
    const session = this.session();
    try {
      await session.open();
      this.connected = true;
      await this.noticeThrottle();
      const qqGroupId = await this.qqGroupIdOf(gid, session);
      if (!qqGroupId) return { ok: false, error: '没有找到该群对应的 QQ 群号，请先在设置里填写群映射' };
      await session.call('_del_group_notice', { group_id: Number(qqGroupId), notice_id: id });
      return { ok: true, via: 'napcat', action: 'delete-group-notice', qqGroupId, noticeId: id };
    } catch (error) {
      return this.noticeError(error);
    } finally {
      session.close();
    }
  }

  /** 群公告接口频控：两次连续调用之间至少间隔 noticeGapMs */
  async noticeThrottle() {
    const wait = Math.max(0, this.noticeGapMs - (Date.now() - (this.lastNoticeAt || 0)));
    if (wait > 0) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, wait);
        if (typeof t.unref === 'function') t.unref();
      });
    }
    this.lastNoticeAt = Date.now();
  }

  /** 群公告公共错误归一化：1287 / 权限类都给友好提示 */
  noticeError(error) {
    const message = errorText(error);
    this.lastError = message;
    if (/1287|权限|permission|not admin|管理员|群主/iu.test(message)) {
      return { ok: false, error: '机器人不是本群管理员 / 群主，QQ 不允许操作群公告（先把机器人设成群管理员）' };
    }
    return { ok: false, error: message };
  }

  /** 设置变更后清掉连接状态，下一次打开成员页会重新同步 */
  reconfigure() {
    this.connected = false;
    this.failureAt = 0;
    this.lastError = '';
    this.lastGroups = [];
    this.mappings = [];
    this.lastNoticeAt = 0;
  }

  dispose() {
    this.syncing = null;
  }
}
