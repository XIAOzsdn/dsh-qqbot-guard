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

/** AI 厂商预设：选一个就自动填好接口地址与默认模型 */
const AI_PRESETS = [
  { id: 'dsh', label: 'DSH 当前会话模型', baseUrl: '', model: '' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'doubao', label: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115' },
  { id: 'qwen', label: '通义千问（阿里百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'xiaomi', label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro' },
  { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'lmstudio', label: '本地 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
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

/** 只按换行拆分：欢迎语/句子类内容允许包含逗号 */
function parseLinesOnly(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/u)) {
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
  // 首次部署：必须先选语言，之后才进入密码设置 / 登录
  const boot = await req('/bootstrap');
  if (boot?.ok && boot.data?.needsLanguage) {
    showLanguage();
    return;
  }
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

function showLanguage() {
  for (const id of ['setup', 'login', 'app']) $(id)?.classList.add('hidden');
  let gate = document.getElementById('language');
  if (!gate) {
    gate = document.createElement('div');
    gate.id = 'language';
    gate.className = 'login';
    gate.innerHTML = [
      '<div class="login-card">',
      '  <div class="brand"><span class="logo">语</span><div><h1>选择界面语言</h1>',
      '    <p>Choose your language · 首次部署必须先选择</p></div></div>',
      '  <p class="hint">语言立即生效并写入设置；未选择语言前，QQ 服务不会启动。</p>',
      '  <button class="btn primary block" type="button" data-lang="zh-CN">简体中文（默认）</button>',
      '  <button class="btn block" type="button" data-lang="en" style="margin-top:8px">English</button>',
      '  <p id="language-error" class="error"></p>',
      '</div>',
    ].join('');
    document.body.appendChild(gate);
    gate.querySelectorAll('[data-lang]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const language = btn.getAttribute('data-lang');
        const res = await req('/language', { method: 'POST', body: { language } });
        if (!res?.ok) {
          const err = document.getElementById('language-error');
          if (err) err.textContent = res?.error?.message || '选择失败';
          return;
        }
        location.reload();
      });
    });
  }
  gate.classList.remove('hidden');
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
  if (state.boot) state.boot.ai = r.data.ai || state.boot.ai;
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
  const account = state.status?.selfId || '未登录';
  const cpuPct = Math.max(0, Math.min(100, Number(d.cpuUsage) || 0));
  const memPct = Math.max(0, Math.min(100, Number(d.memUsage) || 0));
  const cpuSpeed = d.cpuSpeedMhz ? (Number(d.cpuSpeedMhz) / 1000).toFixed(2) : '-';
  const napcat = d.napcatVersion || '未接入';
  el.innerHTML = `
    <div class="device-card">
      <div class="device-id">
        <div class="avatar">QQ</div>
        <div style="min-width:0;flex:1">
          <div class="device-bot-name">QQ 账号 <span class="device-dot ${esc(s.cls)}"></span></div>
          <div class="device-account mono">${esc(account)}</div>
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
        <p class="hint" style="margin-top:10px">以普通 QQ 账号（协议端登录）工作，不需要 QQ 客户端常驻；登录与换号都在「设置 → QQ 账号登录」里完成。</p>
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
          <dt>QQ 账号</dt><dd class="mono">${esc(account)}</dd>
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
        <input id="trusted-q" class="grow" placeholder="搜索成员昵称 / QQ 号">
        <button id="trusted-search" class="btn">搜索</button>
      </div>
      <div id="trusted-results" class="list" style="margin-top:8px"></div>
      <p class="hint">openid 是按群区分的：请添加「你要管理的那个群」里的成员；搜不到时，让该成员先在该群发一句话。</p>`}
    </div>

    <div class="row" style="margin-top:14px">
      <button id="m-save" class="btn primary">保存违规防护设置</button>
      <span class="hint">普通管理员修改机器人设置需三次确认。</span>
    </div>

    <div class="card">
      <h3>普通用户 AI 通道 <span class="sub">非信任成员 @机器人 时的轻量闲聊</span></h3>
      <div class="row">
        <label class="check"><input id="g-enabled" type="checkbox" ${state.draft.guest.enabled ? 'checked' : ''}>启用普通用户通道</label>
        <label class="check"><input id="g-ai" type="checkbox" ${state.draft.guest.aiEnabled ? 'checked' : ''}>调用 AI 回复（关闭则只回提示）</label>
      </div>
      <div class="grid cols-4">
        <label class="field"><span>每分钟上限（每群）</span><input id="g-permin" type="number" min="1" max="120" value="${state.draft.guest.perMinute}"></label>
        <label class="field"><span>同一成员冷却（秒）</span><input id="g-cool" type="number" min="0" value="${state.draft.guest.cooldownSec}"></label>
        <label class="field"><span>回复字数上限</span><input id="g-maxchars" type="number" min="20" max="1000" value="${state.draft.guest.replyMaxChars}"></label>
        <label class="field"><span>越权禁言（秒）</span><input id="g-mute" type="number" min="0" max="86400" value="${state.draft.guest.muteSeconds}"></label>
        <label class="field"><span>感情牌夹带指令禁言（秒）</span><input id="g-emomute" type="number" min="0" max="86400" value="${state.draft.guest.emotionalMuteSeconds}"></label>
      </div>
      <div class="grid cols-3">
        <label class="field"><span>发表情包概率（%，0 = 不发）</span><input id="g-stickerchance" type="number" min="0" max="100" value="${state.draft.guest.stickerChance ?? 30}"></label>
        <label class="field"><span>兜底 emoji（逗号分隔）</span><input id="g-emojis" value="${esc((state.draft.guest.emojis || []).join(','))}"></label>
      </div>
      <label class="field"><span>表情包图片（每行一个 URL，走 NapCat 发图；留空则只发 emoji）</span><textarea id="g-stickers">${esc(lines(state.draft.guest.stickers || []))}</textarea></label>
      <label class="field"><span>人设补充（只影响闲聊语气）</span><textarea id="g-persona">${esc(state.draft.guest.persona)}</textarea></label>
      <label class="field"><span>越权拦截词（每行一个）</span><textarea id="g-keywords">${esc(lines(state.draft.guest.guardKeywords))}</textarea></label>
      <p class="hint">安全规则：管理操作、索要系统提示、扮演套设定等请求一律拒绝并警告一次；再次越权禁言 5 分钟。感情牌夹带恶意指令直接禁言 1 小时；信任成员触发时只警告并通告所有群。越权判断全在本地完成，不消耗模型。</p>
      <div class="row" style="margin-top:10px">
        <button id="g-save" class="btn primary">保存普通用户通道</button>
        <span class="hint">建议搭配轻量模型或云端 API，避免本机模型占用过高。</span>
      </div>
    </div>`;

  if (!ro) {
    for (const btn of el.querySelectorAll('[data-del-trusted]')) {
      btn.addEventListener('click', () => {
        state.draft.moderation.trustedUsers = state.draft.moderation.trustedUsers.filter((x) => x.uid !== btn.dataset.delTrusted);
        render();
      });
    }
    $('trusted-search').addEventListener('click', async () => {
      const list = await searchMembers($('trusted-q').value, '');
      paintMemberResults($('trusted-results'), list, (m) => {
        if (!m.uid) return;
        if (state.draft.moderation.trustedUsers.some((x) => x.uid === m.uid)) {
          return toast('已在信任成员里', true);
        }
        state.draft.moderation.trustedUsers.push({ uid: m.uid, name: m.name || '', note: '' });
        toast('已添加，记得保存');
        render();
      }, '添加');
    });
    $('trusted-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('trusted-search').click(); });
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

  $('g-save').addEventListener('click', () => {
    const g = state.draft.guest;
    g.enabled = $('g-enabled').checked;
    g.aiEnabled = $('g-ai').checked;
    g.perMinute = Number($('g-permin').value);
    g.cooldownSec = Number($('g-cool').value);
    g.replyMaxChars = Number($('g-maxchars').value);
    g.muteSeconds = Number($('g-mute').value);
    g.emotionalMuteSeconds = Number($('g-emomute').value);
    g.persona = $('g-persona').value;
    g.guardKeywords = parseLines($('g-keywords').value);
    g.stickers = parseLines($('g-stickers').value);
    g.stickerChance = Number($('g-stickerchance').value) || 0;
    g.emojis = String($('g-emojis').value || '').split(/[,，\s]+/u).filter(Boolean);
    savePatch(sectionPatch(['guest']));
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
      <p class="hint">本地规则拒绝时使用这里的理由；AI 自动审批拒绝时由 AI 自己写不超过 10 字的说明。</p>
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
    j.welcome.variants = parseLinesOnly($('j-variants').value);
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
  const napcatOn = !!(state.boot.napcat && state.boot.napcat.enabled);
  el.innerHTML = `
    <div class="card">
      <h3>新建公告 <span class="sub">可选发布为“真·群公告”或普通消息</span></h3>
      <label class="field"><span>标题（可选）</span><input id="a-title" placeholder="例如：本周活动安排"></label>
      <label class="field"><span>正文</span><textarea id="a-content" placeholder="公告内容"></textarea></label>
      <div class="grid cols-3">
        <label class="field"><span>发布方式</span>
          <select id="a-mode">
            <option value="text">普通消息（无需 NapCat）</option>
            <option value="notice">真·群公告（需 NapCat + 管理员）</option>
          </select>
        </label>
        <label class="field"><span>定时发布时间（留空=草稿）</span><input id="a-time" type="datetime-local"></label>
        <label class="field"><span>真公告置顶</span>
          <select id="a-pinned">
            <option value="0">不置顶</option>
            <option value="1">置顶</option>
          </select>
        </label>
      </div>
      ${napcatOn ? '<p class="hint">已启用 NapCat：发布方式可选手“真·群公告”，会显示在群公告栏（需机器人是群管理员/群主）。</p>' : '<p class="hint">当前未启用 NapCat：真·群公告不可用，将回落到普通消息。可在 设置 → NapCat 成员目录 里启用。</p>'}
      <div class="field"><span>目标群</span>
        <div class="row" id="a-targets">
          ${groups.map((g) => `<label class="check"><input type="checkbox" value="${esc(g.gid)}">${esc(g.name || g.gid)}</label>`).join('') || '<span class="hint">还没有群</span>'}
        </div>
      </div>
      <button id="a-create" class="btn primary">保存公告</button>
    </div>
    <div class="card" id="notice-manager">
      <h3>真·群公告管理 <span class="sub">拉取 / 删除群公告（需 NapCat 且机器人是群管理员）</span></h3>
      <div class="row">
        <select id="n-gid">
          <option value="">选择群…</option>
          ${groups.map((g) => `<option value="${esc(g.gid)}">${esc(g.name || g.gid)}</option>`).join('') || ''}
        </select>
        <button id="n-list" class="btn primary">拉取公告</button>
        <span id="n-hint" class="hint"></span>
      </div>
      <div class="list" id="n-notices"><div class="empty">请先选择群并拉取公告</div></div>
    </div>
    <div class="card">
      <h3>公告列表</h3>
      <div class="list">
        ${items.map((x) => `
          <div class="item">
            <div class="main">
              <div class="title">${esc(x.title || '（无标题）')} <span class="pill ${x.status === 'done' ? 'ok' : x.status === 'failed' ? 'bad' : ''}">${esc(statusLabel(x.status))}</span> ${x.mode === 'notice' ? '<span class="pill">真公告</span>' : ''}</div>
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
      mode: $('a-mode').value === 'notice' ? 'notice' : 'text',
      pinned: $('a-pinned').value === '1',
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

  // 真·群公告：拉取 / 删除
  const renderNotices = (notices, hint) => {
    const box = $('n-notices');
    $('n-hint').textContent = hint || '';
    if (!notices || !notices.length) {
      box.innerHTML = '<div class="empty">该群暂无公告</div>';
      return;
    }
    box.innerHTML = notices.map((n) => `
      <div class="item">
        <div class="main">
          <div class="title">${esc(n.message?.text || '(无文本)')}<span class="pill">${n.pinned || n.pinned ? '置顶' : ''}${n.send_to_new_member ? '新成员可见' : ''}</span></div>
          <div class="meta">${esc(n.notice_id || n.fid || '')} · ${esc(fmtTime(n.publish_time ? new Date(Number(n.publish_time) * 1000).toISOString() : ''))}</div>
        </div>
        <div class="row">
          <button class="btn danger" data-notice-del="${esc(n.notice_id || n.fid || '')}">删除</button>
        </div>
      </div>`).join('');
    for (const btn of box.querySelectorAll('[data-notice-del]')) {
      btn.addEventListener('click', async () => {
        if (!await modal('删除群公告', '删除后不可恢复，确认继续？', '删除')) return;
        const r = await req('/group-notices', {
          method: 'POST',
          body: { action: 'delete', gid: $('n-gid').value, noticeId: btn.dataset.noticeDel },
        });
        toast(r.ok ? '已删除' : (r.error?.message || '删除失败'), !r.ok);
        if (r.ok) $('n-list').click();
      });
    }
  };
  $('n-list').addEventListener('click', async () => {
    const gid = $('n-gid').value;
    if (!gid) return toast('请先选择群', true);
    $('n-hint').textContent = '拉取中…';
    const r = await req('/group-notices', { method: 'POST', body: { action: 'list', gid } });
    if (!r.ok) {
      $('n-hint').textContent = '';
      $('n-notices').innerHTML = `<div class="empty">${esc(r.error?.message || '拉取失败')}</div>`;
      return toast(r.error?.message || '拉取失败', true);
    }
    renderNotices(r.data.notices, `共 ${r.data.notices.length} 条（${r.data.qqGroupId || ''}）`);
  });
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

/** 成员搜索：供信任成员、黑名单、指令白名单等页面复用 */
async function searchMembers(q, gid = '') {
  const r = await req(`/members?gid=${encodeURIComponent(gid)}&q=${encodeURIComponent(q)}`);
  return r.ok ? (r.data.members || []) : [];
}

function paintMemberResults(el, members, onPick, actionLabel = '选择') {
  if (!el) return;
  el.innerHTML = members.map((m, i) => `
    <div class="item"><div class="main">
      <div class="title">${esc(m.name || '(无昵称)')}${m.pending ? ' <span class="pill warn">待审批</span>' : ''}</div>
      <div class="meta mono">${esc(groupNameOf(m.gid))} · ${esc(m.uid)}</div>
    </div><button class="btn" data-pick="${i}">${esc(actionLabel)}</button></div>`).join('')
    || '<div class="empty">没有匹配成员；让他先在群里发一句话</div>';
  for (const btn of el.querySelectorAll('[data-pick]')) {
    btn.addEventListener('click', () => onPick(members[Number(btn.dataset.pick)]));
  }
}

/** gid → 群名；拿不到群名时退回 gid，避免搜索结果看不懂 */
function groupNameOf(gid) {
  const g = state.boot?.groups?.[gid];
  return g?.name || String(gid || '-');
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
        <input id="g-gid" class="grow" placeholder="群号">
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
      <h3>成员查询与操作 <span class="sub">启用协议端成员目录后可看到完整花名册与 QQ 号</span></h3>
      <div class="row">
        <select id="mem-gid" class="grow"><option value="">全部群</option>${groups.map((g) => `<option value="${esc(g.gid)}">${esc(g.name || g.gid)}</option>`).join('')}</select>
        <input id="mem-q" class="grow" placeholder="按昵称 / QQ 号 / openid 搜索" value="${esc(state.memberQuery)}">
        <button id="mem-search" class="btn">搜索</button>
        <button id="mem-sync" class="btn primary">同步花名册</button>
      </div>
      <p class="hint" id="mem-hint" style="margin-top:8px">正在读取成员…</p>
      <div id="mem-list" class="list" style="margin-top:10px"><div class="empty">输入关键词后搜索</div></div>
    </div>

    <div class="card">
      <h3>全体禁言与定时任务 <span class="sub">优先用协议端群级开关，不支持时逐人禁言；定时由插件自己调度</span></h3>
      <div class="row">
        <button id="wb-on" class="btn danger">立即全员禁言</button>
        <button id="wb-off" class="btn">解除全员禁言</button>
        <input id="sch-time" class="grow" style="max-width:130px" placeholder="22:30" value="22:30">
        <select id="sch-kind"><option value="whole-ban">全员禁言</option><option value="whole-unban">解除全员禁言</option></select>
        <label class="check"><input id="sch-daily" type="checkbox">每天重复</label>
        <button id="sch-add" class="btn primary">添加定时任务</button>
      </div>
      <div id="sch-list" class="list" style="margin-top:10px"><div class="empty">正在读取定时任务…</div></div>
    </div>`;

  if (!ro) {
    $('g-add').addEventListener('click', async () => {
      const gid = $('g-gid').value.trim();
      if (!gid) return toast('请填写群号', true);
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
    const welcome = parseLinesOnly($('og-welcome').value);
    if (welcome.length) join.welcome = { variants: welcome };
    const patch = { groups: { [gid]: {} } };
    if (Object.keys(mod).length) patch.groups[gid].moderation = mod;
    if (Object.keys(join).length) patch.groups[gid].join = join;
    if (admin()) patch.groups[gid].__replace = true;
    savePatch(patch);
  });

  const setHint = (napcat, total) => {
    const hint = $('mem-hint');
    if (!hint) return;
    const parts = [`共 ${total} 人`];
    if (!napcat) {
      parts.push('NapCat 成员目录未接入：只能看到机器人见过的成员');
    } else if (!napcat.enabled) {
      parts.push('NapCat 成员目录未启用：可在设置里开启完整花名册');
    } else if (napcat.lastError) {
      parts.push(`NapCat 同步异常：${napcat.lastError}`);
    } else if (!napcat.connected && !napcat.directoryMembers) {
      parts.push('NapCat 未连接：请确认协议端已启动');
    } else {
      parts.push(`NapCat 已接入 · 花名册 ${napcat.directoryMembers} 人${napcat.lastSyncAt ? ` · 上次同步 ${fmtTime(napcat.lastSyncAt)}` : ''}`);
    }
    hint.textContent = parts.join(' · ');
    hint.classList.toggle('warn', !!(napcat?.lastError));
  };

  const search = async () => {
    const gid = $('mem-gid')?.value ?? '';
    state.memberQuery = $('mem-q')?.value ?? '';
    const r = await req(`/members?gid=${encodeURIComponent(gid)}&q=${encodeURIComponent(state.memberQuery)}`);
    if (!r.ok) return toast(r.error?.message || '查询失败', true);
    const list = $('mem-list');
    if (!list) return;
    const rows = r.data.members || [];
    setHint(r.data.napcat, r.data.total ?? rows.length);
    list.innerHTML = rows.map((m) => {
      const uid = String(m.uid || '');
      const qq = String(m.qq || '');
      const source = m.source === 'official+napcat' ? '官方+NapCat'
        : m.source === 'napcat' ? 'NapCat 花名册'
          : m.pending ? '待审批申请' : '本地台账';
      const tags = [];
      if (m.isBot) tags.push('机器人');
      if (m.role === 'owner') tags.push('群主');
      else if (m.role === 'admin') tags.push('管理员');
      if (m.whitelisted) tags.push('白名单');
      if (m.trusted) tags.push('信任');
      const meta = [
        qq ? `QQ ${qq}` : 'QQ 未关联',
        uid ? `openid ${uid}` : '',
        source,
        tags.join(' / '),
        `发言 ${m.messageCount || 0} 次`,
        m.lastSeenAt ? `最近 ${fmtTime(m.lastSeenAt)}` : '',
      ].filter(Boolean).join(' · ');
      const target = `data-qq="${esc(qq)}" data-uid="${esc(uid)}" data-gid="${esc(m.gid || gid)}"`;
      const actions = m.pending
        ? ''
        : `<div class="row">
        <button class="btn" data-act="mute" ${target}>禁言</button>
        <button class="btn" data-act="unmute" ${target}>解禁</button>
        <button class="btn danger" data-act="kick" ${target}>移出</button>
      </div>`;
      const dispName = String(m.name || m.nickname || '').trim()
        || (uid ? `未命名(${uid.slice(-6)})` : '未备注');
      return `<div class="item"><div class="main"><div class="title">${esc(dispName)}</div>
      <div class="meta mono">${esc(meta)}</div></div>${actions}</div>`;
    }).join('') || '<div class="empty">没有匹配成员</div>';
    for (const btn of list.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', () => memberAction(btn.dataset.gid || gid, { uid: btn.dataset.uid, qq: btn.dataset.qq }, btn.dataset.act));
    }
  };
  $('mem-search').addEventListener('click', search);
  $('mem-gid').addEventListener('change', search);
  $('mem-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  $('mem-sync').addEventListener('click', async () => {
    if (!admin()) return toast('需要最高管理员权限', true);
    const gid = $('mem-gid')?.value ?? '';
    $('mem-sync').disabled = true;
    $('mem-sync').textContent = '同步中…';
    try {
      const r = await req('/members/sync', { method: 'POST', body: { gid } });
      if (!r.ok) throw new Error(r.error?.message || '同步失败');
      const data = r.data || {};
      toast(`已同步 ${data.syncedGroups || 0} 个群、${data.syncedMembers || 0} 人${data.warning ? `（${data.warning}）` : ''}`);
      await search();
    } catch (error) {
      toast(error.message || '同步失败', true);
    } finally {
      const btn = $('mem-sync');
      if (btn) { btn.disabled = false; btn.textContent = '同步花名册'; }
    }
  });
  const schList = async () => {
    const gid = $('mem-gid')?.value ?? '';
    const box = $('sch-list');
    if (!box) return;
    const r = await req('/schedules');
    if (!r.ok) { box.innerHTML = `<div class="empty">${esc(r.error?.message || '读取失败')}</div>`; return; }
    const rows = (r.data.schedules || []).filter((x) => !gid || x.gid === gid);
    if (!rows.length) { box.innerHTML = '<div class="empty">还没有定时任务</div>'; return; }
    box.innerHTML = rows.map((x) => {
      const when = x.repeat === 'daily' ? `每天 ${esc(x.time)}` : esc(fmtTime(new Date(x.at).toISOString()));
      const what = x.kind === 'whole-ban' ? '全员禁言' : x.kind === 'whole-unban' ? '解除全员禁言'
        : x.kind === 'mute' ? '禁言成员' : '解除成员禁言';
      return `<div class="item"><div class="main"><div class="title">${when}</div>
        <div class="meta">${esc(what)}</div></div>
        <button class="btn danger" data-cancel="${esc(x.id)}">取消</button></div>`;
    }).join('');
    for (const btn of box.querySelectorAll('[data-cancel]')) {
      btn.addEventListener('click', async () => {
        const rr = await req('/schedules/cancel', { method: 'POST', body: { id: btn.dataset.cancel } });
        toast(rr.ok ? '已取消' : (rr.error?.message || '取消失败'), !rr.ok);
        await schList();
      });
    }
  };
  $('sch-add').addEventListener('click', async () => {
    const gid = $('mem-gid')?.value ?? '';
    if (!gid) return toast('先在上方选择群', true);
    const m = String($('sch-time').value || '').trim().match(/^(\d{1,2}):(\d{2})$/u);
    if (!m) return toast('时间格式写成 22:30', true);
    const at = new Date();
    at.setSeconds(0, 0);
    at.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    const daily = $('sch-daily').checked;
    const r = await req('/schedules', {
      method: 'POST',
      body: {
        gid, kind: $('sch-kind').value, at: at.getTime(),
        repeat: daily ? 'daily' : 'once', time: `${String(m[1]).padStart(2, '0')}:${m[2]}`,
      },
    });
    toast(r.ok ? '已添加定时任务' : (r.error?.message || '添加失败'), !r.ok);
    await schList();
  });
  $('wb-on').addEventListener('click', async () => {
    const gid = $('mem-gid')?.value ?? '';
    if (!gid) return toast('先在上方选择群', true);
    const r = await req('/whole-ban', { method: 'POST', body: { gid, enable: true } });
    toast(r.ok ? `已批量禁言 ${r.data?.done ?? ''} 人（失败 ${r.data?.failed ?? 0}）` : (r.error?.message || '执行失败'), !r.ok);
  });
  $('wb-off').addEventListener('click', async () => {
    const gid = $('mem-gid')?.value ?? '';
    if (!gid) return toast('先在上方选择群', true);
    const r = await req('/whole-ban', { method: 'POST', body: { gid, enable: false } });
    toast(r.ok ? `已批量解禁 ${r.data?.done ?? ''} 人` : (r.error?.message || '执行失败'), !r.ok);
  });
  void schList();
  void search();
}

async function memberAction(gid, target, action) {
  if (!admin()) return toast('需要最高管理员权限', true);
  const uid = String(target?.uid || '').trim();
  const qq = String(target?.qq || '').trim();
  if (!uid && !qq) return toast('缺少成员标识', true);
  if (action === 'kick' && !await modal('移出成员', '将把该成员移出群聊，确认继续？', '移出')) return;
  const body = uid ? { action, gid, uid } : { action, gid, qq };
  const r = await req('/members/action', { method: 'POST', body });
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
      <div class="row" style="margin-bottom:10px">
        <input id="b-q" class="grow" placeholder="搜索成员昵称 / QQ 号">
        <button id="b-search" class="btn">搜索</button>
      </div>
      <div id="b-results" class="list" style="margin-bottom:10px"></div>
      <div class="grid cols-3">
        <label class="field"><span>群</span><select id="b-gid">${groups.map((g) => `<option value="${esc(g.gid)}">${esc(g.name || g.gid)}</option>`).join('')}</select></label>
        <label class="field"><span>成员 QQ 号</span><input id="b-uid"></label>
        <label class="field"><span>昵称（可选）</span><input id="b-name"></label>
      </div>
      <label class="field"><span>原因</span><input id="b-reason" placeholder="例如：多次发广告"></label>
      <button id="b-add" class="btn primary">加入黑名单</button>
    </div>`;

  $('b-search').addEventListener('click', async () => {
    const list = await searchMembers($('b-q').value, '');
    paintMemberResults($('b-results'), list, (m) => {
      const sel = $('b-gid');
      if ([...sel.options].some((o) => o.value === m.gid)) sel.value = m.gid;
      $('b-uid').value = m.uid;
      $('b-name').value = m.name || '';
      toast('已填入成员信息');
    }, '填入');
  });
  $('b-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('b-search').click(); });

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
        <input id="au-gid" placeholder="群号" class="grow">
        <input id="au-uid" placeholder="成员 QQ 号" class="grow">
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
  const ai = s.ai || {};
  const aiMod = ai.moderation || {};
  const aiJoin = ai.join || {};
  const aiSchedule = aiJoin.schedule || {};
  const aiVision = ai.vision || {};
  const aiQuiz = ai.quiz || {};
  const aiStatus = state.boot.ai || {};
  const net = state.net;
  const napcat = s.napcat || {};
  const napcatState = state.boot.napcat || {};
  const nat = s.natural || {};
  const natKeywords = (Array.isArray(nat.keywords) ? nat.keywords : [])
    .map((k) => `${k.phrase} = ${k.action}`).join('\n');
  const pwdRule = sec.passwordMin
    ? `新密码至少 ${sec.passwordMin} 位，必须同时包含字母和数字，且不能与另一个角色的密码相同。`
    : '新密码必须同时包含字母和数字，且不能与另一个角色的密码相同。';
  el.innerHTML = `
    <div class="card">
      <h3>界面语言 <span class="sub">默认简体中文；语言包在 locale/ 下，可直接替换文件</span></h3>
      <label class="field"><span>语言</span>
        <select id="s-language">
          <option value="zh-CN" ${(s.language || 'zh-CN') === 'zh-CN' ? 'selected' : ''}>简体中文</option>
          <option value="en" ${s.language === 'en' ? 'selected' : ''}>English</option>
        </select>
      </label>
      <p class="hint">首次部署必须先选语言；未选择前插件服务不会启动。切换后立即生效。</p>
    </div>

    <div class="card">
      <h3>QQ 账号登录 <span class="sub">普通 QQ 账号 · 不用填 AppID，也不用开 QQ 客户端</span>
        <span id="s-login-pill" class="pill off">读取中…</span></h3>
      <div id="s-login-body" class="s" style="line-height:1.8"></div>
      <div id="s-login-qr" style="margin-top:10px"></div>
      <div class="row" style="margin-top:10px">
        <button id="s-login-qr-btn" class="btn" type="button" ${disabledAttr(ro)}>扫码登录</button>
        <button id="s-login-refresh" class="btn ghost" type="button">刷新状态</button>
        <span id="s-login-quick" class="row"></span>
      </div>
      <p class="hint" style="margin-top:8px">登录、换号都在这里完成：二维码由本机协议端生成，手机 QQ 扫码确认即可；这台机器上登录过的账号可以一键快速登录。换号请先在协议端退出登录。</p>
      <div class="grid cols-2" style="margin-top:10px">
        <label class="field"><span>协议端 WebUI 地址</span><input id="s-napcat-webui-url" value="${esc(napcat.webuiUrl || '')}" placeholder="http://127.0.0.1:6099" ${disabledAttr(ro)}></label>
        <label class="field"><span>WebUI 令牌（可留空，留空自动读 webui.json）</span><input id="s-napcat-webui-token" type="password" placeholder="${napcat.webuiToken ? '已设置，留空不变' : '自动读取'}" ${disabledAttr(ro)}></label>
      </div>
    </div>

    <div class="card">
      <h3>连接行为</h3>
      <div class="row">
        <label class="check"><input id="s-auto" type="checkbox" ${s.autoConnect ? 'checked' : ''} ${disabledAttr(ro)}>插件加载时自动连接协议端</label>
        <label class="check"><input id="s-watch" type="checkbox" ${s.watchJoinRequests ? 'checked' : ''} ${disabledAttr(ro)}>自动同步入群申请</label>
      </div>
      <p class="hint">插件以普通 QQ 账号身份工作（协议端登录）：群消息、@、禁言、踢人、群公告、入群审批都用这个账号的群管理权限。不需要 AppID/AppSecret。</p>
    </div>

    <div class="card">
      <h3>协议端连接（OneBot / NapCat） <span class="sub">收发消息、群成员花名册、群公告都走这里</span></h3>
      <p class="hint" style="line-height:1.8">地址默认 <span class="mono">ws://127.0.0.1:3001</span>；点「自动探测」会直接读协议端的 <span class="mono">onebot11_&lt;QQ&gt;.json</span>，把端口和 token 填好。协议端没起时，插件可以按「启动命令」自己把它拉起来。</p>
      <div class="row">
        <label class="check"><input id="s-napcat-enabled" type="checkbox" ${napcat.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用成员目录</label>
        <label class="check"><input id="s-napcat-detect" type="checkbox" ${napcat.autoDetect !== false ? 'checked' : ''} ${disabledAttr(ro)}>连不上时自动探测地址</label>
        <label class="check"><input id="s-napcat-auto" type="checkbox" ${napcat.autoSync ? 'checked' : ''} ${disabledAttr(ro)}>打开成员页时自动同步</label>
        <label class="check"><input id="s-napcat-nocache" type="checkbox" ${napcat.noCache !== false ? 'checked' : ''} ${disabledAttr(ro)}>绕过协议端缓存（no_cache）</label>
        <span class="pill ${napcatState.connected ? 'ok' : 'off'}">${esc(napcatState.connected ? '已连接' : (napcatState.lastError ? '连接异常' : '未连接'))}</span>
      </div>
      <div class="grid cols-2" style="margin-top:10px">
        <label class="field"><span>WebSocket 地址</span><input id="s-napcat-url" value="${esc(napcat.wsUrl || '')}" placeholder="ws://127.0.0.1:3001" ${disabledAttr(ro)}></label>
        <label class="field"><span>Token（可留空；留空保持不变）</span><input id="s-napcat-token" type="password" placeholder="${napcat.token ? '已设置，留空不变' : '未设置'}" ${disabledAttr(ro)}></label>
        <label class="field"><span>缓存时长（分钟，0 = 每次重新拉取）</span><input id="s-napcat-ttl" type="number" min="0" max="1440" value="${Math.round((Number(napcat.cacheTtlMs) || 0) / 60000)}" ${disabledAttr(ro)}></label>
        <label class="field"><span>调用超时（毫秒）</span><input id="s-napcat-timeout" type="number" min="1000" max="15000" step="500" value="${Number(napcat.timeoutMs) || 4000}" ${disabledAttr(ro)}></label>
      </div>
      <p class="hint" style="line-height:1.8">地址模板：NapCat 默认 <span class="mono">ws://127.0.0.1:3001</span>；LLOneBot 默认 <span class="mono">ws://127.0.0.1:3000</span>；OneBot v11 实现默认 <span class="mono">ws://127.0.0.1:6700</span>。端口与 token 在协议端配置的 <span class="mono">onebot11_&lt;登录QQ&gt;.json → websocketServers[].port / token</span> 里；没开鉴权时 token 留空。</p>
      <label class="field" style="margin-top:8px"><span>手动群映射（每行一条：官方群号 = QQ 群号；留空则按群名自动匹配）</span><textarea id="s-napcat-map" placeholder="0123456789ABCDEF0123456789ABCDEF = 123456789&#10;（群名与协议端一致时会自动匹配，通常不用手填）" ${disabledAttr(ro)}>${esc(lines(Object.entries(napcat.groupMap || {}).map(([gid, qq]) => `${gid} = ${qq}`)))}</textarea></label>
      <div class="row" style="margin-top:8px">
        <button id="s-napcat-detect-btn" class="btn">自动探测</button>
        <button id="s-napcat-test" class="btn">测试连接</button>
        <span id="s-napcat-result" class="hint">${esc(napcatState.lastError || (napcatState.connected ? `已连接 ${napcatState.url || ''}` : ''))}</span>
      </div>
      ${(napcatState.groups || []).length ? `<p class="hint" style="margin-top:6px">协议端可见群：${napcatState.groups.map((g) => `${esc(g.name || g.qqGroupId)}（${esc(g.qqGroupId)}，${g.memberCount || 0} 人）`).join(' · ')}</p>` : ''}
      ${(napcatState.mappings || []).length ? `<p class="hint" style="margin-top:2px">目录匹配：${napcatState.mappings.map((m) => `${esc(m.name || m.gid)} → ${m.qqGroupId ? `QQ ${esc(m.qqGroupId)}（${m.directoryCount || 0} 人${m.auto ? '，自动' : '，手动'}）` : '未匹配'}`).join(' · ')}</p>` : ''}
    </div>

    <div class="card">
      <h3>变更通知对象 <span class="sub">仅普通管理员修改时 @</span></h3>
      <div class="grid cols-2">
        <label class="field"><span>通知对象昵称（必填）</span><input id="s-notify-name" value="${esc(s.panel.notifyName)}" placeholder="例如：群主昵称" ${disabledAttr(ro)}></label>
        <label class="field"><span>成员 QQ 号（可留空）</span><input id="s-notify-uid" value="${esc(s.panel.notifyOpenid)}" placeholder="不知道就留空；同名时再填" ${disabledAttr(ro)}></label>
      </div>
      <label class="field"><span>从成员列表选择（自动填入昵称与 openid）</span>
        <select id="s-notify-member" ${disabledAttr(ro)}><option value="">加载中…</option></select></label>
      <div class="row" style="margin-top:2px">
        <button id="s-notify-check" class="btn">验证通知对象</button>
        <span id="s-notify-result" class="hint"></span>
      </div>
      <p class="hint">QQ 官方 Bot API 只提供成员 QQ 号，不提供 QQ 号，所以无法按 QQ 号 @ 人（开启 NapCat 成员目录后，成员列表会额外显示 QQ 号，但通知仍按 openid/昵称匹配）。留空 openid 时按昵称匹配：群内该昵称唯一就 @ 他；有同名成员则需要补 openid 或从上面列表选人。@ 仅在普通管理员修改机器人级设置时生效。</p>
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
        <label class="check"><input id="s-natural" type="checkbox" ${s.commands.naturalEnabled ? 'checked' : ''} ${disabledAttr(ro)}>允许受信任成员 @机器人 用自然语言下指令</label>
        <label class="field"><span>免@续聊（秒）</span><input id="s-follow-up" type="number" min="0" max="600" value="${s.commands.followUpSec}" style="width:90px" ${disabledAttr(ro)}></label>
        <label class="field"><span>重启二次确认（秒）</span><input id="s-restart-confirm" type="number" min="0" max="300" value="${s.commands.restartConfirmSec}" style="width:90px" ${disabledAttr(ro)}></label>
        <label class="field"><span>前缀</span><input id="s-cmd-prefix" value="${esc(s.commands.prefix)}" style="width:80px" ${disabledAttr(ro)}></label>
      </div>
      <p class="hint">示例：@机器人 看看群里有多少人；@机器人 把“某某”踢出群聊并拉黑；@机器人 禁言“某某”10分钟。也可以直接 @ 要处理的成员再说动作。同一成员 @ 过一次后，上表秒数内继续说话不必重复 @（填 0 关闭）。白名单成员可用 /设备 查看设备与资源占用、/余额 查询 AI 接口余额、/重启 完整重启插件并自动登录（/重启 需二次确认，完成后会回报结果；不受“启用指令”开关限制）。</p>
      <label class="field"><span>允许使用的成员 QQ 号（每行一个；信任成员自动允许）</span><textarea id="s-cmd-users" ${disabledAttr(ro)}>${esc(lines(s.commands.allowUsers))}</textarea></label>
      <div class="row" style="margin-bottom:8px">
        <input id="cmd-q" class="grow" placeholder="搜索成员昵称 / QQ 号">
        <button id="cmd-search" class="btn">搜索</button>
      </div>
      <div id="cmd-results" class="list" style="margin-bottom:10px"></div>
      <label class="field"><span>群规文本（/rule 返回）</span><textarea id="s-rule" ${disabledAttr(ro)}>${esc(s.commands.ruleText)}</textarea></label>
    </div>

    <div class="card">
      <h3>自然语言决策 <span class="sub">v1.9.0：先问 AI，关键词只兜底</span></h3>
      <div class="row">
        <label class="check"><input id="s-nat-aifirst" type="checkbox" ${nat.aiFirst !== false ? 'checked' : ''} ${disabledAttr(ro)}>所有自然语言指令先经过 AI 决策</label>
        <label class="field"><span>关键词重排周期（周，最多 10 周）</span><input id="s-nat-review" type="number" min="1" max="10" value="${Number(nat.reviewWeeks) || 3}" style="width:90px" ${disabledAttr(ro)}></label>
        <label class="field"><span>最近 7 天用量达到</span><input id="s-nat-weekly" type="number" min="1" max="5000" value="${Number(nat.weeklyCommands) || 100}" style="width:90px" ${disabledAttr(ro)}></label>
        <label class="field"><span>提醒对象 QQ 号（留空=第一个信任成员）</span><input id="s-nat-notify" value="${esc(nat.notifyUid || '')}" style="width:260px" ${disabledAttr(ro)}></label>
      </div>
      <label class="field"><span>保留的快捷关键词（最多 15 个，每行“说法 = 动作”）</span><textarea id="s-nat-keywords" placeholder="列出群成员 = list-members&#10;禁言 = mute&#10;解禁 = unmute" ${disabledAttr(ro)}>${esc(natKeywords)}</textarea></label>
      <p class="hint">只有 AI 超时 / 不可用时才会用到这些关键词；到重排周期（默认 3 周，最多 10 周）或最近 7 天用满上面的次数（默认 100 次）时，插件会按最近常用动作自动重排，并 @ 提醒对象。关键词最多保存 15 条，动作名可参考「管理功能」清单。</p>
    </div>

    <div class="card">
      <h3>AI 辅助审核 <span class="sub">总开关关闭后所有 AI 功能停用，全部走本地规则</span></h3>
      <p class="hint" style="margin-bottom:10px;line-height:1.8">
        新手这样填：① 已经装好 dsh 模型 → 选「DSH 当前会话模型」，不用填其他；② 想用其他厂商 → 选「OpenAI 兼容接口」，点“快速选择厂商”，再填 API Key；③ 保存后点“测试当前模型”，能看到判定结果就说明配通了。
      </p>
      <div class="row">
        <label class="check"><input id="ai-master" type="checkbox" ${ai.master !== false ? 'checked' : ''} ${disabledAttr(ro)}>AI 总开关（关闭后所有 AI 功能失效）</label>
        <label class="check"><input id="ai-enabled" type="checkbox" ${ai.enabled ? 'checked' : ''} ${disabledAttr(ro)}>启用 AI 审核</label>
        <label class="check"><input id="ai-vision" type="checkbox" ${aiVision.enabled ? 'checked' : ''} ${disabledAttr(ro)}>分析图片（需视觉模型）</label>
        <label class="field"><span>单条最多图片</span><input id="ai-max-images" type="number" min="1" max="5" value="${Number(aiVision.maxImages) || 3}" ${disabledAttr(ro)}></label>
        <label class="field"><span>单张上限（MB）</span><input id="ai-max-mb" type="number" min="1" max="8" step="0.5" value="${Number(((Number(aiVision.maxBytes) || 3145728) / 1048576).toFixed(1))}" ${disabledAttr(ro)}></label>
        <span class="pill ${aiStatus.available ? 'ok' : 'off'}">${aiStatus.available ? '模型可用：' + esc(aiStatus.model || '') : esc(aiStatus.reason || '未配置模型')}</span>
        <span class="pill ${aiStatus.vision && aiStatus.vision.ready ? 'ok' : 'off'}">${aiStatus.vision && aiStatus.vision.ready ? '可读图' : '图片分析不可用'}</span>
      </div>
      <div class="grid cols-3" style="margin-top:10px">
        <label class="field"><span>接入方式</span>
          <select id="ai-provider" ${disabledAttr(ro)}>
            <option value="dsh" ${ai.provider === 'dsh' ? 'selected' : ''}>DSH 当前会话模型</option>
            <option value="openai" ${ai.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容接口</option>
          </select></label>
        <label class="field" id="ai-preset-field"><span>快速选择厂商（自动填地址与模型）</span>
          <select id="ai-preset" ${disabledAttr(ro)}>
            ${AI_PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
          </select></label>
        <label class="field" id="ai-model-field"><span>模型名称</span><input id="ai-model" value="${esc(ai.model || '')}" placeholder="deepseek-chat / qwen-plus / glm-4-flash" ${disabledAttr(ro)}></label>
      </div>
      <div id="ai-dsh-note" class="hint" style="display:none;margin:6px 0 10px">API Key：你无需进行配置，因为已绑定了 DSH 模型。</div>
      <div class="grid cols-2">
        <label class="field" id="ai-base-field"><span>接口地址（OpenAI 兼容，通常以 /v1 结尾）</span><input id="ai-base" value="${esc(ai.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" ${disabledAttr(ro)}></label>
        <label class="field" id="ai-key-field"><span>API Key（留空不修改；本地模型可留空）</span><input id="ai-key" type="password" placeholder="${ai.apiKeySet ? '已设置，留空不变' : '填写厂商密钥'}" ${disabledAttr(ro)}></label>
      </div>
      <div class="grid cols-3">
        <label class="field"><span>超时（毫秒）</span><input id="ai-timeout" type="number" min="1000" max="60000" value="${Number(ai.timeoutMs) || 8000}" ${disabledAttr(ro)}></label>
        <label class="field"><span>最大输出 tokens</span><input id="ai-tokens" type="number" min="32" max="2000" value="${Number(ai.maxTokens) || 512}" ${disabledAttr(ro)}></label>
        <label class="field"><span>最低置信度（0-1）</span><input id="ai-minconf" type="number" min="0" max="1" step="0.05" value="${ai.minConfidence == null ? 0.7 : ai.minConfidence}" ${disabledAttr(ro)}></label>
      </div>
      <div class="row" style="gap:16px">
        <label class="check"><input id="ai-mod" type="checkbox" ${aiMod.enabled ? 'checked' : ''} ${disabledAttr(ro)}>违规防护接入 AI</label>
        <label class="field"><span>处理方式</span>
          <select id="ai-mod-mode" ${disabledAttr(ro)}>
            <option value="auto" ${aiMod.mode === 'auto' ? 'selected' : ''}>识别即处置</option>
            <option value="suggest" ${aiMod.mode === 'suggest' ? 'selected' : ''}>只记录建议</option>
          </select></label>
        <label class="field"><span>最短检测字数</span><input id="ai-mod-min" type="number" min="1" max="200" value="${Number(aiMod.minChars) || 4}" ${disabledAttr(ro)}></label>
        <label class="field"><span>每群每分钟上限</span><input id="ai-mod-rate" type="number" min="1" max="600" value="${Number(aiMod.maxPerMinute) || 30}" ${disabledAttr(ro)}></label>
        <label class="check"><input id="ai-img" type="checkbox" ${aiMod.analyzeImages ? 'checked' : ''} ${disabledAttr(ro)}>违规防护分析图片</label>
      </div>
      <div class="row" style="gap:16px">
        <label class="check"><input id="ai-join" type="checkbox" ${aiJoin.enabled ? 'checked' : ''} ${disabledAttr(ro)}>入群审批接入 AI</label>
        <label class="field"><span>处理方式</span>
          <select id="ai-join-mode" ${disabledAttr(ro)}>
            <option value="suggest" ${aiJoin.mode === 'suggest' ? 'selected' : ''}>只给建议</option>
            <option value="auto" ${aiJoin.mode === 'auto' ? 'selected' : ''}>AI 全权判断</option>
          </select></label>
        <label class="field"><span>启用时段</span>
          <select id="ai-join-sched" ${disabledAttr(ro)}>
            <option value="always" ${aiSchedule.mode === 'always' ? 'selected' : ''}>全天 24 小时</option>
            <option value="day" ${aiSchedule.mode === 'day' ? 'selected' : ''}>仅白天</option>
            <option value="night" ${aiSchedule.mode === 'night' ? 'selected' : ''}>仅晚上</option>
            <option value="active" ${aiSchedule.mode === 'active' ? 'selected' : ''}>群活跃时</option>
          </select></label>
        <label class="field"><span>白天开始（时）</span><input id="ai-day-start" type="number" min="0" max="23" value="${Number(aiSchedule.dayStart ?? 8)}" ${disabledAttr(ro)}></label>
        <label class="field"><span>白天结束（时）</span><input id="ai-day-end" type="number" min="1" max="24" value="${Number(aiSchedule.dayEnd ?? 22)}" ${disabledAttr(ro)}></label>
        <label class="field"><span>活跃判定（分钟）</span><input id="ai-idle" type="number" min="1" max="1440" value="${Number(aiSchedule.idleMinutes ?? 30)}" ${disabledAttr(ro)}></label>
        <button id="ai-test" class="btn" ${disabledAttr(ro)}>测试当前模型</button>
        <span id="ai-test-result" class="hint">测试使用已保存的配置，改完请先保存</span>
      </div>
      <div class="row" style="gap:16px">
        <label class="check"><input id="ai-quiz" type="checkbox" ${aiQuiz.enabled ? 'checked' : ''} ${disabledAttr(ro)}>入群验证由 AI 随机出题</label>
        <label class="field"><span>题型</span>
          <select id="ai-quiz-mode" ${disabledAttr(ro)}>
            <option value="mixed" ${aiQuiz.mode === 'mixed' ? 'selected' : ''}>算术 + 日常</option>
            <option value="arithmetic" ${aiQuiz.mode === 'arithmetic' ? 'selected' : ''}>只出算术</option>
            <option value="daily" ${aiQuiz.mode === 'daily' ? 'selected' : ''}>只出日常常识</option>
          </select></label>
        <label class="check"><input id="ai-quiz-judge" type="checkbox" ${aiQuiz.judge ? 'checked' : ''} ${disabledAttr(ro)}>答案不一致时让 AI 判卷</label>
      </div>
      <p class="hint">AI 只处理本地词表/正则没命中的消息；开启图片分析后会一起判断图片里的辱骂、广告和二维码。入群审批只在所选时段生效，AI 不确定会转人工；AI 出题失败会回退本地题库，本地比对不一致时可再让 AI 判卷。模型超时、断网或输出不合规都会自动回退，不会误踢。</p>
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
        ${admin() ? '<button id="cfg-import" class="btn danger">导入配置</button>' : ''}
      </div>
      <p class="hint">导出的文件包含词表、按群配置、公告、黑名单；不含任何密钥（AI 密钥、协议端 token）。</p>
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
    if (!name) {
      out.textContent = '请填写昵称';
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
      const src = d.source === 'api' ? '官方昵称校验' : d.source === 'name' ? '按昵称唯一匹配' : '成员台账';
      out.textContent = `已匹配：${d.nickname}（${src}）`;
      out.style.color = 'var(--ok)';
    } else {
      let text = d.reason || '未匹配';
      if (Array.isArray(d.candidates) && d.candidates.length) {
        text += '；可选：' + d.candidates.map((c) => `${c.name || '未命名'}=${c.uid}`).join('、');
      }
      out.textContent = text;
      out.style.color = 'var(--bad)';
    }
    if (!silent) toast(d.matched ? '通知对象验证通过' : (d.reason || '通知对象未匹配'), !d.matched);
    return d;
  };
  $('s-notify-check').addEventListener('click', () => { void verifyNotify(false); });

  // 成员列表：选中后自动填入昵称与 openid，免去手动找 openid
  void (async () => {
    const sel = $('s-notify-member');
    if (!sel) return;
    const r = await req('/members?gid=&q=');
    if (!r.ok) {
      sel.innerHTML = '<option value="">成员列表加载失败</option>';
      return;
    }
    const list = r.data.members || [];
    const opts = list.map((m) => {
      const label = m.uid
        ? `${m.name || '(无昵称)'} · ${m.gid} · ${m.uid}`
        : `${m.name || '(无昵称)'} · ${m.gid} · QQ ${m.qq}（NapCat）`;
      const value = JSON.stringify({ name: m.name || '', uid: m.uid || '' });
      return `<option value="${esc(value)}">${esc(label)}</option>`;
    }).join('');
    sel.innerHTML = '<option value="">选择成员（自动填昵称与 QQ 号）</option>'
      + (opts || '<option value="">暂无成员（让他在群里发言后刷新）</option>');
  })();
  $('s-notify-member').addEventListener('change', () => {
    const raw = $('s-notify-member').value;
    if (!raw) return;
    try {
      const picked = JSON.parse(raw);
      $('s-notify-name').value = picked.name || '';
      $('s-notify-uid').value = picked.uid || '';
      $('s-notify-result').textContent = '已填入，可以点“验证通知对象”';
    } catch { /* ignore */ }
  });

  const syncAiProvider = () => {
    const dsh = $('ai-provider').value === 'dsh';
    for (const id of ['ai-base', 'ai-key', 'ai-model', 'ai-preset']) {
      const node = $(id);
      if (node) node.disabled = dsh;
    }
    for (const id of ['ai-preset-field', 'ai-model-field', 'ai-base-field', 'ai-key-field']) {
      const node = $(id);
      if (node) node.style.display = dsh ? 'none' : '';
    }
    const note = $('ai-dsh-note');
    if (note) note.style.display = dsh ? '' : 'none';
  };
  $('ai-provider').addEventListener('change', syncAiProvider);
  $('ai-preset').addEventListener('change', () => {
    const p = AI_PRESETS.find((x) => x.id === $('ai-preset').value);
    if (!p) return;
    if (p.id === 'dsh') {
      $('ai-provider').value = 'dsh';
    } else {
      $('ai-provider').value = 'openai';
      $('ai-base').value = p.baseUrl;
      $('ai-model').value = p.model;
    }
    syncAiProvider();
  });
  $('ai-test').addEventListener('click', async () => {
    const out = $('ai-test-result');
    out.textContent = '测试中…';
    out.style.color = '';
    const r = await req('/ai/test', { method: 'POST', body: {} });
    if (!r.ok) {
      out.textContent = r.error?.message || '测试失败';
      out.style.color = 'var(--bad)';
      return;
    }
    const d = r.data || {};
    out.style.color = 'var(--ok)';
    out.textContent = `可用：判定「${d.verdict}」，置信度 ${Number(d.confidence).toFixed(2)} · ${d.provider}/${d.model} · ${d.latencyMs}ms`;
  });
  syncAiProvider();

  $('s-napcat-detect-btn')?.addEventListener('click', async () => {
    const out = $('s-napcat-result');
    if (out) out.textContent = '正在探测本机协议端…';
    const r = await req('/napcat/discover', { method: 'POST', body: {} });
    if (!r.ok) {
      if (out) out.textContent = r.error?.message || '没有发现可用的 NapCat / LLOneBot';
      return toast(r.error?.message || '没有发现可用的协议端', true);
    }
    const d = r.data || {};
    const enabled = $('s-napcat-enabled');
    const url = $('s-napcat-url');
    if (enabled) enabled.checked = true;
    if (url && d.wsUrl) url.value = d.wsUrl;
    if (out) {
      out.textContent = `已发现：${d.nickname || '未知账号'}（${d.selfId || '-'}）· ${d.wsUrl || ''}${d.tokenSet ? '（带 token，已保存）' : ''}，参数已自动填入`;
    }
    toast('已探测到 NapCat，参数已填入（记得保存）');
  });

  $('s-napcat-test')?.addEventListener('click', async () => {
    const out = $('s-napcat-result');
    if (out) out.textContent = '连接测试中…';
    const r = await req('/napcat/test', { method: 'POST', body: {} });
    if (!r.ok) {
      if (out) out.textContent = r.error?.message || '连接失败';
      return toast(r.error?.message || '连接失败', true);
    }
    const d = r.data || {};
    if (out) out.textContent = `已连接：${d.nickname || '未知账号'}（${d.selfId || '-'}），协议端可见 ${(d.groups || []).length} 个群`;
    toast('NapCat 连接正常');
  });

  $('cmd-search').addEventListener('click', async () => {
    const list = await searchMembers($('cmd-q').value, '');
    paintMemberResults($('cmd-results'), list, (m) => {
      const ta = $('s-cmd-users');
      const current = parseLines(ta.value);
      if (current.includes(m.uid)) return toast('已在白名单里', true);
      ta.value = current.concat([m.uid]).join('\n');
      toast('已加入白名单（记得保存）');
    }, '加入白名单');
  });
  $('cmd-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('cmd-search').click(); });

  /* QQ 账号登录（协议端）：状态 / 扫码 / 快速登录，都在设置页完成，不用开 QQ 客户端 */
  function paintLogin(data) {
    const pill = $('s-login-pill');
    const body = $('s-login-body');
    const webui = data?.webui || null;
    const loggedIn = !!webui?.isLogin;
    if (pill) {
      const tone = !webui ? 'off' : loggedIn ? 'ok' : (webui.reachable ? 'warn' : 'bad');
      pill.className = `pill ${tone}`;
      pill.textContent = !webui ? '读取中…'
        : loggedIn ? '已登录'
          : (webui.reachable ? (webui.loginPhase === 'qrcode_scanned' ? '已扫码，待确认' : '未登录') : '协议端不可达');
    }
    if (!body) return;
    const rows = [];
    if (webui?.reason) rows.push(`<div class="hint">${esc(webui.reason)}</div>`);
    if (webui?.reachable) {
      rows.push(`<div>当前账号：<b>${esc(loggedIn ? (webui.nick || '未知昵称') : '未登录')}</b>`
        + `${webui.uin ? ` <span class="mono">${esc(webui.uin)}</span>` : ''}</div>`);
      rows.push(`<div class="hint">核心：${esc(webui.coreReady ? '在线' : (webui.isOffline ? '离线' : '启动中'))}`
        + ` · WebUI：<span class="mono">${esc(webui.webuiUrl || '')}</span>`
        + ` · 令牌：${esc(webui.tokenSource === 'auto' ? '自动读取' : (webui.tokenSource === 'settings' ? '面板填写' : '-'))}</div>`);
    }
    if (webui?.loginError) rows.push(`<div class="hint" style="color:var(--bad)">登录错误：${esc(webui.loginError)}</div>`);
    body.innerHTML = rows.join('');
    const quickBox = $('s-login-quick');
    if (!quickBox) return;
    const quick = (!loggedIn && data?.quick) || [];
    quickBox.innerHTML = quick.map((q) => `<button class="btn ghost" data-uin="${esc(q.uin)}" type="button">${esc(q.nick || q.uin)}（${esc(q.uin)}）</button>`).join(' ');
    quickBox.querySelectorAll('button[data-uin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = await req('/napcat/login/quick', { method: 'POST', body: { uin: btn.dataset.uin } });
        if (!r.ok) { toast(r.error?.message || '快速登录失败', true); btn.disabled = false; return; }
        toast(`已提交登录 ${btn.dataset.uin}，几秒后生效`);
        setTimeout(() => { void loadLogin(); }, 3000);
      });
    });
  }
  async function loadLogin() {
    const r = await req('/napcat/login');
    if (state.loginTimer) { clearInterval(state.loginTimer); state.loginTimer = null; }
    if (!r.ok) { toast(r.error?.message || '读取登录状态失败', true); return null; }
    paintLogin(r.data);
    const webui = r.data?.webui;
    if (webui && webui.reachable && !webui.isLogin) {
      state.loginTimer = setInterval(async () => {
        if (!$('s-login-body')) { clearInterval(state.loginTimer); state.loginTimer = null; return; }
        const s2 = await req('/napcat/login');
        if (!s2.ok) return;
        paintLogin(s2.data);
        if (s2.data?.webui?.isLogin) {
          clearInterval(state.loginTimer);
          state.loginTimer = null;
          $('s-login-qr').innerHTML = '';
          toast('QQ 已登录：' + (s2.data.account?.nickname || s2.data.account?.selfId || ''));
          void loadBoot();
        }
      }, 2500);
    }
    return r.data;
  }
  async function showLoginQr(refresh) {
    const box = $('s-login-qr');
    const r = await req('/napcat/login/qr', { method: 'POST', body: { refresh: !!refresh } });
    if (!r.ok) { toast(r.error?.message || '取二维码失败', true); return; }
    if (box) {
      box.innerHTML = `<div class="row" style="align-items:flex-start;gap:14px">
        <img src="${r.data.dataUrl}" alt="QQ 登录二维码" style="width:168px;height:168px;border-radius:8px;background:#fff">
        <div class="hint" style="max-width:340px">用手机 QQ 扫码并确认登录；二维码约 2 分钟有效，过期重新点「扫码登录」。</div></div>`;
    }
  }
  $('s-login-refresh')?.addEventListener('click', () => { void loadLogin(); });
  $('s-login-qr-btn')?.addEventListener('click', () => { void showLoginQr($('s-login-qr')?.innerHTML ? true : false); });
  void loadLogin();

  $('s-save').addEventListener('click', async () => {
    s.autoConnect = $('s-auto').checked;
    s.watchJoinRequests = $('s-watch').checked;
    s.panel.enabled = $('s-panel').checked;
    s.panel.host = $('s-host').value.trim();
    s.panel.port = Number($('s-port').value);
    const notifyName = $('s-notify-name').value.trim();
    const notifyUid = $('s-notify-uid').value.trim();
    if (!notifyName && notifyUid) {
      return toast('填写 QQ 号时请同时填写昵称', true);
    }
    var pendingVerify = false;
    if (notifyName) {
      const verified = await verifyNotify(true);
      if (verified && verified.matched === false && verified.definite) {
        return toast(verified.reason || '通知对象校验未通过，已阻止保存', true);
      }
      pendingVerify = !!(verified && verified.matched === false);
    }
    s.panel.notifyName = notifyName;
    s.panel.notifyOpenid = notifyUid;
    s.commands.enabled = $('s-cmd').checked;
    s.commands.naturalEnabled = $('s-natural').checked;
    s.commands.followUpSec = Number($('s-follow-up').value);
    s.commands.restartConfirmSec = Number($('s-restart-confirm').value);
    s.commands.prefix = $('s-cmd-prefix').value.trim() || '/';
    s.commands.allowUsers = parseLines($('s-cmd-users').value);
    s.commands.ruleText = $('s-rule').value;
    s.ai.master = $('ai-master').checked;
    s.ai.enabled = $('ai-enabled').checked;
    s.ai.provider = $('ai-provider').value === 'dsh' ? 'dsh' : 'openai';
    s.ai.baseUrl = $('ai-base').value.trim();
    const aiKey = $('ai-key').value;
    if (aiKey) s.ai.apiKey = aiKey;
    s.ai.model = $('ai-model').value.trim();
    s.ai.timeoutMs = Number($('ai-timeout').value);
    s.ai.maxTokens = Number($('ai-tokens').value);
    s.ai.minConfidence = Number($('ai-minconf').value);
    s.ai.vision.enabled = $('ai-vision').checked;
    s.ai.vision.maxImages = Number($('ai-max-images').value);
    s.ai.vision.maxBytes = Math.round(Number($('ai-max-mb').value) * 1024 * 1024);
    s.ai.moderation.enabled = $('ai-mod').checked;
    s.ai.moderation.mode = $('ai-mod-mode').value;
    s.ai.moderation.analyzeImages = $('ai-img').checked;
    s.ai.moderation.minChars = Number($('ai-mod-min').value);
    s.ai.moderation.maxPerMinute = Number($('ai-mod-rate').value);
    s.ai.join.enabled = $('ai-join').checked;
    s.ai.join.mode = $('ai-join-mode').value;
    s.ai.join.schedule.mode = $('ai-join-sched').value;
    s.ai.join.schedule.dayStart = Number($('ai-day-start').value);
    s.ai.join.schedule.dayEnd = Number($('ai-day-end').value);
    s.ai.join.schedule.idleMinutes = Number($('ai-idle').value);
    s.ai.quiz.enabled = $('ai-quiz').checked;
    s.ai.quiz.mode = $('ai-quiz-mode').value;
    s.ai.quiz.judge = $('ai-quiz-judge').checked;
    s.napcat = s.napcat || {};
    s.napcat.enabled = $('s-napcat-enabled').checked;
    s.napcat.autoSync = $('s-napcat-auto').checked;
    s.napcat.autoDetect = $('s-napcat-detect').checked;
    s.napcat.noCache = $('s-napcat-nocache').checked;
    s.napcat.wsUrl = $('s-napcat-url').value.trim();
    const napcatToken = $('s-napcat-token').value;
    if (napcatToken) s.napcat.token = napcatToken;
    s.napcat.webuiUrl = $('s-napcat-webui-url').value.trim();
    const webuiToken = $('s-napcat-webui-token').value;
    if (webuiToken) s.napcat.webuiToken = webuiToken;
    s.napcat.cacheTtlMs = Math.max(0, Math.round(Number($('s-napcat-ttl').value) || 0)) * 60000;
    s.napcat.timeoutMs = Number($('s-napcat-timeout').value) || 4000;
    const map = {};
    for (const line of parseLines($('s-napcat-map').value)) {
      const m = line.match(/^([^\s=]+)\s*[=:：]\s*(\d{5,12})$/u);
      if (m) map[m[1].trim()] = m[2];
    }
    s.napcat.groupMap = map;
    s.natural = s.natural || {};
    s.language = $('s-language').value === 'en' ? 'en' : 'zh-CN';
    s.natural.aiFirst = $('s-nat-aifirst').checked;
    s.natural.reviewWeeks = Math.min(10, Math.max(1, Math.round(Number($('s-nat-review').value) || 3)));
    s.natural.weeklyCommands = Number($('s-nat-weekly').value) || 100;
    s.natural.notifyUid = $('s-nat-notify').value.trim();
    const natKeywords = [];
    for (const line of String($('s-nat-keywords').value || '').split(/\r?\n/u)) {
      const text = line.trim();
      if (!text) continue;
      const m = text.match(/^([^=]+?)\s*=\s*([a-z][a-z0-9-]*)$/u);
      if (!m) continue;
      natKeywords.push({ phrase: m[1].trim().slice(0, 20), action: m[2] });
      if (natKeywords.length >= 15) break;
    }
    s.natural.keywords = natKeywords;
    await savePatch(sectionPatch(['language', 'autoConnect', 'watchJoinRequests', 'panel', 'commands', 'natural', 'ai', 'napcat']));
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
    const r = await req('/config/export?secrets=0');
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

