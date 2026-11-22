/* QQ 群管家 — 浏览器半边（手写模块，无需构建）。
 * 注册「设置 → QQ 群管家」整页，所有数据走同源 /api/qqbot-guard/*。
 * 标签页、字段与独立局域网面板保持一致，避免两处设置不一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-guard',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var API = 'api/qqbot-guard/';

    var CSS = [
      '.qqg-root{color:var(--dsw-alias-text-primary,#1f2329);font-size:13px;line-height:1.55;background:transparent;padding:4px 2px 20px}',
      '.qqg-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
      '.qqg-title{font-size:16px;font-weight:650}',
      '.qqg-sub{color:var(--dsw-alias-text-secondary,#6b7280);font-size:12px}',
      '.qqg-spacer{flex:1}',
      '.qqg-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-primary,#e5e6eb);margin-bottom:14px}',
      '.qqg-tab{border:0;background:transparent;color:var(--dsw-alias-text-secondary,#6b7280);padding:8px 12px;border-radius:8px 8px 0 0;cursor:pointer;font:inherit}',
      '.qqg-tab[data-on="1"]{color:#6b5ae6;background:rgba(124,108,240,.10);font-weight:600;box-shadow:inset 0 -2px 0 #6b5ae6}',
      '.qqg-card{background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-primary,#e5e6eb);border-radius:10px;padding:14px;margin-bottom:12px}',
      '.qqg-card h4{margin:0 0 10px;font-size:13.5px;font-weight:650;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.qqg-card h4 .qqg-sub{font-weight:400}',
      '.qqg-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}',
      '.qqg-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;min-width:160px}',
      '.qqg-field>span{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.qqg-in,.qqg-ta,.qqg-sel{border:1px solid var(--dsw-alias-border-primary,#d7dae0);background:var(--dsw-alias-bg-primary,#fff);color:inherit;border-radius:6px;padding:6px 8px;font:inherit;min-height:30px;box-sizing:border-box}',
      '.qqg-ta{min-height:88px;resize:vertical;width:100%}',
      '.qqg-in:focus,.qqg-ta:focus,.qqg-sel:focus{outline:2px solid rgba(107,90,230,.35);border-color:#6b5ae6}',
      '.qqg-btn{border:1px solid var(--dsw-alias-border-primary,#d7dae0);background:var(--dsw-alias-bg-primary,#fff);color:inherit;border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit;white-space:nowrap}',
      '.qqg-btn:hover{border-color:#6b5ae6;color:#6b5ae6}',
      '.qqg-btn[data-v="primary"]{background:#6b5ae6;border-color:#6b5ae6;color:#fff;font-weight:600}',
      '.qqg-btn[data-v="primary"]:hover{background:#5b4bd6;color:#fff}',
      '.qqg-btn[data-v="danger"]{color:#d33;border-color:rgba(221,51,51,.45);background:rgba(221,51,51,.06)}',
      '.qqg-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.qqg-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:11.5px;border:1px solid transparent}',
      '.qqg-pill[data-t="ok"]{background:rgba(31,158,79,.12);color:#1f9e4f;border-color:rgba(31,158,79,.3)}',
      '.qqg-pill[data-t="warn"]{background:rgba(217,119,6,.12);color:#b45309;border-color:rgba(217,119,6,.3)}',
      '.qqg-pill[data-t="bad"]{background:rgba(221,51,51,.1);color:#c22;border-color:rgba(221,51,51,.3)}',
      '.qqg-pill[data-t="off"]{background:rgba(107,114,128,.12);color:#6b7280;border-color:rgba(107,114,128,.25)}',
      '.qqg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}',
      '.qqg-stat{border:1px solid var(--dsw-alias-border-primary,#eceef2);border-radius:8px;padding:10px 12px}',
      '.qqg-stat b{display:block;font-size:20px;line-height:1.25}',
      '.qqg-stat span{font-size:11.5px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.qqg-list{display:flex;flex-direction:column;gap:8px}',
      '.qqg-item{border:1px solid var(--dsw-alias-border-primary,#eceef2);border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start}',
      '.qqg-item .qqg-main{flex:1;min-width:0}',
      '.qqg-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-text-secondary,#6b7280);word-break:break-all}',
      '.qqg-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.qqg-table th,.qqg-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-primary,#eceef2);vertical-align:top}',
      '.qqg-table th{color:var(--dsw-alias-text-secondary,#6b7280);font-weight:500}',
      '.qqg-table-wrap{overflow-x:auto}',
      '.qqg-toast{position:sticky;bottom:8px;margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(31,158,79,.12);border:1px solid rgba(31,158,79,.3);color:#187a3d;font-size:12px}',
      '.qqg-toast[data-err="1"]{background:rgba(221,51,51,.1);border-color:rgba(221,51,51,.3);color:#b02020}',
      '.qqg-note{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);background:rgba(124,108,240,.07);border:1px solid rgba(124,108,240,.2);border-radius:8px;padding:8px 10px;margin:8px 0}',
      '.qqg-hint{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.qqg-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;margin:0 14px 8px 0}',
      '.qqg-empty{padding:28px 0;text-align:center;color:var(--dsw-alias-text-secondary,#8a919c);font-size:12.5px}',
      '.qqg-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:12px}',
      '.qqg-kv dt{color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.qqg-kv dd{margin:0;word-break:break-all}',
      '.qqg-device{display:grid;grid-template-columns:minmax(220px,280px) 1fr;grid-template-areas:"id metrics" "sys metrics";gap:12px;background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-primary,#e5e6eb);border-radius:10px;padding:14px;margin-bottom:12px}',
      '.qqg-device-id{grid-area:id;display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #eceef2;border-radius:8px;background:#f7f8fd}',
      '.qqg-avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#6b5ae6,#8d7bf0);color:#fff;font-weight:700;font-size:14px;flex:none}',
      '.qqg-device-sys{grid-area:sys;padding:12px;border:1px solid #eceef2;border-radius:8px;background:#f7f8fd}',
      '.qqg-device-metrics{grid-area:metrics;display:grid;gap:10px}',
      '.qqg-metric{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;border:1px solid #eceef2;border-radius:8px;background:#f7f8fd}',
      '.qqg-gauge{--p:0;width:82px;height:82px;border-radius:50%;flex:none;display:grid;place-items:center;background:conic-gradient(#6b5ae6 calc(var(--p)*1%),#e8eaf2 0)}',
      '.qqg-gauge>div{width:66px;height:66px;border-radius:50%;background:var(--dsw-alias-bg-primary,#fff);display:grid;place-items:center;text-align:center;font-size:11.5px;line-height:1.3}',
      '.qqg-gauge b{font-size:14px}',
      '@media(max-width:760px){.qqg-device{grid-template-columns:1fr;grid-template-areas:"id" "sys" "metrics"}}',
    ].join('');

    function ensureCss() {
      try {
        if (document.getElementById('qqg-style')) return;
        var el = document.createElement('style');
        el.id = 'qqg-style';
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch (e) { /* ignore */ }
    }

    async function api(path, body) {
      var init = body === undefined
        ? { cache: 'no-store' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-qqbot-guard': '1' },
          body: JSON.stringify(body),
        };
      try {
        var res = await fetch(API + path, init);
        var json = await res.json();
        if (!json || typeof json !== 'object') return { ok: false, error: { message: '响应格式异常' } };
        return json;
      } catch (e) {
        return { ok: false, error: { message: '无法连接插件接口：' + (e && e.message ? e.message : String(e)) } };
      }
    }

    function fmtTime(iso) {
      if (!iso) return '-';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '-';
      return d.toLocaleString('zh-CN', { hour12: false });
    }

    function fmtDuration(ms) {
      var n = Math.max(0, Number(ms) || 0);
      var m = Math.floor(n / 60000);
      if (m < 60) return m + ' 分钟';
      var hh = Math.floor(m / 60);
      if (hh < 24) return hh + ' 小时 ' + (m % 60) + ' 分';
      return Math.floor(hh / 24) + ' 天 ' + (hh % 24) + ' 小时';
    }

    function fmtBytes(n) {
      var v = Number(n) || 0;
      if (v < 1024) return v + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      var value = v / 1024;
      var i = 0;
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
      return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
    }

    function statusView(status) {
      if (!status) return { t: 'off', label: '未初始化' };
      if (!status.configured) return { t: 'off', label: '未配置凭据' };
      if (status.state === 'online') return { t: 'ok', label: '在线' };
      if (status.state === 'connecting') return { t: 'warn', label: '连接中' };
      if (status.state === 'error') return { t: 'bad', label: '连接失败' };
      if (status.state === 'unconfigured') return { t: 'off', label: '未配置' };
      return { t: 'off', label: '已断开' };
    }

    function listToLines(list) {
      return (Array.isArray(list) ? list : []).join('\n');
    }
    function linesToList(text) {
      var seen = {};
      var out = [];
      String(text || '').split(/\r?\n|,|，/u).forEach(function (raw) {
        var s = raw.trim();
        if (!s || seen[s]) return;
        seen[s] = true;
        out.push(s);
      });
      return out;
    }
    /** 只按换行拆分：欢迎语里允许出现逗号 */
    function linesToListOnly(text) {
      var seen = {};
      var out = [];
      String(text || '').split(/\r?\n/u).forEach(function (raw) {
        var s = raw.trim();
        if (!s || seen[s]) return;
        seen[s] = true;
        out.push(s);
      });
      return out;
    }
    function setIn(obj, path, value) {
      var keys = path.split('.');
      var root = Array.isArray(obj) ? obj.slice() : Object.assign({}, obj);
      var cur = root;
      for (var i = 0; i < keys.length - 1; i++) {
        var k = keys[i];
        var next = cur[k];
        cur[k] = next && typeof next === 'object' ? (Array.isArray(next) ? next.slice() : Object.assign({}, next)) : {};
        cur = cur[k];
      }
      cur[keys[keys.length - 1]] = value;
      return root;
    }
    function getIn(obj, path, fallback) {
      var cur = obj;
      var keys = path.split('.');
      for (var i = 0; i < keys.length; i++) {
        if (cur == null) return fallback;
        cur = cur[keys[i]];
      }
      return cur === undefined ? fallback : cur;
    }
    function download(name, text) {
      try {
        var blob = new Blob([text], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      } catch (e) { /* ignore */ }
    }
    function csvCell(v) {
      return '"' + String(v == null ? '' : v).replace(/"/gu, '""') + '"';
    }

    function Btn(props) {
      return h('button', {
        className: 'qqg-btn',
        'data-v': props.variant || '',
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
        style: props.style,
      }, props.children);
    }

    function Field(props) {
      return h('label', { className: 'qqg-field', style: props.wide ? { width: '100%' } : undefined },
        h('span', null, props.label),
        props.children,
        props.hint ? h('span', { style: { fontSize: 11, opacity: .75 } }, props.hint) : null);
    }

    function TextInput(props) {
      return h('input', {
        className: 'qqg-in',
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder || '',
        type: props.type || 'text',
        disabled: !!props.disabled,
        onChange: function (e) { props.onChange(e.target.value); },
        style: props.style,
      });
    }

    function NumberInput(props) {
      return h('input', {
        className: 'qqg-in',
        value: props.value == null ? '' : String(props.value),
        type: 'number',
        min: props.min,
        max: props.max,
        step: props.step,
        disabled: !!props.disabled,
        onChange: function (e) { props.onChange(Number(e.target.value)); },
        style: { width: 110 },
      });
    }

    function TextArea(props) {
      return h('textarea', {
        className: 'qqg-ta',
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder || '',
        onChange: function (e) { props.onChange(e.target.value); },
        style: props.style,
      });
    }

    function Check(props) {
      return h('label', { className: 'qqg-check' },
        h('input', { type: 'checkbox', checked: !!props.checked, onChange: function (e) { props.onChange(e.target.checked); } }),
        props.label);
    }

    function Select(props) {
      return h('select', {
        className: 'qqg-sel',
        value: props.value,
        disabled: !!props.disabled,
        onChange: function (e) { props.onChange(e.target.value); },
        style: props.style,
      }, props.options.map(function (o) {
        return h('option', { key: o.value, value: o.value }, o.label);
      }));
    }

    function Toast(props) {
      if (!props.text) return null;
      return h('div', { className: 'qqg-toast', 'data-err': props.error ? '1' : '0' }, props.text);
    }

    function Empty(props) {
      return h('div', { className: 'qqg-empty' }, props.text || '暂无数据');
    }

    function StatusTag(props) {
      var s = statusView(props.status);
      return h('span', { className: 'qqg-pill', 'data-t': s.t },
        h('span', {
          style: {
            width: 7, height: 7, borderRadius: '50%', background: 'currentColor', display: 'inline-block',
          },
        }),
        s.label,
        props.status && props.status.degraded ? '（降级）' : '');
    }

    var ACTION_OPTIONS = [
      { value: 'warn', label: '警告' },
      { value: 'mute', label: '禁言' },
      { value: 'kick', label: '移出群聊' },
    ];

    /** AI 厂商预设：选一个就自动填好接口地址与默认模型 */
    var AI_PRESETS = [
      { id: 'dsh', label: 'DSH 当前会话模型', baseUrl: '', model: '' },
      { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      { id: 'doubao', label: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115' },
      { id: 'qwen', label: '通义千问（阿里百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
      { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      { id: 'xiaomi', label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro' },
      { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
      { id: 'lmstudio', label: '本地 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
    ];

    var TABS = [
      { id: 'overview', label: '总览' },
      { id: 'moderation', label: '违规防护' },
      { id: 'join', label: '入群' },
      { id: 'announcements', label: '公告' },
      { id: 'groups', label: '群与成员' },
      { id: 'blacklist', label: '黑名单' },
      { id: 'audit', label: '审计' },
      { id: 'changelog', label: '修改日志' },
      { id: 'settings', label: '设置' },
    ];

    function QqGuardPanel(props) {
      var bootState = useState(null);
      var boot = bootState[0];
      var setBoot = bootState[1];
      var tabState = useState('overview');
      var tab = tabState[0];
      var setTab = tabState[1];
      var errState = useState('');
      var error = errState[0];
      var setError = errState[1];
      var toastState = useState(null);
      var toast = toastState[0];
      var setToast = toastState[1];

      useEffect(function () {
        ensureCss();
      }, []);

      async function load() {
        var r = await api('bootstrap');
        if (r.ok) {
          setBoot(r.data);
          setError('');
        } else {
          setError((r.error && r.error.message) || '加载失败');
        }
      }

      useEffect(function () {
        var alive = true;
        load();
        var timer = setInterval(function () {
          if (!alive) return;
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          api('status').then(function (r) {
            if (!alive || !r.ok) return;
            setBoot(function (prev) {
              if (!prev) return prev;
              return Object.assign({}, prev, {
                status: r.data.status,
                panel: r.data.panel || prev.panel,
                device: r.data.device || prev.device,
                ai: r.data.ai || prev.ai,
                counts: Object.assign({}, prev.counts, { counters: r.data.counts }),
              });
            });
          });
        }, 8000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      function notify(text, isErr) {
        setToast({ text: text, error: !!isErr });
        setTimeout(function () { setToast(null); }, 3200);
      }

      async function savePatch(patch) {
        var r = await api('settings', { patch: patch });
        if (r.ok) {
          setBoot(function (prev) { return prev ? Object.assign({}, prev, { settings: r.data }) : prev; });
          notify('设置已保存并热生效');
          return true;
        }
        notify((r.error && r.error.message) || '保存失败', true);
        return false;
      }

      if (error) {
        return h('div', { className: 'qqg-root' },
          h('div', { className: 'qqg-card' },
            h('h4', null, 'QQ 群管家'),
            h('div', { className: 'qqg-note' }, error),
            h(Btn, { variant: 'primary', onClick: load }, '重试')));
      }
      if (!boot) return h('div', { className: 'qqg-root' }, h(Empty, { text: '正在加载 QQ 群管家…' }));

      var common = { boot: boot, savePatch: savePatch, reload: load, notify: notify };
      var body;
      if (tab === 'moderation') body = h(ModerationTab, common);
      else if (tab === 'join') body = h(JoinTab, common);
      else if (tab === 'announcements') body = h(AnnouncementsTab, common);
      else if (tab === 'groups') body = h(GroupsTab, common);
      else if (tab === 'blacklist') body = h(BlacklistTab, common);
      else if (tab === 'audit') body = h(AuditTab, common);
      else if (tab === 'changelog') body = h(ChangelogTab, common);
      else if (tab === 'settings') body = h(SettingsTab, common);
      else body = h(OverviewTab, common);

      return h('div', { className: 'qqg-root' },
        h('div', { className: 'qqg-head' },
          h('div', null,
            h('div', { className: 'qqg-title' }, 'QQ 群管家'),
            h('div', { className: 'qqg-sub' }, '违规防护 · 入群审批 · 入群欢迎 · 公告管理（不调用 AI）')),
          h('div', { className: 'qqg-spacer' }),
          h(StatusTag, { status: boot.status }),
          h(Btn, { onClick: load }, '刷新')),
        h('div', { className: 'qqg-tabs' }, TABS.map(function (t) {
          return h('button', {
            key: t.id,
            className: 'qqg-tab',
            'data-on': tab === t.id ? '1' : '0',
            type: 'button',
            onClick: function () { setTab(t.id); },
          }, t.label);
        })),
        body,
        h(Toast, { text: toast && toast.text, error: toast && toast.error }),
        props && props.close
          ? h('div', { style: { textAlign: 'right' } }, h(Btn, { onClick: props.close }, '关闭'))
          : null);
    }

    function OverviewTab(props) {
      var boot = props.boot;
      var st = boot.status || {};
      var c = (boot.counts && boot.counts.counters) || {};
      var d = boot.device || {};
      var panel = boot.panel || {};
      var s = statusView(st);
      var appId = (boot.settings && boot.settings.appId) || st.appIdMasked || '未配置';
      var cpuPct = Math.max(0, Math.min(100, Number(d.cpuUsage) || 0));
      var memPct = Math.max(0, Math.min(100, Number(d.memUsage) || 0));
      var cpuSpeed = d.cpuSpeedMhz ? (Number(d.cpuSpeedMhz) / 1000).toFixed(2) : '-';
      var stats = [
        { label: '今日拦截', value: c.blocked || 0 },
        { label: '警告', value: c.warns || 0 },
        { label: '禁言', value: c.mutes || 0 },
        { label: '移出', value: c.kicks || 0 },
        { label: '入群通过', value: c.approvals || 0 },
        { label: '入群拒绝', value: c.declines || 0 },
        { label: '欢迎', value: c.welcomes || 0 },
        { label: '公告', value: c.announces || 0 },
      ];
      function gauge(pct, label) {
        return h('div', { className: 'qqg-gauge', style: { '--p': pct } },
          h('div', null, h('b', null, Math.round(pct) + '%'), h('span', { className: 'qqg-sub' }, label)));
      }
      return h('div', null,
        h('div', { className: 'qqg-device' },
          h('div', { className: 'qqg-device-id' },
            h('div', { className: 'qqg-avatar' }, 'QQ'),
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { style: { fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 } },
                'QQ 机器人',
                h('span', { className: 'qqg-pill', 'data-t': s.t }, s.label)),
              h('div', { className: 'qqg-mono' }, appId))),
          h('div', { className: 'qqg-device-sys' },
            h('h4', null, '系统信息'),
            h('dl', { className: 'qqg-kv' },
              h('dt', null, '插件版本'), h('dd', null, 'v' + (boot.version || '')),
              h('dt', null, 'WebUI 版本'), h('dd', null, 'v' + (d.webuiVersion || boot.version || '')),
              h('dt', null, 'NapCat 版本'), h('dd', null, d.napcatVersion || '未接入'),
              h('dt', null, '系统版本'), h('dd', null, d.systemVersion || '-')),
            h('div', { className: 'qqg-hint', style: { marginTop: 8 } }, '使用 QQ 官方 Bot API，不依赖 NapCat / QQ 客户端。')),
          h('div', { className: 'qqg-device-metrics' },
            h('div', { className: 'qqg-metric' },
              h('div', null,
                h('h4', null, 'CPU'),
                h('dl', { className: 'qqg-kv' },
                  h('dt', null, '型号'), h('dd', null, d.cpuModel || '未知'),
                  h('dt', null, '内核数'), h('dd', null, (Number(d.cpuCores) || 0) + ' 核 · ' + cpuSpeed + ' GHz'),
                  h('dt', null, '运行时长'), h('dd', null, fmtDuration(d.processUptimeMs)))),
              gauge(cpuPct, 'CPU 占用')),
            h('div', { className: 'qqg-metric' },
              h('div', null,
                h('h4', null, '内存'),
                h('dl', { className: 'qqg-kv' },
                  h('dt', null, '总量'), h('dd', null, fmtBytes(d.memTotal)),
                  h('dt', null, '使用量'), h('dd', null, fmtBytes(d.memUsed)),
                  h('dt', null, '本进程'), h('dd', null, fmtBytes(d.processRss)))),
              gauge(memPct, '内存占用')),
            h('div', { className: 'qqg-hint', style: { textAlign: 'right' } },
              'Node ' + (d.nodeVersion || '-') + ' · ' + (d.hostName || '-') + ' · 系统运行 ' + fmtDuration(d.systemUptimeMs)))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '连接状态'),
          h('div', { className: 'qqg-row', style: { gap: 18 } },
            h('div', null, h('div', { className: 'qqg-sub' }, 'AppID'), h('div', { className: 'qqg-mono' }, st.appIdMasked || '-')),
            h('div', null, h('div', { className: 'qqg-sub' }, '已连接时长'), h('div', null, st.connectedAt ? fmtDuration(Date.now() - Date.parse(st.connectedAt)) : '-')),
            h('div', null, h('div', { className: 'qqg-sub' }, '群数量'), h('div', null, String((boot.counts && boot.counts.groupCount) || 0))),
            h('div', null, h('div', { className: 'qqg-sub' }, '待审批'), h('div', null, String((boot.counts && boot.counts.pendingCount) || 0))),
            h('div', null, h('div', { className: 'qqg-sub' }, '数据目录'), h('div', { className: 'qqg-mono' }, boot.dataDir || ''))),
          st.lastError ? h('div', { className: 'qqg-note' }, '最近错误：' + st.lastError) : null,
          st.degraded ? h('div', { className: 'qqg-note' }, '入群申请事件未授权，已降级为普通群事件。') : null),
        h('div', { className: 'qqg-card' },
          h('h4', null, '今日统计'),
          h('div', { className: 'qqg-grid' }, stats.map(function (x) {
            return h('div', { className: 'qqg-stat', key: x.label }, h('b', null, String(x.value)), h('span', null, x.label));
          }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '局域网面板'),
          h('div', { className: 'qqg-row', style: { gap: 18 } },
            h('div', null, h('div', { className: 'qqg-sub' }, '状态'), h('div', null, panel.running ? '运行中' : '未启动')),
            h('div', null, h('div', { className: 'qqg-sub' }, '监听'), h('div', { className: 'qqg-mono' }, (panel.host || '-') + ':' + (panel.port || '-'))),
            h('div', null, h('div', { className: 'qqg-sub' }, '访问地址'), h('div', { className: 'qqg-mono' }, (panel.urls || []).join(' · ') || '-'))),
          panel.lastError ? h('div', { className: 'qqg-note' }, '启动失败：' + panel.lastError) : null),
        h('div', { className: 'qqg-card' },
          h('h4', null, '最近操作'),
          boot.audit && boot.audit.length
            ? h('div', { className: 'qqg-table-wrap' }, h('table', { className: 'qqg-table' },
              h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '类型'), h('th', null, '动作'), h('th', null, '群'), h('th', null, '对象'), h('th', null, '详情'))),
              h('tbody', null, boot.audit.slice(0, 12).map(function (a, i) {
                return h('tr', { key: i },
                  h('td', null, fmtTime(a.at)),
                  h('td', null, a.kind),
                  h('td', null, a.action),
                  h('td', { className: 'qqg-mono' }, a.groupName || a.groupId || '-'),
                  h('td', { className: 'qqg-mono' }, a.userName || a.userId || '-'),
                  h('td', null, a.detail || ''));
              }))))
            : h(Empty, { text: '还没有操作记录' })));
    }

    function ModerationTab(props) {
      var sState = useState(props.boot.settings.moderation);
      var draft = sState[0];
      var setDraft = sState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      useEffect(function () { setDraft(props.boot.settings.moderation); }, [props.boot.settings]);

      function set(path, value) { setDraft(setIn(draft, path, value)); }
      async function doSave() {
        setSaving(true);
        await props.savePatch({ moderation: draft });
        setSaving(false);
      }
      var trusted = draft.trustedUsers || [];

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '基础策略'),
          h(Check, { checked: draft.enabled, label: '启用违规防护', onChange: function (v) { set('enabled', v); } }),
          h(Check, { checked: draft.fuzzy.enabled, label: '模糊变体匹配', onChange: function (v) { set('fuzzy.enabled', v); } }),
          h(Check, { checked: draft.media.detectImages, label: '检测图片广告', onChange: function (v) { set('media.detectImages', v); } }),
          h(Check, { checked: draft.media.detectCards, label: '检测卡片/名片', onChange: function (v) { set('media.detectCards', v); } }),
          h('div', { className: 'qqg-note' }, '提示：需要在 QQ 开放平台为机器人开通「群聊全量消息」权限并设为群管理员，否则只能看到 @ 机器人的消息，无法覆盖全部群聊。'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '命中后的动作' }, h(Select, { value: draft.action, onChange: function (v) { set('action', v); }, options: ACTION_OPTIONS })),
            h(Field, { label: '禁言时长（秒）' }, h(NumberInput, { value: draft.muteSeconds, min: 1, max: 2592000, onChange: function (v) { set('muteSeconds', v); } })),
            h(Field, { label: '同一用户冷却（秒）' }, h(NumberInput, { value: draft.cooldownSec, min: 0, max: 86400, onChange: function (v) { set('cooldownSec', v); } }))),
          h(Field, { label: '警告文案（{user} 会被替换成 @成员）', wide: true },
            h(TextArea, { value: draft.warnTemplate || '', onChange: function (v) { set('warnTemplate', v); } })),
          h('div', { className: 'qqg-note' }, (props.boot.settings.ui && props.boot.settings.ui.notice) || '')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '规则'),
          h(Field, { label: '违规词（每行一个）', wide: true },
            h(TextArea, { value: listToLines(draft.keywords), onChange: function (v) { set('keywords', linesToList(v)); } })),
          h(Field, { label: '正则规则（每行一个，需符合 JS 正则语法）', wide: true },
            h(TextArea, { value: listToLines(draft.regexes), onChange: function (v) { set('regexes', linesToList(v)); } })),
          h(Field, { label: '额外模糊别名（每行一个，格式：别名=标准词）', wide: true },
            h(TextArea, { value: listToLines(draft.fuzzy.extras), onChange: function (v) { set('fuzzy.extras', linesToList(v)); } })),
          h(Field, { label: '图片广告关键词（每行一个）', wide: true },
            h(TextArea, { value: listToLines(draft.media.adKeywords), onChange: function (v) { set('media.adKeywords', linesToList(v)); } }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '刷屏与升级处理'),
          h(Check, { checked: draft.spam.enabled, label: '启用刷屏检测', onChange: function (v) { set('spam.enabled', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '统计窗口（秒）' }, h(NumberInput, { value: draft.spam.windowSec, min: 1, max: 600, onChange: function (v) { set('spam.windowSec', v); } })),
            h(Field, { label: '窗口内消息数' }, h(NumberInput, { value: draft.spam.maxMessages, min: 2, max: 100, onChange: function (v) { set('spam.maxMessages', v); } }))),
          h(Check, { checked: draft.escalation.enabled, label: '启用多次违规升级', onChange: function (v) { set('escalation.enabled', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '第几次违规升级' }, h(NumberInput, { value: draft.escalation.violations, min: 1, max: 100, onChange: function (v) { set('escalation.violations', v); } })),
            h(Field, { label: '统计窗口（小时）' }, h(NumberInput, { value: draft.escalation.windowHours, min: 1, max: 720, onChange: function (v) { set('escalation.windowHours', v); } })),
            h(Field, { label: '升级动作' }, h(Select, { value: draft.escalation.action, onChange: function (v) { set('escalation.action', v); }, options: ACTION_OPTIONS }))),
          h(Field, { label: '豁免群 openid（每行一个，只记录不处置）', wide: true },
            h(TextArea, { value: listToLines(draft.exemptGroups), onChange: function (v) { set('exemptGroups', linesToList(v)); } }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '链接与黑名单'),
          h(Check, { checked: draft.detectLinks, label: '检测可疑链接（域名白名单外）', onChange: function (v) { set('detectLinks', v); } }),
          h(Field, { label: '链接白名单（每行一个域名）', wide: true },
            h(TextArea, { value: listToLines(draft.linkWhitelist), onChange: function (v) { set('linkWhitelist', linesToList(v)); } })),
          h(Check, { checked: draft.blacklist.enabled, label: '启用累计黑名单', onChange: function (v) { set('blacklist.enabled', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '第几次违规触发' }, h(NumberInput, { value: draft.blacklist.threshold, min: 1, max: 100, onChange: function (v) { set('blacklist.threshold', v); } })),
            h(Field, { label: '统计窗口（天）' }, h(NumberInput, { value: draft.blacklist.windowDays, min: 1, max: 365, onChange: function (v) { set('blacklist.windowDays', v); } }))),
          h(Check, { checked: draft.blacklist.addToGroupBlacklist, label: '同时加入官方群黑名单', onChange: function (v) { set('blacklist.addToGroupBlacklist', v); } })),
        h('div', { className: 'qqg-card' },
          h('h4', null, '信任成员', h('span', { className: 'qqg-sub' }, '豁免处置，并允许使用群指令')),
          h('div', { className: 'qqg-list' },
            trusted.length
              ? trusted.map(function (u) {
                return h('div', { className: 'qqg-item', key: u.uid },
                  h('div', { className: 'qqg-main' },
                    h('div', { style: { fontWeight: 600 } }, u.name || '未备注'),
                    h('div', { className: 'qqg-mono' }, u.uid + (u.note ? ' · ' + u.note : ''))),
                  h(Btn, {
                    variant: 'danger',
                    onClick: function () {
                      set('trustedUsers', trusted.filter(function (x) { return x.uid !== u.uid; }));
                    },
                  }, '移除'));
              })
              : h(Empty, { text: '暂无信任成员' })),
          h(TrustedAdd, { onAdd: function (item) {
            if (!item.uid) return;
            set('trustedUsers', trusted.concat([{ uid: item.uid, name: item.name, note: '' }]));
          } })),
        h('div', { style: { textAlign: 'right' } },
          h(Btn, { variant: 'primary', disabled: saving, onClick: doSave }, saving ? '保存中…' : '保存违规防护设置')));
    }

    function MemberSearch(props) {
      var qState = useState('');
      var q = qState[0];
      var setQ = qState[1];
      var listState = useState([]);
      var list = listState[0];
      var setList = listState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      async function go() {
        setBusy(true);
        var r = await api('members?gid=' + encodeURIComponent(props.gid || '') + '&q=' + encodeURIComponent(q));
        setBusy(false);
        if (r.ok) setList(r.data.members || []);
      }
      return h('div', { style: props.style },
        h('div', { className: 'qqg-row' },
          h('div', { style: { flex: 1, minWidth: 180 } },
            h(TextInput, {
              value: q,
              placeholder: props.placeholder || '搜索成员昵称 / openid',
              onChange: setQ,
            })),
          h(Btn, { onClick: go, disabled: busy }, busy ? '搜索中…' : '搜索')),
        list.length
          ? h('div', { className: 'qqg-list', style: { marginTop: 8 } }, list.map(function (m) {
            return h('div', { className: 'qqg-item', key: (m.gid || '') + '|' + m.uid },
              h('div', { className: 'qqg-main' },
                h('div', { style: { fontWeight: 600 } }, m.name || '(无昵称)'),
                h('div', { className: 'qqg-mono' }, (m.gid || '') + ' · ' + m.uid)),
              h(Btn, { onClick: function () { props.onPick(m); } }, props.actionLabel || '选择'));
          }))
          : null);
    }

    function TrustedAdd(props) {
      return h('div', null,
        h(MemberSearch, {
          actionLabel: '添加为信任成员',
          onPick: function (m) {
            if (m && m.uid) props.onAdd({ uid: m.uid, name: m.name || '' });
          },
        }),
        h('div', { className: 'qqg-hint', style: { marginTop: 6 } },
          '搜不到时，让该成员先在群里发一句话，机器人才能看到。'));
    }

    function JoinTab(props) {
      var sState = useState(props.boot.settings.join);
      var draft = sState[0];
      var setDraft = sState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var pendingState = useState(props.boot.pending || []);
      var pending = pendingState[0];
      var setPending = pendingState[1];
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      var gidState = useState((props.boot.groups && props.boot.groups[0] && props.boot.groups[0].gid) || '');
      var syncGid = gidState[0];
      var setSyncGid = gidState[1];
      useEffect(function () { setDraft(props.boot.settings.join); }, [props.boot.settings]);
      useEffect(function () { setPending(props.boot.pending || []); }, [props.boot.pending]);
      var gState = useState(props.boot.settings.guest || {});
      var guestDraft = gState[0];
      var setGuestDraft = gState[1];
      useEffect(function () { setGuestDraft(props.boot.settings.guest || {}); }, [props.boot.settings]);

      function set(path, value) { setDraft(setIn(draft, path, value)); }
      function setGuest(path, value) { setGuestDraft(setIn(guestDraft, path, value)); }
      var join = draft;

      async function act(item, action) {
        setBusy(item.joinRequestId || item.memberOpenid || '');
        var r = await api('join', {
          action: action,
          gid: item.groupId || item.group_id || '',
          uid: item.memberOpenid,
          jid: item.joinRequestId,
          reason: '',
        });
        setBusy('');
        if (r.ok) {
          props.notify(action === 'approve' ? '已通过' : '已拒绝');
          setPending(pending.filter(function (x) {
            return !(x.groupId === item.groupId && x.joinRequestId === item.joinRequestId);
          }));
          props.reload();
        } else {
          props.notify((r.error && r.error.message) || '操作失败', true);
        }
      }

      async function refreshRemote() {
        if (!syncGid) return props.notify('还没有已登记的群', true);
        setBusy('refresh');
        var r = await api('join', { action: 'refresh', gid: syncGid });
        setBusy('');
        if (r.ok) {
          props.notify('已同步官方待审批列表：新增 ' + r.data.count);
          props.reload();
        } else {
          props.notify((r.error && r.error.message) || '同步失败', true);
        }
      }

      async function doSave() {
        setSaving(true);
        await props.savePatch({ join: draft });
        setSaving(false);
      }

      async function saveGuest() {
        setSaving(true);
        await props.savePatch({ guest: guestDraft });
        setSaving(false);
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '待审批', h('span', { className: 'qqg-sub' }, '群内事件与应用内同步')),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群' },
              h(Select, {
                value: syncGid,
                onChange: setSyncGid,
                options: (props.boot.groups || []).map(function (g) {
                  return { value: g.gid, label: (g.name || '(未命名群)') + ' · ' + g.gid };
                }),
                style: { minWidth: 260 },
              })),
            h(Btn, { disabled: busy === 'refresh', onClick: refreshRemote }, busy === 'refresh' ? '同步中…' : '从官方同步')),
          pending.length
            ? h('div', { className: 'qqg-list' }, pending.map(function (item, i) {
              var key = (item.groupId || '') + '|' + (item.joinRequestId || i);
              return h('div', { className: 'qqg-item', key: key },
                h('div', { className: 'qqg-main' },
                  h('div', null,
                    h('b', null, item.username || '未知昵称'), ' ',
                    h('span', { className: 'qqg-mono' }, item.memberOpenid || ''), ' ',
                    item.riskTips ? h('span', { className: 'qqg-pill', 'data-t': 'bad' }, '风险') : null, ' ',
                    item.aiVerdict
                      ? h('span', {
                        className: 'qqg-pill',
                        'data-t': item.aiVerdict === 'decline' ? 'bad' : item.aiVerdict === 'approve' ? 'ok' : 'warn',
                      }, `AI 建议：${item.aiVerdict === 'decline' ? '拒绝' : item.aiVerdict === 'approve' ? '通过' : '复核'}${item.aiConfidence ? ' ' + Number(item.aiConfidence).toFixed(2) : ''}`)
                      : null),
                  h('div', { className: 'qqg-sub' }, '验证：' + (item.verifyMessage || item.verify_message || '-') + ' · 来源：' + (item.applySource || '-')),
                  h('div', { className: 'qqg-mono' }, '群 ' + (item.groupId || '') + ' · ' + fmtTime(item.seenAt))),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h(Btn, { variant: 'primary', disabled: !!busy, onClick: function () { act(item, 'approve'); } }, '通过'),
                  h(Btn, { variant: 'danger', disabled: !!busy, onClick: function () { act(item, 'decline'); } }, '拒绝')));
            }))
            : h(Empty, { text: '暂无待审批申请' })),
        h('div', { className: 'qqg-card' },
          h('h4', null, '入群审批'),
          h(Check, { checked: join.autoApprove, label: '关键词匹配自动通过', onChange: function (v) { set('autoApprove', v); } }),
          h(Check, { checked: join.autoDeclineRisk, label: '风险账号自动拒绝', onChange: function (v) { set('autoDeclineRisk', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '通过关键词（每行一个）', wide: true },
              h(TextArea, { value: listToLines(join.approveKeywords), onChange: function (v) { set('approveKeywords', linesToList(v)); } })),
            h(Field, { label: '拒绝关键词（每行一个）', wide: true },
              h(TextArea, { value: listToLines(join.declineKeywords), onChange: function (v) { set('declineKeywords', linesToList(v)); } }))),
          h(Field, { label: '拒绝理由', wide: true },
            h(TextInput, { value: join.rejectReason || '', onChange: function (v) { set('rejectReason', v); } }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '入群欢迎'),
          h(Check, { checked: join.welcome.enabled, label: '新成员入群时发送欢迎语', onChange: function (v) { set('welcome.enabled', v); } }),
          h(Field, { label: '欢迎语模板（{user} 为 @新成员，{name} 为昵称，{group} 为群名）', wide: true },
            h(TextArea, { value: join.welcome.template || '', onChange: function (v) { set('welcome.template', v); } })),
          h(Field, { label: '欢迎语变体（每行一条；多条时按群+成员+日期固定随机）', wide: true },
            h(TextArea, { value: listToLines(join.welcome.variants), onChange: function (v) { set('welcome.variants', linesToListOnly(v)); } })),
          h(Field, { label: '随机种子盐' },
            h(TextInput, { value: join.welcome.seedSalt || '', onChange: function (v) { set('welcome.seedSalt', v); } }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '新成员观察期'),
          h(Check, { checked: join.observation.enabled, label: '启用观察期', onChange: function (v) { set('observation.enabled', v); } }),
          h(Check, { checked: join.observation.blockLinks, label: '观察期禁止链接', onChange: function (v) { set('observation.blockLinks', v); } }),
          h(Check, { checked: join.observation.blockImages, label: '观察期禁止图片', onChange: function (v) { set('observation.blockImages', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '观察时长（分钟，0=不限制）' }, h(NumberInput, { value: join.observation.minutes, min: 0, max: 1440, onChange: function (v) { set('observation.minutes', v); } })),
            h(Field, { label: '观察期动作' }, h(Select, { value: join.observation.action, onChange: function (v) { set('observation.action', v); }, options: ACTION_OPTIONS })))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '入群答题', h('span', { className: 'qqg-sub' }, '入群后在群里提问，答对才算完成验证')),
          h(Check, { checked: join.quiz.enabled, label: '启用入群答题', onChange: function (v) { set('quiz.enabled', v); } }),
          h(Check, { checked: join.quiz.askBeforeWelcome, label: '答题通过后再发欢迎语', onChange: function (v) { set('quiz.askBeforeWelcome', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '超时（秒）' }, h(NumberInput, { value: join.quiz.timeoutSec, min: 30, max: 3600, onChange: function (v) { set('quiz.timeoutSec', v); } })),
            h(Field, { label: '最多答错次数' }, h(NumberInput, { value: join.quiz.maxAttempts, min: 1, max: 20, onChange: function (v) { set('quiz.maxAttempts', v); } })),
            h(Field, { label: '失败动作' }, h(Select, { value: join.quiz.action, onChange: function (v) { set('quiz.action', v); }, options: ACTION_OPTIONS }))),
          h(Field, { label: '题目（每行一条，格式：问题 | 答案；答案可用 / 分隔多个）', wide: true },
            h(TextArea, {
              value: (join.quiz.questions || []).map(function (x) { return x.q + ' | ' + x.a; }).join('\n'),
              onChange: function (v) {
                var list = String(v || '').split(/\r?\n/u).map(function (line) {
                  var parts = line.split('|');
                  var q = (parts[0] || '').trim();
                  var a = (parts[1] || '').trim();
                  return q && a ? { q: q, a: a } : null;
                }).filter(Boolean);
                set('quiz.questions', list);
              },
            }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '普通用户 AI 通道', h('span', { className: 'qqg-sub' }, '非信任成员 @机器人 时的轻量闲聊')),
          h(Check, { checked: guestDraft.enabled, label: '启用普通用户通道', onChange: function (v) { setGuest('enabled', v); } }),
          h(Check, { checked: guestDraft.aiEnabled, label: '调用 AI 回复（关闭则只回提示）', onChange: function (v) { setGuest('aiEnabled', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '每群每分钟上限' }, h(NumberInput, { value: guestDraft.perMinute, min: 1, max: 120, onChange: function (v) { setGuest('perMinute', v); } })),
            h(Field, { label: '同一成员冷却（秒）' }, h(NumberInput, { value: guestDraft.cooldownSec, min: 0, max: 3600, onChange: function (v) { setGuest('cooldownSec', v); } })),
            h(Field, { label: '回复字数上限' }, h(NumberInput, { value: guestDraft.replyMaxChars, min: 20, max: 1000, onChange: function (v) { setGuest('replyMaxChars', v); } })),
            h(Field, { label: '越权禁言（秒）' }, h(NumberInput, { value: guestDraft.muteSeconds, min: 0, max: 86400, onChange: function (v) { setGuest('muteSeconds', v); } })),
            h(Field, { label: '感情牌夹带指令禁言（秒）' }, h(NumberInput, { value: guestDraft.emotionalMuteSeconds, min: 0, max: 86400, onChange: function (v) { setGuest('emotionalMuteSeconds', v); } }))),
          h(Field, { label: '人设补充（只影响闲聊语气）', wide: true },
            h(TextArea, { value: guestDraft.persona || '', onChange: function (v) { setGuest('persona', v); } })),
          h(Field, { label: '越权拦截词（每行一个）', wide: true },
            h(TextArea, { value: listToLines(guestDraft.guardKeywords), onChange: function (v) { setGuest('guardKeywords', linesToList(v)); } })),
          h('div', { className: 'qqg-sub' }, '管理操作、索要系统提示、扮演套设定等请求一律拒绝并警告一次；再次越权禁言 5 分钟。感情牌夹带恶意指令直接禁言 1 小时；信任成员触发时只警告并通告所有群。越权判断全在本地完成，不消耗模型。'),
          h('div', { style: { textAlign: 'right' } },
            h(Btn, { variant: 'primary', disabled: saving, onClick: saveGuest }, saving ? '保存中…' : '保存普通用户通道'))),
        h('div', { style: { textAlign: 'right' } },
          h(Btn, { variant: 'primary', disabled: saving, onClick: doSave }, saving ? '保存中…' : '保存入群设置')));
    }

    function AnnouncementsTab(props) {
      var boot = props.boot;
      var items = boot.announcements || [];
      var formState = useState({ title: '', content: '', targets: [], publishAt: '', publishNow: false });
      var form = formState[0];
      var setForm = formState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var groups = boot.groups || [];

      async function submit() {
        if (!String(form.content || '').trim()) return props.notify('公告内容不能为空', true);
        setBusy(true);
        var input = {
          title: form.title,
          content: form.content,
          targets: form.targets,
          publishAt: form.publishAt ? new Date(form.publishAt).toISOString() : '',
        };
        var r = await api('announcements', { action: 'create', input: input });
        if (r.ok && form.publishNow) {
          var p = await api('announcements', { action: 'publish', id: r.data.id });
          if (p.ok) props.notify('公告已发布：成功 ' + p.data.sent + '/' + p.data.total);
          else props.notify((p.error && p.error.message) || '发布失败', true);
        } else if (r.ok) {
          props.notify(form.publishAt ? '公告已定时' : '公告已保存为草稿');
        } else {
          props.notify((r.error && r.error.message) || '创建失败', true);
        }
        setForm({ title: '', content: '', targets: form.targets, publishAt: '', publishNow: false });
        setBusy(false);
        await props.reload();
      }

      async function act(action, id) {
        setBusy(true);
        var r = await api('announcements', { action: action, id: id });
        setBusy(false);
        if (r.ok) {
          props.notify(action === 'publish'
            ? '发送完成：成功 ' + r.data.sent + '/' + r.data.total
            : (action === 'pause' ? '已转为草稿' : '已删除'));
          await props.reload();
        } else {
          props.notify((r.error && r.error.message) || '操作失败', true);
        }
      }

      function toggleTarget(gid) {
        var next = form.targets.slice();
        var i = next.indexOf(gid);
        if (i >= 0) next.splice(i, 1); else next.push(gid);
        setForm(Object.assign({}, form, { targets: next }));
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '新建公告'),
          h('div', { className: 'qqg-note' }, 'QQ 官方接口不提供“设置群公告”能力，公告会以机器人消息发送到目标群。'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '标题（可选）' }, h(TextInput, { value: form.title, onChange: function (v) { setForm(Object.assign({}, form, { title: v })); } })),
            h(Field, { label: '定时发布（留空为草稿）' },
              h('input', {
                className: 'qqg-in', type: 'datetime-local', value: form.publishAt,
                onChange: function (e) { setForm(Object.assign({}, form, { publishAt: e.target.value })); },
              }))),
          h(Field, { label: '正文', wide: true },
            h(TextArea, {
              value: form.content,
              placeholder: '写公告内容…',
              onChange: function (v) { setForm(Object.assign({}, form, { content: v })); },
            })),
          h('div', { className: 'qqg-field', style: { width: '100%' } },
            h('span', null, '目标群（可多选）'),
            groups.length
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', maxHeight: 150, overflow: 'auto' } }, groups.map(function (g) {
                return h('label', { key: g.gid, className: 'qqg-check' },
                  h('input', {
                    type: 'checkbox', checked: form.targets.indexOf(g.gid) >= 0,
                    onChange: function () { toggleTarget(g.gid); },
                  }),
                  (g.name || '(未命名群)') + ' · ' + g.gid);
              }))
              : h('div', { className: 'qqg-sub' }, '还没有群。先在「群与成员」里添加，或等机器人收到群事件后自动登记。')),
          h('div', { className: 'qqg-row' },
            h(Check, { checked: form.publishNow, label: '创建后立即发布', onChange: function (v) { setForm(Object.assign({}, form, { publishNow: v })); } }),
            h('div', { className: 'qqg-spacer' }),
            h(Btn, { variant: 'primary', disabled: busy, onClick: submit }, busy ? '处理中…' : '创建公告'))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '公告列表'),
          items.length
            ? h('div', { className: 'qqg-list' }, items.map(function (item) {
              var tone = item.status === 'done' ? 'ok' : item.status === 'failed' ? 'bad' : item.status === 'scheduled' ? 'warn' : 'off';
              var label = { draft: '草稿', scheduled: '已定时', sending: '发送中', done: '已完成', failed: '失败', partial_failed: '部分失败' }[item.status] || item.status;
              var content = String(item.content || '');
              var targets = Array.isArray(item.targets) ? item.targets : [];
              return h('div', { className: 'qqg-item', key: item.id },
                h('div', { className: 'qqg-main' },
                  h('div', null,
                    h('b', null, item.title || '(无标题)'), ' ',
                    h('span', { className: 'qqg-pill', 'data-t': tone }, label), ' ',
                    h('span', { className: 'qqg-sub' }, targets.length + ' 个群 · ' + fmtTime(item.updatedAt))),
                  h('div', { style: { margin: '6px 0', whiteSpace: 'pre-wrap' } }, content.slice(0, 180) + (content.length > 180 ? '…' : '')),
                  item.publishAt ? h('div', { className: 'qqg-mono' }, '定时：' + fmtTime(item.publishAt)) : null,
                  item.results && item.results.length
                    ? h('div', { className: 'qqg-mono' }, item.results.map(function (x) { return (x.groupName || x.gid) + (x.ok ? ' ✓' : ' ✗'); }).join(' · '))
                    : null),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h(Btn, { variant: 'primary', disabled: busy, onClick: function () { act('publish', item.id); } }, '立即发布'),
                  item.status === 'scheduled' ? h(Btn, { disabled: busy, onClick: function () { act('pause', item.id); } }, '转草稿') : null,
                  h(Btn, { variant: 'danger', disabled: busy, onClick: function () { act('delete', item.id); } }, '删除')));
            }))
            : h(Empty, { text: '还没有公告' })));
    }

    function GroupsTab(props) {
      var boot = props.boot;
      var groups = boot.groups || [];
      var gidState = useState(groups[0] ? groups[0].gid : '');
      var gid = gidState[0];
      var setGid = gidState[1];
      var memberGidState = useState(groups[0] ? groups[0].gid : '');
      var memberGid = memberGidState[0];
      var setMemberGid = memberGidState[1];
      var addState = useState({ gid: '', name: '' });
      var add = addState[0];
      var setAdd = addState[1];
      var qState = useState('');
      var q = qState[0];
      var setQ = qState[1];
      var membersState = useState([]);
      var members = membersState[0];
      var setMembers = membersState[1];
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      useEffect(function () {
        if (!gid && groups[0]) setGid(groups[0].gid);
      }, [groups.length]);

      var ovState = useState({ action: '', muteSeconds: '', obsMinutes: '', keywords: '', welcome: '', reset: false });
      var ov = ovState[0];
      var setOv = ovState[1];
      useEffect(function () {
        var base = (boot.settings.groups && boot.settings.groups[gid]) || {};
        setOv({
          action: getIn(base, 'moderation.action', ''),
          muteSeconds: getIn(base, 'moderation.muteSeconds', '') === '' ? '' : String(getIn(base, 'moderation.muteSeconds', '')),
          obsMinutes: getIn(base, 'join.observation.minutes', '') === '' ? '' : String(getIn(base, 'join.observation.minutes', '')),
          keywords: listToLines(getIn(base, 'moderation.keywords', [])),
          welcome: listToLines(getIn(base, 'join.welcome.variants', [])),
          reset: false,
        });
      }, [gid, boot.settings]);

      async function search() {
        setBusy('search');
        var r = await api('members?gid=' + encodeURIComponent(memberGid) + '&q=' + encodeURIComponent(q));
        setBusy('');
        if (r.ok) setMembers(r.data.members || []);
        else props.notify((r.error && r.error.message) || '查询失败', true);
      }

      async function addGroup() {
        if (!String(add.gid || '').trim()) return props.notify('请填写群 openid', true);
        setBusy('add');
        var r = await api('groups', { action: 'add', gid: add.gid.trim(), name: add.name.trim() });
        setBusy('');
        if (r.ok) {
          props.notify('群已登记');
          setAdd({ gid: '', name: '' });
          props.reload();
        } else props.notify((r.error && r.error.message) || '登记失败', true);
      }

      async function removeGroup(g) {
        setBusy(g.gid);
        var r = await api('groups', { action: 'remove', gid: g.gid });
        setBusy('');
        if (r.ok) { props.notify('已移除登记'); props.reload(); }
        else props.notify((r.error && r.error.message) || '移除失败', true);
      }

      async function memberAct(action, m) {
        setBusy(action + m.uid);
        var payload = { action: action, gid: m.gid, uid: m.uid };
        if (action === 'mute') payload.seconds = boot.settings.moderation.muteSeconds;
        var r = await api('members/action', payload);
        setBusy('');
        if (r.ok) props.notify('操作完成');
        else props.notify((r.error && r.error.message) || '操作失败', true);
      }

      function saveOverride() {
        if (!gid) return props.notify('先选择群', true);
        if (ov.reset) return props.savePatch({ groups: { [gid]: null } });
        var mod = {};
        var join = {};
        if (ov.action) mod.action = ov.action;
        if (String(ov.muteSeconds) !== '') mod.muteSeconds = Number(ov.muteSeconds);
        var words = linesToList(ov.keywords);
        if (words.length) mod.keywords = words;
        if (String(ov.obsMinutes) !== '') join.observation = { minutes: Number(ov.obsMinutes) };
        var welcome = linesToListOnly(ov.welcome);
        if (welcome.length) join.welcome = { variants: welcome };
        var entry = { __replace: true };
        if (Object.keys(mod).length) entry.moderation = mod;
        if (Object.keys(join).length) entry.join = join;
        var patch = { groups: {} };
        patch.groups[gid] = entry;
        props.savePatch(patch);
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '群注册表'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群 openid' }, h(TextInput, { value: add.gid, onChange: function (v) { setAdd(Object.assign({}, add, { gid: v })); } })),
            h(Field, { label: '群名称（可选）' }, h(TextInput, { value: add.name, onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } })),
            h(Btn, { variant: 'primary', disabled: busy === 'add', onClick: addGroup }, busy === 'add' ? '登记中…' : '登记群')),
          groups.length
            ? h('div', { className: 'qqg-table-wrap', style: { marginTop: 10 } }, h('table', { className: 'qqg-table' },
              h('thead', null, h('tr', null, h('th', null, '群'), h('th', null, 'openid'), h('th', null, '人数'), h('th', null, '最近活跃'), h('th', null, ''))),
              h('tbody', null, groups.map(function (g) {
                return h('tr', { key: g.gid },
                  h('td', null, g.name || '(未命名群)'),
                  h('td', { className: 'qqg-mono' }, g.gid),
                  h('td', null, g.memberCount ? String(g.memberCount) : '-'),
                  h('td', null, fmtTime(g.lastSeenAt)),
                  h('td', null, h(Btn, { variant: 'danger', disabled: !!busy, onClick: function () { removeGroup(g); } }, '移除登记')));
              }))))
            : h(Empty, { text: '还没有群。机器人收到群事件后会自动登记；也可以手动添加 openid。' })),
        h('div', { className: 'qqg-card' },
          h('h4', null, '按群覆盖设置', h('span', { className: 'qqg-sub' }, '留空 = 继承全局')),
          h(Field, { label: '选择群' },
            h(Select, {
              value: gid, onChange: setGid,
              options: groups.map(function (g) { return { value: g.gid, label: (g.name || '(未命名群)') + ' · ' + g.gid }; }),
              style: { minWidth: 260 },
            })),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '违规动作' },
              h(Select, {
                value: ov.action,
                onChange: function (v) { setOv(Object.assign({}, ov, { action: v })); },
                options: [{ value: '', label: '继承' }].concat(ACTION_OPTIONS),
              })),
            h(Field, { label: '禁言秒数' },
              h(TextInput, {
                value: ov.muteSeconds, placeholder: '继承',
                onChange: function (v) { setOv(Object.assign({}, ov, { muteSeconds: v })); },
              })),
            h(Field, { label: '观察期分钟' },
              h(TextInput, {
                value: ov.obsMinutes, placeholder: '继承',
                onChange: function (v) { setOv(Object.assign({}, ov, { obsMinutes: v })); },
              }))),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '覆盖违规词（每行一个，留空继承）', wide: true },
              h(TextArea, { value: ov.keywords, onChange: function (v) { setOv(Object.assign({}, ov, { keywords: v })); } })),
            h(Field, { label: '覆盖欢迎语变体（每行一条，留空继承）', wide: true },
              h(TextArea, { value: ov.welcome, onChange: function (v) { setOv(Object.assign({}, ov, { welcome: v })); } }))),
          h(Check, { checked: ov.reset, label: '清除该群所有覆盖，恢复继承', onChange: function (v) { setOv(Object.assign({}, ov, { reset: v })); } }),
          h('div', { style: { textAlign: 'right' } },
            h(Btn, { variant: 'primary', onClick: saveOverride }, '保存该群设置'))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '成员查询与操作'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群' },
              h(Select, {
                value: memberGid, onChange: setMemberGid,
                options: [{ value: '', label: '全部群' }].concat(groups.map(function (g) {
                  return { value: g.gid, label: (g.name || '(未命名群)') + ' · ' + g.gid };
                })),
                style: { minWidth: 240 },
              })),
            h(Field, { label: '搜索（昵称 / openid）' }, h(TextInput, { value: q, onChange: setQ })),
            h(Btn, { disabled: busy === 'search', onClick: search }, busy === 'search' ? '查询中…' : '查询')),
          h('div', { className: 'qqg-note' }, '成员台账只记录机器人见过的成员（入群申请、群消息）。查不到时可以先选“全部群”，或者改用 openid 搜索。'),
          members.length
            ? h('div', { className: 'qqg-table-wrap' }, h('table', { className: 'qqg-table' },
              h('thead', null, h('tr', null, h('th', null, '昵称'), h('th', null, 'openid'), h('th', null, '最近活跃'), h('th', null, '操作'))),
              h('tbody', null, members.map(function (m) {
                return h('tr', { key: m.gid + '|' + m.uid },
                  h('td', null, m.name || '-'),
                  h('td', { className: 'qqg-mono' }, m.uid),
                  h('td', null, fmtTime(m.lastSeenAt)),
                  h('td', null,
                    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                      h(Btn, { disabled: !!busy, onClick: function () { memberAct('mute', m); } }, '禁言'),
                      h(Btn, { disabled: !!busy, onClick: function () { memberAct('unmute', m); } }, '解除'),
                      h(Btn, { variant: 'danger', disabled: !!busy, onClick: function () { memberAct('kick', m); } }, '移出'))));
              }))))
            : h(Empty, { text: '输入关键词后搜索' })));
    }

    function BlacklistTab(props) {
      var boot = props.boot;
      var groups = boot.groups || [];
      var sState = useState({ gid: groups[0] ? groups[0].gid : '', uid: '', name: '', reason: '' });
      var form = sState[0];
      var setForm = sState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var items = boot.blacklist || [];

      async function addItem() {
        if (!form.gid || !form.uid.trim()) return props.notify('请填写群和成员 openid', true);
        setBusy(true);
        var r = await api('blacklist', {
          action: 'add', gid: form.gid, uid: form.uid.trim(), name: form.name.trim(), reason: form.reason.trim(),
        });
        setBusy(false);
        props.notify(r.ok ? '已加入黑名单' : ((r.error && r.error.message) || '操作失败'), !r.ok);
        if (r.ok) {
          setForm(Object.assign({}, form, { uid: '', name: '', reason: '' }));
          props.reload();
        }
      }

      async function removeItem(x) {
        setBusy(true);
        var r = await api('blacklist', { action: 'remove', gid: x.gid, uid: x.uid });
        setBusy(false);
        props.notify(r.ok ? '已移出黑名单' : ((r.error && r.error.message) || '操作失败'), !r.ok);
        if (r.ok) props.reload();
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '黑名单', h('span', { className: 'qqg-sub' }, '被拒/累计违规的成员再次申请会自动拒绝')),
          items.length
            ? h('div', { className: 'qqg-list' }, items.map(function (x) {
              return h('div', { className: 'qqg-item', key: x.gid + '|' + x.uid },
                h('div', { className: 'qqg-main' },
                  h('div', { style: { fontWeight: 600 } }, x.name || x.uid),
                  h('div', { className: 'qqg-mono' }, x.gid + ' · ' + x.uid),
                  h('div', { className: 'qqg-sub' }, (x.reason || '未填写原因') + ' · ' + fmtTime(x.at) + ' · ' + (x.by || ''))),
                h(Btn, { variant: 'danger', disabled: !!busy, onClick: function () { removeItem(x); } }, '移出'));
            }))
            : h(Empty, { text: '黑名单为空' })),
        h('div', { className: 'qqg-card' },
          h('h4', null, '手动加入黑名单'),
          h(MemberSearch, {
            actionLabel: '填入',
            style: { marginBottom: 10 },
            onPick: function (m) {
              var gidOk = groups.some(function (g) { return g.gid === m.gid; });
              setForm(Object.assign({}, form, {
                gid: gidOk ? m.gid : form.gid,
                uid: m.uid,
                name: m.name || '',
              }));
            },
          }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群' },
              h(Select, {
                value: form.gid,
                onChange: function (v) { setForm(Object.assign({}, form, { gid: v })); },
                options: groups.map(function (g) { return { value: g.gid, label: (g.name || '(未命名群)') + ' · ' + g.gid }; }),
              })),
            h(Field, { label: '成员 openid' }, h(TextInput, { value: form.uid, onChange: function (v) { setForm(Object.assign({}, form, { uid: v })); } })),
            h(Field, { label: '昵称（可选）' }, h(TextInput, { value: form.name, onChange: function (v) { setForm(Object.assign({}, form, { name: v })); } }))),
          h(Field, { label: '原因', wide: true }, h(TextInput, { value: form.reason, placeholder: '例如：多次发广告', onChange: function (v) { setForm(Object.assign({}, form, { reason: v })); } })),
          h(Btn, { variant: 'primary', disabled: busy, onClick: addItem }, '加入黑名单')));
    }

    function AuditTab() {
      var itemsState = useState([]);
      var items = itemsState[0];
      var setItems = itemsState[1];
      var fState = useState({ kind: '', gid: '', uid: '' });
      var f = fState[0];
      var setF = fState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      async function load() {
        setBusy(true);
        var r = await api('audit?kind=' + encodeURIComponent(f.kind)
          + '&groupId=' + encodeURIComponent(f.gid) + '&userId=' + encodeURIComponent(f.uid) + '&limit=300');
        setBusy(false);
        if (r.ok) setItems(r.data.items || []);
      }
      useEffect(function () { void load(); }, []);

      function exportCsv() {
        var head = '时间,类型,群,成员,动作,详情,结果\n';
        var body = items.map(function (x) {
          return [x.at, x.kind, x.groupName || x.groupId, x.userName || x.userId, x.action, x.detail, x.ok ? '成功' : '失败']
            .map(csvCell).join(',');
        }).join('\n');
        download('qqbot-guard-audit.csv', head + body);
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '审计日志'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '类型' },
              h(Select, {
                value: f.kind,
                onChange: function (v) { setF(Object.assign({}, f, { kind: v })); },
                options: [{ value: '', label: '全部类型' }].concat(['moderation', 'join', 'announce', 'command', 'config'].map(function (x) {
                  return { value: x, label: x };
                })),
              })),
            h(Field, { label: '群 openid' }, h(TextInput, { value: f.gid, onChange: function (v) { setF(Object.assign({}, f, { gid: v })); } })),
            h(Field, { label: '成员 openid' }, h(TextInput, { value: f.uid, onChange: function (v) { setF(Object.assign({}, f, { uid: v })); } })),
            h(Btn, { disabled: busy, onClick: function () { void load(); } }, busy ? '查询中…' : '查询'),
            h(Btn, { onClick: exportCsv }, '导出 CSV')),
          items.length
            ? h('div', { className: 'qqg-table-wrap', style: { marginTop: 10 } }, h('table', { className: 'qqg-table' },
              h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '类型'), h('th', null, '群'), h('th', null, '成员'), h('th', null, '动作'), h('th', null, '详情'), h('th', null, '结果'))),
              h('tbody', null, items.map(function (x, i) {
                return h('tr', { key: i },
                  h('td', null, fmtTime(x.at)),
                  h('td', null, x.kind),
                  h('td', { className: 'qqg-mono' }, x.groupName || x.groupId || '-'),
                  h('td', { className: 'qqg-mono' }, x.userName || x.userId || '-'),
                  h('td', null, x.action),
                  h('td', null, x.detail || ''),
                  h('td', null, h('span', { className: 'qqg-pill', 'data-t': x.ok ? 'ok' : 'bad' }, x.ok ? '成功' : '失败')));
              }))))
            : h(Empty, { text: '没有记录' })));
    }

    var CHANGE_ACTION_LABEL = { update: '保存设置', password: '修改密码', import: '导入配置' };

    function ChangelogTab() {
      var itemsState = useState([]);
      var items = itemsState[0];
      var setItems = itemsState[1];
      var kState = useState('');
      var keyword = kState[0];
      var setKeyword = kState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      async function load() {
        setBusy(true);
        var r = await api('changelog?keyword=' + encodeURIComponent(keyword));
        setBusy(false);
        if (r.ok) setItems(r.data.items || []);
      }
      useEffect(function () { void load(); }, []);

      function exportCsv() {
        var head = '时间,操作者,来源IP,操作,变更内容,结果\n';
        var body = items.map(function (x) {
          return [x.at, x.userName, x.userId, CHANGE_ACTION_LABEL[x.action] || x.action, x.detail, x.ok ? '成功' : '失败']
            .map(csvCell).join(',');
        }).join('\n');
        download('qqbot-guard-changelog.csv', head + body);
      }

      return h('div', { className: 'qqg-card' },
        h('h4', null, '修改日志', h('span', { className: 'qqg-sub' }, '设置保存 / 密码修改 / 配置导入')),
        h('div', { className: 'qqg-row' },
          h('div', { style: { flex: 1, minWidth: 200 } },
            h(TextInput, { value: keyword, placeholder: '搜索操作者、来源 IP 或变更内容', onChange: setKeyword })),
          h(Btn, { disabled: busy, onClick: function () { void load(); } }, busy ? '查询中…' : '查询'),
          h(Btn, { onClick: exportCsv }, '导出 CSV')),
        h('p', { className: 'qqg-hint' }, '按时间倒序显示最近的修改记录，包含操作者、来源 IP 与变更摘要。'),
        items.length
          ? h('div', { className: 'qqg-table-wrap', style: { marginTop: 10 } }, h('table', { className: 'qqg-table' },
            h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '操作者'), h('th', null, '来源 IP'), h('th', null, '操作'), h('th', null, '变更内容'), h('th', null, '结果'))),
            h('tbody', null, items.map(function (x, i) {
              return h('tr', { key: i },
                h('td', null, fmtTime(x.at)),
                h('td', null, x.userName || '-'),
                h('td', { className: 'qqg-mono' }, x.userId || '-'),
                h('td', null, CHANGE_ACTION_LABEL[x.action] || x.action),
                h('td', null, x.detail || ''),
                h('td', null, h('span', { className: 'qqg-pill', 'data-t': x.ok ? 'ok' : 'bad' }, x.ok ? '成功' : '失败')));
            }))))
          : h(Empty, { text: '暂无修改记录' }));
    }

    function SettingsTab(props) {
      var boot = props.boot;
      var sState = useState(boot.settings || {});
      var draft = sState[0];
      var setDraft = sState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var secretState = useState('');
      var secret = secretState[0];
      var setSecret = secretState[1];
      var verifyState = useState(null);
      var verify = verifyState[0];
      var setVerify = verifyState[1];
      var pwdState = useState({ target: 'operator', current: '', next: '' });
      var pwd = pwdState[0];
      var setPwd = pwdState[1];
      var netState = useState(null);
      var net = netState[0];
      var setNet = netState[1];
      var netBusyState = useState(false);
      var netBusy = netBusyState[0];
      var setNetBusy = netBusyState[1];
      var aiKeyState = useState('');
      var aiKey = aiKeyState[0];
      var setAiKey = aiKeyState[1];
      var aiTestState = useState(null);
      var aiTest = aiTestState[0];
      var setAiTest = aiTestState[1];
      var aiPresetState = useState('');
      var aiPreset = aiPresetState[0];
      var setAiPreset = aiPresetState[1];
      var notifyMembersState = useState([]);
      var notifyMembers = notifyMembersState[0];
      var setNotifyMembers = notifyMembersState[1];
      useEffect(function () { setDraft(boot.settings || {}); }, [boot.settings]);
      useEffect(function () {
        api('members?gid=&q=').then(function (r) {
          if (r && r.ok) setNotifyMembers(r.data.members || []);
        });
      }, []);

      function set(path, value) { setDraft(setIn(draft, path, value)); }
      function setAi(values) {
        var next = draft;
        Object.keys(values).forEach(function (key) {
          next = setIn(next, 'ai.' + key, values[key]);
        });
        setDraft(next);
      }

      async function verifyNotify(silent) {
        var name = String(draft.panel.notifyName || '').trim();
        var uid = String(draft.panel.notifyOpenid || '').trim();
        if (!name) {
          setVerify({ matched: false, reason: '请填写昵称' });
          if (!silent) props.notify('请填写昵称', true);
          return null;
        }
        var r = await api('notify/verify', { name: name, uid: uid });
        if (!r.ok) {
          setVerify({ matched: false, reason: (r.error && r.error.message) || '验证失败' });
          if (!silent) props.notify((r.error && r.error.message) || '验证失败', true);
          return null;
        }
        setVerify(r.data);
        if (!silent) props.notify(r.data.matched ? '通知对象验证通过' : (r.data.reason || '通知对象未匹配'), !r.data.matched);
        return r.data;
      }

      async function save() {
        var name = String(draft.panel.notifyName || '').trim();
        var uid = String(draft.panel.notifyOpenid || '').trim();
        if (!name && uid) return props.notify('填写 openid 时请同时填写昵称', true);
        var pendingVerify = false;
        if (name) {
          var v = await verifyNotify(true);
          if (v && v.matched === false && v.definite) {
            return props.notify(v.reason || '通知对象昵称与 openid 不匹配，已阻止保存', true);
          }
          pendingVerify = !!(v && v.matched === false);
        }
        var patch = {
          appId: draft.appId,
          autoConnect: draft.autoConnect,
          watchJoinRequests: draft.watchJoinRequests,
          panel: draft.panel,
          commands: draft.commands,
          ai: draft.ai,
        };
        if (secret.trim()) patch.appSecret = secret.trim();
        if (aiKey.trim()) patch.ai = Object.assign({}, draft.ai, { apiKey: aiKey.trim() });
        setSaving(true);
        var okSaved = await props.savePatch(patch);
        setSaving(false);
        if (okSaved) {
          setSecret('');
          setAiKey('');
          if (pendingVerify) props.notify('已保存；通知对象暂未校验（机器人未连接或无台账记录）');
        }
      }

      async function runAiTest() {
        setAiTest({ busy: true, text: '测试中…' });
        var r = await api('ai/test', {});
        if (!r.ok) {
          setAiTest({ text: (r.error && r.error.message) || '测试失败', bad: true });
          return;
        }
        var d = r.data || {};
        setAiTest({
          text: '可用：判定「' + d.verdict + '」，置信度 ' + Number(d.confidence).toFixed(2)
            + ' · ' + d.provider + '/' + d.model + ' · ' + d.latencyMs + 'ms',
        });
      }

      async function changePassword() {
        var min = Number((boot.security && boot.security.passwordMin) || 0);
        var max = Number((boot.security && boot.security.passwordMax) || 0);
        var text = String(pwd.next || '');
        if (min && text.length < min) return props.notify('新密码至少 ' + min + ' 位', true);
        if (max && text.length > max) return props.notify('新密码最多 ' + max + ' 位', true);
        if (!/[A-Za-z]/u.test(text) || !/\d/u.test(text)) return props.notify('新密码必须同时包含字母和数字', true);
        setSaving(true);
        var r = await api('security/password', {
          target: pwd.target, currentPassword: pwd.current, newPassword: text,
        });
        setSaving(false);
        if (!r.ok) return props.notify((r.error && r.error.message) || '修改失败', true);
        setPwd({ target: pwd.target, current: '', next: '' });
        props.notify('密码已修改');
      }

      async function exportConfig() {
        var r = await api('config/export?secrets=0');
        if (!r.ok) return props.notify((r.error && r.error.message) || '导出失败', true);
        download('qqbot-guard-config.json', JSON.stringify(r.data, null, 2));
        props.notify('配置已导出');
      }

      function importConfig() {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', async function () {
          var file = input.files && input.files[0];
          if (!file) return;
          var data;
          try {
            data = JSON.parse(await file.text());
          } catch (e) {
            return props.notify('文件不是合法 JSON', true);
          }
          var r = await api('config/import', { data: data });
          if (!r.ok) return props.notify((r.error && r.error.message) || '导入失败', true);
          props.notify('导入完成');
          await props.reload();
        });
        input.click();
      }

      async function checkNetwork() {
        setNetBusy(true);
        var r = await api('compat?network=1');
        setNetBusy(false);
        if (r.ok) setNet(r.data.network || null);
        else setNet({ ok: false, results: [{ name: '检测失败', ok: false, error: (r.error && r.error.message) || '未知错误' }] });
      }

      var compat = boot.compat;
      var panel = boot.panel || {};
      var sec = boot.security || {};
      var pwdRule = sec.passwordMin
        ? '新密码至少 ' + sec.passwordMin + ' 位，必须同时包含字母和数字，且不能与另一个角色的密码相同。'
        : '新密码必须同时包含字母和数字，且不能与另一个角色的密码相同。';
      var verifyText = '';
      var verifyTone = 'off';
      if (verify) {
        if (verify.matched) {
          var srcLabel = verify.source === 'api' ? '官方昵称校验'
            : verify.source === 'name' ? '按昵称唯一匹配' : '成员台账';
          verifyText = '已匹配：' + verify.nickname + '（' + srcLabel + '）';
          verifyTone = 'ok';
        } else {
          verifyText = verify.reason || '未匹配';
          if (Array.isArray(verify.candidates) && verify.candidates.length) {
            verifyText += '；可选：' + verify.candidates.map(function (c) {
              return (c.name || '未命名') + '=' + c.uid;
            }).join('、');
          }
          verifyTone = 'bad';
        }
      }

      var notifySeen = {};
      var notifyOptions = [{ value: '', label: '选择成员（自动填昵称与 openid）' }];
      notifyMembers.forEach(function (m) {
        if (!m || !m.uid || notifySeen[m.uid]) return;
        notifySeen[m.uid] = true;
        notifyOptions.push({
          value: JSON.stringify({ name: m.name || '', uid: m.uid }),
          label: (m.name || '(无昵称)') + ' · ' + m.uid,
        });
      });

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '机器人凭据'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: 'AppID' }, h(TextInput, { value: draft.appId || '', onChange: function (v) { set('appId', v); } })),
            h(Field, { label: 'AppSecret', hint: '留空或保持掩码表示不修改' },
              h(TextInput, {
                value: secret,
                placeholder: draft.secretSet ? '已设置（留空不修改）' : '填写 AppSecret',
                type: 'password',
                onChange: setSecret,
              }))),
          h(Check, { checked: draft.autoConnect, label: '启动时自动连接 QQ', onChange: function (v) { set('autoConnect', v); } }),
          h(Check, { checked: draft.watchJoinRequests, label: '订阅入群申请事件（需要平台授权 GROUP_MEMBER_EVENT）', onChange: function (v) { set('watchJoinRequests', v); } }),
          h('div', { className: 'qqg-note' }, '机器人需要在 QQ 开放平台开通「群管理员」相关权限（入群审批、禁言、移除成员），并把机器人设为群管理员。本插件不连接任何 AI 模型，也不处理聊天、表情包、图片或语音。')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '变更通知对象', h('span', { className: 'qqg-sub' }, '仅普通管理员修改时 @')),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '通知对象昵称（必填）' },
              h(TextInput, {
                value: draft.panel.notifyName || '',
                placeholder: '例如：群主昵称',
                onChange: function (v) { set('panel.notifyName', v); setVerify(null); },
              })),
            h(Field, { label: '成员 openid（可留空）' },
              h(TextInput, {
                value: draft.panel.notifyOpenid || '',
                placeholder: '不知道就留空；同名时再填',
                onChange: function (v) { set('panel.notifyOpenid', v); setVerify(null); },
              })),
            h(Field, { label: '从成员列表选择（自动填入）' },
              h(Select, {
                value: '',
                onChange: function (v) {
                  if (!v) return;
                  try {
                    var picked = JSON.parse(v);
                    var next = setIn(draft, 'panel.notifyName', picked.name || '');
                    next = setIn(next, 'panel.notifyOpenid', picked.uid || '');
                    setDraft(next);
                    setVerify(null);
                  } catch (e) { /* ignore */ }
                },
                options: notifyOptions,
              }))),
          h('div', { className: 'qqg-row', style: { marginTop: 2 } },
            h(Btn, { onClick: function () { void verifyNotify(false); } }, '验证通知对象'),
            verifyText ? h('span', { className: 'qqg-pill', 'data-t': verifyTone }, verifyText) : null),
          h('p', { className: 'qqg-hint' }, 'QQ 官方 Bot API 只提供成员 openid，不提供 QQ 号，所以无法按 QQ 号查人。留空 openid 时按昵称匹配：群内该昵称唯一就 @ 他；有同名成员则需要补 openid 或从上面列表选人。@ 仅在普通管理员修改机器人级设置时生效。')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '局域网面板'),
          h('div', { className: 'qqg-row' },
            h(Check, { checked: draft.panel.enabled, label: '启用面板', onChange: function (v) { set('panel.enabled', v); } }),
            h(Field, { label: '监听地址' }, h(TextInput, { value: draft.panel.host || '', onChange: function (v) { set('panel.host', v); } })),
            h(Field, { label: '端口' }, h(NumberInput, { value: draft.panel.port, min: 0, max: 65535, onChange: function (v) { set('panel.port', v); } }))),
          h('p', { className: 'qqg-hint' }, '当前地址：' + ((panel.urls || []).join(' · ') || '未启动') + '。修改监听地址或端口后保存会自动重启面板。')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '群内管理员指令'),
          h('div', { className: 'qqg-row' },
            h(Check, { checked: draft.commands.enabled, label: '启用指令', onChange: function (v) { set('commands.enabled', v); } }),
            h(Check, {
              checked: draft.commands.naturalEnabled,
              label: '允许受信任成员 @机器人 用自然语言下指令',
              onChange: function (v) { set('commands.naturalEnabled', v); },
            }),
            h(Field, { label: '前缀' }, h(TextInput, { value: draft.commands.prefix || '/', onChange: function (v) { set('commands.prefix', v); }, style: { width: 80 } }))),
          h(Field, { label: '允许使用的成员 openid（每行一个；信任成员自动允许）', wide: true },
            h(TextArea, { value: listToLines(draft.commands.allowUsers), onChange: function (v) { set('commands.allowUsers', linesToList(v)); } })),
          h(MemberSearch, {
            actionLabel: '加入白名单',
            style: { marginBottom: 10 },
            onPick: function (m) {
              var cur = draft.commands.allowUsers || [];
              if (cur.indexOf(m.uid) >= 0) {
                props.notify('已在白名单里');
                return;
              }
              set('commands.allowUsers', cur.concat([m.uid]));
            },
          }),
          h(Field, { label: '群规文本（/rule 返回）', wide: true },
            h(TextArea, { value: draft.commands.ruleText || '', onChange: function (v) { set('commands.ruleText', v); } }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, 'AI 辅助审核', h('span', { className: 'qqg-sub' }, '本地词表的补充，模型失败自动回退')),
          h('div', { className: 'qqg-row' },
            h(Check, { checked: draft.ai.enabled, label: '启用 AI 审核', onChange: function (v) { setAi({ enabled: v }); } }),
            h(Check, {
              checked: draft.ai.vision.enabled,
              label: '分析图片（需视觉模型）',
              onChange: function (v) { setAi({ vision: Object.assign({}, draft.ai.vision, { enabled: v }) }); },
            }),
            h(Field, { label: '单条最多图片' },
              h(NumberInput, {
                value: draft.ai.vision.maxImages,
                min: 1,
                max: 5,
                onChange: function (v) { setAi({ vision: Object.assign({}, draft.ai.vision, { maxImages: v }) }); },
              })),
            h(Field, { label: '单张上限（MB）' },
              h(NumberInput, {
                value: Number(((Number(draft.ai.vision.maxBytes) || 3145728) / 1048576).toFixed(1)),
                min: 1,
                max: 8,
                step: 0.5,
                onChange: function (v) {
                  setAi({ vision: Object.assign({}, draft.ai.vision, { maxBytes: Math.round(Number(v) * 1048576) }) });
                },
              })),
            h('span', {
              className: 'qqg-pill',
              'data-t': boot.ai && boot.ai.available ? 'ok' : 'off',
            }, boot.ai && boot.ai.available
              ? '模型可用：' + (boot.ai.model || '')
              : ((boot.ai && boot.ai.reason) || '未配置模型')),
            h('span', {
              className: 'qqg-pill',
              'data-t': boot.ai && boot.ai.vision && boot.ai.vision.ready ? 'ok' : 'off',
            }, boot.ai && boot.ai.vision && boot.ai.vision.ready ? '可读图' : '图片分析不可用')),
          h('p', { className: 'qqg-hint', style: { marginBottom: 10, lineHeight: 1.8 } },
            '新手这样填：① 已经装好 dsh 模型 → 选「DSH 当前会话模型」，不用填其他；② 想用其他厂商 → 选「OpenAI 兼容接口」，点“快速选择厂商”，再填 API Key；③ 保存后点“测试当前模型”，能看到判定结果就说明配通了。'),
          h('div', { className: 'qqg-row', style: { marginTop: 8 } },
            h(Field, { label: '接入方式' },
              h(Select, {
                value: draft.ai.provider,
                onChange: function (v) { setAi({ provider: v }); },
                options: [
                  { value: 'dsh', label: 'DSH 当前会话模型' },
                  { value: 'openai', label: 'OpenAI 兼容接口' },
                ],
              })),
            draft.ai.provider === 'openai'
              ? h(Field, { label: '快速选择厂商（自动填地址与模型）' },
                h(Select, {
                  value: aiPreset,
                  onChange: function (v) {
                    setAiPreset(v);
                    var p = null;
                    for (var i = 0; i < AI_PRESETS.length; i += 1) {
                      if (AI_PRESETS[i].id === v) p = AI_PRESETS[i];
                    }
                    if (!p) return;
                    if (p.id === 'dsh') setAi({ provider: 'dsh' });
                    else setAi({ provider: 'openai', baseUrl: p.baseUrl, model: p.model });
                  },
                  options: [{ value: '', label: '选择厂商…' }].concat(AI_PRESETS.map(function (p) {
                    return { value: p.id, label: p.label };
                  })),
                }))
              : null,
            draft.ai.provider === 'openai'
              ? h(Field, { label: '模型名称' },
                h(TextInput, {
                  value: draft.ai.model || '',
                  placeholder: 'deepseek-chat / qwen-plus / glm-4-flash',
                  onChange: function (v) { setAi({ model: v }); },
                }))
              : null),
          draft.ai.provider === 'dsh'
            ? h('div', { className: 'qqg-hint', style: { margin: '4px 0 10px' } },
              'API Key：你无需进行配置，因为已绑定了 DSH 模型。')
            : h('div', { className: 'qqg-row' },
              h(Field, { label: '接口地址（OpenAI 兼容，通常以 /v1 结尾）' },
                h(TextInput, {
                  value: draft.ai.baseUrl || '',
                  placeholder: 'https://api.deepseek.com/v1',
                  onChange: function (v) { setAi({ baseUrl: v }); },
                  style: { minWidth: 320 },
                })),
              h(Field, { label: 'API Key（留空不修改；本地模型可留空）' },
                h(TextInput, {
                  value: aiKey,
                  type: 'password',
                  placeholder: draft.ai.apiKeySet ? '已设置，留空不变' : '填写厂商密钥',
                  onChange: setAiKey,
                  style: { minWidth: 260 },
                }))),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '超时（毫秒）' },
              h(NumberInput, { value: draft.ai.timeoutMs, min: 1000, max: 60000, onChange: function (v) { setAi({ timeoutMs: v }); } })),
            h(Field, { label: '最大输出 tokens' },
              h(NumberInput, { value: draft.ai.maxTokens, min: 32, max: 2000, onChange: function (v) { setAi({ maxTokens: v }); } })),
            h(Field, { label: '最低置信度（0-1）' },
              h(NumberInput, { value: draft.ai.minConfidence, min: 0, max: 1, step: 0.05, onChange: function (v) { setAi({ minConfidence: v }); } }))),
          h('div', { className: 'qqg-row', style: { gap: 16 } },
            h(Check, {
              checked: draft.ai.moderation.enabled,
              label: '违规防护接入 AI',
              onChange: function (v) { setAi({ moderation: Object.assign({}, draft.ai.moderation, { enabled: v }) }); },
            }),
            h(Field, { label: '处理方式' },
              h(Select, {
                value: draft.ai.moderation.mode,
                onChange: function (v) { setAi({ moderation: Object.assign({}, draft.ai.moderation, { mode: v }) }); },
                options: [{ value: 'auto', label: '识别即处置' }, { value: 'suggest', label: '只记录建议' }],
              })),
            h(Field, { label: '最短检测字数' },
              h(NumberInput, { value: draft.ai.moderation.minChars, min: 1, max: 200, onChange: function (v) { setAi({ moderation: Object.assign({}, draft.ai.moderation, { minChars: v }) }); } })),
            h(Field, { label: '每群每分钟上限' },
              h(NumberInput, { value: draft.ai.moderation.maxPerMinute, min: 1, max: 600, onChange: function (v) { setAi({ moderation: Object.assign({}, draft.ai.moderation, { maxPerMinute: v }) }); } })),
            h(Check, {
              checked: draft.ai.moderation.analyzeImages,
              label: '违规防护分析图片',
              onChange: function (v) { setAi({ moderation: Object.assign({}, draft.ai.moderation, { analyzeImages: v }) }); },
            })),
          h('div', { className: 'qqg-row', style: { gap: 16 } },
            h(Check, {
              checked: draft.ai.join.enabled,
              label: '入群审批接入 AI',
              onChange: function (v) { setAi({ join: Object.assign({}, draft.ai.join, { enabled: v }) }); },
            }),
            h(Field, { label: '处理方式' },
              h(Select, {
                value: draft.ai.join.mode,
                onChange: function (v) { setAi({ join: Object.assign({}, draft.ai.join, { mode: v }) }); },
                options: [{ value: 'suggest', label: '只给建议' }, { value: 'auto', label: 'AI 全权判断' }],
              })),
            h(Field, { label: '启用时段' },
              h(Select, {
                value: draft.ai.join.schedule.mode,
                onChange: function (v) {
                  setAi({ join: Object.assign({}, draft.ai.join, {
                    schedule: Object.assign({}, draft.ai.join.schedule, { mode: v }),
                  }) });
                },
                options: [
                  { value: 'always', label: '全天 24 小时' },
                  { value: 'day', label: '仅白天' },
                  { value: 'night', label: '仅晚上' },
                  { value: 'active', label: '群活跃时' },
                ],
              })),
            h(Field, { label: '白天开始（时）' },
              h(NumberInput, {
                value: draft.ai.join.schedule.dayStart, min: 0, max: 23,
                onChange: function (v) {
                  setAi({ join: Object.assign({}, draft.ai.join, {
                    schedule: Object.assign({}, draft.ai.join.schedule, { dayStart: v }),
                  }) });
                },
              })),
            h(Field, { label: '白天结束（时）' },
              h(NumberInput, {
                value: draft.ai.join.schedule.dayEnd, min: 1, max: 24,
                onChange: function (v) {
                  setAi({ join: Object.assign({}, draft.ai.join, {
                    schedule: Object.assign({}, draft.ai.join.schedule, { dayEnd: v }),
                  }) });
                },
              })),
            h(Field, { label: '活跃判定（分钟）' },
              h(NumberInput, {
                value: draft.ai.join.schedule.idleMinutes, min: 1, max: 1440,
                onChange: function (v) {
                  setAi({ join: Object.assign({}, draft.ai.join, {
                    schedule: Object.assign({}, draft.ai.join.schedule, { idleMinutes: v }),
                  }) });
                },
              }))),
          h('div', { className: 'qqg-row', style: { gap: 16 } },
            h(Check, {
              checked: draft.ai.quiz.enabled,
              label: '入群验证由 AI 随机出题',
              onChange: function (v) { setAi({ quiz: Object.assign({}, draft.ai.quiz, { enabled: v }) }); },
            }),
            h(Field, { label: '题型' },
              h(Select, {
                value: draft.ai.quiz.mode,
                onChange: function (v) { setAi({ quiz: Object.assign({}, draft.ai.quiz, { mode: v }) }); },
                options: [
                  { value: 'mixed', label: '算术 + 日常' },
                  { value: 'arithmetic', label: '只出算术' },
                  { value: 'daily', label: '只出日常常识' },
                ],
              })),
            h(Check, {
              checked: draft.ai.quiz.judge,
              label: '答案不一致时让 AI 判卷',
              onChange: function (v) { setAi({ quiz: Object.assign({}, draft.ai.quiz, { judge: v }) }); },
            }),
            h(Btn, { onClick: runAiTest, disabled: !!(aiTest && aiTest.busy) }, '测试当前模型'),
            aiTest
              ? h('span', { className: 'qqg-pill', 'data-t': aiTest.bad ? 'bad' : 'ok' }, aiTest.text)
              : h('span', { className: 'qqg-hint' }, '测试使用已保存的配置，改完请先保存')),
          h('p', { className: 'qqg-hint' }, 'AI 只处理本地词表/正则没命中的消息；开启图片分析后会一起判断图片里的辱骂、广告和二维码。入群审批只在所选时段生效，AI 不确定会转人工；AI 出题失败会回退本地题库，本地比对不一致时可再让 AI 判卷。')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '安全'),
          h('dl', { className: 'qqg-kv' },
            h('dt', null, '当前角色'), h('dd', null, boot.me && boot.me.role === 'admin' ? '最高管理员（全部权限）' : '普通管理员'),
            h('dt', null, '面板密码'), h('dd', null, sec.initialized ? '已设置，可在下方修改' : '尚未设置')),
          h('div', { className: 'qqg-row', style: { marginTop: 12 } },
            h(Field, { label: '要修改的密码' },
              h(Select, {
                value: pwd.target,
                onChange: function (v) { setPwd(Object.assign({}, pwd, { target: v })); },
                options: [{ value: 'admin', label: '最高管理员' }, { value: 'operator', label: '普通管理员' }],
              })),
            h(Field, { label: '当前最高管理员密码' },
              h(TextInput, { value: pwd.current, type: 'password', onChange: function (v) { setPwd(Object.assign({}, pwd, { current: v })); } })),
            h(Field, { label: '新密码' },
              h(TextInput, { value: pwd.next, type: 'password', onChange: function (v) { setPwd(Object.assign({}, pwd, { next: v })); } }))),
          h(Btn, { disabled: saving, onClick: changePassword }, '修改密码'),
          h('p', { className: 'qqg-hint' }, pwdRule)),
        h('div', { className: 'qqg-card' },
          h('h4', null, '配置备份与恢复'),
          h('div', { className: 'qqg-row' },
            h(Btn, { onClick: exportConfig }, '导出配置 JSON'),
            h(Btn, { variant: 'danger', onClick: importConfig }, '导入配置')),
          h('p', { className: 'qqg-hint' }, '导出的文件包含词表、按群配置、公告、黑名单；默认不含 AppSecret。')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '兼容性自检'),
          compat
            ? h('div', null,
              h('div', { className: 'qqg-sub' }, 'Node ' + compat.node + ' · ' + compat.platform + '/' + compat.arch + ' · 内核/系统 ' + compat.release),
              h('div', { className: 'qqg-grid', style: { marginTop: 10 } }, (compat.checks || []).map(function (c) {
                var tone = c.ok ? 'ok' : (c.level === 'required' ? 'bad' : 'warn');
                var text = c.ok ? '通过' : (c.level === 'required' ? '不通过' : '注意');
                return h('div', { className: 'qqg-stat', key: c.id },
                  h('span', { className: 'qqg-pill', 'data-t': tone }, text),
                  h('div', { style: { fontWeight: 600, marginTop: 6 } }, c.label),
                  h('div', { className: 'qqg-sub' }, c.detail),
                  (!c.ok && c.hint) ? h('div', { className: 'qqg-sub', style: { color: '#b45309', marginTop: 4 } }, c.hint) : null);
              })),
              h('div', { className: 'qqg-row', style: { marginTop: 10 } },
                h(Btn, { disabled: netBusy, onClick: checkNetwork }, netBusy ? '检测中…' : '网络连通性检测'),
                net ? h('span', { className: 'qqg-pill', 'data-t': net.ok ? 'ok' : 'bad' }, net.ok ? 'QQ 接口可达' : '网络不可达') : null),
              net && net.results
                ? h('div', { className: 'qqg-mono', style: { marginTop: 6 } }, net.results.map(function (x) {
                  return x.name + (x.ok ? ' 可达（HTTP ' + x.status + '）' : ' 失败：' + (x.error || ''));
                }).join(' · '))
                : null)
            : h('div', { className: 'qqg-sub' }, '兼容性数据不可用')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '运行信息'),
          h('div', { className: 'qqg-mono' }, '数据目录：' + (boot.dataDir || '')),
          h('div', { className: 'qqg-mono' }, '版本：' + (boot.version || '') + ' · 无 AI 依赖')),
        h('div', { style: { textAlign: 'right' } },
          h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存设置')));
    }

    function apply(ctx) {
      try {
        ensureCss();
        var slots = ctx && ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'qqbot-guard', order: 33, label: 'QQ 群管家' },
            function (props) { return h(QqGuardPanel, { close: props && props.close }); },
          );
        });
      } catch (e) {
        try { console.warn('[qqbot-guard] client degraded: ' + ((e && e.message) || e)); } catch (x) { /* ignore */ }
      }
    }

    return { inject: ['slots'], apply: apply };
  },
});
