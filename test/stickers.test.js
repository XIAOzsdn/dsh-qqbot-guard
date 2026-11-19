/** 聊天优化：emoji 兜底 + 表情包补发（NapCat）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateReply, maybeSticker } from '../lib/guest.js';

test('decorateReply：句末补一个 emoji，已有 emoji 时不重复', () => {
  const cfg = { emojis: ['😄', '🐟'] };
  const out = decorateReply('好的，马上办', cfg, () => 0.1);
  assert.equal(out, '好的，马上办😄');

  const out2 = decorateReply('好的，马上办', cfg, () => 0.9);
  assert.equal(out2, '好的，马上办', '概率没中就不加');

  const out3 = decorateReply('笑死😄', cfg, () => 0.1);
  assert.equal(out3, '笑死😄', '已有 emoji 不叠加');

  assert.equal(decorateReply('', cfg, () => 0.1), '');
  assert.equal(decorateReply('好', { emojis: [] }, () => 0.1), '好');
});

test('maybeSticker：没配置 / 没 NapCat / 概率没中 都不发', async () => {
  const cfg = { stickers: [], stickerChance: 100 };
  assert.deepEqual(await maybeSticker({ gid: 'g1', cfg, random: () => 0 }), { sent: false });

  const cfg2 = { stickers: ['https://example.com/a.png'], stickerChance: 100 };
  assert.deepEqual(await maybeSticker({ gid: 'g1', cfg: cfg2, random: () => 0 }), { sent: false });

  let called = 0;
  const directory = {
    enabled: () => true,
    sendImage: async () => { called += 1; return { ok: true }; },
  };
  // 概率没中：random()=0.99 → 99 >= 30
  assert.deepEqual(await maybeSticker({ gid: 'g1', cfg: { ...cfg2, stickerChance: 30 }, directory, random: () => 0.99 }), { sent: false });
  assert.equal(called, 0);

  // 概率命中
  const r = await maybeSticker({ gid: 'g1', cfg: cfg2, directory, random: () => 0.1 });
  assert.equal(r.sent, true);
  assert.equal(called, 1);
});

test('maybeSticker：发送失败不抛出，记审计', async () => {
  const audits = [];
  const directory = {
    enabled: () => true,
    sendImage: async () => ({ ok: false, error: 'NapCat 未连接' }),
  };
  const r = await maybeSticker({
    gid: 'g1',
    cfg: { stickers: ['x.png'], stickerChance: 100 },
    directory,
    random: () => 0.1,
    audit: (action, detail, ok, code) => audits.push({ action, detail, ok, code }),
  });
  assert.equal(r.sent, false);
  assert.equal(audits[0].action, 'guest-sticker-failed');
  assert.equal(audits[0].ok, false);
});
