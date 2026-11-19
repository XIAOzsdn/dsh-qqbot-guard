import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import {
  PAY_METHODS, RECHARGE_ERRORS, RECHARGE_PROGRESS_MILESTONES, RECHARGE_TIMEOUTS, buildAgentPrompt, createRequest,
  estimateRechargeProgress, formatRechargeProgress, inferRechargeErrorCode, isAbandonReply, isContinueReply,
  listRequests, maskOrderId, parseRechargeCommand, rechargeDir, rechargeErrorText, rechargeWorkspace, scanAgentFiles,
  updateRequest,
} from '../lib/recharge.js';
import { parseIntentReply } from '../lib/ai.js';
import { handleNaturalCommand, parseNaturalIntent } from '../lib/natural.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-recharge-'));
  const store = new Store(dir);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('解析充值指令：金额 + 支付方式', () => {
  assert.deepEqual(
    (() => { const r = parseRechargeCommand('充值 50 支付宝'); return { amount: r.amount, method: r.method }; })(),
    { amount: 50, method: 'alipay' },
  );
  assert.equal(parseRechargeCommand('充值50元 微信').method, 'wechat');
  assert.equal(parseRechargeCommand('充 100 微信支付').amount, 100);
  assert.equal(parseRechargeCommand('充值 ¥20').amount, 20);
  assert.equal(parseRechargeCommand('查一下余额'), null);
  assert.equal(parseRechargeCommand('充值 0 支付宝'), null);
  // 外部充值对象不该被当成给插件 API 充值
  assert.equal(parseRechargeCommand('我要充3块钱话费'), null);
  assert.equal(parseRechargeCommand('给游戏币充值 100 微信'), null);
  // 无动词、无支付方式：不是充值指令
  assert.equal(parseRechargeCommand('这个 50 元'), null);
});

test('订单号脱敏：中间 5 位替换为 *，短号也不整号外泄', () => {
  assert.equal(maskOrderId('ABCDEFGHIJ'), 'AB*****HIJ');
  assert.equal(maskOrderId('1234567890123456'), '12345*****123456');
  // 旧版对 ≤5 位直接原样返回，等于把完整单号发到群里；现在保留首尾各 1 位
  assert.equal(maskOrderId('12345'), '1***5');
  assert.equal(maskOrderId('123'), '1*3');
  assert.equal(maskOrderId('12'), '**');
  assert.equal(maskOrderId(''), '');
});

test('创建请求：写入 state 与请求文件', () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const item = createRequest(store, {
      gid: 'g1', uid: 'u1', name: '青衫故人', amount: 50, method: 'alipay', msgId: 'm1',
    });
    assert.equal(item.status, 'pending');
    assert.equal(item.amount, 50);
    assert.equal(item.method, 'alipay');
    assert.equal(listRequests(store, 'pending').length, 1);
    const file = join(dir, 'recharge', `req-${item.id}.json`);
    assert.equal(existsSync(file), true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.id, item.id);
    assert.equal(saved.amount, 50);
    assert.equal(saved.methodLabel, '支付宝');
    updateRequest(store, item.id, { status: 'qr-sent' });
    assert.equal(listRequests(store, 'qr-sent').length, 1);
    // 提示词动态填实际数据（金额/方式/请求ID/输出路径），且带插件名与失败码约定
    const prompt = buildAgentPrompt(item, dir);
    assert.ok(prompt.includes('dsh-qqbot-guard'));
    assert.ok(prompt.includes(item.id));
    assert.ok(prompt.includes('50 元'));
    assert.ok(prompt.includes('支付宝'));
    assert.ok(prompt.includes(join(dir, 'recharge', `qr-${item.id}.png`)));
    assert.ok(prompt.includes(join(dir, 'recharge', `res-${item.id}.json`)));
    assert.ok(prompt.includes('BSK_CLI_MISSING'));
    assert.ok(prompt.includes('默认浏览器'), '应包含“先打开默认浏览器”步骤');
    assert.ok(prompt.includes('bsk status'), '应包含扩展连接检查');
    assert.ok(prompt.includes('最多重试 2 次'), '应包含失败重连 2 次');
    // 文件扫描
    const scan = scanAgentFiles(dir);
    assert.equal(scan.qrs.length, 0);
    assert.equal(scan.results.length, 0);
  } finally {
    cleanup();
  }
});

test('自然语言解析：充值意图带金额与方式', () => {
  const local = parseNaturalIntent('充值 50 支付宝');
  assert.equal(local.action, 'recharge');
  assert.equal(local.amount, 50);
  assert.equal(local.method, 'alipay');
  const local2 = parseNaturalIntent('给群充值 100 微信');
  assert.equal(local2.action, 'recharge');
  assert.equal(local2.method, 'wechat');
});

test('AI 解析：recharge 在动作白名单内且金额受限', () => {
  const r = parseIntentReply('{"action":"recharge","amount":50,"method":"alipay"}');
  assert.equal(r.ok, true);
  assert.equal(r.intent.action, 'recharge');
  assert.equal(r.intent.amount, 50);
  assert.equal(r.intent.method, 'alipay');
  const bad = parseIntentReply('{"action":"recharge","amount":999999,"method":"paypal"}');
  assert.equal(bad.ok, true);
  assert.equal(bad.intent.amount, 0, '超范围金额归零');
  assert.equal(bad.intent.method, '', '未知支付方式留空');
});

test('支付方式映射', () => {
  assert.equal(PAY_METHODS.alipay, '支付宝');
  assert.equal(PAY_METHODS.wechat, '微信支付');
});

test('插件专用工作区随用随建', () => {
  const { dir, cleanup } = tempStore();
  try {
    const ws = rechargeWorkspace(dir);
    assert.equal(existsSync(ws), true, '工作区目录应自动创建');
    assert.ok(ws.includes('recharge-workspace'));
    const rd = rechargeDir(dir);
    assert.equal(existsSync(rd), true);
  } finally {
    cleanup();
  }
});

test('未配置充值处理端：返回配置提醒，而不是技术错误', async () => {
  const { store, cleanup } = tempStore();
  try {
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '充值 50 支付宝', msgId: 'm1',
      settings: store.settings, store, client,
    });
    assert.equal(r.handled, true);
    assert.ok(sent.some((t) => t.includes('请先进行配置')), `应提醒配置：${sent.join(' | ')}`);
    assert.ok(!sent.some((t) => t.includes('功能未启用')), '不应暴露技术错误');
  } finally {
    cleanup();
  }
});

test('已配置但无可用 agent：返回专业错误码与处置建议，不用“请先配置”模板', async () => {
  const { store, cleanup } = tempStore();
  try {
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '充值 50 支付宝', msgId: 'm1',
      settings: store.settings, store, client,
      requestRecharge: async () => false,
    });
    assert.equal(r.handled, true);
    assert.ok(sent.some((t) => t.includes('E_AGENT_UNAVAILABLE')), `应返回专业错误码：${sent.join(' | ')}`);
    assert.ok(sent.some((t) => t.includes('bridge.log')), '应包含排查建议');
    assert.ok(!sent.some((t) => t.includes('请先进行配置')), '已配置时不能复用配置模板');
  } finally {
    cleanup();
  }
});

test('失败码映射：不同错误对应不同建议', () => {
  assert.match(rechargeErrorText('BROWSER_NOT_CONNECTED'), /E_BROWSER_NOT_CONNECTED/);
  assert.match(rechargeErrorText('BROWSER_NOT_CONNECTED'), /bsk daemon pair/);
  assert.match(rechargeErrorText('BSK_CLI_MISSING'), /bskPath/);
  assert.match(rechargeErrorText('PAYMENT_TIMEOUT'), /重新发起充值/);
  assert.match(rechargeErrorText('QR_SEND_FAILED'), /该群/);
  assert.match(rechargeErrorText('HANDLER_TIMEOUT'), /3 分钟/);
  assert.match(rechargeErrorText('BUSY'), /E_BUSY/);
  assert.match(rechargeErrorText('UNKNOWN', 'boom'), /详情：boom/);
  assert.equal(rechargeErrorText(''), RECHARGE_ERRORS.UNKNOWN);
});

test('并发已满：返回 E_BUSY 提示', async () => {
  const { store, cleanup } = tempStore();
  try {
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '充值 50 支付宝', msgId: 'm1',
      settings: store.settings, store, client,
      requestRecharge: async () => 'E_BUSY',
    });
    assert.equal(r.handled, true);
    assert.ok(sent.some((t) => t.includes('E_BUSY')), `应返回繁忙提示：${sent.join(' | ')}`);
  } finally {
    cleanup();
  }
});

test('投递成功：回复受理并标记 dispatched', async () => {
  const { store, cleanup } = tempStore();
  try {
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '充值 50 支付宝', msgId: 'm1',
      settings: store.settings, store, client,
      requestRecharge: async () => true,
    });
    assert.equal(r.handled, true);
    assert.ok(sent.some((t) => t.includes('已受理充值')));
    assert.equal(listRequests(store, 'dispatched').length, 1);
  } finally {
    cleanup();
  }
});

test('自由文本错误可推断失败码', () => {
  assert.equal(inferRechargeErrorCode('the bsk CLI ("bsk") was not found'), 'BSK_CLI_MISSING');
  assert.equal(inferRechargeErrorCode('no browser is currently connected'), 'BROWSER_NOT_CONNECTED');
  assert.equal(inferRechargeErrorCode('需要登录'), 'LOGIN_REQUIRED');
  assert.equal(inferRechargeErrorCode('支付超时'), 'PAYMENT_TIMEOUT');
  assert.equal(inferRechargeErrorCode('元素不存在'), 'PAGE_CHANGED');
  assert.equal(inferRechargeErrorCode('未知错误'), 'UNKNOWN');
});

test('进度估算：按工具调用次数与时长给出阶段/预计时间', () => {
  const p0 = estimateRechargeProgress(5_000, 0);
  assert.match(p0.stage, /启动处理会话/);
  const p1 = estimateRechargeProgress(30_000, 2);
  assert.match(p1.stage, /打开充值页/);
  const p2 = estimateRechargeProgress(45_000, 4);
  assert.match(p2.stage, /生成支付二维码/);
  assert.match(p2.eta, /30 秒/);
  const p3 = estimateRechargeProgress(130_000, 2);
  assert.match(p3.eta, /5 分钟/);
  assert.equal(p3.elapsedSec, 130);
  assert.ok(p2.percent > p1.percent, '阶段越往后进度越高');
});

test('进度文案：简短、带请求编号与金额', () => {
  const item = { id: 'rcg-abc', amount: 50, method: 'alipay' };
  const text = formatRechargeProgress(item, estimateRechargeProgress(30_000, 2));
  assert.match(text, /rcg-abc/);
  assert.match(text, /50 元/);
  assert.match(text, /支付宝/);
  assert.ok(text.length < 120, '避免长文案刷屏');
});

test('进度推送最多 3 档，且 5 分钟超时提示存在', () => {
  assert.deepEqual([...RECHARGE_PROGRESS_MILESTONES], [20, 60, 120]);
  assert.match(rechargeErrorText('QR_TIMEOUT'), /5 分钟/);
  assert.match(rechargeErrorText('E_QR_TIMEOUT'), /强制结束/);
});

test('三段计时：5 分钟出码 + 3 分钟支付 + 2 分钟延长 = 10 分钟', () => {
  assert.equal(RECHARGE_TIMEOUTS.qrWaitMs, 5 * 60_000);
  assert.equal(RECHARGE_TIMEOUTS.payWaitMs, 3 * 60_000);
  assert.equal(RECHARGE_TIMEOUTS.extendMs, 2 * 60_000);
  assert.equal(RECHARGE_TIMEOUTS.askReplyMs, 2 * 60_000);
  const total = RECHARGE_TIMEOUTS.qrWaitMs + RECHARGE_TIMEOUTS.payWaitMs + RECHARGE_TIMEOUTS.extendMs;
  assert.equal(total, 10 * 60_000);
});

test('继续/放弃回复识别', () => {
  assert.equal(isContinueReply('继续'), true);
  assert.equal(isContinueReply('继续等待'), true);
  assert.equal(isContinueReply('再等等'), true);
  assert.equal(isContinueReply('放弃'), false);
  assert.equal(isAbandonReply('放弃'), true);
  assert.equal(isAbandonReply('算了不用了'), true);
  assert.equal(isAbandonReply('继续'), false);
});
