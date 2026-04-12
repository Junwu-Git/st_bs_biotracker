import { callOpenAICompatible } from './api.js';
import { buildMainFlowStatePrompt, buildTrackerSystemPrompt } from './tracker_prompt_context.js';
import { applyToolCallsResult, TOOL_DEFINITIONS } from './tools.js';
import {
  buildRecentMessages,
  buildSignature,
  cloneValue,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  getCharacterCard,
  getCharacterWorldBookName,
  getCharacterWorldBookNameViaSTscript,
  getChatKey,
  getChatState,
  getRegisteredTargetNames,
  getSettings,
  getLatestMatchingSnapshot,
  recordChatStateSnapshot,
  restoreChatStateFromSnapshot,
  saveSettings,
  shouldTriggerForMessage,
} from './state.js';

export const POLL_RUNTIME_KEY = '__bs_biotracker_poll__';
export const RUN_RUNTIME_KEY = '__bs_biotracker_running__';

function getVitalityLevelText(level) {
  const levels = {
    1: '一推就倒',
    2: '身怀病弱',
    3: '难产体态',
    4: '均衡活力',
    5: '安产体态',
    6: '经过锻炼',
    7: '无坚不摧',
  };
  return levels[Math.max(1, Math.min(7, Math.round(Number(level) || 4)))] || '未知';
}

function getPsyStressLevelText(level) {
  const levels = {
    1: '情感丧失、麻木不仁',
    2: '内向压抑、冷感',
    3: '情绪平缓、理性',
    4: '情绪均衡、稳定',
    5: '情绪丰富、敏感',
    6: '强烈波动、焦躁',
    7: '极端情绪、精神异常',
  };
  return levels[Math.max(1, Math.min(7, Math.round(Number(level) || 4)))] || '未知';
}

function getTendencyAngleText(angle) {
  const value = Number(angle);
  if (!Number.isFinite(value)) return '未知';
  if ((value >= 0 && value <= 15) || (value >= 345 && value <= 360)) return '正位(↓)';
  if ((value >= 165 && value <= 195)) return '倒位(↑)';
  if ((value >= 75 && value <= 105)) return '横位(←)';
  if ((value >= 255 && value <= 285)) return '横位(→)';
  if (value > 15 && value < 75) return '斜位(↗)';
  if (value > 105 && value < 165) return '斜位(↖)';
  if (value > 195 && value < 255) return '斜位(↙)';
  if (value > 285 && value < 345) return '斜位(↘)';
  return '斜位';
}

function buildPromptFacingCharacterState(item) {
  const next = cloneValue(item);
  const profile = next?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const immune = profile.immune || {};
  const metabolism = profile.metabolism || {};

  profile.base = {
    ...base,
    vitalityLevelText: getVitalityLevelText(base.vitalityLevel),
    psyStressLevelText: getPsyStressLevelText(base.psyStressLevel),
  };

  if (Array.isArray(pregnant.fetuses)) {
    profile.pregnant = {
      pregnantDays: Number.isFinite(Number(pregnant.pregnantDays)) ? Number(pregnant.pregnantDays) : 0,
      laborHours: Number.isFinite(Number(pregnant.laborHours)) ? Number(pregnant.laborHours) : 0,
      effectiveLaborHours: Number.isFinite(Number(pregnant.effectiveLaborHours)) ? Number(pregnant.effectiveLaborHours) : 0,
      amnionDurability: Number.isFinite(Number(pregnant.amnionDurability)) ? Number(pregnant.amnionDurability) : 0,
      fetuses: pregnant.fetuses.map((fetus) => ({
        ...fetus,
        tendencyAngleText: getTendencyAngleText(fetus?.tendencyAngle),
        race: undefined,
      })),
    };
  } else {
    profile.pregnant = {
      pregnantDays: Number.isFinite(Number(pregnant.pregnantDays)) ? Number(pregnant.pregnantDays) : 0,
      laborHours: Number.isFinite(Number(pregnant.laborHours)) ? Number(pregnant.laborHours) : 0,
      effectiveLaborHours: Number.isFinite(Number(pregnant.effectiveLaborHours)) ? Number(pregnant.effectiveLaborHours) : 0,
      amnionDurability: Number.isFinite(Number(pregnant.amnionDurability)) ? Number(pregnant.amnionDurability) : 0,
      fetuses: [],
    };
  }

  if (base.derivedType) {
    profile.metabolism = {
      flux: Number.isFinite(Number(metabolism.flux)) ? Number(metabolism.flux) : 0,
    };
  } else {
    profile.metabolism = {
      urine: metabolism.urine ?? 0,
      stool: metabolism.stool ?? 0,
      hunger: metabolism.hunger ?? 0,
      sleep: metabolism.sleep ?? 0,
    };
  }

  delete profile.bio;
  delete profile.immune;
  if (immune.metabolism) delete profile.metabolism;

  delete next.updatedAt;
  delete next.runtime;

  next.profile = profile;
  return next;
}

function buildOffscreenCharacterState(item) {
  const profile = item?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  return {
    name: item?.name || '',
    initialized: Boolean(item?.initialized),
    offscreen: true,
    profile: {
      base: {
        isHere: false,
        stage: base.stage ?? null,
        days: base.days ?? 1,
        age: base.age ?? null,
        race: base.race ?? null,
        derivedType: base.derivedType ?? null,
      },
      pregnant: {
        pregnantDays: pregnant.pregnantDays ?? 0,
        laborHours: pregnant.laborHours ?? 0,
        effectiveLaborHours: pregnant.effectiveLaborHours ?? 0,
      },
    },
  };
}

function buildTrackerStateView(existingState) {
  return Object.fromEntries(
    Object.entries(existingState).map(([name, item]) => {
      if (item?.profile?.base?.isHere === false) return [name, buildOffscreenCharacterState(item)];
      return [name, buildPromptFacingCharacterState(item)];
    }),
  );
}

function parseTrackerWorldbookExcludeNames(settings) {
  return new Set(
    String(settings?.trackerWorldbookExcludeNames || '')
      .split(/[\r\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function filterTrackerWorldbookEntries(value, excludedNames) {
  if (!value || typeof value !== 'object') return value;

  const normalizeEntryName = (entry) => String(entry?.name || entry?.comment || entry?.title || entry?.displayName || entry?.uid || '').trim();

  // always filter disabled entries, regardless of excludedNames
  const keepEntry = (entry) => {
    if (entry?.enabled === false || entry?.disable === true) return false;
    if (!excludedNames || excludedNames.size === 0) return true;
    const name = normalizeEntryName(entry);
    return !name || !excludedNames.has(name);
  };

  if (Array.isArray(value.entries)) {
    return {
      ...value,
      entries: value.entries.filter(keepEntry),
    };
  }

  if (value.entries && typeof value.entries === 'object') {
    const filteredEntries = Object.fromEntries(
      Object.entries(value.entries).filter(([, entry]) => keepEntry(entry)),
    );
    return {
      ...value,
      entries: filteredEntries,
    };
  }

  return value;
}

export function buildTrackerPayload(ctx, settings, reason = 'manual', endIndexExclusive = null) {
  const currentCharacter = getCharacterCard(ctx);
  const chatState = getChatState(ctx, settings);
  const existingState = chatState.characters || {};
  const filteredWorldBook = filterTrackerWorldbookEntries(
    currentCharacter.worldBook || null,
    parseTrackerWorldbookExcludeNames(settings),
  );
  return {
    reason,
    chat_id: getChatKey(ctx),
    current_character: {
      ...currentCharacter,
      worldBook: filteredWorldBook,
    },
    character_description: currentCharacter.description || '',
    character_worldbook_name: getCharacterWorldBookName(ctx) || null,
    character_worldbook: filteredWorldBook,
    tracked_females: getRegisteredTargetNames(ctx, settings, chatState),
    existing_state: buildTrackerStateView(existingState),
    available_tools: TOOL_DEFINITIONS,
    recent_messages: buildRecentMessages(ctx, settings, endIndexExclusive),
  };
}

export function buildMainFlowPrompt(ctx, settings) {
  const chatState = getChatState(ctx, settings);
  reconcileChatStateSnapshots(ctx, chatState);
  return buildMainFlowStatePrompt(buildTrackerPayload(ctx, settings, 'mainflow'));
}

function normalizeTrackerResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Tracker response must be a JSON object.');
  }
  const directToolCalls = Array.isArray(result.tool_calls) ? result.tool_calls : null;
  const altToolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : null;
  const altCalls = Array.isArray(result.calls) ? result.calls : null;
  return {
    ...result,
    tool_calls: directToolCalls || altToolCalls || altCalls || [],
  };
}

function reconcileChatStateSnapshots(ctx, chatState) {
  const matchedSnapshot = getLatestMatchingSnapshot(ctx, chatState);
  restoreChatStateFromSnapshot(chatState, matchedSnapshot);
  return {
    nextMessageIndex: matchedSnapshot ? matchedSnapshot.messageCount : 0,
  };
}

function prepareManualReplay(ctx, chatState, chatLength) {
  if (chatLength <= 0) {
    restoreChatStateFromSnapshot(chatState, null);
    return { nextMessageIndex: 0 };
  }
  const replayStart = Math.max(0, chatLength - 1);
  const baseSnapshot = replayStart > 0 ? getLatestMatchingSnapshot(ctx, chatState, replayStart) : null;
  restoreChatStateFromSnapshot(chatState, baseSnapshot);
  return { nextMessageIndex: replayStart };
}

function hasPendingChatHistory(ctx, chatState) {
  const matchedSnapshot = getLatestMatchingSnapshot(ctx, chatState);
  const currentLength = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
  return !matchedSnapshot || matchedSnapshot.messageCount !== currentLength;
}

async function processTrackerMessage(ctx, settings, chatState, deps, reason, messageIndex) {
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const message = chat[messageIndex];
  const shouldTrigger = reason === 'manual' ? true : shouldTriggerForMessage(settings, message);
  if (!shouldTrigger) {
    recordChatStateSnapshot(ctx, chatState, { messageCount: messageIndex + 1, reason: 'skip' });
    saveSettings(ctx);
    return;
  }

  const payload = buildTrackerPayload(ctx, settings, reason, messageIndex + 1);
  if (!payload.character_worldbook && !payload.character_worldbook_name) {
    payload.character_worldbook_name = await getCharacterWorldBookNameViaSTscript();
  }
  if (!payload.character_worldbook && payload.character_worldbook_name && typeof ctx?.loadWorldInfo === 'function') {
    try {
      const loadedWorldBook = await ctx.loadWorldInfo(payload.character_worldbook_name);
      payload.character_worldbook = filterTrackerWorldbookEntries(
        loadedWorldBook || null,
        parseTrackerWorldbookExcludeNames(settings),
      );
    } catch (error) {
      console.warn('[BS BioTracker] loadWorldInfo for tracker failed', error);
    }
  }
  chatState.lastRunAt = Date.now();
  chatState.lastAttemptedSignature = buildSignature(ctx, messageIndex + 1);
  saveSettings(ctx);
  const rawResult = await callOpenAICompatible(
    settings,
    payload,
    buildTrackerSystemPrompt(settings.systemPrompt || DEFAULT_SYSTEM_PROMPT, settings.registryDescriptionGuides, payload)
  );
  const result = normalizeTrackerResult(rawResult);
  applyToolCallsResult(ctx, result);
  chatState.lastProcessedSignature = chatState.lastAttemptedSignature;
  recordChatStateSnapshot(ctx, chatState, { messageCount: messageIndex + 1, reason: 'tracker' });
  saveSettings(ctx);
}

export async function runTracker(ctx, deps, reason = 'manual') {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const registeredTargets = getRegisteredTargetNames(ctx, settings, chatState);
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const lastMessage = chat[chat.length - 1];
  if (!lastMessage) {
    chatState.lastRawResult = {
      message: '当前对话没有可分析的消息，已跳过追踪。',
      tool_calls: [],
    };
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    return { skipped: true, reason: 'empty_chat' };
  }
  if (globalThis[RUN_RUNTIME_KEY]) {
    chatState.lastRawResult = {
      message: '已有一轮追踪请求正在执行，本次请求未重复发送。',
      tool_calls: [],
    };
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    return { skipped: true, reason: 'already_running' };
  }
  if (registeredTargets.length === 0) {
    chatState.lastRawResult = {
      message: '尚无已注册角色，跳过分析。',
      tool_calls: [],
    };
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    deps.updateMainFlowPrompt?.(ctx);
    return { skipped: true, reason: 'no_registered_targets' };
  }
  globalThis[RUN_RUNTIME_KEY] = true;
  try {
    const { nextMessageIndex } =
      reason === 'manual' ? prepareManualReplay(ctx, chatState, chat.length) : reconcileChatStateSnapshots(ctx, chatState);
    let processedCount = 0;
    for (let index = nextMessageIndex; index < chat.length; index += 1) {
      await processTrackerMessage(ctx, settings, chatState, deps, reason, index);
      processedCount += 1;
    }
    deps.renderStatusPanel(ctx);
    deps.updateMainFlowPrompt?.(ctx);
    if (reason === 'poll' && processedCount === 0) return;
    const toolCalls = Array.isArray(chatState.lastRawResult?.tool_calls) ? chatState.lastRawResult.tool_calls : [];
    globalThis.toastr?.success?.(toolCalls.length > 0 ? '[BS BioTracker] 状态已更新' : '[BS BioTracker] 分析完成，本轮没有工具调用');
    return { skipped: false, processedCount, toolCalls };
  } catch (error) {
    console.error('[BS BioTracker] runTracker failed', error);
    chatState.lastRawResult = {
      error: String(error?.message || error),
      tool_calls: [],
    };
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    globalThis.toastr?.error?.(String(error?.message || error), '[BS BioTracker]');
    throw error;
  } finally {
    globalThis[RUN_RUNTIME_KEY] = false;
  }
}

export async function poll(ctx, deps) {
  const settings = getSettings(ctx);
  if (!settings.enabled) return;
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  if (chat.length === 0) return;
  const chatState = getChatState(ctx, settings);
  if (getRegisteredTargetNames(ctx, settings, chatState).length === 0) return;
  if (!hasPendingChatHistory(ctx, chatState)) return;
  await runTracker(ctx, deps, 'poll');
}

export function resetPoller(ctx, deps) {
  if (globalThis[POLL_RUNTIME_KEY]) clearInterval(globalThis[POLL_RUNTIME_KEY]);
  const settings = getSettings(ctx);
  globalThis[POLL_RUNTIME_KEY] = setInterval(() => {
    deps.updateClock(settings);
    poll(ctx, deps).catch((error) => console.error('[BS BioTracker] poll failed', error));
  }, Math.max(800, Number(settings.pollMs) || DEFAULT_SETTINGS.pollMs));
}
