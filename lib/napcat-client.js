/**
 * NapCat 客户端：把 OneBot v11 的 QQ 号/群号语义，适配成插件内部使用的
 * QQClient 接口（sendGroupText / setMemberMute / removeMembers / 公告等）。
 *
 * 这样 Moderation、充值的二维码发送、公告发布等业务代码不必区分
 * “官方 Bot”与“普通 QQ 账号”两种传输。
 */

function ok(data) {
  return { ok: true, data };
}

function fail(human, code = 'NAPCAT_ERROR') {
  return { ok: false, err: { code, human: String(human || 'NapCat 调用失败') } };
}

function uidList(input) {
  const list = Array.isArray(input) ? input : [input];
  return [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/**
 * 把插件内部的消息文本（含 `<qqbot-at-user id="…" />`）转成 OneBot 消息段数组。
 * 支持 @全体（id="all"）。
 */
export function toSegments(content) {
  const text = String(content ?? '');
  const segments = [];
  const pattern = /<qqbot-at-user\s+id="([^"]*)"\s*\/>/gu;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } });
    segments.push({ type: 'at', data: { qq: match[1] || 'all' } });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } });
  return segments.length ? segments : [{ type: 'text', data: { text } }];
}

export class NapCatClient {
  /**
   * @param {{transport: import('./napcat-transport.js').NapCatTransport, logger?: any}} deps
   */
  constructor(deps = {}) {
    this.transport = deps.transport;
    this.logger = deps.logger || console;
    this.selfId = '';
    this.joinRequests = [];
  }

  /** 读取登录账号（QQ 号），用于 @机器人 判定 */
  async identify() {
    try {
      const info = await this.transport.call('get_login_info', {});
      this.selfId = String(info?.user_id || '');
    } catch (error) {
      this.logger.warn?.(`[qqbot-guard] 读取 NapCat 登录账号失败：${String(error?.message || error)}`);
    }
    return this.selfId;
  }

  async call(action, params, timeoutMs) {
    try {
      return await this.transport.call(action, params, timeoutMs);
    } catch (error) {
      return fail(error?.message || error);
    }
  }

  /** 传输是否在线（离线时的失败不该计入业务重试次数） */
  get connected() {
    return this.transport?.connected === true;
  }

  /**
   * 判断一次失败是不是“链路没连上”这类瞬时错误。
   * 这类错误重试不计次，等重连后再发，避免把请求误判成永久失败。
   */
  static isLinkError(result) {
    if (!result || result.ok !== false) return false;
    const text = String(result.err?.human || result.err?.message || '');
    return /未连接|连接已关闭|WebSocket is not open|调用超时：send_group_msg|ECONNREFUSED|socket hang up/iu.test(text);
  }

  async sendGroupText(gid, content, opts = {}) {
    const r = await this.call('send_group_msg', {
      group_id: Number(gid),
      message: toSegments(content),
    });
    if (r && r.ok === false) return r;
    return ok({ message_id: r?.message_id });
  }

  async sendGroupMedia(gid, fileInfo) {
    const file = String(fileInfo || '').trim();
    if (!file) return fail('图片数据为空', 'MEDIA_EMPTY');
    // 图片上传走富媒体通道，需要更长的超时（默认 4 秒不够）
    const r = await this.call('send_group_msg', {
      group_id: Number(gid),
      message: [{ type: 'image', data: { file } }],
    }, 30_000);
    if (r && r.ok === false) return r;
    return ok({ message_id: r?.message_id });
  }

  /** 直接发送一张本地图片：NapCat 认 file:/// 本地 URI（base64 留给小图） */
  async sendGroupImageFile(gid, filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return fail('图片路径为空', 'IMAGE_EMPTY');
    const uri = /^file:\/\//iu.test(raw) ? raw : `file:///${raw.replace(/\\/gu, '/').replace(/^\/+/u, '')}`;
    const r = await this.call('send_group_msg', {
      group_id: Number(gid),
      message: [{ type: 'image', data: { file: uri } }],
    }, 30_000);
    if (r && r.ok === false) return r;
    return ok({ message_id: r?.message_id });
  }

  /** 无头协议端发不了图片时的兜底：把二维码作为群文件上传 */
  async sendGroupFile(gid, filePath, name = 'file') {
    // NapCat 会把 file 当 URL 解析：Windows 反斜杠会报「识别URL失败」，统一转成 /。
    const slash = String(filePath || '').trim().replace(/\\/gu, '/');
    if (!slash) return fail('文件路径为空', 'FILE_EMPTY');
    const upload = (file) => this.call('upload_group_file', {
      group_id: Number(gid),
      file,
      name: String(name || 'file'),
    }, 30_000);
    const first = await upload(slash);
    if (!(first && first.ok === false)) return ok({ file_id: first?.file_id });
    // 有些 NapCat 版本只认带 scheme 的本地 URI，换个写法再试一次
    if (!/^file:\/\//iu.test(slash)) {
      const second = await upload(`file:///${slash.replace(/^\/+/u, '')}`);
      if (!(second && second.ok === false)) return ok({ file_id: second?.file_id });
      return second;
    }
    return first;
  }

  /** NapCat 直接支持 base64:// 图片，无需先“上传”再发送 */
  async uploadGroupImage(gid, bytes, fileName = 'image.png') {
    if (!bytes || !bytes.length) return fail('图片数据为空', 'IMAGE_EMPTY');
    return ok({ file_info: `base64://${Buffer.from(bytes).toString('base64')}`, name: fileName });
  }

  async getGroupInfo(gid) {
    const r = await this.call('get_group_info', { group_id: Number(gid) });
    if (r && r.ok === false) return r;
    return ok({
      group_name: r?.group_name || '',
      member_count: r?.member_count || 0,
      max_member_count: r?.max_member_count || 0,
      group_openid: String(gid),
    });
  }

  async getUserInfo(uid) {
    const r = await this.call('get_stranger_info', { user_id: Number(uid) });
    if (r && r.ok === false) return r;
    return ok({ nickname: r?.nickname || r?.card || '' });
  }

  async groupMemberList(gid, noCache = true) {
    const params = { group_id: Number(gid) };
    if (noCache) params.no_cache = true;
    const r = await this.call('get_group_member_list', params);
    if (r && r.ok === false) return r;
    return ok(Array.isArray(r) ? r : []);
  }

  async setMemberMute(gid, uids, seconds) {
    const duration = seconds === null || seconds === undefined ? 0 : Math.max(0, Number(seconds) || 0);
    let lastError = '';
    for (const uid of uidList(uids)) {
      const r = await this.call('set_group_ban', {
        group_id: Number(gid), user_id: Number(uid), duration,
      });
      if (r && r.ok === false) lastError = r.err?.human || '禁言失败';
    }
    return lastError ? fail(lastError) : ok({});
  }

  async getGroupMuteSetting() {
    // OneBot 没有“读取禁言成员列表”的标准动作；返回失败让上层退回台账
    return { ok: false, err: { human: 'NapCat 模式暂不支持读取禁言成员，已改用台账' } };
  }

  async setWholeBan(gid, enable) {
    const r = await this.call('set_group_whole_ban', { group_id: Number(gid), enable: !!enable });
    if (r && r.ok === false) return r;
    return ok({});
  }

  async removeMembers(gid, uids, addToBlacklist = false) {
    let lastError = '';
    for (const uid of uidList(uids)) {
      const r = await this.call('set_group_kick', {
        group_id: Number(gid), user_id: Number(uid), reject_add_request: !!addToBlacklist,
      });
      if (r && r.ok === false) lastError = r.err?.human || '踢人失败';
    }
    return lastError ? fail(lastError) : ok({});
  }

  async recallMessage(gid, msgId) {
    const r = await this.call('delete_msg', { message_id: Number(msgId) });
    if (r && r.ok === false) return r;
    return ok({});
  }

  /**
   * 待处理入群申请：OneBot v11 没有“主动拉取申请列表”的标准动作，
   * 只能返回插件已收到的 request 事件（由 BotManager 推入 this.joinRequests）。
   * 返回结构与官方 `list` 对齐（join_request_id / member_openid / username / verify_info），
   * 这样上层 syncJoinRequests 不必区分两种传输。
   * @param {string} [gid] 只取该群（空 = 全部）
   * @param {string} [flag] 保留参数（对齐官方签名），不参与过滤
   * @param {number} [count] 最多返回条数
   */
  async listJoinRequests(gid = '', flag = '', count = 50) {
    const limit = Math.max(1, Math.min(200, Number(count) || 50));
    const items = this.joinRequests
      .filter((x) => !gid || String(x.gid) === String(gid))
      .slice(0, limit)
      .map((x) => ({
        join_request_id: String(x.flag || x.uid || ''),
        member_openid: String(x.uid || ''),
        username: String(x.nickname || x.comment || ''),
        verify_info: x.comment ? { verify_message: String(x.comment) } : {},
        apply_source: '',
        risk_tips: '',
        sub_type: String(x.subType || 'add'),
      }));
    return ok({ list: items, items, total: items.length });
  }

  async approveJoinRequest(gid, flag, op, opts = {}) {
    const target = this.joinRequests.find((x) => String(x.flag) === String(flag) || String(x.uid) === String(flag));
    // OneBot v11 的 sub_type 必须是 add（主动加群）或 invite（被邀请），
    // 入群申请一律是 add；写死 invite 会被协议端判定参数错误。
    const subType = String(target?.subType || opts?.subType || 'add');
    const r = await this.call('set_group_add_request', {
      flag: target?.flag ?? flag,
      sub_type: subType,
      approve: op === 'approve' ? true : false,
      ...(opts?.reason ? { reason: String(opts.reason) } : {}),
    });
    if (r && r.ok === false) return r;
    if (target) this.joinRequests = this.joinRequests.filter((x) => x !== target);
    return ok({});
  }

  async sendGroupNotice({ gid, content, pinned = false, confirmRequired = false, image = '' } = {}) {
    const params = {
      group_id: Number(gid),
      content: String(content || ''),
      pinned: !!pinned,
      confirm_required: !!confirmRequired,
    };
    if (image) params.image = String(image);
    const r = await this.call('_send_group_notice', params);
    if (r && r.ok === false) return r;
    return { ok: true, via: 'napcat', action: 'send-group-notice', qqGroupId: String(gid) };
  }

  async getGroupNotices(gid) {
    const r = await this.call('_get_group_notice', { group_id: Number(gid) });
    if (r && r.ok === false) return r;
    const list = Array.isArray(r) ? r : [];
    return { ok: true, via: 'napcat', action: 'list-group-notices', qqGroupId: String(gid), notices: list, all: list };
  }

  async deleteGroupNotice({ gid, noticeId } = {}) {
    const r = await this.call('_del_group_notice', { group_id: Number(gid), notice_id: String(noticeId || '') });
    if (r && r.ok === false) return r;
    return { ok: true, via: 'napcat', action: 'delete-group-notice', qqGroupId: String(gid) };
  }

  stats() {
    return { transport: 'napcat', connected: this.transport?.connected === true, selfId: this.selfId };
  }
}
