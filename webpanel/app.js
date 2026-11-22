/* 青衫群管 · 独立控制台（原生 JS，无构建依赖） */
'use strict';

const API = '/api/qqbot-guard';
const state = {
  me: null,
  security: null,
  boot: null,
  draft: null,
  tab: 'overview',
  status: null,
  device: null,
  audit: [],
  changelog: [],
  groupSel: '',
  memberQuery: '',
  net: null,
  poll: null,
};

const TABS = [
  ['overview', '总览'],
  ['moderation', '违规防护'],
  ['join', '入群'],
  ['announcements', '公告'],
  ['groups', '群与成员'],
  ['blacklist', '黑名单'],
  ['audit', '审计'],
  ['changelog', '修改日志'],
  ['settings', '设置'],
];

const $ = (id) => document.getElementById(id);
const admin = () => state.me?.role === 'admin';

/* ---------------- 基础工具 ---------------- */
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/gu, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
function lines(list) { return (Array.isArray(list) ? list : []).join('\n'); }
function parseLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/\r?\n|,|，/u)) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
}
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = v / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const day = Math.floor(total / 86400);
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  if (day) return `${day} 天 ${hour} 小时`;
  if (hour) return `${hour} 小时 ${minute} 分`;
  return `${minute} 分钟`;
}
function diff(before, after) {
  if (Array.isArray(after) || Array.isArray(before)) {
    return JSON.stringify(before) === JSON.stringify(after) ? undefined : after;
  }
  if (after && typeof after === 'object' && before && typeof before === 'object') {
    const out = {};
    for (const key of Object.keys(after)) {
      const sub = diff(before[key], after[key]);
      if (sub !== undefined) out[key] = sub;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return before === after ? undefined : after;
}
function isBasicPatchClient(patch, prefix = '') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  const entries = Object.entries(patch);
  if (!entries.length) return false;
  return entries.every(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) return isBasicPatchClient(value, path);
    if (/^moderation\.(keywords|fuzzy\.extras)$/u.test(path)) return true;
    if (/^join\.welcome\.(template|variants)$/u.test(path)) return true;
    if (/^groups\.[^.]+\.moderation\.(keywords|fuzzy\.extras)$/u.test(path)) return true;
    if (/^groups\.[^.]+\.join\.welcome\.(template|variants)$/u.test(path)) return true;
    if (/^groups\.[^.]+\.__replace$/u.test(path) && value === true) return true;
    return false;
  });
}
function statusInfo(status) {
  if (!status) return { cls: 'off', text: '未初始化' };
  if (!status.configured) return { cls: 'off', text: '未配置凭据' };
  if (status.state === 'online') return { cls: 'ok', text: '机器人在线' };
  if (status.state === 'connecting') return { cls: 'warn', text: '连接中' };
  if (status.state === 'error') return { cls: 'bad', text: '连接失败' };
  return { cls: 'off', text: '已断开' };
}

async function req(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (init.method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.headers['x-qqg-csrf'] = '1';
    init.body = JSON.stringify(opts.body || {});
  }
  try {
    const res = await fetch(API + path, init);
    if (res.status === 401) {
      showLogin();
      return { ok: false, error: { message: '登录已过期，请重新登录' } };
    }
    const json = await res.json();
    if (!json || typeof json !== 'object') return { ok: false, error: { message: '响应格式异常' } };
    return json;
  } catch (error) {
    return { ok: false, error: { message: '无法连接面板：' + (error?.message || error) } };
  }
}

async function authReq(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (init.method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.headers['x-qqg-csrf'] = '1';
    init.body = JSON.stringify(opts.body || {});
  }
  const res = await fetch(path, init);
  return res.json();
}

function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 3600);
}

function modal(title, text, okText = '继续') {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    $('modal-ok').textContent = okText;
    $('modal').classList.remove('hidden');
    const done = (value) => {
      $('modal').classList.add('hidden');
      $('modal-ok').removeEventListener('click', yes);
      $('modal-cancel').removeEventListener('click', no);
      resolve(value);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('modal-ok').addEventListener('click', yes);
    $('modal-cancel').addEventListener('click', no);
  });
}

/* ---------------- 首次初始化与登录 ---------------- */
function showLogin() {
  state.me = null;
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  $('setup').classList.add('hidden');
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

function showSetup() {
  state.me = null;
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  $('login').classList.add('hidden');
  $('app').classList.add('hidden');
  $('setup').classList.remove('hidden');
}

function showApp() {
  $('setup').classList.add('hidden');
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
}

/** 前端预校验，与服务端策略一致；长度限制来自服务端，避免重复写死 */
function pwdProblem(password) {
  const text = String(password || '');
  const sec = state.security || {};
  const min = Number(sec.passwordMin) || 0;
  const max = Number(sec.passwordMax) || 0;
  if (min && text.length < min) return `密码至少 ${min} 位`;
  if (max && text.length > max) return `密码最多 ${max} 位`;
  if (/\s/u.test(text)) return '密码不能包含空格';
  if (!/[A-Za-z]/u.test(text)) return '密码必须包含字母';
  if (!/\d/u.test(text)) return '密码必须包含数字';
  return '';
}

async function checkSession() {
  const r = await fetch('/api/qqg/session', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  if (r?.ok) {
    state.security = r.data?.security || null;
    if (!r.data?.initialized) {
      showSetup();
      return;
    }
    if (r.data?.role) {
      state.me = r.data;
      showApp();
      await loadBoot();
      return;
    }
  }
  showLogin();
}

async function setup(event) {
  event.preventDefault();
  const adminPassword = $('setup-admin').value;
  const operatorPassword = $('setup-operator').value;
  const error = $('setup-error');
  error.textContent = '';
  if (adminPassword !== $('setup-admin2').value) {
    error.textContent = '两次输入的最高管理员密码不一致';
    return;
  }
  if (operatorPassword !== $('setup-operator2').value) {
    error.textContent = '两次输入的普通管理员密码不一致';
    return;
  }
  const bad = pwdProblem(adminPassword) || pwdProblem(operatorPassword);
  if (bad) {
    error.textContent = bad;
    return;
  }
  if (adminPassword === operatorPassword) {
    error.textContent = '两个角色的密码不能相同';
    return;
  }
  const r = await authReq('/api/qqg/setup', {
    method: 'POST',
    body: { adminPassword, operatorPassword },
  });
  if (!r.ok) {
    error.textContent = r.error?.message || '设置失败';
    return;
  }
  state.me = r.data;
  state.security = r.data.security || null;
  for (const id of ['setup-admin', 'setup-admin2', 'setup-operator', 'setup-operator2']) $(id).value = '';
  showApp();
  await loadBoot();
}

async function login(event) {
  event.preventDefault();
  const password = $('login-password').value;
  $('login-error').textContent = '';
  const r = await authReq('/api/qqg/login', { method: 'POST', body: { password } });
  if (!r.ok) {
    if (r.error?.code === 'SETUP_REQUIRED') {
      showSetup();
      return;
    }
    $('login-error').textContent = r.error?.message || '登录失败';
    return;
  }
  state.me = r.data;
  state.security = r.data.security || null;
  $('login-password').value = '';
  showApp();
  await loadBoot();
}

async function logout() {
  await authReq('/api/qqg/logout', { method: 'POST' });
  showLogin();
}

/* ---------------- 数据加载 ---------------- */
async function loadBoot() {
  const r = await req('/bootstrap');
  if (!r.ok) {
    toast(r.error?.message || '加载失败', true);
    return;
  }
  state.boot = r.data;
  state.draft = deepClone(r.data.settings);
  state.status = r.data.status;
  state.device = r.data.device || null;
  state.security = r.data.security || state.security;
  updateHeader();
  render();
  if (!state.poll) {
    state.poll = setInterval(() => {
      if (document.hidden) return;
      void refreshStatus();
    }, 8000);
  }
}

async function refreshStatus() {
  const r = await req('/status');
  if (!r.ok) return;
  state.status = r.data.status;
  state.device = r.data.device || state.device;
  updateHeader();
  if (state.tab === 'overview') render();
}

function updateHeader() {
  const role = state.me?.role === 'admin' ? '最高管理员' : '普通管理员';
  $('role-badge').textContent = role;
  const info = statusInfo(state.status);
  const badge = $('bot-badge');
  badge.textContent = info.text;
  badge.className = 'badge ' + info.cls;
  const urls = state.boot?.panel?.urls || [];
  $('panel-url').textContent = urls[0] || '控制台';
}

/* ---------------- 保存 ---------------- */
async function savePatch(patch) {
  if (!patch || !Object.keys(patch).length) {
    toast('没有需要保存的修改');
    return;
  }
  const basic = isBasicPatchClient(patch);
  let token = '';
  if (!admin() && !basic) {
    const summary = summarize(patch);
    for (let i = 1; i <= 3; i++) {
      const ok = await modal(
        `第 ${i}/3 次确认`,
        `你正在以普通管理员身份修改机器人级别的设置，保存后会通知所有已加入的群；如果配置了通知对象，会在群里 @ 该成员。\n\n变更内容：\n${summary}`,
        i === 3 ? '确认保存' : '继续确认',
      );
      if (!ok) return;
      const c = await req('/settings/challenge', { method: 'POST', body: {} });
      if (!c.ok) {
        toast(c.error?.message || '确认失败', true);
        return;
      }
      if (i === 3) token = c.data.token;
    }
  }
  const r = await req('/settings', { method: 'POST', body: { patch, confirmToken: token } });
  if (!r.ok) {
    toast(r.error?.message || '保存失败', true);
    return;
  }
  if (r.data?.notify?.queued) {
    toast(`已保存，并已向 ${r.data.notify.groups} 个群发送变更通知`);
  } else {
    toast('已保存');
  }
  await loadBoot();
}

function summarize(patch, prefix = '', out = []) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (key.startsWith('__')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) summarize(value, path, out);
    else {
      const text = /secret/iu.test(path) ? '已更新（隐藏）'
        : (Array.isArray(value) ? value.join('、') : String(value));
      out.push(`${path}：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
    }
    if (out.length >= 10) break;
  }
  return out.join('\n');
}

function sectionPatch(sections) {
  const patch = {};
  for (const key of sections) {
    const d = diff(state.boot.settings[key], state.draft[key]);
    if (d !== undefined) patch[key] = d;
  }
  return patch;
}

/* ---------------- 渲染 ---------------- */
function render() {
  renderTabs();
  const view = $('view');
  const map = {
    overview: renderOverview,
    moderation: renderModeration,
    join: renderJoin,
    announcements: renderAnnouncements,
    groups: renderGroups,
    blacklist: renderBlacklist,
    audit: renderAudit,
    changelog: renderChangelog,
    settings: renderSettings,
  };
  (map[state.tab] || renderOverview)(view);
}

function renderTabs() {
  $('tabs').innerHTML = TABS.map(([id, label]) => (
    `<button class="tab${state.tab === id ? ' active' : ''}" data-tab="${id}">${label}</button>`
  )).join('');
  for (const btn of $('tabs').querySelectorAll('.tab')) {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      render();
    });
  }
}

function renderOverview(el) {
  const b = state.boot;
  if (!b) return;
  const s = statusInfo(state.status);
  const panel = b.panel || {};
  const compat = b.compat || {};
  const d = state.device || b.device || {};
  const appId = b.settings.appId || state.status?.appIdMasked || '未配置';
  const cpuPct = Math.max(0, Math.min(100, Number(d.cpuUsage) || 0));
  const memPct = Math.max(0, Math.min(100, Number(d.memUsage) || 0));
  const cpuSpeed = d.cpuSpeedMhz ? (Number(d.cpuSpeedMhz) / 1000).toFixed(2) : '-';
  const napcat = d.napcatVersion || '未接入';
  el.innerHTML = `
    <div class="device-card">
      <div class="device-id">
        <div class="avatar">QQ</div>
        <div style="min-width:0;flex:1">
          <div class="device-bot-name">QQ 机器人 <span class="device-dot ${esc(s.cls)}"></span></div>
          <div class="device-account mono">${esc(appId)}</div>
        </div>
        <span class="pill ${s.cls === 'ok' ? 'ok' : s.cls === 'bad' ? 'bad' : ''}">${esc(s.text)}</span>
      </div>
      <div class="device-sys">
        <h4>系统信息</h4>
        <dl class="device-kv">
          <dt>插件版本</dt><dd>v${esc(b.version)}</dd>
          <dt>WebUI 版本</dt><dd>v${esc(d.webuiVersion || b.version)}</dd>
          <dt>NapCat 版本</dt><dd>${esc(napcat)}</dd>
          <dt>系统版本</dt><dd>${esc(d.systemVersion || '-')}</dd>
        </dl>
        <p class="hint" style="margin-top:10px">使用 QQ 官方 Bot API，不依赖 NapCat / QQ 客户端。</p>
      </div>
      <div class="device-metrics">
        <div class="metric-row">
          <div class="metric-info">
            <h4>CPU</h4>
            <dl class="device-kv">
              <dt>型号</dt><dd>${esc(d.cpuModel || '未知')}</dd>
              <dt>内核数</dt><dd>${Number(d.cpuCores) || 0} 核 · ${esc(cpuSpeed)} GHz</dd>
              <dt>运行时长</dt><dd>${fmtDuration(d.processUptimeMs)}</dd>
            </dl>
          </div>
          <div class="gauge" style="--p:${cpuPct};--ring:var(--accent)">
            <div class="gauge-inner"><b>${Math.round(cpuPct)}%</b><span>CPU 占用</span></div>
          </div>
        </div>
        <div class="metric-row">
          <div class="metric-info">
            <h4>内存</h4>
            <dl class="device-kv">
              <dt>总量</dt><dd>${fmtBytes(d.memTotal)}</dd>
              <dt>使用量</dt><dd>${fmtBytes(d.memUsed)}</dd>
              <dt>本进程</dt><dd>${fmtBytes(d.processRss)}</dd>
            </dl>
          </div>
          <div class="gauge" style="--p:${memPct};--ring:#e05a7a">
            <div class="gauge-inner"><b>${Math.round(memPct)}%</b><span>内存占用</span></div>
          </div>
        </div>
        <div class="device-foot">Node ${esc(d.nodeVersion || '-')} · ${esc(d.hostName || '-')} · 系统运行 ${fmtDuration(d.systemUptimeMs)}</div>
      </div>
    </div>
    <div class="grid cols-4" style="margin-top:14px">
      <div class="stat"><b>${b.counts.groupCount}</b><span>已登记群</span></div>
      <div class="stat"><b>${b.counts.memberCount}</b><span>成员台账</span></div>
      <div class="stat"><b>${b.counts.pendingCount}</b><span>待审批</span></div>
      <div class="stat"><b>${b.counts.counters.blocked || 0}</b><span>今日拦截</span></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>机器人状态 <span class="sub">${esc(b.version)}</span></h3>
        <dl class="kv">
          <dt>连接</dt><dd><span class="pill ${s.cls === 'ok' ? 'ok' : s.cls === 'bad' ? 'bad' : ''}">${esc(s.text)}</span></dd>
          <dt>AppID</dt><dd class="mono">${esc(b.settings.appId || '未配置')}</dd>
          <dt>数据目录</dt><dd class="mono">${esc(b.dataDir)}</dd>
          <dt>兼容性</dt><dd>${compat.requiredFailed?.length ? '存在必检失败' : '通过'}（Node ${esc(compat.node || '-')}）</dd>
        </dl>
      </div>
      <div class="card">
        <h3>局域网面板</h3>
        <dl class="kv">
          <dt>状态</dt><dd>${panel.running ? '运行中' : '未启动'}</dd>
          <dt>监听</dt><dd class="mono">${esc(panel.host || '-')}:${esc(panel.port || '-')}</dd>
          <dt>访问地址</dt><dd class="mono">${(panel.urls || []).map(esc).join('<br>') || '-'}</dd>
        </dl>
        <p class="hint" style="margin-top:10px">同一局域网内的手机、平板、电脑都可以打开上面的地址。</p>
        ${panel.lastError ? `<p class="hint" style="color:var(--bad)">启动失败：${esc(panel.lastError)}</p>` : ''}
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>最近审计</h3>
        ${(b.audit || []).slice(0, 8).map((x) => `
          <div class="item"><div class="main"><div class="title">${esc(x.action)} · ${esc(x.groupName || x.groupId || '系统')}</div>
          <div class="meta">${esc(fmtTime(x.at))} · ${esc(x.detail || '')}</div></div>
          <span class="pill ${x.ok ? 'ok' : 'bad'}">${x.ok ? '成功' : '失败'}</span></div>
        `).join('') || '<div class="empty">暂无记录</div>'}
      </div>
      <div class="card">
        <h3>今日统计</h3>
        <dl class="kv">
          <dt>警告</dt><dd>${b.counts.counters.warns || 0}</dd>
          <dt>禁言</dt><dd>${b.counts.counters.mutes || 0}</dd>
          <dt>移出</dt><dd>${b.counts.counters.kicks || 0}</dd>
          <dt>审批通过 / 拒绝</dt><dd>${b.counts.counters.approvals || 0} / ${b.counts.counters.declines || 0}</dd>
          <dt>欢迎</dt><dd>${b.counts.counters.welcomes || 0}</dd>
        </dl>
      </div>
    </div>`;
}

function disabledAttr(condition) { return condition ? 'disabled' : ''; }

function renderModeration(el) {
  const m = state.draft.moderation;
  const ro = false;
  el.innerHTML = `
    <div class="card">
      <h3>违规防护 <span class="sub">${admin() ? '修改后通知所有群' : '普通管理员修改需三次确认'}</span></h3>
      <div class="row">
        <label class="check"><input id="m-enabled" type="checkbox" ${m.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用防护</label>
        <label class="check"><input id="m-fuzzy" type="checkbox" ${m.fuzzy.enabled ? 'checked' : ''} ${disabledAttr(ro)}>模糊变体匹配</label>
        <label class="check"><input id="m-img" type="checkbox" ${m.media.detectImages ? 'checked' : ''} ${disabledAttr(ro)}>检测图片广告</label>
        <label class="check"><input id="m-card" type="checkbox" ${m.media.detectCards ? 'checked' : ''} ${disabledAttr(ro)}>检测卡片/名片</label>
      </div>
      <div class="grid cols-3">
        <label class="field"><span>命中动作</span>
          <select id="m-action" ${disabledAttr(ro)}>
            ${['warn', 'mute', 'kick'].map((x) => `<option value="${x}" ${m.action === x ? 'selected' : ''}>${({ warn: '警告', mute: '禁言', kick: '移出' })[x]}</option>`).join('')}
          </select></label>
        <label class="field"><span>禁言时长（秒）</span><input id="m-mute" type="number" min="0" value="${m.muteSeconds}" ${disabledAttr(ro)}></label>
        <label class="field"><span>同一用户冷却（秒）</span><input id="m-cool" type="number" min="0" value="${m.cooldownSec}" ${disabledAttr(ro)}></label>
      </div>
      <label class="field"><span>违规词（每行一个）</span><textarea id="m-words" ${disabledAttr(false)}>${esc(lines(m.keywords))}</textarea></label>
      <label class="field"><span>正则规则（每行一个，仅最高管理员可改）</span><textarea id="m-regex" ${disabledAttr(!admin())}>${esc(lines(m.regexes))}</textarea></label>
      <label class="field"><span>额外模糊别名（每行一个，格式：别名=标准词）</span><textarea id="m-extras" ${disabledAttr(false)}>${esc(lines(m.fuzzy.extras))}</textarea></label>
      <label class="field"><span>图片广告关键词（每行一个）</span><textarea id="m-adwords" ${disabledAttr(ro)}>${esc(lines(m.media.adKeywords))}</textarea></label>
    </div>

    <div class="card">
      <h3>刷屏与升级</h3>
      <div class="grid cols-4">
        <label class="check"><input id="m-spam" type="checkbox" ${m.spam.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用刷屏检测</label>
        <label class="field"><span>窗口（秒）</span><input id="m-spam-win" type="number" value="${m.spam.windowSec}" ${disabledAttr(ro)}></label>
        <label class="field"><span>窗口内条数</span><input id="m-spam-max" type="number" value="${m.spam.maxMessages}" ${disabledAttr(ro)}></label>
        <label class="check"><input id="m-esc" type="checkbox" ${m.escalation.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用违规升级</label>
        <label class="field"><span>第几次升级</span><input id="m-esc-n" type="number" value="${m.escalation.violations}" ${disabledAttr(ro)}></label>
        <label class="field"><span>统计窗口（小时）</span><input id="m-esc-h" type="number" value="${m.escalation.windowHours}" ${disabledAttr(ro)}></label>
        <label class="field"><span>升级动作</span>
          <select id="m-esc-a" ${disabledAttr(ro)}>
            ${['warn', 'mute', 'kick'].map((x) => `<option value="${x}" ${m.escalation.action === x ? 'selected' : ''}>${({ warn: '警告', mute: '禁言', kick: '移出' })[x]}</option>`).join('')}
          </select></label>
      </div>
    </div>

    <div class="card">
      <h3>链接与黑名单</h3>
      <label class="check"><input id="m-links" type="checkbox" ${m.detectLinks ? 'checked' : ''} ${disabledAttr(ro)}>检测可疑链接</label>
      <label class="field"><span>链接白名单（每行一个域名）</span><textarea id="m-linkwhite" ${disabledAttr(ro)}>${esc(lines(m.linkWhitelist))}</textarea></label>
      <div class="grid cols-4">
        <label class="check"><input id="m-black" type="checkbox" ${m.blacklist.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用累计黑名单</label>
        <label class="field"><span>第几次违规触发</span><input id="m-black-n" type="number" value="${m.blacklist.threshold}" ${disabledAttr(ro)}></label>
        <label class="field"><span>统计窗口（天）</span><input id="m-black-d" type="number" value="${m.blacklist.windowDays}" ${disabledAttr(ro)}></label>
        <label class="check"><input id="m-black-api" type="checkbox" ${m.blacklist.addToGroupBlacklist ? 'checked' : ''} ${disabledAttr(ro)}>同时加入官方群黑名单</label>
      </div>
    </div>

    <div class="card">
      <h3>信任成员 <span class="sub">豁免处置，并允许使用群指令</span></h3>
      <div id="trusted-list" class="list">
        ${(m.trustedUsers || []).map((u) => `
          <div class="item"><div class="main"><div class="title">${esc(u.name || '未备注')}</div>
          <div class="meta mono">${esc(u.uid)} ${u.note ? '· ' + esc(u.note) : ''}</div></div>
          ${ro ? '' : `<button class="btn danger" data-del-trusted="${esc(u.uid)}">移除</button>`}</div>
        `).join('') || '<div class="empty">暂无信任成员</div>'}
      </div>
      ${ro ? '' : `<div class="row" style="margin-top:10px">
        <input id="trusted-uid" class="grow" placeholder="成员 openid（可在“群与成员”里复制）">
        <input id="trusted-name" placeholder="昵称（可选）">
        <button id="trusted-add" class="btn">添加</button>
      </div>`}
    </div>

    <div class="row" style="margin-top:14px">
      <button id="m-save" class="btn primary">保存违规防护设置</button>
      <span class="hint">普通管理员修改机器人设置需三次确认。</span>
    </div>`;

  if (!ro) {
    for (const btn of el.querySelectorAll('[data-del-trusted]')) {
      btn.addEventListener('click', () => {
        state.draft.moderation.trustedUsers = state.draft.moderation.trustedUsers.filter((x) => x.uid !== btn.dataset.delTrusted);
        render();
      });
    }
    $('trusted-add').addEventListener('click', () => {
      const uid = $('trusted-uid').value.trim();
      if (!uid) return toast('请填写 openid', true);
      state.draft.moderation.trustedUsers.push({ uid, name: $('trusted-name').value.trim(), note: '' });
      render();
    });
  }

  $('m-save').addEventListener('click', () => {
    m.keywords = parseLines($('m-words').value);
    m.fuzzy.extras = parseLines($('m-extras').value);
    if (admin()) m.regexes = parseLines($('m-regex').value);
    m.enabled = $('m-enabled').checked;
    m.fuzzy.enabled = $('m-fuzzy').checked;
    m.media.detectImages = $('m-img').checked;
    m.media.detectCards = $('m-card').checked;
    m.action = $('m-action').value;
    m.muteSeconds = Number($('m-mute').value);
    m.cooldownSec = Number($('m-cool').value);
    m.media.adKeywords = parseLines($('m-adwords').value);
    m.spam.enabled = $('m-spam').checked;
    m.spam.windowSec = Number($('m-spam-win').value);
    m.spam.maxMessages = Number($('m-spam-max').value);
    m.escalation.enabled = $('m-esc').checked;
    m.escalation.violations = Number($('m-esc-n').value);
    m.escalation.windowHours = Number($('m-esc-h').value);
    m.escalation.action = $('m-esc-a').value;
    m.detectLinks = $('m-links').checked;
    m.linkWhitelist = parseLines($('m-linkwhite').value);
    m.blacklist.enabled = $('m-black').checked;
    m.blacklist.threshold = Number($('m-black-n').value);
    m.blacklist.windowDays = Number($('m-black-d').value);
    m.blacklist.addToGroupBlacklist = $('m-black-api').checked;
    savePatch(sectionPatch(['moderation']));
  });
}

function renderJoin(el) {
  const j = state.draft.join;
  const ro = false;
  el.innerHTML = `
    <div class="card">
      <h3>入群审批 <span class="sub">${admin() ? '' : '普通管理员修改需三次确认'}</span></h3>
      <div class="row">
        <label class="check"><input id="j-auto" type="checkbox" ${j.autoApprove ? 'checked' : ''} ${disabledAttr(ro)}>关键词匹配自动通过</label>
        <label class="check"><input id="j-risk" type="checkbox" ${j.autoDeclineRisk ? 'checked' : ''} ${disabledAttr(ro)}>风险账号自动拒绝</label>
      </div>
      <div class="grid cols-2">
        <label class="field"><span>通过关键词（每行一个）</span><textarea id="j-ok-key" ${disabledAttr(ro)}>${esc(lines(j.approveKeywords))}</textarea></label>
        <label class="field"><span>拒绝关键词（每行一个）</span><textarea id="j-no-key" ${disabledAttr(ro)}>${esc(lines(j.declineKeywords))}</textarea></label>
      </div>
      <label class="field"><span>拒绝理由</span><input id="j-reason" value="${esc(j.rejectReason)}" ${disabledAttr(ro)}></label>
    </div>

    <div class="card">
      <h3>入群欢迎 <span class="sub">普通管理员可以直接修改</span></h3>
      <label class="check"><input id="j-welcome" type="checkbox" ${j.welcome.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用欢迎语</label>
      <label class="field"><span>欢迎模板（支持 {user} {name} {group}）</span><textarea id="j-template">${esc(j.welcome.template)}</textarea></label>
      <label class="field"><span>欢迎语变体（每行一条，随机挑选；留空则只用模板）</span><textarea id="j-variants">${esc(lines(j.welcome.variants))}</textarea></label>
    </div>

    <div class="card">
      <h3>新成员观察期 <span class="sub">默认 10 分钟，可按群覆盖</span></h3>
      <div class="row">
        <label class="check"><input id="j-obs" type="checkbox" ${j.observation.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用观察期</label>
        <label class="check"><input id="j-obs-link" type="checkbox" ${j.observation.blockLinks ? 'checked' : ''} ${disabledAttr(ro)}>观察期禁止链接</label>
        <label class="check"><input id="j-obs-img" type="checkbox" ${j.observation.blockImages ? 'checked' : ''} ${disabledAttr(ro)}>观察期禁止图片</label>
      </div>
      <div class="grid cols-3">
        <label class="field"><span>观察时长（分钟，0=不限制）</span><input id="j-obs-min" type="number" min="0" max="1440" value="${j.observation.minutes}" ${disabledAttr(ro)}></label>
        <label class="field"><span>观察期动作</span>
          <select id="j-obs-action" ${disabledAttr(ro)}>
            ${['warn', 'mute', 'kick'].map((x) => `<option value="${x}" ${j.observation.action === x ? 'selected' : ''}>${({ warn: '警告', mute: '禁言', kick: '移出' })[x]}</option>`).join('')}
          </select></label>
      </div>
    </div>

    <div class="card">
      <h3>入群答题 <span class="sub">入群后在群里提问，答对才算完成验证</span></h3>
      <div class="row">
        <label class="check"><input id="j-quiz" type="checkbox" ${j.quiz.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用入群答题</label>
        <label class="check"><input id="j-quiz-before" type="checkbox" ${j.quiz.askBeforeWelcome ? 'checked' : ''} ${disabledAttr(ro)}>答题通过后再发欢迎语</label>
      </div>
      <div class="grid cols-4">
        <label class="field"><span>超时（秒）</span><input id="j-quiz-timeout" type="number" value="${j.quiz.timeoutSec}" ${disabledAttr(ro)}></label>
        <label class="field"><span>最多答错次数</span><input id="j-quiz-max" type="number" value="${j.quiz.maxAttempts}" ${disabledAttr(ro)}></label>
        <label class="field"><span>失败动作</span>
          <select id="j-quiz-action" ${disabledAttr(ro)}>
            ${['warn', 'mute', 'kick'].map((x) => `<option value="${x}" ${j.quiz.action === x ? 'selected' : ''}>${({ warn: '警告', mute: '禁言', kick: '移出' })[x]}</option>`).join('')}
          </select></label>
      </div>
      <label class="field"><span>题目（每行一条，格式：问题 | 答案；答案可用 / 分隔多个）</span>
        <textarea id="j-quiz-q" ${disabledAttr(ro)}>${esc((j.quiz.questions || []).map((x) => `${x.q} | ${x.a}`).join('\n'))}</textarea></label>
    </div>

    <div class="row" style="margin-top:14px">
      <button id="j-save" class="btn primary">保存入群设置</button>
      <span class="hint">普通管理员修改机器人设置需三次确认。</span>
    </div>`;

  $('j-save').addEventListener('click', () => {
    j.welcome.template = $('j-template').value;
    j.welcome.variants = parseLines($('j-variants').value);
    j.autoApprove = $('j-auto').checked;
    j.autoDeclineRisk = $('j-risk').checked;
    j.approveKeywords = parseLines($('j-ok-key').value);
    j.declineKeywords = parseLines($('j-no-key').value);
    j.rejectReason = $('j-reason').value;
    j.welcome.enabled = $('j-welcome').checked;
    j.observation.enabled = $('j-obs').checked;
    j.observation.blockLinks = $('j-obs-link').checked;
    j.observation.blockImages = $('j-obs-img').checked;
    j.observation.minutes = Number($('j-obs-min').value);
    j.observation.action = $('j-obs-action').value;
    j.quiz.enabled = $('j-quiz').checked;
    j.quiz.askBeforeWelcome = $('j-quiz-before').checked;
    j.quiz.timeoutSec = Number($('j-quiz-timeout').value);
    j.quiz.maxAttempts = Number($('j-quiz-max').value);
    j.quiz.action = $('j-quiz-action').value;
    j.quiz.questions = String($('j-quiz-q').value || '').split(/\r?\n/u).map((line) => {
      const [q, a] = line.split('|').map((x) => (x || '').trim());
      return q && a ? { q, a } : null;
    }).filter(Boolean);
    savePatch(sectionPatch(['join']));
  });
}

function renderAnnouncements(el) {
  const groups = groupList();
  const items = state.boot.announcements || [];
  el.innerHTML = `
    <div class="card">
      <h3>新建公告 <span class="sub">以机器人消息发送，可选定时</span></h3>
      <label class="field"><span>标题（可选）</span><input id="a-title" placeholder="例如：本周活动安排"></label>
      <label class="field"><span>正文</span><textarea id="a-content" placeholder="公告内容"></textarea></label>
      <div class="grid cols-3">
        <label class="field"><span>定时发布时间（留空=草稿）</span><input id="a-time" type="datetime-local"></label>
      </div>
      <div class="field"><span>目标群</span>
        <div class="row" id="a-targets">
          ${groups.map((g) => `<label class="check"><input type="checkbox" value="${esc(g.gid)}">${esc(g.name || g.gid)}</label>`).join('') || '<span class="hint">还没有群</span>'}
        </div>
      </div>
      <button id="a-create" class="btn primary">保存公告</button>
    </div>
    <div class="card">
      <h3>公告列表</h3>
      <div class="list">
        ${items.map((x) => `
          <div class="item">
            <div class="main">
              <div class="title">${esc(x.title || '（无标题）')} <span class="pill ${x.status === 'done' ? 'ok' : x.status === 'failed' ? 'bad' : ''}">${esc(statusLabel(x.status))}</span></div>
              <div class="meta">${esc(x.content).slice(0, 160)}</div>
              <div class="meta">目标 ${x.targets.length} 个群 · 更新 ${esc(fmtTime(x.updatedAt))}${x.publishAt ? ' · 定时 ' + esc(fmtTime(x.publishAt)) : ''}</div>
            </div>
            <div class="row">
              <button class="btn" data-publish="${esc(x.id)}">立即发布</button>
              <button class="btn" data-pause="${esc(x.id)}">转草稿</button>
              <button class="btn danger" data-delete="${esc(x.id)}">删除</button>
            </div>
          </div>`).join('') || '<div class="empty">还没有公告</div>'}
      </div>
    </div>`;

  $('a-create').addEventListener('click', async () => {
    const targets = [...$('a-targets').querySelectorAll('input:checked')].map((x) => x.value);
    const input = {
      title: $('a-title').value,
      content: $('a-content').value,
      targets,
      publishAt: $('a-time').value ? new Date($('a-time').value).toISOString() : '',
    };
    const r = await req('/announcements', { method: 'POST', body: { action: 'create', input } });
    if (!r.ok) return toast(r.error?.message || '创建失败', true);
    toast('公告已保存');
    await loadBoot();
  });
  for (const btn of el.querySelectorAll('[data-publish]')) {
    btn.addEventListener('click', async () => {
      if (!await modal('发布公告', '将立即向目标群发送这条公告，确认继续？', '立即发送')) return;
      const r = await req('/announcements', { method: 'POST', body: { action: 'publish', id: btn.dataset.publish } });
      toast(r.ok ? `已发送 ${r.data.sent}/${r.data.total} 个群` : (r.error?.message || '发布失败'), !r.ok);
      await loadBoot();
    });
  }
  for (const btn of el.querySelectorAll('[data-pause]')) {
    btn.addEventListener('click', async () => {
      const r = await req('/announcements', { method: 'POST', body: { action: 'pause', id: btn.dataset.pause } });
      toast(r.ok ? '已转为草稿' : (r.error?.message || '操作失败'), !r.ok);
      await loadBoot();
    });
  }
  for (const btn of el.querySelectorAll('[data-delete]')) {
    btn.addEventListener('click', async () => {
      if (!await modal('删除公告', '删除后不可恢复，确认继续？', '删除')) return;
      const r = await req('/announcements', { method: 'POST', body: { action: 'delete', id: btn.dataset.delete } });
      toast(r.ok ? '已删除' : (r.error?.message || '删除失败'), !r.ok);
      await loadBoot();
    });
  }
}

function statusLabel(status) {
  return ({
    draft: '草稿', scheduled: '已定时', sending: '发送中', done: '已发送',
    failed: '发送失败', partial_failed: '部分失败',
  })[status] || status;
}

function groupList() {
  const groups = state.boot?.groups || {};
  return Object.entries(groups).map(([gid, g]) => ({ gid, name: g?.name || '' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function renderGroups(el) {
  const groups = groupList();
  const ro = !admin();
  if (!state.groupSel && groups.length) state.groupSel = groups[0].gid;
  const override = state.draft.groups?.[state.groupSel] || {};
  el.innerHTML = `
    <div class="card">
      <h3>群列表</h3>
      <div class="list">
        ${groups.map((g) => `
          <div class="item"><div class="main"><div class="title">${esc(g.name || '未命名群')}</div>
          <div class="meta mono">${esc(g.gid)}</div></div>
          ${ro ? '' : `<button class="btn danger" data-del-group="${esc(g.gid)}">移除登记</button>`}</div>
        `).join('') || '<div class="empty">还没有群，机器人被拉进群并收到消息后会自动登记</div>'}
      </div>
      ${ro ? '' : `<div class="row" style="margin-top:10px">
        <input id="g-gid" class="grow" placeholder="群 openid">
        <input id="g-name" placeholder="群名称（可选）">
        <button id="g-add" class="btn">登记群</button>
      </div>`}
    </div>

    <div class="card">
      <h3>按群覆盖设置 <span class="sub">留空 = 继承全局；普通管理员修改需三次确认</span></h3>
      <label class="field"><span>选择群</span>
        <select id="g-sel">
          ${groups.map((g) => `<option value="${esc(g.gid)}" ${state.groupSel === g.gid ? 'selected' : ''}>${esc(g.name || g.gid)}</option>`).join('')}
        </select></label>
      <div class="grid cols-3">
        <label class="field"><span>违规动作</span>
          <select id="og-action" ${disabledAttr(false)}>
            <option value="">继承</option>
            ${['warn', 'mute', 'kick'].map((x) => `<option value="${x}" ${override.moderation?.action === x ? 'selected' : ''}>${({ warn: '警告', mute: '禁言', kick: '移出' })[x]}</option>`).join('')}
          </select></label>
        <label class="field"><span>禁言秒数</span><input id="og-mute" type="number" min="0" value="${override.moderation?.muteSeconds ?? ''}" placeholder="继承" ${disabledAttr(false)}></label>
        <label class="field"><span>观察期分钟</span><input id="og-obs" type="number" min="0" value="${override.join?.observation?.minutes ?? ''}" placeholder="继承" ${disabledAttr(false)}></label>
      </div>
      <div class="grid cols-2">
        <label class="field"><span>覆盖违规词（每行一个，留空继承）</span><textarea id="og-words">${esc(lines(override.moderation?.keywords || []))}</textarea></label>
        <label class="field"><span>覆盖欢迎语变体（每行一条，留空继承）</span><textarea id="og-welcome">${esc(lines(override.join?.welcome?.variants || []))}</textarea></label>
      </div>
      <label class="check"><input id="og-reset" type="checkbox">清除该群所有覆盖，恢复继承</label>
      <div class="row" style="margin-top:10px"><button id="og-save" class="btn primary">保存该群设置</button></div>
    </div>

    <div class="card">
      <h3>成员查询与操作</h3>
      <div class="row">
        <select id="mem-gid" class="grow">${groups.map((g) => `<option value="${esc(g.gid)}">${esc(g.name || g.gid)}</option>`).join('')}</select>
        <input id="mem-q" class="grow" placeholder="按昵称/openid 搜索" value="${esc(state.memberQuery)}">
        <button id="mem-search" class="btn">搜索</button>
      </div>
      <div id="mem-list" class="list" style="margin-top:10px"><div class="empty">输入关键词后搜索</div></div>
    </div>`;

  if (!ro) {
    $('g-add').addEventListener('click', async () => {
      const gid = $('g-gid').value.trim();
      if (!gid) return toast('请填写群 openid', true);
      const r = await req('/groups', { method: 'POST', body: { action: 'add', gid, name: $('g-name').value.trim() } });
      toast(r.ok ? '已登记' : (r.error?.message || '登记失败'), !r.ok);
      await loadBoot();
    });
    for (const btn of el.querySelectorAll('[data-del-group]')) {
      btn.addEventListener('click', async () => {
        if (!await modal('移除登记', '只从面板移除，不会让机器人退群。确认继续？', '移除')) return;
        const r = await req('/groups', { method: 'POST', body: { action: 'remove', gid: btn.dataset.delGroup } });
        toast(r.ok ? '已移除' : (r.error?.message || '操作失败'), !r.ok);
        await loadBoot();
      });
    }
  }

  $('g-sel').addEventListener('change', () => { state.groupSel = $('g-sel').value; render(); });
  $('og-save').addEventListener('click', () => {
    const gid = state.groupSel;
    if (!gid) return;
    if ($('og-reset').checked) return savePatch({ groups: { [gid]: null } });
    const mod = {};
    const join = {};
    if ($('og-action').value) mod.action = $('og-action').value;
    if ($('og-mute').value !== '') mod.muteSeconds = Number($('og-mute').value);
    const words = parseLines($('og-words').value);
    if (words.length) mod.keywords = words;
    if ($('og-obs').value !== '') join.observation = { minutes: Number($('og-obs').value) };
    const welcome = parseLines($('og-welcome').value);
    if (welcome.length) join.welcome = { variants: welcome };
    const patch = { groups: { [gid]: {} } };
    if (Object.keys(mod).length) patch.groups[gid].moderation = mod;
    if (Object.keys(join).length) patch.groups[gid].join = join;
    if (admin()) patch.groups[gid].__replace = true;
    savePatch(patch);
  });

  const search = async () => {
    const gid = $('mem-gid').value;
    state.memberQuery = $('mem-q').value;
    const r = await req(`/members?gid=${encodeURIComponent(gid)}&q=${encodeURIComponent(state.memberQuery)}`);
    if (!r.ok) return toast(r.error?.message || '查询失败', true);
    const list = $('mem-list');
    if (!list) return;
    list.innerHTML = r.data.members.map((m) => `
      <div class="item"><div class="main"><div class="title">${esc(m.name || '未备注')}</div>
      <div class="meta mono">${esc(m.uid)} · 发言 ${m.messageCount || 0} 次</div></div>
      <div class="row">
        <button class="btn" data-mute="${esc(m.uid)}">禁言</button>
        <button class="btn" data-unmute="${esc(m.uid)}">解禁</button>
        <button class="btn danger" data-kick="${esc(m.uid)}">移出</button>
      </div></div>`).join('') || '<div class="empty">没有匹配成员</div>';
    for (const btn of list.querySelectorAll('[data-mute]')) btn.addEventListener('click', () => memberAction(gid, btn.dataset.mute, 'mute'));
    for (const btn of list.querySelectorAll('[data-unmute]')) btn.addEventListener('click', () => memberAction(gid, btn.dataset.unmute, 'unmute'));
    for (const btn of list.querySelectorAll('[data-kick]')) btn.addEventListener('click', () => memberAction(gid, btn.dataset.kick, 'kick'));
  };
  $('mem-search').addEventListener('click', search);
  $('mem-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
}

async function memberAction(gid, uid, action) {
  if (!admin()) return toast('需要最高管理员权限', true);
  if (action === 'kick' && !await modal('移出成员', '将把该成员移出群聊，确认继续？', '移出')) return;
  const r = await req('/members/action', { method: 'POST', body: { action, gid, uid } });
  toast(r.ok ? '操作已完成' : (r.error?.message || '操作失败'), !r.ok);
}

function renderBlacklist(el) {
  const items = state.boot.blacklist || [];
  const groups = groupList();
  el.innerHTML = `
    <div class="card">
      <h3>黑名单 <span class="sub">被拒/累计违规的成员再次申请会自动拒绝</span></h3>
      <div class="list">
        ${items.map((x) => `
          <div class="item"><div class="main"><div class="title">${esc(x.name || x.uid)}</div>
          <div class="meta mono">${esc(x.gid)} · ${esc(x.uid)}</div>
          <div class="meta">${esc(x.reason || '未填写原因')} · ${esc(fmtTime(x.at))} · ${esc(x.by)}</div></div>
          <button class="btn danger" data-unban="${esc(x.gid)}|${esc(x.uid)}">移出</button></div>
        `).join('') || '<div class="empty">黑名单为空</div>'}
      </div>
    </div>
    <div class="card">
      <h3>手动加入黑名单</h3>
      <div class="grid cols-3">
        <label class="field"><span>群</span><select id="b-gid">${groups.map((g) => `<option value="${esc(g.gid)}">${esc(g.name || g.gid)}</option>`).join('')}</select></label>
        <label class="field"><span>成员 openid</span><input id="b-uid"></label>
        <label class="field"><span>昵称（可选）</span><input id="b-name"></label>
      </div>
      <label class="field"><span>原因</span><input id="b-reason" placeholder="例如：多次发广告"></label>
      <button id="b-add" class="btn primary">加入黑名单</button>
    </div>`;

  $('b-add').addEventListener('click', async () => {
    const r = await req('/blacklist', {
      method: 'POST',
      body: { action: 'add', gid: $('b-gid').value, uid: $('b-uid').value.trim(), name: $('b-name').value.trim(), reason: $('b-reason').value.trim() },
    });
    toast(r.ok ? '已加入黑名单' : (r.error?.message || '操作失败'), !r.ok);
    await loadBoot();
  });
  for (const btn of el.querySelectorAll('[data-unban]')) {
    btn.addEventListener('click', async () => {
      const [gid, uid] = btn.dataset.unban.split('|');
      const r = await req('/blacklist', { method: 'POST', body: { action: 'remove', gid, uid } });
      toast(r.ok ? '已移出黑名单' : (r.error?.message || '操作失败'), !r.ok);
      await loadBoot();
    });
  }
}

function renderAudit(el) {
  el.innerHTML = `
    <div class="card">
      <h3>审计日志</h3>
      <div class="row">
        <select id="au-kind"><option value="">全部类型</option>${['moderation', 'join', 'announce', 'command', 'config'].map((x) => `<option value="${x}">${x}</option>`).join('')}</select>
        <input id="au-gid" placeholder="群 openid" class="grow">
        <input id="au-uid" placeholder="成员 openid" class="grow">
        <button id="au-search" class="btn">查询</button>
        <button id="au-csv" class="btn">导出 CSV</button>
      </div>
      <div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>时间</th><th>类型</th><th>群</th><th>成员</th><th>动作</th><th>详情</th><th>结果</th></tr></thead>
        <tbody id="au-body"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  const load = async () => {
    const r = await req(`/audit?kind=${encodeURIComponent($('au-kind').value)}&groupId=${encodeURIComponent($('au-gid').value)}&userId=${encodeURIComponent($('au-uid').value)}&limit=300`);
    if (!r.ok) return toast(r.error?.message || '查询失败', true);
    state.audit = r.data.items;
    $('au-body').innerHTML = state.audit.map((x) => `
      <tr><td>${esc(fmtTime(x.at))}</td><td>${esc(x.kind)}</td><td class="mono">${esc(x.groupName || x.groupId || '-')}</td>
      <td class="mono">${esc(x.userName || x.userId || '-')}</td><td>${esc(x.action)}</td>
      <td>${esc(x.detail || '')}</td><td><span class="pill ${x.ok ? 'ok' : 'bad'}">${x.ok ? '成功' : '失败'}</span></td></tr>
    `).join('') || '<tr><td colspan="7" class="empty">没有记录</td></tr>';
  };
  $('au-search').addEventListener('click', load);
  $('au-csv').addEventListener('click', () => {
    const head = '时间,类型,群,成员,动作,详情,结果\n';
    const body = state.audit.map((x) => [x.at, x.kind, x.groupName || x.groupId, x.userName || x.userId, x.action, x.detail, x.ok ? '成功' : '失败']
      .map((v) => `"${String(v == null ? '' : v).replace(/"/gu, '""')}"`).join(',')).join('\n');
    download('qqbot-guard-audit.csv', head + body);
  });
  void load();
}

const CHANGE_ACTION_LABEL = Object.freeze({
  update: '保存设置',
  password: '修改密码',
  import: '导入配置',
});

function renderChangelog(el) {
  el.innerHTML = `
    <div class="card">
      <h3>修改日志 <span class="sub">设置保存 / 密码修改 / 配置导入</span></h3>
      <div class="row">
        <input id="cl-keyword" placeholder="搜索操作者、来源 IP 或变更内容" class="grow">
        <button id="cl-search" class="btn">查询</button>
        <button id="cl-csv" class="btn">导出 CSV</button>
      </div>
      <p class="hint">按时间倒序显示最近的修改记录，包含操作者、来源 IP 与变更摘要。</p>
      <div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>时间</th><th>操作者</th><th>来源 IP</th><th>操作</th><th>变更内容</th><th>结果</th></tr></thead>
        <tbody id="cl-body"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
  const load = async () => {
    const r = await req(`/changelog?keyword=${encodeURIComponent($('cl-keyword').value)}`);
    if (!r.ok) return toast(r.error?.message || '查询失败', true);
    state.changelog = r.data.items;
    $('cl-body').innerHTML = state.changelog.map((x) => `
      <tr><td>${esc(fmtTime(x.at))}</td><td>${esc(x.userName || '-')}</td>
      <td class="mono">${esc(x.userId || '-')}</td>
      <td>${esc(CHANGE_ACTION_LABEL[x.action] || x.action)}</td>
      <td>${esc(x.detail || '')}</td>
      <td><span class="pill ${x.ok ? 'ok' : 'bad'}">${x.ok ? '成功' : '失败'}</span></td></tr>
    `).join('') || '<tr><td colspan="6" class="empty">暂无修改记录</td></tr>';
  };
  $('cl-search').addEventListener('click', load);
  $('cl-keyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void load();
  });
  $('cl-csv').addEventListener('click', () => {
    const head = '时间,操作者,来源IP,操作,变更内容,结果\n';
    const body = state.changelog.map((x) => [x.at, x.userName, x.userId, CHANGE_ACTION_LABEL[x.action] || x.action, x.detail, x.ok ? '成功' : '失败']
      .map((v) => `"${String(v == null ? '' : v).replace(/"/gu, '""')}"`).join(',')).join('\n');
    download('qqbot-guard-changelog.csv', head + body);
  });
  void load();
}

function renderSettings(el) {
  const s = state.draft;
  const ro = false;
  const panel = state.boot.panel || {};
  const sec = state.security || {};
  const compat = state.boot.compat || {};
  const net = state.net;
  const pwdRule = sec.passwordMin
    ? `新密码至少 ${sec.passwordMin} 位，必须同时包含字母和数字，且不能与另一个角色的密码相同。`
    : '新密码必须同时包含字母和数字，且不能与另一个角色的密码相同。';
  el.innerHTML = `
    <div class="card">
      <h3>机器人凭据 <span class="sub">普通管理员修改需三次确认</span></h3>
      <div class="grid cols-2">
        <label class="field"><span>AppID</span><input id="s-appid" value="${esc(s.appId)}" ${disabledAttr(ro)}></label>
        <label class="field"><span>AppSecret（留空保持不变）</span><input id="s-secret" type="password" placeholder="${s.appSecret ? '已设置，留空不变' : '未设置'}" ${disabledAttr(ro)}></label>
      </div>
      <div class="row">
        <label class="check"><input id="s-auto" type="checkbox" ${s.autoConnect ? 'checked' : ''} ${disabledAttr(ro)}>启动时自动连接</label>
        <label class="check"><input id="s-watch" type="checkbox" ${s.watchJoinRequests ? 'checked' : ''} ${disabledAttr(ro)}>自动轮询入群申请</label>
      </div>
    </div>

    <div class="card">
      <h3>变更通知对象 <span class="sub">仅普通管理员修改时 @</span></h3>
      <div class="grid cols-2">
        <label class="field"><span>通知对象昵称（必填）</span><input id="s-notify-name" value="${esc(s.panel.notifyName)}" placeholder="例如：群主昵称" ${disabledAttr(ro)}></label>
        <label class="field"><span>对应 QQ 号 / openid（必填）</span><input id="s-notify-uid" value="${esc(s.panel.notifyOpenid)}" placeholder="与昵称必须属于同一位成员" ${disabledAttr(ro)}></label>
      </div>
      <div class="row" style="margin-top:2px">
        <button id="s-notify-check" class="btn">验证通知对象</button>
        <span id="s-notify-result" class="hint"></span>
      </div>
      <p class="hint">昵称和 QQ 号（openid）必须同时匹配同一位成员才会 @ 他；任一不匹配就只发日志、不 @。@ 仅在普通管理员修改机器人级设置时生效。</p>
    </div>

    <div class="card">
      <h3>局域网面板</h3>
      <div class="grid cols-3">
        <label class="check"><input id="s-panel" type="checkbox" ${s.panel.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用面板</label>
        <label class="field"><span>监听地址</span><input id="s-host" value="${esc(s.panel.host)}" ${disabledAttr(ro)}></label>
        <label class="field"><span>端口</span><input id="s-port" type="number" value="${s.panel.port}" ${disabledAttr(ro)}></label>
      </div>
      <p class="hint">当前地址：${(panel.urls || []).map(esc).join(' · ') || '未启动'}。修改监听地址或端口后保存会自动重启面板。</p>
    </div>

    <div class="card">
      <h3>群内管理员指令</h3>
      <div class="row">
        <label class="check"><input id="s-cmd" type="checkbox" ${s.commands.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用指令</label>
        <label class="field"><span>前缀</span><input id="s-cmd-prefix" value="${esc(s.commands.prefix)}" style="width:80px" ${disabledAttr(ro)}></label>
      </div>
      <label class="field"><span>允许使用的成员 openid（每行一个；信任成员自动允许）</span><textarea id="s-cmd-users" ${disabledAttr(ro)}>${esc(lines(s.commands.allowUsers))}</textarea></label>
      <label class="field"><span>群规文本（/rule 返回）</span><textarea id="s-rule" ${disabledAttr(ro)}>${esc(s.commands.ruleText)}</textarea></label>
    </div>

    <div class="card">
      <h3>安全</h3>
      <dl class="kv">
        <dt>当前角色</dt><dd>${admin() ? '最高管理员（全部权限）' : '普通管理员（可改设置，机器人级修改需三次确认）'}</dd>
        <dt>面板密码</dt><dd>${state.security?.initialized ? '已设置，可在下方修改' : '尚未设置'}</dd>
      </dl>
      ${admin() ? `
      <div class="grid cols-3" style="margin-top:12px">
        <label class="field"><span>要修改的密码</span>
          <select id="pw-target"><option value="admin">最高管理员</option><option value="operator">普通管理员</option></select></label>
        <label class="field"><span>当前最高管理员密码</span><input id="pw-current" type="password"></label>
        <label class="field"><span>新密码</span><input id="pw-new" type="password"></label>
      </div>
      <button id="pw-save" class="btn">修改密码</button>
      <p class="hint">${pwdRule}</p>` : ''}
    </div>

    <div class="card">
      <h3>配置备份与恢复</h3>
      <div class="row">
        <button id="cfg-export" class="btn">导出配置 JSON</button>
        <label class="check"><input id="cfg-secrets" type="checkbox">包含 AppSecret</label>
        ${admin() ? '<button id="cfg-import" class="btn danger">导入配置</button>' : ''}
      </div>
      <p class="hint">导出的文件包含词表、按群配置、公告、黑名单；默认不含 AppSecret。</p>
    </div>

    <div class="card">
      <h3>兼容性自检</h3>
      <div class="hint">Node ${esc(compat.node || '-')} · ${esc(compat.platform || '-')}/${esc(compat.arch || '-')} · 内核/系统 ${esc(compat.release || '-')}</div>
      <div class="list" style="margin-top:10px">
        ${(compat.checks || []).map((c) => {
          const tone = c.ok ? 'ok' : (c.level === 'required' ? 'bad' : 'warn');
          const text = c.ok ? '通过' : (c.level === 'required' ? '不通过' : '注意');
          return `<div class="item"><div class="main"><div class="title"><span class="pill ${tone}">${text}</span> ${esc(c.label)}</div>
            <div class="meta">${esc(c.detail)}</div>${(!c.ok && c.hint) ? `<div class="meta" style="color:var(--warn)">${esc(c.hint)}</div>` : ''}</div></div>`;
        }).join('') || '<div class="empty">兼容性数据不可用</div>'}
      </div>
      <div class="row" style="margin-top:10px">
        <button id="compat-net" class="btn">网络连通性检测</button>
        ${net ? `<span class="pill ${net.ok ? 'ok' : 'bad'}">${net.ok ? 'QQ 接口可达' : '网络不可达'}</span>` : ''}
      </div>
      ${net && net.results ? `<div class="mono" style="margin-top:6px">${net.results.map((x) => esc(x.name + (x.ok ? ` 可达（HTTP ${x.status}）` : ` 失败：${x.error || ''}`))).join(' · ')}</div>` : ''}
    </div>

    <div class="card">
      <h3>运行信息</h3>
      <div class="mono">数据目录：${esc(state.boot.dataDir || '')}</div>
      <div class="mono">版本：${esc(state.boot.version || '')} · 无 AI 依赖</div>
    </div>

    <div class="row" style="margin-top:14px">
      <button id="s-save" class="btn primary">保存设置</button>
    </div>`;

  const verifyNotify = async (silent) => {
    const name = $('s-notify-name').value.trim();
    const uid = $('s-notify-uid').value.trim();
    const out = $('s-notify-result');
    if (!name || !uid) {
      out.textContent = '两项都填写后才能验证';
      out.style.color = 'var(--warn)';
      return null;
    }
    const r = await req('/notify/verify', { method: 'POST', body: { name, uid } });
    if (!r.ok) {
      out.textContent = r.error?.message || '验证失败';
      out.style.color = 'var(--warn)';
      return null;
    }
    const d = r.data || {};
    if (d.matched) {
      out.textContent = `已匹配：${d.nickname}（${d.source === 'api' ? '官方昵称校验' : '成员台账'}）`;
      out.style.color = 'var(--ok)';
    } else {
      out.textContent = d.reason || '未匹配';
      out.style.color = 'var(--bad)';
    }
    if (!silent) toast(d.matched ? '通知对象验证通过' : (d.reason || '通知对象未匹配'), !d.matched);
    return d;
  };
  $('s-notify-check').addEventListener('click', () => { void verifyNotify(false); });

  $('s-save').addEventListener('click', async () => {
    s.appId = $('s-appid').value.trim();
    const secret = $('s-secret').value;
    if (secret) s.appSecret = secret;
    s.autoConnect = $('s-auto').checked;
    s.watchJoinRequests = $('s-watch').checked;
    s.panel.enabled = $('s-panel').checked;
    s.panel.host = $('s-host').value.trim();
    s.panel.port = Number($('s-port').value);
    const notifyName = $('s-notify-name').value.trim();
    const notifyUid = $('s-notify-uid').value.trim();
    if ((notifyName && !notifyUid) || (!notifyName && notifyUid)) {
      return toast('通知对象的昵称和 QQ 号必须同时填写', true);
    }
    var pendingVerify = false;
    if (notifyName && notifyUid) {
      const verified = await verifyNotify(true);
      if (verified && verified.matched === false && verified.definite) {
        return toast(verified.reason || '通知对象昵称与 openid 不匹配，已阻止保存', true);
      }
      pendingVerify = !!(verified && verified.matched === false);
    }
    s.panel.notifyName = notifyName;
    s.panel.notifyOpenid = notifyUid;
    s.commands.enabled = $('s-cmd').checked;
    s.commands.prefix = $('s-cmd-prefix').value.trim() || '/';
    s.commands.allowUsers = parseLines($('s-cmd-users').value);
    s.commands.ruleText = $('s-rule').value;
    await savePatch(sectionPatch(['appId', 'appSecret', 'autoConnect', 'watchJoinRequests', 'panel', 'commands']));
    if (pendingVerify) toast('已保存；通知对象暂未校验（机器人未连接或无台账记录）', false);
  });

  if (admin()) {
    $('pw-save').addEventListener('click', async () => {
      const problem = pwdProblem($('pw-new').value);
      if (problem) return toast(problem, true);
      const r = await authReq('/api/qqg/password', {
        method: 'POST',
        body: { target: $('pw-target').value, currentPassword: $('pw-current').value, newPassword: $('pw-new').value },
      });
      if (!r.ok) return toast(r.error?.message || '修改失败', true);
      toast('密码已修改，请用新密码重新登录');
      showLogin();
    });
  }

  $('cfg-export').addEventListener('click', async () => {
    const secrets = $('cfg-secrets').checked ? '1' : '0';
    const r = await req('/config/export?secrets=' + secrets);
    if (!r.ok) return toast(r.error?.message || '导出失败', true);
    download('qqbot-guard-config.json', JSON.stringify(r.data, null, 2));
  });

  if (admin()) {
    $('cfg-import').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          return toast('文件不是合法 JSON', true);
        }
        for (let i = 1; i <= 3; i++) {
          const ok = await modal(`导入确认 ${i}/3`, '导入会覆盖当前设置、公告和黑名单，并重启机器人。请确认文件来源可信。', i === 3 ? '确认导入' : '继续');
          if (!ok) return;
        }
        const c = await req('/settings/challenge', { method: 'POST', body: {} });
        const c2 = await req('/settings/challenge', { method: 'POST', body: {} });
        const c3 = await req('/settings/challenge', { method: 'POST', body: {} });
        if (!c.ok || !c2.ok || !c3.ok) return toast('确认令牌获取失败', true);
        const r = await req('/config/import', { method: 'POST', body: { data, confirmToken: c3.data.token } });
        if (!r.ok) return toast(r.error?.message || '导入失败', true);
        toast('导入完成');
        await loadBoot();
      });
      input.click();
    });
  }

  $('compat-net').addEventListener('click', async () => {
    const r = await req('/compat?network=1');
    state.net = r.ok
      ? (r.data.network || null)
      : { ok: false, results: [{ name: '检测失败', ok: false, error: r.error?.message || '未知错误' }] };
    renderSettings(el);
  });
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  $('setup-form').addEventListener('submit', setup);
  $('login-form').addEventListener('submit', login);
  $('logout').addEventListener('click', logout);
  void checkSession();
});

