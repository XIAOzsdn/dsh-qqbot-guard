/* QQ 群管家 — 浏览器半边（手写模块，无需构建）。
 * 注册「设置 → QQ 群管家」整页，所有数据走同源 /api/qqbot-guard/*。
 * 不依赖任何 AI 会话；只在面板打开时做低频状态刷新。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-guard',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;

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
      '.qqg-card h4{margin:0 0 10px;font-size:13.5px;font-weight:650}',
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
      '.qqg-toast{position:sticky;bottom:8px;margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(31,158,79,.12);border:1px solid rgba(31,158,79,.3);color:#187a3d;font-size:12px}',
      '.qqg-toast[data-err="1"]{background:rgba(221,51,51,.1);border-color:rgba(221,51,51,.3);color:#b02020}',
      '.qqg-note{font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);background:rgba(124,108,240,.07);border:1px solid rgba(124,108,240,.2);border-radius:8px;padding:8px 10px;margin:8px 0}',
      '.qqg-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;margin:0 14px 8px 0}',
      '.qqg-empty{padding:28px 0;text-align:center;color:var(--dsw-alias-text-secondary,#8a919c);font-size:12.5px}',
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
      return String(text || '')
        .split(/\r?\n|,|，/u)
        .map(function (x) { return x.trim(); })
        .filter(Boolean);
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

    function Btn(props) {
      return h('button', {
        className: 'qqg-btn',
        'data-v': props.variant || '',
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
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
        onChange: function (e) { props.onChange(Number(e.target.value)); },
        style: { width: 110 },
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

    var TABS = [
      { id: 'overview', label: '总览' },
      { id: 'moderation', label: '违规防护' },
      { id: 'announcements', label: '公告' },
      { id: 'join', label: '入群审批' },
      { id: 'groups', label: '群与成员' },
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

      async function save(patch) {
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

      var body;
      if (tab === 'moderation') body = h(ModerationTab, { settings: boot.settings, save: save });
      else if (tab === 'announcements') body = h(AnnouncementsTab, { boot: boot, refresh: load, notify: notify });
      else if (tab === 'join') body = h(JoinTab, { boot: boot, refresh: load, notify: notify, save: save });
      else if (tab === 'groups') body = h(GroupsTab, { boot: boot, refresh: load, notify: notify });
      else if (tab === 'settings') body = h(SettingsTab, { boot: boot, save: save });
      else body = h(OverviewTab, { boot: boot, refresh: load });

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
      return h('div', null,
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
          h('div', { className: 'qqg-grid' }, stats.map(function (s) {
            return h('div', { className: 'qqg-stat', key: s.label }, h('b', null, String(s.value)), h('span', null, s.label));
          }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '最近操作'),
          boot.audit && boot.audit.length
            ? h('table', { className: 'qqg-table' },
              h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '类型'), h('th', null, '动作'), h('th', null, '群'), h('th', null, '对象'), h('th', null, '详情'))),
              h('tbody', null, boot.audit.slice(0, 12).map(function (a, i) {
                return h('tr', { key: i },
                  h('td', null, fmtTime(a.at)),
                  h('td', null, a.kind),
                  h('td', null, a.action),
                  h('td', { className: 'qqg-mono' }, a.groupName || a.groupId || '-'),
                  h('td', { className: 'qqg-mono' }, a.userName || a.userId || '-'),
                  h('td', null, a.detail || ''));
              })))
            : h(Empty, { text: '还没有操作记录' })));
    }

    function ModerationTab(props) {
      var settings = props.settings;
      var sState = useState(settings);
      var draft = sState[0];
      var setDraft = sState[1];
      var saveState = useState(false);
      var saving = saveState[0];
      var setSaving = saveState[1];
      useEffect(function () { setDraft(settings); }, [settings]);
      var mod = draft.moderation || {};

      function set(path, value) { setDraft(setIn(draft, 'moderation.' + path, value)); }
      async function doSave() {
        setSaving(true);
        await props.save(draft);
        setSaving(false);
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '基础策略'),
          h(Check, { checked: mod.enabled, label: '启用违规防护', onChange: function (v) { set('enabled', v); } }),
          h('div', { className: 'qqg-note' }, '提示：需要在 QQ 开放平台为机器人开通「群聊全量消息」权限并设为群管理员，否则只能看到 @ 机器人的消息，无法覆盖全部群聊。'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '命中后的动作' },
              h(Select, {
                value: mod.action,
                onChange: function (v) { set('action', v); },
                options: [{ value: 'warn', label: '警告' }, { value: 'mute', label: '禁言' }, { value: 'kick', label: '移出群聊' }],
              })),
            h(Field, { label: '禁言时长（秒）' }, h(NumberInput, { value: mod.muteSeconds, min: 1, max: 2592000, onChange: function (v) { set('muteSeconds', v); } })),
            h(Field, { label: '同一用户冷却（秒）' }, h(NumberInput, { value: mod.cooldownSec, min: 0, max: 86400, onChange: function (v) { set('cooldownSec', v); } }))),
          h(Field, { label: '警告文案（{user} 会被替换成 @成员）', wide: true },
            h('textarea', { className: 'qqg-ta', value: mod.warnTemplate || '', onChange: function (e) { set('warnTemplate', e.target.value); } })),
          h('div', { className: 'qqg-note' }, draft.ui && draft.ui.notice ? draft.ui.notice : '')),
        h('div', { className: 'qqg-card' },
          h('h4', null, '规则'),
          h(Field, { label: '违规词（每行一个）', wide: true },
            h('textarea', { className: 'qqg-ta', value: listToLines(mod.keywords), onChange: function (e) { set('keywords', linesToList(e.target.value)); } })),
          h(Field, { label: '正则规则（每行一个，需符合 JS 正则语法）', wide: true },
            h('textarea', { className: 'qqg-ta', value: listToLines(mod.regexes), onChange: function (e) { set('regexes', linesToList(e.target.value)); } })),
          h(Check, { checked: mod.detectLinks, label: '检测可疑链接（域名白名单外）', onChange: function (v) { set('detectLinks', v); } }),
          h(Field, { label: '链接白名单（每行一个域名）', wide: true },
            h('textarea', { className: 'qqg-ta', value: listToLines(mod.linkWhitelist), onChange: function (e) { set('linkWhitelist', linesToList(e.target.value)); } }))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '刷屏与升级处理'),
          h(Check, { checked: getIn(mod, 'spam.enabled', true), label: '启用刷屏检测', onChange: function (v) { set('spam.enabled', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '统计窗口（秒）' }, h(NumberInput, { value: getIn(mod, 'spam.windowSec', 10), min: 1, max: 600, onChange: function (v) { set('spam.windowSec', v); } })),
            h(Field, { label: '窗口内消息数' }, h(NumberInput, { value: getIn(mod, 'spam.maxMessages', 6), min: 2, max: 100, onChange: function (v) { set('spam.maxMessages', v); } }))),
          h(Check, { checked: getIn(mod, 'escalation.enabled', true), label: '启用多次违规升级', onChange: function (v) { set('escalation.enabled', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '第几次违规升级' }, h(NumberInput, { value: getIn(mod, 'escalation.violations', 3), min: 1, max: 100, onChange: function (v) { set('escalation.violations', v); } })),
            h(Field, { label: '统计窗口（小时）' }, h(NumberInput, { value: getIn(mod, 'escalation.windowHours', 24), min: 1, max: 720, onChange: function (v) { set('escalation.windowHours', v); } })),
            h(Field, { label: '升级动作' },
              h(Select, {
                value: getIn(mod, 'escalation.action', 'kick'),
                onChange: function (v) { set('escalation.action', v); },
                options: [{ value: 'warn', label: '警告' }, { value: 'mute', label: '禁言' }, { value: 'kick', label: '移出群聊' }],
              }))),
          h(Field, { label: '豁免群 openid（每行一个，只记录不处置）', wide: true },
            h('textarea', { className: 'qqg-ta', value: listToLines(mod.exemptGroups), onChange: function (e) { set('exemptGroups', linesToList(e.target.value)); } }))),
        h('div', { style: { textAlign: 'right' } },
          h(Btn, { variant: 'primary', disabled: saving, onClick: doSave }, saving ? '保存中…' : '保存防护设置')));
    }

    function AnnouncementsTab(props) {
      var boot = props.boot;
      var listState = useState(null);
      var items = listState[0];
      var setItems = listState[1];
      var formState = useState({ title: '', content: '', targets: [], publishAt: '', publishNow: false });
      var form = formState[0];
      var setForm = formState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      useEffect(function () { setItems(boot.announcements || []); }, [boot.announcements]);

      var groups = boot.groups || [];

      async function reload() {
        var r = await api('bootstrap');
        if (r.ok) setItems(r.data.announcements || []);
        props.refresh();
      }

      async function submit() {
        if (!form.content.trim()) return props.notify('公告内容不能为空', true);
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
          if (p.ok) props.notify('公告已发布到群：成功 ' + p.data.sent + '/' + p.data.total);
          else props.notify((p.error && p.error.message) || '发布失败', true);
        } else if (r.ok) {
          props.notify(form.publishAt ? '公告已定时' : '公告已保存为草稿');
        } else {
          props.notify((r.error && r.error.message) || '创建失败', true);
        }
        setForm({ title: '', content: '', targets: form.targets, publishAt: '', publishNow: false });
        setBusy(false);
        await reload();
      }

      async function act(action, id) {
        setBusy(true);
        var r = await api('announcements', { action: action, id: id });
        setBusy(false);
        if (r.ok) {
          props.notify(action === 'publish' ? '发送完成：成功 ' + r.data.sent + '/' + r.data.total : '操作完成');
          await reload();
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
            h('textarea', {
              className: 'qqg-ta', value: form.content, placeholder: '写公告内容…',
              onChange: function (e) { setForm(Object.assign({}, form, { content: e.target.value })); },
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
          items && items.length
            ? h('div', { className: 'qqg-list' }, items.map(function (item) {
              var tone = item.status === 'done' ? 'ok' : item.status === 'failed' ? 'bad' : item.status === 'scheduled' ? 'warn' : 'off';
              var label = { draft: '草稿', scheduled: '已定时', sending: '发送中', done: '已完成', failed: '失败', partial_failed: '部分失败' }[item.status] || item.status;
              var itemContent = String(item.content || '');
              var targets = Array.isArray(item.targets) ? item.targets : [];
              return h('div', { className: 'qqg-item', key: item.id },
                h('div', { className: 'qqg-main' },
                  h('div', null,
                    h('b', null, item.title || '(无标题)'), ' ',
                    h('span', { className: 'qqg-pill', 'data-t': tone }, label), ' ',
                    h('span', { className: 'qqg-sub' }, targets.length + ' 个群 · ' + fmtTime(item.updatedAt))),
                  h('div', { style: { margin: '6px 0', whiteSpace: 'pre-wrap' } }, itemContent.slice(0, 180) + (itemContent.length > 180 ? '…' : '')),
                  item.publishAt ? h('div', { className: 'qqg-mono' }, '定时：' + fmtTime(item.publishAt)) : null,
                  item.results && item.results.length
                    ? h('div', { className: 'qqg-mono' }, item.results.map(function (r) { return (r.groupName || r.gid) + (r.ok ? ' ✓' : ' ✗'); }).join(' · '))
                    : null),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h(Btn, { variant: 'primary', disabled: busy, onClick: function () { act('publish', item.id); } }, '立即发布'),
                  item.status === 'scheduled' ? h(Btn, { disabled: busy, onClick: function () { act('pause', item.id); } }, '暂停') : null,
                  h(Btn, { variant: 'danger', disabled: busy, onClick: function () { act('delete', item.id); } }, '删除')));
            }))
            : h(Empty, { text: '还没有公告' })));
    }

    function JoinTab(props) {
      var boot = props.boot;
      var settings = boot.settings;
      var sState = useState(settings);
      var draft = sState[0];
      var setDraft = sState[1];
      var pendingState = useState(boot.pending || []);
      var pending = pendingState[0];
      var setPending = pendingState[1];
      var gidState = useState((boot.groups && boot.groups[0] && boot.groups[0].gid) || '');
      var gid = gidState[0];
      var setGid = gidState[1];
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      useEffect(function () { setDraft(settings); }, [settings]);
      useEffect(function () { setPending(boot.pending || []); }, [boot.pending]);

      function set(path, value) { setDraft(setIn(draft, path, value)); }
      var join = draft.join || {};
      var welcome = join.welcome || {};

      async function doAction(item, action) {
        setBusy(item.joinRequestId);
        var r = await api('join', {
          action: action, gid: item.groupId || item.group_id || item.groupId, uid: item.memberOpenid, jid: item.joinRequestId, reason: '',
        });
        setBusy('');
        if (r.ok) {
          props.notify(action === 'approve' ? '已通过' : '已拒绝');
          setPending(pending.filter(function (x) {
            return !(x.groupId === item.groupId && x.joinRequestId === item.joinRequestId);
          }));
          props.refresh();
        } else {
          props.notify((r.error && r.error.message) || '操作失败', true);
        }
      }

      async function refreshRemote() {
        if (!gid) return props.notify('先选择群', true);
        setBusy('refresh');
        var r = await api('join', { action: 'refresh', gid: gid });
        setBusy('');
        if (r.ok) {
          props.notify('已同步官方待审批列表：新增 ' + r.data.count);
          props.refresh();
        } else {
          props.notify((r.error && r.error.message) || '同步失败', true);
        }
      }

      async function doSave() {
        await props.save(draft);
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '待审批'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群' },
              h(Select, {
                value: gid,
                onChange: setGid,
                options: (boot.groups || []).map(function (g) { return { value: g.gid, label: (g.name || '(未命名群)') + ' · ' + g.gid }; }),
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
                    item.riskTips ? h('span', { className: 'qqg-pill', 'data-t': 'bad' }, '风险') : null),
                  h('div', { className: 'qqg-sub' }, '验证：' + (item.verifyMessage || item.verify_message || '-') + ' · 来源：' + (item.applySource || '-')),
                  h('div', { className: 'qqg-mono' }, '群 ' + (item.groupId || '') + ' · ' + fmtTime(item.seenAt))),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h(Btn, { variant: 'primary', disabled: !!busy, onClick: function () { doAction(item, 'approve'); } }, '通过'),
                  h(Btn, { variant: 'danger', disabled: !!busy, onClick: function () { doAction(item, 'decline'); } }, '拒绝')));
            }))
            : h(Empty, { text: '暂无待审批申请' })),
        h('div', { className: 'qqg-card' },
          h('h4', null, '自动审批'),
          h(Check, { checked: join.autoApprove, label: '自动通过（验证信息命中通过关键词，或未设置关键词）', onChange: function (v) { set('join.autoApprove', v); } }),
          h(Check, { checked: join.autoDeclineRisk, label: '命中风险提示时自动拒绝', onChange: function (v) { set('join.autoDeclineRisk', v); } }),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '通过关键词（每行一个）' }, h('textarea', { className: 'qqg-ta', value: listToLines(join.approveKeywords), onChange: function (e) { set('join.approveKeywords', linesToList(e.target.value)); } })),
            h(Field, { label: '拒绝关键词（每行一个）' }, h('textarea', { className: 'qqg-ta', value: listToLines(join.declineKeywords), onChange: function (e) { set('join.declineKeywords', linesToList(e.target.value)); } })))),
        h('div', { className: 'qqg-card' },
          h('h4', null, '入群欢迎'),
          h(Check, { checked: welcome.enabled, label: '新成员入群时发送欢迎语', onChange: function (v) { set('join.welcome.enabled', v); } }),
          h(Field, { label: '欢迎语模板（{user} 为 @新成员，{name} 为昵称，{group} 为群名）', wide: true },
            h('textarea', { className: 'qqg-ta', value: welcome.template || '', onChange: function (e) { set('join.welcome.template', e.target.value); } })),
          h(Field, { label: '欢迎语变体（每行一条；多条时按群+成员+日期固定随机）', wide: true },
            h('textarea', { className: 'qqg-ta', value: listToLines(welcome.variants), onChange: function (e) { set('join.welcome.variants', linesToList(e.target.value)); } })),
          h(Field, { label: '随机种子盐' }, h(TextInput, { value: welcome.seedSalt || '', onChange: function (v) { set('join.welcome.seedSalt', v); } }))),
        h('div', { style: { textAlign: 'right' } }, h(Btn, { variant: 'primary', onClick: doSave }, '保存审批与欢迎设置')));
    }

    function GroupsTab(props) {
      var boot = props.boot;
      var groups = boot.groups || [];
      var addState = useState({ gid: '', name: '' });
      var add = addState[0];
      var setAdd = addState[1];
      var gidState = useState(groups[0] ? groups[0].gid : '');
      var gid = gidState[0];
      var setGid = gidState[1];
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

      async function search() {
        setBusy('search');
        var r = await api('members?gid=' + encodeURIComponent(gid) + '&q=' + encodeURIComponent(q));
        setBusy('');
        if (r.ok) setMembers(r.data.members || []);
        else props.notify((r.error && r.error.message) || '查询失败', true);
      }

      async function addGroup() {
        if (!add.gid.trim()) return props.notify('请填写群 openid', true);
        setBusy('add');
        var r = await api('groups', { action: 'add', gid: add.gid.trim(), name: add.name.trim() });
        setBusy('');
        if (r.ok) {
          props.notify('群已添加');
          setAdd({ gid: '', name: '' });
          props.refresh();
        } else props.notify((r.error && r.error.message) || '添加失败', true);
      }

      async function removeGroup(g) {
        setBusy(g.gid);
        var r = await api('groups', { action: 'remove', gid: g.gid });
        setBusy('');
        if (r.ok) { props.notify('已移除群'); props.refresh(); }
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

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '群注册表'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群 openid' }, h(TextInput, { value: add.gid, onChange: function (v) { setAdd(Object.assign({}, add, { gid: v })); } })),
            h(Field, { label: '群名称（可选）' }, h(TextInput, { value: add.name, onChange: function (v) { setAdd(Object.assign({}, add, { name: v })); } })),
            h(Btn, { variant: 'primary', disabled: busy === 'add', onClick: addGroup }, '添加群')),
          groups.length
            ? h('table', { className: 'qqg-table' },
              h('thead', null, h('tr', null, h('th', null, '群'), h('th', null, 'openid'), h('th', null, '人数'), h('th', null, '最近活跃'), h('th', null, ''))),
              h('tbody', null, groups.map(function (g) {
                return h('tr', { key: g.gid },
                  h('td', null, g.name || '(未命名群)'),
                  h('td', { className: 'qqg-mono' }, g.gid),
                  h('td', null, g.memberCount ? String(g.memberCount) : '-'),
                  h('td', null, fmtTime(g.lastSeenAt)),
                  h('td', null, h(Btn, { variant: 'danger', disabled: !!busy, onClick: function () { removeGroup(g); } }, '移除')));
              })))
            : h(Empty, { text: '还没有群。机器人收到群事件后会自动登记；也可以手动添加 openid。' })),
        h('div', { className: 'qqg-card' },
          h('h4', null, '成员台账'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: '群' },
              h(Select, {
                value: gid, onChange: setGid,
                options: groups.map(function (g) { return { value: g.gid, label: (g.name || '(未命名群)') + ' · ' + g.gid }; }),
                style: { minWidth: 240 },
              })),
            h(Field, { label: '搜索（昵称 / openid）' }, h(TextInput, { value: q, onChange: setQ })),
            h(Btn, { disabled: busy === 'search', onClick: search }, busy === 'search' ? '查询中…' : '查询')),
          h('div', { className: 'qqg-note' }, '成员台账只记录机器人见过的成员（入群申请、群消息）。QQ 官方暂未开放“全量成员列表”接口。'),
          members.length
            ? h('table', { className: 'qqg-table' },
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
              })))
            : h(Empty, { text: '没有匹配的成员' })));
    }

    function SettingsTab(props) {
      var settings = props.boot && props.boot.settings;
      var compat = props.boot && props.boot.compat;
      var sState = useState(settings || {});
      var draft = sState[0];
      var setDraft = sState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var netState = useState(null);
      var net = netState[0];
      var setNet = netState[1];
      var netBusyState = useState(false);
      var netBusy = netBusyState[0];
      var setNetBusy = netBusyState[1];
      useEffect(function () { setDraft(settings || {}); }, [settings]);

      async function checkNetwork() {
        setNetBusy(true);
        var r = await api('compat?network=1');
        setNetBusy(false);
        if (r.ok) setNet(r.data.network || null);
        else setNet({ ok: false, results: [{ name: '检测失败', ok: false, error: (r.error && r.error.message) || '未知错误' }] });
      }

      function set(path, value) { setDraft(setIn(draft, path, value)); }
      async function save() {
        setSaving(true);
        await props.save(draft);
        setSaving(false);
      }

      return h('div', null,
        h('div', { className: 'qqg-card' },
          h('h4', null, '机器人凭据'),
          h('div', { className: 'qqg-row' },
            h(Field, { label: 'AppID' }, h(TextInput, { value: draft.appId, onChange: function (v) { set('appId', v); } })),
            h(Field, { label: 'AppSecret', hint: '留空或保持掩码表示不修改' },
              h(TextInput, {
                value: draft.appSecret === '••••••••' ? '' : draft.appSecret,
                placeholder: draft.secretSet ? '已设置（留空不修改）' : '填写 AppSecret',
                type: 'password',
                onChange: function (v) { set('appSecret', v); },
              }))),
          h(Check, { checked: draft.autoConnect, label: '启动时自动连接 QQ', onChange: function (v) { set('autoConnect', v); } }),
          h(Check, { checked: draft.watchJoinRequests, label: '订阅入群申请事件（需要平台授权 GROUP_MEMBER_EVENT）', onChange: function (v) { set('watchJoinRequests', v); } }),
          h('div', { className: 'qqg-note' },
            '机器人需要在 QQ 开放平台开通「群管理员」相关权限（入群审批、禁言、移除成员），并把机器人设为群管理员。',
            ' 本插件不连接任何 AI 模型，也不处理聊天、表情包、图片或语音。'),
          h('div', { style: { textAlign: 'right' } }, h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存并重连'))),
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
          h('div', { className: 'qqg-mono' }, '数据目录：' + (props.boot && props.boot.dataDir ? props.boot.dataDir : '')),
          h('div', { className: 'qqg-mono' }, '版本：' + (props.boot && props.boot.version ? props.boot.version : '') + ' · 无 AI 依赖')));
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
