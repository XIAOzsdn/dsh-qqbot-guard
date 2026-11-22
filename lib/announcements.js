/**
 * 公告：创建、定时、立即发布、历史管理。
 * 说明：QQ 官方机器人接口没有“设置群公告”能力，这里以机器人消息形式发布到群内。
 */
import { LIMITS } from './defaults.js';

let idSeq = 0;

/** 生成不依赖 Math.random 的稳定 id */
export function makeId(now = Date.now()) {
  idSeq = (idSeq + 1) % 1_000_000;
  return `ann-${now.toString(36)}-${idSeq.toString(36)}`;
}

function normalizeTargets(targets) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(targets) ? targets : []) {
    const gid = String(raw || '').trim();
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    out.push(gid);
    if (out.length >= 200) break;
  }
  return out;
}

export function listAnnouncements(store) {
  return store.announcements.items
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getAnnouncement(store, id) {
  return store.announcements.items.find((x) => x.id === id);
}

/**
 * 新建公告。
 * @param {{store: import('./store.js').Store, input: {title?: string, content?: string, targets?: string[], publishAt?: string}}} args
 */
export function createAnnouncement({ store, input }) {
  const content = String(input?.content || '').trim();
  if (!content) return { ok: false, error: '公告内容不能为空' };
  if (content.length > LIMITS.announcementMaxChars) return { ok: false, error: '公告内容过长' };
  const title = String(input?.title || '').trim().slice(0, LIMITS.titleMaxChars);
  const targets = normalizeTargets(input?.targets);
  const publishAt = normalizeTime(input?.publishAt);
  const now = new Date().toISOString();
  const item = {
    id: makeId(),
    title,
    content,
    targets,
    status: publishAt ? 'scheduled' : 'draft',
    publishAt,
    createdAt: now,
    updatedAt: now,
    publishedAt: '',
    results: [],
  };
  store.announcements.items.unshift(item);
  store.saveAnnouncements();
  return { ok: true, item };
}

/**
 * 更新公告（只允许 draft / scheduled）。
 */
export function updateAnnouncement({ store, id, patch }) {
  const item = getAnnouncement(store, id);
  if (!item) return { ok: false, error: '公告不存在' };
  if (item.status === 'sending') return { ok: false, error: '公告正在发送，暂不能修改' };
  const content = patch?.content === undefined ? item.content : String(patch.content).trim();
  if (!content) return { ok: false, error: '公告内容不能为空' };
  if (content.length > LIMITS.announcementMaxChars) return { ok: false, error: '公告内容过长' };
  const publishAt = normalizeTime(patch?.publishAt === undefined ? item.publishAt : patch.publishAt);
  item.title = patch?.title === undefined ? item.title : String(patch.title).trim().slice(0, LIMITS.titleMaxChars);
  item.content = content;
  item.targets = patch?.targets === undefined ? item.targets : normalizeTargets(patch.targets);
  item.publishAt = publishAt;
  item.status = publishAt ? 'scheduled' : 'draft';
  item.updatedAt = new Date().toISOString();
  store.saveAnnouncements();
  return { ok: true, item };
}

export function deleteAnnouncement({ store, id }) {
  const before = store.announcements.items.length;
  store.announcements.items = store.announcements.items.filter((x) => x.id !== id);
  if (store.announcements.items.length === before) return { ok: false, error: '公告不存在' };
  store.saveAnnouncements();
  return { ok: true };
}

/** 暂停定时（回到草稿） */
export function pauseAnnouncement({ store, id }) {
  const item = getAnnouncement(store, id);
  if (!item) return { ok: false, error: '公告不存在' };
  item.status = 'draft';
  item.publishAt = '';
  item.updatedAt = new Date().toISOString();
  store.saveAnnouncements();
  return { ok: true, item };
}

/**
 * 立即发布。
 * @param {{store: import('./store.js').Store, client: import('./qq-api.js').QQClient|undefined, id: string}} args
 */
export async function publishAnnouncement({ store, client, id }) {
  const item = getAnnouncement(store, id);
  if (!item) return { ok: false, error: '公告不存在' };
  if (!client) return { ok: false, error: '机器人未连接' };
  if (!item.targets.length) return { ok: false, error: '没有选择发布目标群' };
  if (item.status === 'sending') return { ok: false, error: '公告正在发送中' };

  item.status = 'sending';
  item.updatedAt = new Date().toISOString();
  store.saveAnnouncements();

  const text = formatText(item);
  const results = [];
  for (const gid of item.targets) {
    const groupName = store.state.groups[gid]?.name || '';
    let last = null;
    for (let attempt = 0; attempt <= LIMITS.announceRetries; attempt++) {
      last = await client.sendGroupText(gid, text);
      if (last.ok) break;
      if (attempt < LIMITS.announceRetries) {
        await new Promise((r) => { const t = setTimeout(r, LIMITS.sendGapMs * 2); if (t.unref) t.unref(); });
      }
    }
    results.push({
      gid,
      groupName,
      ok: !!last?.ok,
      error: last?.ok ? '' : (last?.err?.human || '发送失败'),
      at: new Date().toISOString(),
    });
    store.appendAudit({
      kind: 'announce', action: 'publish', groupId: gid, groupName,
      detail: `${item.title ? `【${item.title}】` : ''}${item.content.slice(0, LIMITS.auditSnippetChars)}${last?.ok ? '' : `；失败：${last?.err?.human || ''}`}`,
      ok: !!last?.ok, code: last?.ok ? '' : last?.err?.code || '', confidence: 1,
    });
  }

  const okCount = results.filter((x) => x.ok).length;
  item.results = results;
  item.publishedAt = new Date().toISOString();
  item.status = okCount === results.length ? 'done' : okCount === 0 ? 'failed' : 'partial_failed';
  item.updatedAt = item.publishedAt;
  store.saveAnnouncements();
  if (okCount > 0) store.incCounter('announces', okCount);
  return {
    ok: okCount > 0,
    item,
    sent: okCount,
    total: results.length,
    error: okCount > 0 ? '' : '全部目标群发送失败',
  };
}

/** 调度器：每 tick 检查一次到期公告 */
export async function tickAnnouncements({ store, client }) {
  if (!store.settings.announcements.enabled || !client) return { published: 0 };
  const now = Date.now();
  const due = store.announcements.items.filter(
    (x) => x.status === 'scheduled' && x.publishAt && Date.parse(x.publishAt) <= now && x.targets.length > 0,
  );
  let published = 0;
  for (const item of due.slice(0, 5)) {
    const r = await publishAnnouncement({ store, client, id: item.id });
    if (r.ok) published += 1;
  }
  return { published };
}

export function formatText(item) {
  const title = String(item?.title || '').trim();
  const content = String(item?.content || '').trim();
  if (!title) return content.slice(0, LIMITS.announcementMaxChars);
  if (content.startsWith(title)) return content.slice(0, LIMITS.announcementMaxChars);
  return `【${title}】\n${content}`.slice(0, LIMITS.announcementMaxChars);
}

/** 时间归一化：空 → ''；合法 ISO/本地时间 → ISO；非法 → '' */
export function normalizeTime(value) {
  if (!value) return '';
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString();
}
