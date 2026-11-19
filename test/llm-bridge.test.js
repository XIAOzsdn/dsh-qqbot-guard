import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_PROVIDER, createLlmBridge, toOpenAiMessages, toOpenAiTools } from '../lib/llm-bridge.js';

test('消息转换：system / user / assistant(tool_call) / tool', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我充值' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool-call', id: 'call_1', name: 'bsk_page', arguments: '{"action":"navigate"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
  ];
  const out = toOpenAiMessages(messages);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user');
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].tool_calls.length, 1);
  assert.equal(out[2].tool_calls[0].function.name, 'bsk_page');
  assert.equal(out[3].role, 'tool');
  assert.equal(out[3].tool_call_id, 'call_1');
  assert.equal(out[3].content, 'ok');
});

test('消息转换：developer 消息被忽略，system 参数插到最前', () => {
  const out = toOpenAiMessages([
    { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ], '系统提示');
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, '系统提示');
  assert.equal(out[1].role, 'user');
});

test('工具声明转换：name/description/parameters', () => {
  const out = toOpenAiTools([
    { name: 'bsk_session', description: '开浏览器', parameters: { type: 'object', properties: { action: { type: 'string' } } } },
    { name: 'no_params' },
    { description: '没有名字' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'bsk_session');
  assert.deepEqual(out[0].function.parameters.properties.action, { type: 'string' });
  assert.deepEqual(out[1].function.parameters, { type: 'object', properties: {} });
});

test('适配器元数据：providerInfo / listModels / resolveModel', async () => {
  const bridge = createLlmBridge({ getConfig: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-flash' }) });
  assert.equal(bridge.providerInfo(BRIDGE_PROVIDER).id, BRIDGE_PROVIDER);
  assert.equal(bridge.providerRetryPolicy(), undefined);
  const models = await bridge.listModels(BRIDGE_PROVIDER);
  assert.equal(models[0].id, 'deepseek-flash');
  const resolved = await bridge.resolveModel(BRIDGE_PROVIDER, 'deepseek-chat');
  assert.deepEqual(resolved.inputModalities, ['text']);
  assert.equal(resolved.id, 'deepseek-chat');
});

test('缺少 baseUrl/apiKey 时流式请求直接报错', async () => {
  const bridge = createLlmBridge({ getConfig: () => ({}) });
  const iter = bridge.stream({ provider: BRIDGE_PROVIDER, model: 'm', messages: [] });
  await assert.rejects(async () => { for await (const _ of iter) { /* noop */ } }, /baseUrl/);
  const bridge2 = createLlmBridge({ getConfig: () => ({ baseUrl: 'https://x.test' }) });
  const iter2 = bridge2.stream({ provider: BRIDGE_PROVIDER, model: 'm', messages: [] });
  await assert.rejects(async () => { for await (const _ of iter2) { /* noop */ } }, /apiKey/);
});
