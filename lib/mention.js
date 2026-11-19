/**
 * 群消息里的 @ 标记。
 *
 * 插件内部统一用 `<qqbot-at-user id="…" />` 表示 @（官方消息格式），
 * NapCat 发送前会由 `toSegments()` 转成 OneBot 的 at 段；
 * 各业务模块只负责生成这个标记，不关心底层传输。
 */
export function mention(openid) {
  const id = String(openid || '').trim().replace(/["<>]/gu, '');
  return id ? `<qqbot-at-user id="${id}" />` : '';
}
