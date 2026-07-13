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
  getActiveGlobalWorldBookNames,
  getChatKey,
  getChatState,
  getRegisteredTargetNames,
  getSettings,
  getLatestMatchingSnapshot,
  hydrateChatStateFromHost,
  loadGlobalWorldBook,
  recordChatStateSnapshot,
  restoreChatStateFromSnapshot,
  saveSettings,
  shouldTriggerForMessage,
} from './state.js';
import { getDerivedTypeMetabolismExemptions } from './race_config.js';
import { LABOR_STAGES, PREGNANCY_STAGES } from './stage_config.js';
import { canLoadHostWorldInfo, getHostAgentRunBarrier, getHostChat, getHostKind, loadHostWorldInfo, refreshHostChatView } from './host.js';

export const POLL_RUNTIME_KEY = '__bs_biotracker_poll__';
export const RUN_RUNTIME_KEY = '__bs_biotracker_running__';
const UPDATE_CUE_EVENT = 'bs-biotracker:update-cue';
const AFTER_AI_SETTLE_MS = 1400;
const MAINFLOW_CONTEXT_SNAPSHOT_KEY = '__bs_biotracker_mainflow_context_snapshot__';
const DEBUG_LAST_TRACKER_REQUEST_KEY = '__bs_biotracker_debug_last_tracker_request__';
const DEBUG_LAST_TRACKER_RESULT_KEY = '__bs_biotracker_debug_last_tracker_result__';

function getTrackerResumeIndexes(ctx, settings) {
  const chatKey = getChatKey(ctx);
  const snapshots = settings?.chatStates?.[chatKey]?.snapshots;
  if (!Array.isArray(snapshots)) return [0];
  return snapshots.map((snapshot) => {
    const count = Number(snapshot?.messageCount);
    return Number.isInteger(count) && count >= 0 ? count : null;
  }).filter((count) => count !== null);
}

export function isFailedAutoRetryBlocked(ctx, chatState) {
  const chat = getHostChat(ctx);
  if (chat.length === 0 || !chatState?.lastFailedSignature) return false;
  return chatState.lastFailedSignature === buildSignature(ctx, chat.length);
}

function normalizeWorldbookMode(value) {
  const mode = String(value || 'exclude').trim();
  if (mode === 'mainflow' || mode === 'allowlist_all' || mode === 'exclude') return mode;
  return 'exclude';
}

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

function getDiaryRecentLimit(settings, characterCount) {
  const singleLimit = Math.max(0, Math.min(20, Math.floor(Number(settings?.diaryRecentLimit) || 0)));
  if (singleLimit <= 0) return 0;
  return characterCount > 1 ? Math.max(1, Math.floor(singleLimit / 2)) : singleLimit;
}

function hasPreparedWardrobe(existingState = {}) {
  return Object.values(existingState || {}).some((item) => item?.profile?.wardrobe?.enabled === true);
}

export function hasBreedingPsychology(existingState = {}) {
  return Object.values(existingState || {}).some((item) => {
    const stageProfiles = item?.profile?.psychology?.stageProfiles;
    return stageProfiles && typeof stageProfiles === 'object' && !Array.isArray(stageProfiles)
      && Object.keys(stageProfiles).length > 0;
  });
}

export function getTrackerToolDefinitions(settings, existingState = {}) {
  const diaryEnabled = Math.max(0, Math.min(20, Math.floor(Number(settings?.diaryRecentLimit) || 0))) > 0;
  const wardrobeEnabled = hasPreparedWardrobe(existingState);
  const psychologyEnabled = hasBreedingPsychology(existingState);
  const hiddenTools = new Set();
  if (!diaryEnabled) hiddenTools.add('bsWriteDiary');
  if (!psychologyEnabled) hiddenTools.add('bsUpdatePsychology');
  if (!wardrobeEnabled) {
    hiddenTools.add('bsAddWardrobeItem');
    hiddenTools.add('bsRemoveWardrobeItem');
    hiddenTools.add('bsChangeOutfit');
  }
  return TOOL_DEFINITIONS.filter((tool) => !hiddenTools.has(tool?.name));
}

function getRecentDiaryEntries(profile, limit) {
  if (limit <= 0 || !Array.isArray(profile?.diary)) return [];
  return profile.diary.slice(-limit);
}

function shouldSendPregnantState(base = {}, pregnant = {}) {
  const stage = String(base.stage || '');
  const hasFetuses = Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0;
  return hasFetuses
    || PREGNANCY_STAGES.includes(stage)
    || stage === '产兆前驱'
    || LABOR_STAGES.includes(stage)
    || stage === '产后恢复'
    || stage === '假孕期';
}

function getPromptFacingMetabolismSymptoms(pregnant = {}) {
  const result = {};
  for (const symptomType of ['blockage', 'acceleration', 'expansion']) {
    const symptom = pregnant[symptomType];
    if (!symptom || typeof symptom !== 'object') continue;
    const key = String(symptom.key || '').trim();
    if (!key) continue;
    result[symptomType] = {
      key,
      severity: Number.isFinite(Number(symptom.severity)) ? Number(symptom.severity) : 0,
    };
  }
  return result;
}

function getPromptFacingLaborState(base = {}, pregnant = {}) {
  const stage = String(base.stage || '');
  if (stage !== '产兆前驱' && !LABOR_STAGES.includes(stage)) return {};
  return {
    laborHours: Number.isFinite(Number(pregnant.laborHours)) ? Number(pregnant.laborHours) : 0,
    effectiveLaborHours: Number.isFinite(Number(pregnant.effectiveLaborHours)) ? Number(pregnant.effectiveLaborHours) : 0,
    laborPhase: pregnant.laborPhase ?? null,
    laborFetusIndex: Number.isFinite(Number(pregnant.laborFetusIndex)) ? Number(pregnant.laborFetusIndex) : 0,
    laborPain: Number.isFinite(Number(pregnant.laborPain)) ? Number(pregnant.laborPain) : 0,
  };
}

function buildPromptFacingCharacterState(item, diaryLimit = 0) {
  const next = cloneValue(item);
  const profile = next?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const immune = profile.immune || {};
  const metabolism = profile.metabolism || {};
  const hasFetuses = Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0;
  const sendPregnantState = shouldSendPregnantState(base, pregnant);

  profile.base = {
    ...base,
    vitalityLevelText: getVitalityLevelText(base.vitalityLevel),
    psyStressLevelText: getPsyStressLevelText(base.psyStressLevel),
  };

  if (!sendPregnantState) {
    delete profile.pregnant;
  } else if (Array.isArray(pregnant.fetuses)) {
    profile.pregnant = {
      pregnantDays: Number.isFinite(Number(pregnant.pregnantDays)) ? Number(pregnant.pregnantDays) : 0,
      effectivePregnantDays: Number.isFinite(Number(pregnant.effectivePregnantDays)) ? Number(pregnant.effectivePregnantDays) : 0,
      ...getPromptFacingLaborState(base, pregnant),
      amnionDurability: Number.isFinite(Number(pregnant.amnionDurability)) ? Number(pregnant.amnionDurability) : 0,
      ...(hasFetuses ? { nutrition: Number.isFinite(Number(pregnant.nutrition)) ? Number(pregnant.nutrition) : 0 } : {}),
      ...(hasFetuses ? { symptomReliefPending: Number.isFinite(Number(pregnant.symptomReliefPending)) ? Number(pregnant.symptomReliefPending) : 0 } : {}),
      ...getPromptFacingMetabolismSymptoms(pregnant),
      fetuses: pregnant.fetuses.map((fetus) => ({
        ...fetus,
        tendencyAngleText: getTendencyAngleText(fetus?.tendencyAngle),
        race: undefined,
      })),
    };
  } else {
    profile.pregnant = {
      pregnantDays: Number.isFinite(Number(pregnant.pregnantDays)) ? Number(pregnant.pregnantDays) : 0,
      effectivePregnantDays: Number.isFinite(Number(pregnant.effectivePregnantDays)) ? Number(pregnant.effectivePregnantDays) : 0,
      ...getPromptFacingLaborState(base, pregnant),
      amnionDurability: Number.isFinite(Number(pregnant.amnionDurability)) ? Number(pregnant.amnionDurability) : 0,
      ...getPromptFacingMetabolismSymptoms(pregnant),
      fetuses: [],
    };
  }

  if (base.derivedType) {
    const exemptions = new Set(getDerivedTypeMetabolismExemptions(base.derivedType));
    const includeNeed = (key) => (exemptions.has(key) ? {} : { [key]: metabolism[key] ?? 0 });
    profile.metabolism = {
      flux: Number.isFinite(Number(metabolism.flux)) ? Number(metabolism.flux) : 0,
      ...includeNeed('excretion'),
      ...includeNeed('hunger'),
      ...includeNeed('sleep'),
      ...includeNeed('milk'),
      ...includeNeed('odor'),
      ...includeNeed('companionship'),
    };
  } else {
    profile.metabolism = {
      excretion: metabolism.excretion ?? 0,
      hunger: metabolism.hunger ?? 0,
      sleep: metabolism.sleep ?? 0,
      milk: metabolism.milk ?? 0,
      odor: metabolism.odor ?? 0,
      companionship: metabolism.companionship ?? 0,
    };
  }

  delete profile.bio;
  delete profile.immune;
  delete profile.cooldown;
  if (immune.metabolism) delete profile.metabolism;
  if (!hasBreedingPsychology({ current: item })) delete profile.psychology;
  profile.diary = getRecentDiaryEntries(item?.profile || {}, diaryLimit);

  delete next.updatedAt;
  delete next.runtime;

  next.profile = profile;
  return next;
}

function buildOffscreenCharacterState(item, diaryLimit = 0) {
  const profile = item?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const notify = profile.notify || {};
  const hasFetuses = Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0;
  const sendPregnantState = shouldSendPregnantState(base, pregnant);
  return {
    name: item?.name || '',
    initialized: Boolean(item?.initialized),
    offscreen: true,
    profile: {
      base: {
        isHere: false,
        stage: base.stage ?? null,
        days: base.days ?? 0,
        age: base.age ?? null,
        race: base.race ?? null,
        derivedType: base.derivedType ?? null,
      },
      ...(sendPregnantState ? {
        pregnant: {
          pregnantDays: pregnant.pregnantDays ?? 0,
          effectivePregnantDays: pregnant.effectivePregnantDays ?? 0,
          ...getPromptFacingLaborState(base, pregnant),
          fetusesCount: hasFetuses ? pregnant.fetuses.length : 0,
          ...getPromptFacingMetabolismSymptoms(pregnant),
        },
      } : {}),
      diary: getRecentDiaryEntries(profile, diaryLimit),
      notify: Object.values(notify).some((value) => String(value || '').trim()) ? notify : undefined,
    },
  };
}

function buildTrackerStateView(existingState, settings = null) {
  const characterCount = Object.keys(existingState || {}).length;
  const diaryLimit = getDiaryRecentLimit(settings, characterCount);
  return Object.fromEntries(
    Object.entries(existingState).map(([name, item]) => {
      if (item?.profile?.base?.isHere === false) return [name, buildOffscreenCharacterState(item, diaryLimit)];
      return [name, buildPromptFacingCharacterState(item, diaryLimit)];
    }),
  );
}

function parseTrackerWorldbookExcludeNames(settings) {
  return new Set(
    String(settings?.trackerWorldbookExcludeNames || '')
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseTrackerWorldbookIncludeNames(settings) {
  return new Set(
    String(settings?.trackerWorldbookIncludeNames || '')
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseTrackerGlobalWorldbookExcludeNames(settings) {
  return new Set(
    String(settings?.trackerGlobalWorldbookExcludeNames || '')
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseTrackerGlobalWorldbookIncludeNames(settings) {
  return new Set(
    String(settings?.trackerGlobalWorldbookIncludeNames || '')
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function formatGlobalWorldbookSelectionName(bookName, entryName) {
  return `${String(bookName || '').trim()} :: ${String(entryName || '').trim()}`;
}

function normalizeWorldbookKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function buildWorldbookActivationText(recentMessages = []) {
  return (Array.isArray(recentMessages) ? recentMessages : [])
    .map((message) => `${message?.name || ''}\n${message?.text || ''}`)
    .join('\n')
    .toLowerCase();
}

function getWorldbookEntryActivationMode(entry) {
  const mode = String(entry?.activationMode || '').trim().toLowerCase();
  if (mode) return mode;
  if (entry?.constant === true || entry?.always === true) return 'always';
  if (entry?.selective === true || normalizeWorldbookKeywords(entry?.key).length > 0 || normalizeWorldbookKeywords(entry?.keys).length > 0) return 'keyword';
  return '';
}

function worldbookKeywordMatches(entry, activationText) {
  if (!activationText) return false;
  const primaryKeys = [
    ...normalizeWorldbookKeywords(entry?.key),
    ...normalizeWorldbookKeywords(entry?.keys),
  ];
  if (primaryKeys.length === 0) return false;
  const primaryMatched = primaryKeys.some((keyword) => activationText.includes(keyword.toLowerCase()));
  if (!primaryMatched) return false;

  const secondaryKeys = [
    ...normalizeWorldbookKeywords(entry?.keysecondary),
    ...normalizeWorldbookKeywords(entry?.keySecondary),
    ...normalizeWorldbookKeywords(entry?.secondary_keys),
    ...normalizeWorldbookKeywords(entry?.secondaryKeys),
  ];
  if (entry?.selective === true && secondaryKeys.length > 0) {
    return secondaryKeys.some((keyword) => activationText.includes(keyword.toLowerCase()));
  }
  return true;
}

function filterTrackerWorldbookEntries(value, excludedNames, settings = null, recentMessages = [], options = {}) {
  if (!value || typeof value !== 'object') return value;
  const mode = normalizeWorldbookMode(settings?.trackerWorldbookMode);
  const globalBookName = String(options.globalBookName || '').trim();
  const includedNames = globalBookName ? parseTrackerGlobalWorldbookIncludeNames(settings) : parseTrackerWorldbookIncludeNames(settings);
  const activationText = mode === 'mainflow' ? buildWorldbookActivationText(recentMessages) : '';

  const normalizeEntryName = (entry) => String(entry?.name || entry?.comment || entry?.title || entry?.displayName || entry?.uid || '').trim();

  const keepEntry = (entry) => {
    const name = normalizeEntryName(entry);
    const selectionName = globalBookName ? formatGlobalWorldbookSelectionName(globalBookName, name) : name;
    if (mode === 'allowlist_all') return Boolean(name) && includedNames.has(selectionName);
    if (entry?.enabled === false || entry?.disable === true) return false;
    if (name && excludedNames.has(selectionName)) return false;
    if (mode === 'mainflow') {
      const activationMode = getWorldbookEntryActivationMode(entry);
      if (activationMode === 'always' || activationMode === 'constant') return true;
      if (activationMode === 'keyword' || activationMode === 'selective') return worldbookKeywordMatches(entry, activationText);
      return false;
    }
    if (!excludedNames || excludedNames.size === 0) return true;
    return true;
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

async function getFilteredGlobalWorldbooks(ctx, settings, recentMessages = []) {
  const boundName = String(getCharacterWorldBookName(ctx) || await getCharacterWorldBookNameViaSTscript() || '').trim();
  try {
    const names = (await getActiveGlobalWorldBookNames()).filter((name) => name !== boundName);
    const excludedNames = parseTrackerGlobalWorldbookExcludeNames(settings);
    const books = await Promise.all(names.map(async (name) => {
      try {
        const worldBook = await loadGlobalWorldBook(ctx, name);
        return filterTrackerWorldbookEntries(worldBook || null, excludedNames, settings, recentMessages, { globalBookName: name });
      } catch (error) {
        console.warn(`[BS BioTracker] load global worldbook "${name}" for tracker failed`, error);
        return null;
      }
    }));
    return books.filter((book) => book && ((Array.isArray(book.entries) && book.entries.length > 0) || (book.entries && typeof book.entries === 'object' && Object.keys(book.entries).length > 0)));
  } catch (error) {
    console.warn('[BS BioTracker] load active global worldbooks for tracker failed', error);
    return [];
  }
}

function getMainflowContextSnapshot() {
  const snapshot = globalThis[MAINFLOW_CONTEXT_SNAPSHOT_KEY];
  if (!snapshot || typeof snapshot !== 'object') return null;
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages
      .filter((message) => message && typeof message === 'object' && String(message.content || '').trim())
      .map((message) => ({
        role: String(message.role || 'user'),
        content: String(message.content || ''),
        name: message.name ? String(message.name) : undefined,
      }))
    : [];
  if (messages.length === 0) return null;
  return {
    source: String(snapshot.source || 'st_request'),
    capturedAt: Number(snapshot.capturedAt || 0) || null,
    model: snapshot.model ? String(snapshot.model) : '',
    messages,
  };
}

export function buildTrackerPayload(ctx, settings, reason = 'manual', endIndexExclusive = null) {
  const currentCharacter = getCharacterCard(ctx);
  const chatState = getChatState(ctx, settings);
  const existingState = chatState.characters || {};
  const recentMessages = buildRecentMessages(ctx, settings, endIndexExclusive);
  const useMainflowMode = normalizeWorldbookMode(settings?.trackerWorldbookMode) === 'mainflow';
  let mainflowContextSnapshot = useMainflowMode ? getMainflowContextSnapshot() : null;
  if (mainflowContextSnapshot && settings?.useStPresetForAsync) {
    mainflowContextSnapshot = {
      ...mainflowContextSnapshot,
      messages: mainflowContextSnapshot.messages.filter((m) => m.role !== 'system'),
    };
    if (mainflowContextSnapshot.messages.length === 0) mainflowContextSnapshot = null;
  }
  const filteredWorldBook = filterTrackerWorldbookEntries(
    currentCharacter.worldBook || null,
    parseTrackerWorldbookExcludeNames(settings),
    settings,
    recentMessages,
  );
  const payloadWorldBook = mainflowContextSnapshot ? null : filteredWorldBook;
  const diaryEnabled = getDiaryRecentLimit(settings, Object.keys(existingState || {}).length) > 0;
  const psychologyEnabled = hasBreedingPsychology(existingState);
  return {
    reason,
    chat_id: getChatKey(ctx),
    current_character: {
      ...currentCharacter,
      worldBook: payloadWorldBook,
    },
    character_description: currentCharacter.description || '',
    character_worldbook_name: getCharacterWorldBookName(ctx) || null,
    character_worldbook: payloadWorldBook,
    mainflow_context_snapshot: mainflowContextSnapshot,
    tracked_females: getRegisteredTargetNames(ctx, settings, chatState),
    existing_state: buildTrackerStateView(existingState, settings),
    available_tools: getTrackerToolDefinitions(settings, existingState),
    diary_enabled: diaryEnabled,
    require_full_description_updates: settings?.requireFullDescriptionUpdates === true,
    ...(psychologyEnabled ? { breeding_psychology_enabled: true } : {}),
    wardrobe_enabled: hasPreparedWardrobe(existingState),
    recent_messages: recentMessages,
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
  if (matchedSnapshot) {
    restoreChatStateFromSnapshot(chatState, matchedSnapshot);
  }
  return {
    nextMessageIndex: matchedSnapshot ? matchedSnapshot.messageCount : 0,
  };
}

function prepareManualReplay(ctx, chatState, chatLength) {
  if (chatLength <= 0) {
    return { nextMessageIndex: 0 };
  }
  const replayStart = Math.max(0, chatLength - 1);
  const baseSnapshot = replayStart > 0 ? getLatestMatchingSnapshot(ctx, chatState, replayStart) : null;
  if (baseSnapshot) {
    restoreChatStateFromSnapshot(chatState, baseSnapshot);
  }
  return { nextMessageIndex: replayStart };
}

function hasPendingChatHistory(ctx, chatState) {
  const matchedSnapshot = getLatestMatchingSnapshot(ctx, chatState);
  const currentLength = getHostChat(ctx).length;
  return !matchedSnapshot || matchedSnapshot.messageCount !== currentLength;
}

function emitTrackerUpdateCue(detail = {}) {
  globalThis.dispatchEvent?.(new CustomEvent(UPDATE_CUE_EVENT, { detail }));
}

function recordTrackerRequestDebug(systemPrompt, payload) {
  globalThis[DEBUG_LAST_TRACKER_REQUEST_KEY] = {
    capturedAt: Date.now(),
    systemPrompt,
    payload,
    messages: [
      { role: 'system', content: String(systemPrompt || '') },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ],
  };
}

function recordTrackerResultDebug(result, error = null) {
  globalThis[DEBUG_LAST_TRACKER_RESULT_KEY] = {
    capturedAt: Date.now(),
    ok: !error,
    result: result ?? null,
    error: error ? String(error?.message || error) : null,
  };
}

function buildStreamingGuardSignature(ctx) {
  const chat = getHostChat(ctx);
  const last = chat[chat.length - 1];
  if (!last) return '';
  const content = String(last.mes || '');
  return [
    getChatKey(ctx),
    chat.length,
    last.is_user ? 'user' : 'assistant',
    String(last.name || ''),
    content.length,
    content.slice(0, 180),
    content.slice(-120),
  ].join('|');
}

function isAfterAiMessageSettled(ctx, settings, chatState) {
  if (settings.triggerTiming !== 'after_ai') return true;
  const chat = getHostChat(ctx);
  const lastMessage = chat[chat.length - 1];
  if (!lastMessage || lastMessage.is_user) {
    delete chatState.pendingAssistantSignature;
    delete chatState.pendingAssistantUpdatedAt;
    return true;
  }

  const signature = buildStreamingGuardSignature(ctx);
  const now = Date.now();
  if (chatState.pendingAssistantSignature !== signature) {
    chatState.pendingAssistantSignature = signature;
    chatState.pendingAssistantUpdatedAt = now;
    saveSettings(ctx);
    return false;
  }

  const updatedAt = Number(chatState.pendingAssistantUpdatedAt || 0);
  if (!Number.isFinite(updatedAt) || now - updatedAt < AFTER_AI_SETTLE_MS) return false;
  return true;
}

async function processTrackerMessage(ctx, settings, chatState, deps, reason, messageIndex) {
  const chat = getHostChat(ctx);
  const message = chat[messageIndex];
  const shouldTrigger = reason === 'manual' ? true : shouldTriggerForMessage(settings, message);
  if (!shouldTrigger) {
    recordChatStateSnapshot(ctx, chatState, { messageCount: messageIndex + 1, reason: 'skip' });
    saveSettings(ctx);
    return;
  }

  const payload = buildTrackerPayload(ctx, settings, reason, messageIndex + 1);
  if (payload.mainflow_context_snapshot) {
    payload.character_worldbook_name = null;
  } else if (!payload.character_worldbook && !payload.character_worldbook_name) {
    payload.character_worldbook_name = await getCharacterWorldBookNameViaSTscript();
  }
  if (!payload.character_worldbook && payload.character_worldbook_name && canLoadHostWorldInfo(ctx)) {
    try {
      const loadedWorldBook = await loadHostWorldInfo(ctx, payload.character_worldbook_name);
      payload.character_worldbook = filterTrackerWorldbookEntries(
        loadedWorldBook || null,
        parseTrackerWorldbookExcludeNames(settings),
        settings,
        payload.recent_messages,
      );
    } catch (error) {
      console.warn('[BS BioTracker] loadWorldInfo for tracker failed', error);
    }
  }
  payload.global_worldbooks = payload.mainflow_context_snapshot
    ? []
    : await getFilteredGlobalWorldbooks(ctx, settings, payload.recent_messages);
  chatState.lastRunAt = Date.now();
  chatState.lastAttemptedSignature = buildSignature(ctx, messageIndex + 1);
  saveSettings(ctx);
  const systemPrompt = buildTrackerSystemPrompt(settings.systemPrompt || DEFAULT_SYSTEM_PROMPT, null, payload);
  recordTrackerRequestDebug(systemPrompt, payload);
  const rawResult = await callOpenAICompatible(
    settings,
    payload,
    systemPrompt
  );
  recordTrackerResultDebug(rawResult);
  const result = normalizeTrackerResult(rawResult);
  applyToolCallsResult(ctx, result);
  chatState.lastProcessedSignature = chatState.lastAttemptedSignature;
  chatState.lastFailedSignature = '';
  recordChatStateSnapshot(ctx, chatState, { messageCount: messageIndex + 1, reason: 'tracker' });
  saveSettings(ctx);
}

export async function runTracker(ctx, deps, reason = 'manual') {
  const settings = getSettings(ctx);
  await hydrateChatStateFromHost(ctx, settings);
  await refreshHostChatView(ctx, {
    resumeIndexes: getTrackerResumeIndexes(ctx, settings),
    contextSize: settings.contextSize,
  });
  const chatState = getChatState(ctx, settings);
  const registeredTargets = getRegisteredTargetNames(ctx, settings, chatState);
  const chat = getHostChat(ctx);
  const lastMessage = chat[chat.length - 1];
  if (!lastMessage) {
    chatState.lastRawResult = {
      message: '当前对话没有可分析的消息，已跳过追踪。',
      tool_calls: [],
    };
    chatState.lastOperationLogs = [];
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    return { skipped: true, reason: 'empty_chat' };
  }
  if (globalThis[RUN_RUNTIME_KEY]) {
    chatState.lastRawResult = {
      message: '已有一轮追踪请求正在执行，本次请求未重复发送。',
      tool_calls: [],
    };
    chatState.lastOperationLogs = [];
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    return { skipped: true, reason: 'already_running' };
  }
  if (registeredTargets.length === 0) {
    chatState.lastRawResult = {
      message: '尚无已注册角色，跳过分析。',
      tool_calls: [],
    };
    chatState.lastOperationLogs = [];
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    deps.updateMainFlowPrompt?.(ctx);
    return { skipped: true, reason: 'no_registered_targets' };
  }
  if (reason === 'poll' && getHostKind() === 'luker' && settings.lukerMultiAgentManualOnly !== false) {
    chatState.lastRawResult = {
      message: 'Luker 多智能体安全模式已开启，自动追踪暂停；请在编排完成后手动分析。',
      tool_calls: [],
    };
    chatState.lastOperationLogs = [];
    saveSettings(ctx);
    deps.renderStatusPanel(ctx);
    return { skipped: true, reason: 'luker_multi_agent_manual' };
  }
  if (reason === 'poll') {
    const agentBarrier = await getHostAgentRunBarrier(ctx, lastMessage);
    if (agentBarrier.state === 'pending') {
      chatState.lastRawResult = {
        message: `TauriTavern Agent run ${agentBarrier.runId} 尚未完成，自动追踪将等待最终提交。`,
        tool_calls: [],
      };
      chatState.lastOperationLogs = [];
      saveSettings(ctx);
      deps.renderStatusPanel(ctx);
      return { skipped: true, reason: 'agent_run_pending' };
    }
    if (agentBarrier.state === 'aborted') {
      chatState.lastRawResult = {
        message: `TauriTavern Agent run ${agentBarrier.runId} 已取消或失败，未自动追踪该提交；可手动分析。`,
        tool_calls: [],
      };
      chatState.lastOperationLogs = [];
      saveSettings(ctx);
      deps.renderStatusPanel(ctx);
      return { skipped: true, reason: 'agent_run_aborted' };
    }
  }
  if (reason === 'poll' && !isAfterAiMessageSettled(ctx, settings, chatState)) {
    return { skipped: true, reason: 'message_not_settled' };
  }
  if (reason === 'poll' && !hasPendingChatHistory(ctx, chatState)) {
    return { skipped: true, reason: 'no_pending_history' };
  }
  if (reason === 'poll' && isFailedAutoRetryBlocked(ctx, chatState)) {
    return { skipped: true, reason: 'failed_message_blocked' };
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
    emitTrackerUpdateCue({
      hasChanges: toolCalls.length > 0,
      processedCount,
      reason,
    });
    return { skipped: false, processedCount, toolCalls };
  } catch (error) {
    console.error('[BS BioTracker] runTracker failed', error);
    recordTrackerResultDebug(null, error);
    chatState.lastFailedSignature = chatState.lastAttemptedSignature || buildSignature(ctx, chat.length);
    chatState.lastRawResult = {
      error: String(error?.message || error),
      tool_calls: [],
    };
    chatState.lastOperationLogs = [];
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
