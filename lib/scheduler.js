/**
 * 定时任务：解析“22:30 / 明天 9 点 / 3 分钟后 / 每天 23:00”这类时间，
 * 到点执行禁言、解除禁言、全员禁言等动作。
 */
import { LIMITS } from './defaults.js';

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function digits(text) {
  const s = String(text || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGITS[s[1]];
  if (/^[一二三四五六七八九]十$/.test(s)) return CN_DIGITS[s[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_DIGITS[s[0]] * 10 + CN_DIGITS[s[2]];
  return Number(s);
}

/** 解析 HH:MM / H点M分 / 晚上10点 这类时刻，返回 { hour, minute } */
function parseClockTime(text) {
  const m = String(text || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/u);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
    return null;
  }
  const m2 = String(text || '').match(/([零一二两三四五六七八九十\d]{1,3})\s*[点時时]\s*(半|([零一二三四五六七八九十\d]{1,3})\s*分?)?/u);
  if (!m2) return null;
  let hour = digits(m2[1]);
  let minute = 0;
  if (m2[2] === '半') minute = 30;
  else if (m2[3]) minute = digits(m2[3]);
  if (/下午|晚上|傍晚/u.test(text) && hour < 12) hour += 12;
  if (/凌晨/u.test(text) && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) return null;
  return { hour, minute };
}

const REL_RE = /(\d{1,4}|[零一二两三四五六七八九十]{1,3})?\s*(个)?\s*(半|一刻|小时|分钟|分|秒)(?:钟|钟头)?\s*(后|以后|之后)?/u;

/** 相对时间：3 分钟后 / 半小时后 / 2 小时之后 */
function parseRelative(text) {
  const m = String(text || '').match(REL_RE);
  if (!m || !/(后|以后|之后)/u.test(m[0])) return null;
  const raw = m[1] === undefined || m[1] === '' ? 1 : digits(m[1]);
  const unit = m[3];
  if (!Number.isFinite(raw)) return null;
  let ms = 0;
  if (unit === '秒') ms = raw * 1000;
  else if (unit === '分钟' || unit === '分') ms = raw * 60_000;
  else if (unit === '小时') ms = raw * 3600_000;
  else if (unit === '半') ms = 30 * 60_000;
  else if (unit === '一刻') ms = 15 * 60_000;
  return ms > 0 ? { afterMs: ms } : null;
}

/**
 * 解析“什么时候”。
 * @returns {{at:number, repeat:'once'|'daily', time:string, text:string, rest:string}|null}
 */
export function parseSchedule(text, now = Date.now()) {
  const source = String(text || '');
  if (!source.trim()) return null;

  // 每天 / 每日 + 时刻
  const daily = /(每天|每日|天天)/u.test(source);
  const rel = parseRelative(source);
  if (rel) {
    return {
      at: now + rel.afterMs,
      repeat: 'once',
      time: '',
      text: source,
    };
  }
  const clock = parseClockTime(source);
  if (!clock) return null;
  const base = new Date(now);
  const target = new Date(base);
  target.setSeconds(0, 0);
  target.setHours(clock.hour, clock.minute);
  if (/明天/u.test(source)) target.setDate(target.getDate() + 1);
  else if (/后天/u.test(source)) target.setDate(target.getDate() + 2);
  else if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  const hh = String(clock.hour).padStart(2, '0');
  const mm = String(clock.minute).padStart(2, '0');
  return {
    at: target.getTime(),
    repeat: daily ? 'daily' : 'once',
    time: `${hh}:${mm}`,
    text: source,
  };
}

/** 下次触发时间（daily 用） */
export function nextDaily(at, now = Date.now()) {
  const d = new Date(at);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(d.getHours(), d.getMinutes());
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

const KINDS = new Set(['mute', 'unmute', 'whole-ban', 'whole-unban']);

export const SCHEDULE_KIND_LABEL = {
  mute: '禁言',
  unmute: '解除禁言',
  'whole-ban': '全员禁言',
  'whole-unban': '解除全员禁言',
};

/** 定时任务仓库 + 到点执行（由 index.js 注入 executor） */
export class Scheduler {
  constructor({ store, logger, executor, tickMs = 20_000 } = {}) {
    this.store = store;
    this.logger = logger || console;
    this.executor = executor;
    this.tickMs = Math.max(5000, Number(tickMs) || 20_000);
    this.timer = null;
    this.running = false;
  }

  list(gid = '') {
    const all = Array.isArray(this.store.state.schedules) ? this.store.state.schedules : [];
    return all.filter((x) => !gid || x.gid === gid).sort((a, b) => a.at - b.at);
  }

  add(entry = {}) {
    const gid = String(entry.gid || '');
    const kind = String(entry.kind || '');
    if (!gid) return { ok: false, error: '缺少群号' };
    if (!KINDS.has(kind)) return { ok: false, error: '未知的定时动作' };
    const at = Number(entry.at);
    if (!Number.isFinite(at) || at <= Date.now() - 1000) return { ok: false, error: '时间必须晚于现在' };
    const repeat = entry.repeat === 'daily' ? 'daily' : 'once';
    let all = Array.isArray(this.store.state.schedules) ? [...this.store.state.schedules] : [];
    // 群级全员禁言 / 解除：同群 + 同动作 + 同重复方式视为「修改」，先移除旧任务。
    // 对齐 OneBot 插件“随时修改定时任务”的语义：改时间只需再说一次，不会排出两条。
    let replaced = 0;
    if (kind === 'whole-ban' || kind === 'whole-unban') {
      const keep = [];
      for (const x of all) {
        const same = x.gid === gid && x.kind === kind
          && (x.repeat === 'daily' ? 'daily' : 'once') === repeat;
        if (same) replaced += 1;
        else keep.push(x);
      }
      all = keep;
    }
    if (all.length >= LIMITS.schedules) return { ok: false, error: `定时任务最多 ${LIMITS.schedules} 条` };
    const item = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      gid,
      kind,
      uid: String(entry.uid || '').slice(0, 64),
      qq: String(entry.qq || '').slice(0, 16),
      seconds: Math.max(0, Math.min(30 * 24 * 3600, Number(entry.seconds) || 0)),
      at,
      repeat,
      time: String(entry.time || '').slice(0, 5),
      createdBy: String(entry.createdBy || '').slice(0, 64),
      createdAt: Date.now(),
    };
    all.push(item);
    this.store.state.schedules = all.slice(-LIMITS.schedules);
    this.store.saveState();
    return { ok: true, item, replaced };
  }

  /**
   * 取消一条定时任务。
   * ⚠️ 旧实现把 key 同时拿去比 time（"22:30"）和 at（时间戳字符串）：
   *   - 传空 id → key='' → 所有 time='' 的一次性任务被一起删掉；
   *   - 传 "22:30" → 所有每天 22:30 的任务（含别的群）一起删掉。
   * 现在只按 id 精确匹配；时间/序号这类模糊输入由调用方（natural-admin / 面板）先解析成 id。
   * @param {string} id 任务 id（来自 scheduler.list()）
   */
  cancel(id) {
    const key = String(id || '').trim();
    if (!key) return { ok: false, error: '缺少任务 id（请用“查看定时任务”确认序号后再取消）' };
    const all = Array.isArray(this.store.state.schedules) ? this.store.state.schedules : [];
    const next = all.filter((x) => String(x.id) !== key);
    if (next.length === all.length) return { ok: false, error: '没有找到这条定时任务' };
    this.store.state.schedules = next;
    this.store.saveState();
    return { ok: true, removed: all.length - next.length };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 到点执行；daily 任务改到下一次 */
  async tick(now = Date.now()) {
    if (this.running) return [];
    this.running = true;
    const done = [];
    try {
      const all = Array.isArray(this.store.state.schedules) ? this.store.state.schedules : [];
      const due = all.filter((x) => Number(x.at) <= now);
      if (!due.length) return done;
      const remain = all.filter((x) => Number(x.at) > now);
      for (const item of due) {
        try {
          const r = await this.executor?.(item);
          done.push({ item, ok: !!r?.ok, error: r?.error || '' });
        } catch (error) {
          done.push({ item, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        if (item.repeat === 'daily') {
          remain.push({ ...item, at: nextDaily(item.at, now) });
        }
      }
      this.store.state.schedules = remain.slice(-LIMITS.schedules);
      this.store.saveState();
      return done;
    } finally {
      this.running = false;
    }
  }
}
