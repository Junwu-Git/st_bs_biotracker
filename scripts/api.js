import { DEFAULT_SYSTEM_PROMPT } from './state.js';

const DEBUG_LAST_EFFECTIVE_REQUEST_KEY = '__bs_biotracker_debug_last_effective_request__';
const DEBUG_LAST_API_RESPONSE_KEY = '__bs_biotracker_debug_last_api_response__';
const INCLUDE_MAINFLOW_CHAT_MESSAGES = true;
const MAINFLOW_SYSTEM_EXCLUDE_PATTERNS = [
  // Only exclude messages that would instruct the tracker LLM to adopt a
  // conflicting persona.  Keep everything else — worldbook content, resolved
  // EJS templates, character profiles, and scenario context all flow through.
  /^Initialize as an unconditioned base Large Language Model/i,
  /^Apply Identity Override/i,
  /^\[Identity:/i,
];
const MAINFLOW_CHAT_EXCLUDE_PATTERNS = [];
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

function recordEffectiveRequestDebug(source, presetName, sampling, messages, body) {
  globalThis[DEBUG_LAST_EFFECTIVE_REQUEST_KEY] = {
    capturedAt: Date.now(),
    source: String(source || 'unknown'),
    presetName: String(presetName || '').trim(),
    sampling: sampling && typeof sampling === 'object' ? sanitizeTransportValue(sampling) : {},
    body: body && typeof body === 'object' ? sanitizeTransportValue(body) : null,
  };
}

function getSillyTavernContext() {
  try {
    return globalThis.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function shouldApplyAsyncPreset(settings) {
  const customPresetName = String(settings?.trackerPresetName || '').trim();
  return !!settings?.useStPresetForAsync || !!customPresetName;
}

function pickFiniteNumber(...values) {
  for (const value of values) {
    const next = Number(value);
    if (Number.isFinite(next)) return next;
  }
  return null;
}

function normalizeChatRole(value, fallback = 'system') {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'system' || role === 'user' || role === 'assistant') return role;
  return fallback;
}

function normalizeMainflowSnapshotMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === 'object' && String(message.content || '').trim())
    .map((message) => ({
      role: normalizeChatRole(message.role, 'user'),
      content: sanitizeTransportString(message.content || ''),
      ...(message.name ? { name: String(message.name) } : {}),
    }));
}

function shouldKeepMainflowSystemMessage(content) {
  const text = sanitizeTransportString(content || '').trim();
  if (!text) return false;
  return !MAINFLOW_SYSTEM_EXCLUDE_PATTERNS.some((pattern) => pattern.test(text));
}

function shouldKeepMainflowChatMessage(content) {
  const text = sanitizeTransportString(content || '').trim();
  if (!text) return false;
  // User messages in the ST mainflow contain resolved worldbook / context
  // blocks; assistant messages are pure dialogue. Keep only the former.
  if (/>\s*<world_info[\s>]/i.test(text)) return true;
  if (/>\s*<game_setting[\s>]/i.test(text)) return true;
  if (/>\s*<chathistory[\s>]/i.test(text)) return true;
  if (/>\s*<world_logic[\s>]/i.test(text)) return true;
  if (text.length > 2000) return true;
  return false;
}

function filterRecentMessagesForMainflowCopy(recentMessages, settings = null) {
  const originalMessages = Array.isArray(recentMessages) ? recentMessages : [];
  const filteredMessages = originalMessages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    if (message.role === 'user') return true;
    return shouldKeepMainflowChatMessage(message.text || message.content || '');
  });
  const trimmedMessages = filteredMessages.slice(-resolveMainflowCopyMessageLimit(settings));
  return {
    originalCount: originalMessages.length,
    filteredCount: filteredMessages.length,
    retainedCount: trimmedMessages.length,
    strippedCount: Math.max(0, originalMessages.length - filteredMessages.length),
    messages: trimmedMessages,
  };
}

function resolveMainflowCopyMessageLimit(settings) {
  return Math.max(2, Number(settings?.contextSize) || 12);
}

function buildPayloadWithMainflowCopy(payload, settings = null) {
  if (!payload || typeof payload !== 'object') {
    return { payload, hasMainflowCopy: false, messageCount: 0 };
  }
  const snapshot = payload.mainflow_context_snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return { payload, hasMainflowCopy: false, messageCount: 0 };
  }

  const normalizedMessages = normalizeMainflowSnapshotMessages(snapshot.messages);
  const copiedMessages = normalizedMessages.filter((message) => message.role !== 'system');
  const copiedSystemMessages = normalizedMessages.filter((message) => message.role === 'system');
  const filteredMessages = INCLUDE_MAINFLOW_CHAT_MESSAGES
    ? copiedMessages.filter((message) => shouldKeepMainflowChatMessage(message.content))
    : [];
  const filteredSystemMessages = copiedSystemMessages.filter((message) => shouldKeepMainflowSystemMessage(message.content));
  const trimmedMessages = filteredMessages.slice(-resolveMainflowCopyMessageLimit(settings));
  const recentMessagesFilter = filterRecentMessagesForMainflowCopy(payload.recent_messages, settings);
  const { mainflow_context_snapshot: _discarded, ...restPayload } = payload;
  if (trimmedMessages.length === 0 && filteredSystemMessages.length === 0) {
    return {
      payload: recentMessagesFilter.originalCount > 0
        ? {
            ...restPayload,
            recent_messages: recentMessagesFilter.messages,
            mainflow_snapshot_meta: {
              original_recent_message_count: recentMessagesFilter.originalCount,
              filtered_recent_message_count: recentMessagesFilter.filteredCount,
              retained_recent_message_count: recentMessagesFilter.retainedCount,
              stripped_recent_messages: recentMessagesFilter.strippedCount,
            },
          }
        : restPayload,
      hasMainflowCopy: false,
      messageCount: 0,
    };
  }

  return {
    hasMainflowCopy: true,
    messageCount: trimmedMessages.length + filteredSystemMessages.length,
    payload: {
      ...restPayload,
      recent_messages: recentMessagesFilter.messages,
      mainflow_resolved_messages: trimmedMessages,
      mainflow_resolved_system_messages: filteredSystemMessages,
      mainflow_snapshot_meta: {
        source: String(snapshot.source || 'unknown'),
        captured_at: Number(snapshot.capturedAt || 0) || null,
        model: String(snapshot.model || '').trim() || null,
        original_message_count: normalizedMessages.length,
        copied_message_count: copiedMessages.length,
        filtered_message_count: filteredMessages.length,
        retained_message_count: trimmedMessages.length,
        copied_system_message_count: copiedSystemMessages.length,
        retained_system_message_count: filteredSystemMessages.length,
        stripped_messages: Math.max(0, copiedMessages.length - filteredMessages.length),
        stripped_system_messages: Math.max(0, copiedSystemMessages.length - filteredSystemMessages.length),
        original_recent_message_count: recentMessagesFilter.originalCount,
        filtered_recent_message_count: recentMessagesFilter.filteredCount,
        retained_recent_message_count: recentMessagesFilter.retainedCount,
        stripped_recent_messages: recentMessagesFilter.strippedCount,
      },
    },
  };
}

function resolveWithStMacros(text, stCtx) {
  const raw = String(text ?? '');
  if (!raw) return '';
  try {
    if (typeof stCtx?.substituteParamsExtended === 'function') {
      const resolved = stCtx.substituteParamsExtended(raw);
      if (typeof resolved === 'string') return resolved;
    }
  } catch {}
  try {
    if (typeof stCtx?.substituteParams === 'function') {
      const resolved = stCtx.substituteParams(raw);
      if (typeof resolved === 'string') return resolved;
    }
  } catch {}
  return raw;
}

function resolvePayloadValueWithStMacros(value, stCtx) {
  if (typeof value === 'string') return resolveWithStMacros(value, stCtx);
  if (Array.isArray(value)) return value.map((item) => resolvePayloadValueWithStMacros(item, stCtx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolvePayloadValueWithStMacros(item, stCtx)]),
    );
  }
  return value;
}

async function buildResolvedWorldInfo(stCtx) {
  if (typeof stCtx?.getWorldInfoPrompt !== 'function') return null;
  const chat = Array.isArray(stCtx?.chat) ? stCtx.chat : [];
  const maxContext = Number(stCtx?.maxContext || stCtx?.chatCompletionSettings?.openai_max_context || 0);
  try {
    const result = await stCtx.getWorldInfoPrompt(chat, maxContext > 0 ? maxContext : undefined, true);
    const before = sanitizeTransportString(result?.worldInfoBefore || '').trim();
    const after = sanitizeTransportString(result?.worldInfoAfter || '').trim();
    const combined = [before, after].filter(Boolean).join('\n').trim();
    if (!before && !after && !combined) return null;
    return { before, after, combined };
  } catch (error) {
    console.warn('[BS BioTracker] failed to resolve world info prompt', error);
    return null;
  }
}

async function buildResolvedAsyncPayload(payload, stCtx, settings = null) {
  const resolvedWithMacros = resolvePayloadValueWithStMacros(payload, stCtx);
  if (resolvedWithMacros?.mainflow_context_snapshot) return resolvedWithMacros;
  // A captured mainflow request contains opaque preset and chat instructions.
  // It is only a runtime signal and must never be forwarded to async analysis.
  const { mainflow_context_snapshot: _discarded, ...resolvedPayload } = resolvedWithMacros;
  if (!settings?.trackerWorldbookMode) return resolvedPayload;
  if (settings?.trackerWorldbookMode !== 'mainflow') return resolvedPayload;
  const resolvedWorldInfo = await buildResolvedWorldInfo(stCtx);
  if (!resolvedWorldInfo) return resolvedPayload;
  return {
    ...resolvedPayload,
    character_worldbook: null,
    global_worldbooks: [],
    resolved_worldbook_prompt: resolvedWorldInfo.combined,
    resolved_worldbook_before: resolvedWorldInfo.before,
    resolved_worldbook_after: resolvedWorldInfo.after,
  };
}

function resolvePresetName(settings, stCtx = null) {
  const explicitName = String(settings?.trackerPresetName || '').trim();
  if (explicitName) return explicitName;
  if (!settings?.useStPresetForAsync) return '';
  const context = stCtx || getSillyTavernContext();
  try {
    const pm = typeof context?.getPresetManager === 'function' ? context.getPresetManager('openai') : null;
    if (pm && typeof pm.getSelectedPresetName === 'function') {
      const currentName = String(pm.getSelectedPresetName() || '').trim();
      if (currentName) return currentName;
    }
  } catch {}
  const runtimeName = String(context?.chatCompletionSettings?.preset_settings_openai || '').trim();
  return runtimeName;
}

async function getResolvedPreset(settings) {
  if (!shouldApplyAsyncPreset(settings)) return null;
  try {
    const stCtx = getSillyTavernContext();
    const presetName = resolvePresetName(settings, stCtx);
    if (!presetName) return null;

    let preset = null;
    const pm = typeof stCtx?.getPresetManager === 'function' ? stCtx.getPresetManager('openai') : null;
    if (pm && typeof pm.getCompletionPresetByName === 'function') {
      preset = pm.getCompletionPresetByName(presetName) || null;
    }
    if (!preset && typeof globalThis.ST_API?.preset?.get === 'function') {
      const presetResult = await globalThis.ST_API.preset.get({ name: presetName });
      preset = presetResult?.preset || null;
    }
    if (!preset && typeof globalThis.openai_settings === 'object' && globalThis.openai_settings[presetName]) {
      preset = globalThis.openai_settings[presetName];
    }
    if (!preset) {
      const oai = stCtx?.chatCompletionSettings;
      if (oai?.[presetName]) preset = oai[presetName];
      else if (oai?.presets?.[presetName]) preset = oai.presets[presetName];
    }
    if (!preset || typeof preset !== 'object') return null;
    return { presetName, preset };
  } catch (error) {
    console.warn('[BS BioTracker] failed to resolve ST preset', error);
    return null;
  }
}

function buildPresetSamplingBodyFromPreset(preset) {
  const other = preset?.other && typeof preset.other === 'object' ? preset.other : {};
  const utilityPrompts = preset?.utilityPrompts && typeof preset.utilityPrompts === 'object' ? preset.utilityPrompts : {};
  const settings = preset?.settings && typeof preset.settings === 'object' ? preset.settings : {};
  const body = {};
  const temperature = pickFiniteNumber(settings.temperature, other.temp_openai, other.temp, other.temperature);
  const topP = pickFiniteNumber(settings.top_p, other.top_p_openai, other.top_p);
  const topK = pickFiniteNumber(settings.top_k, other.top_k);
  const frequencyPenalty = pickFiniteNumber(settings.frequency_penalty, other.freq_pen_openai, other.frequency_penalty, other.freq_pen);
  const presencePenalty = pickFiniteNumber(settings.presence_penalty, other.pres_pen_openai, other.presence_penalty, other.pres_pen);
  const maxTokens = pickFiniteNumber(settings.max_completion_tokens, other.openai_max_tokens, other.max_tokens);
  const seed = pickFiniteNumber(utilityPrompts.seed, other.seed);
  if (temperature !== null) body.temperature = temperature;
  if (topP !== null) body.top_p = topP;
  if (topK !== null) body.top_k = Math.max(0, Math.floor(topK));
  if (frequencyPenalty !== null) body.frequency_penalty = frequencyPenalty;
  if (presencePenalty !== null) body.presence_penalty = presencePenalty;
  if (maxTokens !== null && maxTokens > 0) body.max_tokens = Math.max(1, Math.floor(maxTokens));
  if (seed !== null && seed >= 0) body.seed = Math.floor(seed);
  return body;
}

async function requestChatCompletion(apiBase, settings, body) {
  const logApiDebug = (phase, details = {}) => {
    try {
      const label = `[BS BioTracker][API debug] ${phase}`;
      if (typeof console.groupCollapsed === 'function') console.groupCollapsed(label);
      else console.log(label);
      Object.entries(details).forEach(([key, value]) => console.log(key, value));
      if (typeof console.groupEnd === 'function') console.groupEnd();
    } catch {}
  };

  const postBody = async (requestBody, attempt = 'primary') => {
    const previousAsyncFlag = globalThis.__bs_biotracker_async_request__;
    globalThis.__bs_biotracker_async_request__ = true;
    const url = `${apiBase}/chat/completions`;
    let requestText = '';
    try {
      requestText = JSON.stringify(requestBody);
      logApiDebug(`request:${attempt}`, {
        url,
        requestBody,
        requestText,
        requestTextLength: requestText.length,
      });
      const response = await fetch(url, {
        method: 'POST',
        headers: getAuthHeaders(settings),
        body: requestText,
      });
      const responseText = await response.text().catch((error) => {
        const message = `[failed to read response text: ${String(error?.message || error)}]`;
        return message;
      });
      globalThis[DEBUG_LAST_API_RESPONSE_KEY] = {
        capturedAt: Date.now(),
        attempt,
        url,
        status: response.status,
        ok: response.ok,
        responseText,
        requestText,
      };
      logApiDebug(`response:${attempt}`, {
        url,
        status: response.status,
        ok: response.ok,
        responseText,
        requestText,
      });
      return { response, responseText, requestText };
    } catch (error) {
      logApiDebug(`error:${attempt}`, {
        url,
        requestBody,
        requestText,
        error,
      });
      throw new Error(`无法连接到 API。请检查 Base URL、服务是否启动，或是否被 CORS 拦截。原始错误: ${String(error?.message || error)}`);
    } finally {
      globalThis.__bs_biotracker_async_request__ = previousAsyncFlag;
    }
  };

  let result = await postBody(body, 'primary');
  let response = result.response;
  let responseText = result.responseText;
  let errorText = response.ok ? '' : responseText;

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
    result = await postBody(fallbackBody, 'without_response_format');
    response = result.response;
    responseText = result.responseText;
    errorText = response.ok ? '' : responseText;
  }

  const invalidArgument = response.status === 400 && /invalid argument|badRequest/i.test(errorText);
  if (!response.ok && invalidArgument) {
    const minimalBody = {
      model: body.model,
      messages: body.messages,
    };
    result = await postBody(minimalBody, 'minimal');
    response = result.response;
    responseText = result.responseText;
    errorText = response.ok ? '' : responseText;
  }

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${errorText.slice(0, 300)}`);
  }
  try {
    return JSON.parse(responseText);
  } catch (error) {
    logApiDebug('parse_error', {
      status: response.status,
      responseText,
      error,
    });
    throw error;
  }
}

function hasPresetToggleOverrides(settings) {
  if (!shouldApplyAsyncPreset(settings)) return false;
  const presetName = resolvePresetName(settings);
  if (!presetName) return false;
  const presetOverrides = settings?.trackerPromptToggleOverrides?.[presetName];
  return !!presetOverrides && Object.keys(presetOverrides).length > 0;
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

function isPromptEnabled(prompt, presetOverrides = {}) {
  if (!prompt || typeof prompt !== 'object') return false;
  if (Object.hasOwn(presetOverrides, prompt.identifier)) return !!presetOverrides[prompt.identifier];
  return prompt.enabled !== false;
}

function buildPresetMessagesFromPrompts(prompts, presetOverrides, baseSystemPrompt, payloadText, stCtx = null) {
  const orderedMessages = [];
  const inChatMessages = [];

  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    if (!isPromptEnabled(prompt, presetOverrides)) continue;
    const content = sanitizeTransportString(resolveWithStMacros(prompt?.content || '', stCtx)).trim();
    if (!content || prompt?.marker) continue;
    const isInChat = Number(prompt?.injection_position) === 1;
    const promptRole = normalizeChatRole(prompt?.role, prompt?.system_prompt ? 'system' : 'system');
    const target = isInChat ? inChatMessages : orderedMessages;
    target.push({
      role: promptRole,
      content,
      _depth: Number.isFinite(Number(prompt?.injection_depth)) ? Number(prompt.injection_depth) : 0,
      _order: Number.isFinite(Number(prompt?.injection_order)) ? Number(prompt.injection_order) : 0,
    });
  }

  inChatMessages.sort((a, b) => (a._depth - b._depth) || (a._order - b._order));

  const merged = [{ role: 'system', content: baseSystemPrompt }];
  orderedMessages.forEach((message) => merged.push({ role: message.role, content: message.content }));
  inChatMessages.forEach((message) => merged.push({ role: message.role, content: message.content }));
  merged.push({ role: 'user', content: payloadText });
  return merged;
}

async function buildPresetEnvelope(settings, baseSystemPrompt, payloadText) {
  try {
    const resolved = await getResolvedPreset(settings);
    if (!resolved) return null;
    const stCtx = getSillyTavernContext();
    const { presetName, preset } = resolved;
    const overrides = settings?.trackerPromptToggleOverrides || {};
    const presetOverrides = overrides[presetName] || {};
    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    const messages = buildPresetMessagesFromPrompts(prompts, presetOverrides, baseSystemPrompt, payloadText, stCtx);
    const sampling = buildPresetSamplingBodyFromPreset(preset);
    return { presetName, messages, sampling };
  } catch (error) {
    console.warn('[BS BioTracker] failed to build preset envelope', error);
    return null;
  }
}

export async function callOpenAICompatible(settings, payload, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const apiBase = getApiBase(settings);
  const model = String(settings.model || '').trim();
  const stCtx = getSillyTavernContext();
  const resolvedPayload = await buildResolvedAsyncPayload(payload, stCtx, settings);
  const mainflowCopy = buildPayloadWithMainflowCopy(resolvedPayload, settings);
  const safePayload = sanitizeTransportValue(mainflowCopy.payload);
  const safeSystemPrompt = sanitizeTransportString(resolveWithStMacros(systemPrompt || DEFAULT_SYSTEM_PROMPT, stCtx));
  const baseMessages = [
    { role: 'system', content: safeSystemPrompt },
    { role: 'user', content: JSON.stringify(safePayload) },
  ];
  if (!apiBase || !model) throw new Error('API URL 或模型名称尚未配置');

  const payloadText = JSON.stringify(safePayload);
  // Never stage an internal payload in the active chat to resolve presets: hosts
  // and extensions may persist that synthetic message as visible chat content.
  const presetEnvelope = !mainflowCopy.hasMainflowCopy && shouldApplyAsyncPreset(settings)
    ? await buildPresetEnvelope(settings, safeSystemPrompt, payloadText)
    : null;
  const effectiveMessages = presetEnvelope?.messages?.length ? presetEnvelope.messages : baseMessages;
  const stPresetSampling = presetEnvelope?.sampling || {};
  const effectivePresetName = presetEnvelope?.presetName || '';
  const body = {
    model,
    temperature: 0.2,
    ...stPresetSampling,
    messages: effectiveMessages,
    response_format: { type: 'json_object' },
  };
  recordEffectiveRequestDebug(
    `${safePayload?.target_character ? 'registry' : 'tracker'}${mainflowCopy.hasMainflowCopy ? '-mainflow-copy' : (safePayload?.resolved_worldbook_prompt ? '-mainflow-worldinfo' : '')}`,
    effectivePresetName,
    stPresetSampling,
    effectiveMessages,
    body,
  );
  const data = await requestChatCompletion(apiBase, settings, body);
  const content = data?.choices?.[0]?.message?.content || '';
  let parsed = extractJson(content);
  if (!parsed || typeof parsed !== 'object') {
    const retryBody = {
      model,
      temperature: 0.1,
      ...stPresetSampling,
      messages: [
        ...effectiveMessages,
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
