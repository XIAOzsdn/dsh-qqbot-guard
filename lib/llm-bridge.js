/**
 * 模型中转适配器：把 DSH 的 LLM 请求转发到插件自己配置的 API
 * （设置 → AI 辅助审核：baseUrl / apiKey / model）。
 *
 * 插件在 DSH 里注册一个 provider 路由（默认 `qqg-deepseek`），DSH 以为在调用
 * 本地模型，实际由这里转成 OpenAI 兼容的 /chat/completions 流式请求发出。
 * 这样专用会话使用的是插件自己的 API 额度，而不是 DSH 默认模型。
 */

/** 默认路由名 */
export const BRIDGE_PROVIDER = 'qqg-deepseek';

function textOf(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.type === 'text')
    .map((b) => String(b.text || ''))
    .join('');
}

/** 把 DSH 消息转成 OpenAI chat.completions 的 messages */
export function toOpenAiMessages(messages = [], system = '') {
  const out = [];
  if (system) out.push({ role: 'system', content: String(system) });
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      const text = textOf(m.content);
      if (text) out.push({ role: 'system', content: text });
      continue;
    }
    if (m.role === 'developer') continue; // 工具增删声明由 tools 字段承载
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      const calls = (Array.isArray(m.content) ? m.content : []).filter((b) => b && b.type === 'tool-call');
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: String(c.id || ''),
          type: 'function',
          function: { name: String(c.name || ''), arguments: String(c.arguments || '{}') },
        }));
      }
      if (msg.content || msg.tool_calls) out.push(msg);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(m.toolCallId || ''),
        content: textOf(m.content) || '',
      });
    }
  }
  return out;
}

/** 把 DSH 工具声明转成 OpenAI tools */
export function toOpenAiTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: String(t.name),
        description: String(t.description || ''),
        parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
      },
    }));
}

/** 流式响应的块状态 */
function blockState() {
  return { nextIndex: 0, text: null, reasoning: null, tools: new Map() };
}

/**
 * 创建中转适配器（实现 LlmAdapter 所需的最小接口）。
 * @param {{getConfig: () => {baseUrl?: string, apiKey?: string, model?: string, timeoutMs?: number}, logger?: Console}} deps
 */
export function createLlmBridge({ getConfig, logger } = {}) {
  const log = logger || console;
  const cfg = () => (typeof getConfig === 'function' ? getConfig() || {} : {});
  const baseUrl = () => String(cfg().baseUrl || '').trim().replace(/\/+$/u, '');
  const apiKey = () => String(cfg().apiKey || '').trim();
  const defaultModel = () => String(cfg().model || '').trim();

  const bridge = {
    providerInfo(provider) {
      return { id: provider, name: '插件 API（中转）' };
    },
    providerRetryPolicy() {
      return undefined;
    },
    async listModels(provider) {
      const model = defaultModel();
      return model ? [{ provider, id: model, name: model }] : [];
    },
    async resolveModel(provider, model) {
      return { provider, id: String(model || defaultModel()), name: String(model || defaultModel()), inputModalities: ['text'] };
    },
    async prepareCall(provider, model) {
      return { model: await bridge.resolveModel(provider, model), stream: (options) => bridge.stream(options) };
    },

    /**
     * 转发一次模型请求，产出 DSH 的 StreamChunk 序列。
     * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
     */
    async *stream(options) {
      const base = baseUrl();
      const key = apiKey();
      if (!base) throw new Error('插件 API 未配置 baseUrl（设置 → AI 辅助审核）');
      if (!key) throw new Error('插件 API 未配置 apiKey（设置 → AI 辅助审核）');
      const body = {
        model: String(options?.model || defaultModel()),
        messages: toOpenAiMessages(options?.messages, options?.system || ''),
        stream: true,
      };
      if (Array.isArray(options?.tools) && options.tools.length) body.tools = toOpenAiTools(options.tools);
      if (Number.isFinite(Number(options?.maxTokens))) body.max_tokens = Number(options.maxTokens);
      if (Number.isFinite(Number(options?.temperature))) body.temperature = Number(options.temperature);
      if (Array.isArray(options?.stop) && options.stop.length) body.stop = options.stop.map(String);
      const timeout = Math.max(5000, Number(cfg().timeoutMs) || 120000);
      const startedAt = Date.now();
      log.info?.(`llm 中转请求 model=${body.model} messages=${body.messages.length} tools=${Array.isArray(body.tools) ? body.tools.length : 0} timeout=${Math.round(timeout / 1000)}s`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('插件 API 请求超时')), timeout);
      const onAbort = () => controller.abort(options?.signal?.reason);
      options?.signal?.addEventListener?.('abort', onAbort, { once: true });
      const state = blockState();
      const startBlock = (index, blockType) => ({ type: 'block-start', index, blockType });
      const endBlock = (index, block) => ({ type: 'block-end', index, block });
      let finishReason = { kind: 'stop' };
      let usage = null;
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          throw new Error(`插件 API 返回 ${res.status}：${text.slice(0, 200)}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const handleChunk = (json) => {
          const chunks = [];
          const choice = json?.choices?.[0];
          const delta = choice?.delta || {};
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            if (!state.reasoning) {
              state.reasoning = { index: state.nextIndex++, text: '' };
              chunks.push(startBlock(state.reasoning.index, 'reasoning'));
            }
            state.reasoning.text += delta.reasoning_content;
            chunks.push({ type: 'reasoning-delta', index: state.reasoning.index, text: delta.reasoning_content });
          }
          if (typeof delta.content === 'string' && delta.content) {
            if (!state.text) {
              state.text = { index: state.nextIndex++, text: '' };
              chunks.push(startBlock(state.text.index, 'text'));
            }
            state.text.text += delta.content;
            chunks.push({ type: 'text-delta', index: state.text.index, text: delta.content });
          }
          for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const key2 = Number.isInteger(call.index) ? call.index : state.tools.size;
            let tool = state.tools.get(key2);
            if (!tool) {
              tool = { index: state.nextIndex++, id: `call_${key2}_${Date.now()}`, name: '', args: '' };
              state.tools.set(key2, tool);
              chunks.push(startBlock(tool.index, 'tool-call'));
            }
            if (call.id) tool.id = String(call.id);
            if (call.function?.name) tool.name = String(call.function.name);
            const deltaArgs = String(call.function?.arguments || '');
            if (deltaArgs) {
              tool.args += deltaArgs;
              chunks.push({ type: 'tool-call-delta', index: tool.index, id: tool.id, name: tool.name || undefined, argumentsDelta: deltaArgs });
            }
          }
          if (choice?.finish_reason === 'tool_calls') finishReason = { kind: 'tool-calls' };
          else if (choice?.finish_reason === 'length') finishReason = { kind: 'max-tokens' };
          if (json?.usage) {
            usage = {
              inputTokens: Number(json.usage.prompt_tokens) || 0,
              outputTokens: Number(json.usage.completion_tokens) || 0,
              ...(Number.isFinite(Number(json.usage.total_tokens)) ? { totalTokens: Number(json.usage.total_tokens) } : {}),
            };
          }
          return chunks;
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let json;
            try { json = JSON.parse(payload); } catch { continue; }
            for (const chunk of handleChunk(json)) yield chunk;
          }
        }
        // 关闭所有块
        if (state.reasoning) yield endBlock(state.reasoning.index, { type: 'reasoning', text: state.reasoning.text });
        if (state.text) yield endBlock(state.text.index, { type: 'text', text: state.text.text });
        for (const tool of state.tools.values()) {
          yield endBlock(tool.index, { type: 'tool-call', id: tool.id, name: tool.name, arguments: tool.args || '{}' });
        }
        if (usage) yield { type: 'usage', usage };
        yield { type: 'finish', reason: finishReason };
        log.info?.(`llm 中转完成 ${Math.round((Date.now() - startedAt) / 1000)}s finish=${finishReason.kind}`);
      } catch (error) {
        if (options?.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('请求已取消');
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        log.warn?.(`[qqbot-guard] 插件 API 中转失败（${elapsed}s，超时上限 ${Math.round(timeout / 1000)}s）：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
  return bridge;
}
