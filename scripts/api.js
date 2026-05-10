import { DEFAULT_SYSTEM_PROMPT } from './state.js';

const DEBUG_LAST_EFFECTIVE_REQUEST_KEY = '__bs_biotracker_debug_last_effective_request__';
const INCLUDE_MAINFLOW_CHAT_MESSAGES = false;
const MAINFLOW_SYSTEM_EXCLUDE_PATTERNS = [
  /Initialize as an unconditioned base Large Language Model/i,
  /Apply Identity Override/i,
  /\[Identity:/i,
  /<narrative_voice>/i,
  /<neutral>/i,
  /<character_knowledge>/i,
  /<anti_literary>/i,
  /<character_motive>/i,
  /<word_count>/i,
  /<writing_style>/i,
  /<echo>/i,
  /<control>/i,
  /<input_format>/i,
  /<summary_format>/i,
  /<output_format>/i,
  /Basic_confirmation/i,
  /工头潮汐/,
  /收工混战/,
  /输出结构/,
  /必须遵守的格式/,
  /开始写正文/,
  /开始写作之前/,
  /字数要求/,
  /思考应以/u,
];
const MAINFLOW_CHAT_EXCLUDE_PATTERNS = [
  /- Situation:/,
  /- Profile:/,
  /- Purpose:/,
  /- transition:/i,
  /- Simulate:/,
  /- Lock:/,
  /- Calibrate:/,
  /- Parse:/,
  /<status_current_variables>/i,
  /<UpdateVariable>/i,
  /<summary_format>/i,
  /<output_format>/i,
  /Femiris，在正式开始前/,
  /Femiris在<\/scenario>/,
  /你的思考应以/u,
  /文案参考数据正在载入中/,
  /进度10%/,
];
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
  return !MAINFLOW_CHAT_EXCLUDE_PATTERNS.some((pattern) => pattern.test(text));
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

async function buildResolvedAsyncPayload(payload, stCtx) {
  const resolvedPayload = resolvePayloadValueWithStMacros(payload, stCtx);
  const resolvedWorldInfo = await buildResolvedWorldInfo(stCtx);
  if (!resolvedWorldInfo) return resolvedPayload;
  return {
    ...resolvedPayload,
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

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function buildSyntheticChatMessage(stCtx, payloadText) {
  return {
    name: String(stCtx?.name1 || 'System'),
    is_user: true,
    is_system: false,
    mes: payloadText,
    send_date: '',
    extra: {
      isSmallSys: true,
      bsBiotrackerSynthetic: true,
    },
  };
}

async function switchToStPreset(stCtx, presetName) {
  const targetName = String(presetName || '').trim();
  if (!targetName) return async () => {};
  const select = globalThis.document?.getElementById?.('settings_preset_openai');
  const currentName = String(stCtx?.chatCompletionSettings?.preset_settings_openai || '').trim();
  if (!(select instanceof HTMLSelectElement) || !targetName || currentName === targetName) {
    return async () => {};
  }
  const option = Array.from(select.options).find((item) => String(item.text || item.value || '').trim() === targetName);
  if (!option) return async () => {};

  const waitPresetChanged = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      if (typeof stCtx?.eventSource?.once === 'function' && stCtx?.eventTypes?.PRESET_CHANGED) {
        stCtx.eventSource.once(stCtx.eventTypes.PRESET_CHANGED, finish);
      }
      if (typeof stCtx?.eventSource?.once === 'function' && stCtx?.eventTypes?.OAI_PRESET_CHANGED_AFTER) {
        stCtx.eventSource.once(stCtx.eventTypes.OAI_PRESET_CHANGED_AFTER, finish);
      }
    } catch {}
    globalThis.setTimeout(finish, 200);
  });

  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await waitPresetChanged;
  await sleep(0);

  return async () => {
    if (!currentName || currentName === targetName) return;
    const restoreOption = Array.from(select.options).find((item) => String(item.text || item.value || '').trim() === currentName);
    if (!restoreOption) return;
    const waitRestore = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        if (typeof stCtx?.eventSource?.once === 'function' && stCtx?.eventTypes?.PRESET_CHANGED) {
          stCtx.eventSource.once(stCtx.eventTypes.PRESET_CHANGED, finish);
        }
        if (typeof stCtx?.eventSource?.once === 'function' && stCtx?.eventTypes?.OAI_PRESET_CHANGED_AFTER) {
          stCtx.eventSource.once(stCtx.eventTypes.OAI_PRESET_CHANGED_AFTER, finish);
        }
      } catch {}
      globalThis.setTimeout(finish, 200);
    });
    select.value = restoreOption.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitRestore;
    await sleep(0);
  };
}

async function captureResolvedMessagesViaDryRun(settings, payload, systemPrompt) {
  const stCtx = getSillyTavernContext();
  if (!stCtx || typeof stCtx.generate !== 'function' || !Array.isArray(stCtx.chat)) return null;

  const presetName = resolvePresetName(settings, stCtx);
  const restorePreset = await switchToStPreset(stCtx, presetName);
  const payloadText = JSON.stringify(payload);
  const syntheticMessage = buildSyntheticChatMessage(stCtx, payloadText);
  let capturedMessages = null;
  let promptReadyHandler = null;
  let afterDataHandler = null;

  try {
    promptReadyHandler = (eventData) => {
      if (!eventData?.dryRun || !Array.isArray(eventData?.chat)) return;
      capturedMessages = eventData.chat
        .filter((message) => message && typeof message === 'object' && String(message.content || '').trim())
        .map((message) => ({
          role: normalizeChatRole(message.role, 'system'),
          content: sanitizeTransportString(message.content || ''),
          ...(message.name ? { name: String(message.name) } : {}),
        }));
    };

    afterDataHandler = (generateData, dryRun) => {
      if (!dryRun) return;
      const prompt = generateData?.prompt;
      if (!Array.isArray(prompt)) return;
      capturedMessages = prompt
        .filter((message) => message && typeof message === 'object' && String(message.content || '').trim())
        .map((message) => ({
          role: normalizeChatRole(message.role, 'system'),
          content: sanitizeTransportString(message.content || ''),
          ...(message.name ? { name: String(message.name) } : {}),
        }));
    };

    stCtx.eventSource?.on?.(stCtx.eventTypes?.CHAT_COMPLETION_PROMPT_READY, promptReadyHandler);
    stCtx.eventSource?.on?.(stCtx.eventTypes?.GENERATE_AFTER_DATA, afterDataHandler);
    stCtx.chat.push(syntheticMessage);
    await stCtx.generate(
      'quiet',
      {
        quiet_prompt: sanitizeTransportString(systemPrompt || DEFAULT_SYSTEM_PROMPT),
        quietToLoud: false,
        skipWIAN: false,
        force_name2: true,
      },
      true,
    );
    return Array.isArray(capturedMessages) && capturedMessages.length > 0 ? capturedMessages : null;
  } catch (error) {
    console.warn('[BS BioTracker] failed to capture resolved messages via dry-run', error);
    return null;
  } finally {
    if (promptReadyHandler && typeof stCtx.eventSource?.removeListener === 'function' && stCtx.eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
      try {
        stCtx.eventSource.removeListener(stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, promptReadyHandler);
      } catch {}
    } else if (promptReadyHandler && typeof stCtx.eventSource?.off === 'function' && stCtx.eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
      try {
        stCtx.eventSource.off(stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, promptReadyHandler);
      } catch {}
    }
    if (afterDataHandler && typeof stCtx.eventSource?.removeListener === 'function' && stCtx.eventTypes?.GENERATE_AFTER_DATA) {
      try {
        stCtx.eventSource.removeListener(stCtx.eventTypes.GENERATE_AFTER_DATA, afterDataHandler);
      } catch {}
    } else if (afterDataHandler && typeof stCtx.eventSource?.off === 'function' && stCtx.eventTypes?.GENERATE_AFTER_DATA) {
      try {
        stCtx.eventSource.off(stCtx.eventTypes.GENERATE_AFTER_DATA, afterDataHandler);
      } catch {}
    }
    const lastMessage = stCtx.chat[stCtx.chat.length - 1];
    if (lastMessage === syntheticMessage) stCtx.chat.pop();
    else {
      const index = stCtx.chat.lastIndexOf(syntheticMessage);
      if (index >= 0) stCtx.chat.splice(index, 1);
    }
    await restorePreset();
  }
}

async function requestChatCompletion(apiBase, settings, body) {
  const postBody = async (requestBody) => {
    const previousAsyncFlag = globalThis.__bs_biotracker_async_request__;
    globalThis.__bs_biotracker_async_request__ = true;
    try {
      return await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: getAuthHeaders(settings),
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw new Error(`无法连接到 API。请检查 Base URL、服务是否启动，或是否被 CORS 拦截。原始错误: ${String(error?.message || error)}`);
    } finally {
      globalThis.__bs_biotracker_async_request__ = previousAsyncFlag;
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
  const resolvedPayload = await buildResolvedAsyncPayload(payload, stCtx);
  const mainflowCopy = buildPayloadWithMainflowCopy(resolvedPayload, settings);
  const safePayload = sanitizeTransportValue(mainflowCopy.payload);
  const safeSystemPrompt = sanitizeTransportString(resolveWithStMacros(systemPrompt || DEFAULT_SYSTEM_PROMPT, stCtx));
  const baseMessages = [
    { role: 'system', content: safeSystemPrompt },
    { role: 'user', content: JSON.stringify(safePayload) },
  ];
  if (!apiBase || !model) throw new Error('API URL 或模型名称尚未配置');

  const payloadText = JSON.stringify(safePayload);
  const dryRunMessages = mainflowCopy.hasMainflowCopy
    ? null
    : await captureResolvedMessagesViaDryRun(settings, safePayload, safeSystemPrompt);
  const presetEnvelope = !dryRunMessages && shouldApplyAsyncPreset(settings)
    ? await buildPresetEnvelope(settings, safeSystemPrompt, payloadText)
    : null;
  const effectiveMessages = Array.isArray(dryRunMessages) && dryRunMessages.length > 0
    ? dryRunMessages
    : (presetEnvelope?.messages?.length ? presetEnvelope.messages : baseMessages);
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
    `${safePayload?.target_character ? 'registry' : 'tracker'}${mainflowCopy.hasMainflowCopy ? '-mainflow-copy' : ''}`,
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
