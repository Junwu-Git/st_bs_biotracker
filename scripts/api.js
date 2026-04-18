import { DEFAULT_SYSTEM_PROMPT } from './state.js';

export function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = String(text).match(/```json\s*([\s\S]*?)```/i) || String(text).match(/```([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const start = String(text).indexOf('{');
  const end = String(text).lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(String(text).slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function getApiBase(settings) {
  return String(settings.apiUrl || '').trim().replace(/\/+$/, '');
}

export function getAuthHeaders(settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function buildJsonRetryInstruction() {
  return [
    '你上一条回复不是合法 JSON。',
    '现在请重新作答，并且只输出一个可直接 JSON.parse 的 JSON 对象。',
    '不要输出 Markdown，不要输出 ```json，不要输出解释文字，不要输出对象之外的任何字符。',
  ].join('\n');
}

function summarizeModelText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '模型返回为空字符串';
  return normalized.slice(0, 300);
}

function sanitizeTransportString(value) {
  const text = String(value ?? '');
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) continue;
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += text[index] + text[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    result += text[index];
  }
  return result;
}

function sanitizeTransportValue(value) {
  if (typeof value === 'string') return sanitizeTransportString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTransportValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeTransportValue(item)]),
    );
  }
  return value;
}

function buildWrapperChatMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === 'object')
    .map((message) => ({
      role: String(message.role || 'user'),
      parts: [{ text: sanitizeTransportString(message.content || '') }],
    }));
}

function pickFiniteNumber(...values) {
  for (const value of values) {
    const next = Number(value);
    if (Number.isFinite(next)) return next;
  }
  return null;
}

async function getStPresetSamplingBody(settings) {
  if (!settings?.useStPresetForAsync) return {};
  try {
    const presetResult = await globalThis.ST_API?.preset?.get?.();
    const preset = presetResult?.preset;
    const other = preset?.other && typeof preset.other === 'object' ? preset.other : {};
    const utilityPrompts = preset?.utilityPrompts && typeof preset.utilityPrompts === 'object' ? preset.utilityPrompts : {};

    const temperature = pickFiniteNumber(other.temp_openai, other.temp, other.temperature);
    const topP = pickFiniteNumber(other.top_p_openai, other.top_p);
    const frequencyPenalty = pickFiniteNumber(other.freq_pen_openai, other.frequency_penalty, other.freq_pen);
    const presencePenalty = pickFiniteNumber(other.pres_pen_openai, other.presence_penalty, other.pres_pen);
    const maxTokens = pickFiniteNumber(other.openai_max_tokens, other.max_tokens);
    const seed = pickFiniteNumber(utilityPrompts.seed, other.seed);

    const body = {};
    if (temperature !== null) body.temperature = temperature;
    if (topP !== null) body.top_p = topP;
    if (frequencyPenalty !== null) body.frequency_penalty = frequencyPenalty;
    if (presencePenalty !== null) body.presence_penalty = presencePenalty;
    if (maxTokens !== null && maxTokens > 0) body.max_tokens = Math.max(1, Math.floor(maxTokens));
    if (seed !== null && seed >= 0) body.seed = Math.floor(seed);
    return body;
  } catch (error) {
    console.warn('[BS BioTracker] failed to read ST preset sampling settings', error);
    return {};
  }
}

async function requestChatCompletion(apiBase, settings, body) {
  const postBody = async (requestBody) => {
    try {
      return await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: getAuthHeaders(settings),
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw new Error(`无法连接到 API。请检查 Base URL、服务是否启动，或是否被 CORS 拦截。原始错误: ${String(error?.message || error)}`);
    }
  };

  let response = await postBody(body);
  let errorText = '';
  if (!response.ok) errorText = await response.text().catch(() => '');

  if (!response.ok && response.status === 400 && body.response_format) {
    const fallbackBody = {
      model: body.model,
      temperature: body.temperature,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      max_tokens: body.max_tokens,
      seed: body.seed,
      messages: body.messages,
    };
    response = await postBody(fallbackBody);
    if (!response.ok) errorText = await response.text().catch(() => '');
  }

  const invalidArgument = response.status === 400 && /invalid argument|badRequest/i.test(errorText);
  if (!response.ok && invalidArgument) {
    const minimalBody = {
      model: body.model,
      messages: body.messages,
    };
    response = await postBody(minimalBody);
    if (!response.ok) errorText = await response.text().catch(() => '');
  }

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${errorText.slice(0, 300)}`);
  }
  return response.json();
}

async function requestViaStPromptGenerate(settings, messages) {
  if (!settings?.useStPresetForAsync || typeof globalThis.ST_API?.prompt?.generate !== 'function') return null;
  const wrapperMessages = buildWrapperChatMessages(messages);
  if (wrapperMessages.length === 0) return null;
  const response = await globalThis.ST_API.prompt.generate({
    writeToChat: false,
    timeoutMs: 120000,
    preset: { mode: 'current' },
    worldBook: { mode: 'disable' },
    chatHistory: { replace: wrapperMessages },
  });
  return String(response?.text || '');
}

export async function fetchModelList(settings) {
  const apiBase = getApiBase(settings);
  if (!apiBase) throw new Error('请先填写 API Base URL');
  if (!settings.apiKey) throw new Error('请先填写 API Key');
  const response = await fetch(`${apiBase}/models`, { method: 'GET', headers: getAuthHeaders(settings) });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`模型列表请求失败 ${response.status}: ${errorText.slice(0, 240)}`);
  }
  const data = await response.json();
  const models = (Array.isArray(data?.data) ? data.data : [])
    .map((item) => String(item?.id || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (models.length === 0) throw new Error('API 有响应，但没有返回可用模型');
  return models;
}

export async function callOpenAICompatible(settings, payload, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const apiBase = getApiBase(settings);
  const model = String(settings.model || '').trim();
  const safePayload = sanitizeTransportValue(payload);
  const safeSystemPrompt = sanitizeTransportString(systemPrompt || DEFAULT_SYSTEM_PROMPT);
  const baseMessages = [
    { role: 'system', content: safeSystemPrompt },
    { role: 'user', content: JSON.stringify(safePayload) },
  ];
  if (settings?.useStPresetForAsync) {
    try {
      const content = await requestViaStPromptGenerate(settings, baseMessages);
      if (content !== null) {
        let parsed = extractJson(content);
        if (!parsed || typeof parsed !== 'object') {
          const retryContent = await requestViaStPromptGenerate(settings, [
            ...baseMessages,
            { role: 'assistant', content: String(content || '') },
            { role: 'user', content: buildJsonRetryInstruction() },
          ]);
          parsed = extractJson(retryContent);
          if (!parsed || typeof parsed !== 'object') {
            throw new Error(
              `模型没有返回可解析的 JSON。原始回覆：${summarizeModelText(retryContent || content)}`,
            );
          }
        }
        return parsed;
      }
    } catch (error) {
      console.warn('[BS BioTracker] ST prompt.generate failed, fallback to direct API', error);
    }
  }

  if (!apiBase || !model) throw new Error('API URL 或模型名称尚未配置');
  const stPresetSampling = await getStPresetSamplingBody(settings);
  const body = {
    model,
    temperature: 0.2,
    ...stPresetSampling,
    messages: baseMessages,
    response_format: { type: 'json_object' },
  };
  const data = await requestChatCompletion(apiBase, settings, body);
  const content = data?.choices?.[0]?.message?.content || '';
  let parsed = extractJson(content);
  if (!parsed || typeof parsed !== 'object') {
    const retryBody = {
      model,
      temperature: 0.1,
      ...stPresetSampling,
      messages: [
        ...baseMessages,
        { role: 'assistant', content: String(content || '') },
        { role: 'user', content: buildJsonRetryInstruction() },
      ],
      response_format: { type: 'json_object' },
    };
    const retryData = await requestChatCompletion(apiBase, settings, retryBody);
    const retryContent = retryData?.choices?.[0]?.message?.content || '';
    parsed = extractJson(retryContent);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(
        `模型没有返回可解析的 JSON。原始回覆：${summarizeModelText(retryContent || content)}`,
      );
    }
  }
  return parsed;
}
