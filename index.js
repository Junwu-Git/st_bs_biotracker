import { fetchModelList } from './scripts/api.js';
import { applyRegistryBreedingInference, runRegistry, runRegistryBreedingInference, runRegistryDiaryInference, runRegistryWardrobeInference } from './scripts/registry.js';
import {
  AMORPHOUS_RACES,
  DERIVED_TYPE_FLUX_PROFILES,
  DERIVED_TYPE_INHERITANCE_PROFILES,
  DERIVED_TYPE_RACES,
  RACE_INTRODUCTION_FIELD,
  RACE_PHYSIOLOGY_FIELDS,
  getEmbryoTypeByRace,
  getBuiltinRacePhysiologyProfile,
  getDerivedTypeFluxProfile,
  getDerivedTypeInheritanceProfile,
  getDerivedTypeIntroductionLine,
  getDerivedTypeMetabolismExemptions,
  getDerivedTypeOverride,
  getRaceIntroductionLine,
  getRacePhysiologyOverride,
  setRacePhysiologyOverrides,
  setDerivedTypeOverrides,
  METOVIVIPAROUS_RACES,
  OVIPAROUS_RACES,
  OVOVIVIPAROUS_RACES,
  VIVIPAROUS_RACES,
} from './scripts/race_config.js';
import {
  FIRST_STAGE_NATURAL_BIRTH_EXPERIENCE,
  LABOR_STAGES,
  LABOR_STAGE_BASE_HOURS,
  LABOR_STAGE_INCREMENT,
  LABOR_POSTPARTUM_OBSERVATION_HOURS,
  MENSTRUAL_STAGE_DAYS,
  PREGNANCY_STAGE_DAYS,
  PREGNANCY_STAGES,
} from './scripts/stage_config.js';
import { buildMainFlowPrompt, resetPoller, runTracker } from './scripts/tracker.js';
import { applyToolCall } from './scripts/tools.js';
import { getEmbryoTypeReferenceText } from './scripts/embryo_prompt_context.js';
import { buildSingleRacePhysiologyText } from './scripts/race_prompt_context.js';
import {
  canLoadHostWorldInfo,
  getHostChatCompletionSettings,
  getHostContext,
  getHostKind,
  getHostPreset,
  getHostPresetManager,
  getHostWorldBook,
  listHostPresets,
  loadHostWorldInfo,
  registerHostExtensionMenuItem,
  replaceHostEventSubscription,
} from './scripts/host.js';
import {
  createEmptyChatState,
  DEFAULT_SYSTEM_PROMPT,
  getCharacterWorldBookName,
  getCharacterWorldBookNameViaSTscript,
  getActiveGlobalWorldBookNames,
  getGestationEffectiveSpeed,
  getGestationSpeciesSpeed,
  getChatKey,
  getChatState,
  getContextSafe,
  inheritChatStateFromMatchingChat,
  isChatStateEffectivelyEmpty,
  getResolvedCharacter,
  getSettings,
  hydrateChatStateFromHost,
  loadGlobalWorldBook,
  MODULE_NAME,
  normalizeCharacterPsychologyState,
  recordChatStateSnapshot,
  resolveRegisteredCharacterName,
  saveSettings,
  THEME_CONFIG,
} from './scripts/state.js';

const PANEL_ID = 'bs-biotracker-settings';
const MODAL_ID = 'bs-biotracker-modal';
const MENU_ITEM_ID = 'bs-biotracker-menu-item';
const MENU_API_ID = 'bs-biotracker-menu-api';
const MAINFLOW_PROMPT_KEY = `${MODULE_NAME}_mainflow`;
const LAST_VIEW_STORAGE_KEY = `${MODULE_NAME}_last_view`;
const TRACK_SUBPAGES = ['overview', 'description', 'pregnancy', 'experience', 'diary'];
const WARDROBE_DIMENSION_LABELS = Object.freeze({ masking: '掩形', support: '支撑', capacity: '容身', convenience: '便捷' });
const PREG_FIT_GAP_LABELS = Object.freeze({ masking: '掩形', support: '支撑', capacity: '容身', convenience: '便捷' });
const MAX_PROGRESS_BAR_CAP = 200;
const MODAL_EDGE_GAP = 24;
const UPDATE_CUE_EVENT = 'bs-biotracker:update-cue';
const FLOATING_SPHERE_POSITION_KEY = `${MODULE_NAME}_floating_sphere_position`;
const FLOATING_SPHERE_DRAG_THRESHOLD = 8;
const FLOATING_SPHERE_LONG_PRESS_MS = 650;
const TAURI_MENU_RECOVERY_RETRY_COUNT = 40;
const TAURI_MENU_RECOVERY_OBSERVER_KEY = '__bs_biotracker_tauri_menu_recovery_observer__';
const CLOCK_RUNTIME_KEY = '__bs_biotracker_clock__';
const BOOTSTRAP_RUNTIME_KEY = '__bs_biotracker_bootstrap__';
const CHAT_CHANGED_HANDLER_KEY = '__bs_biotracker_chat_changed_handler__';
const CHAT_CREATED_HANDLER_KEY = '__bs_biotracker_chat_created_handler__';
const APP_READY_HANDLER_KEY = '__bs_biotracker_app_ready_handler__';
const CHAT_DELETED_HANDLER_KEY = '__bs_biotracker_chat_deleted_handler__';
const GROUP_CHAT_DELETED_HANDLER_KEY = '__bs_biotracker_group_chat_deleted_handler__';
const GROUP_CHAT_CREATED_HANDLER_KEY = '__bs_biotracker_group_chat_created_handler__';
const PENDING_CHAT_INHERIT_KEY = '__bs_biotracker_pending_chat_inherit__';
const WORLDBOOK_RELOAD_TIMER_KEY = '__bs_biotracker_worldbook_reload_timer__';
const MAINFLOW_CONTEXT_SNAPSHOT_KEY = '__bs_biotracker_mainflow_context_snapshot__';
const DEBUG_LAST_MAINFLOW_SNAPSHOT_KEY = '__bs_biotracker_debug_last_mainflow_snapshot__';
const FETCH_CAPTURE_READY_KEY = '__bs_biotracker_fetch_capture_ready__';
let registryBreedingInferenceDraft = null;
const ORIGINAL_FETCH_KEY = '__bs_biotracker_original_fetch__';
const MAX_MAINFLOW_SNAPSHOT_MESSAGES = 48;
const VITALITY_CAPS = { 1: 50, 2: 75, 3: 100, 4: 125, 5: 150, 6: 175, 7: 200 };
const PSY_STRESS_CAPS = { 1: 20, 2: 50, 3: 80, 4: 110, 5: 140, 6: 170, 7: 200 };

let selectedFullStateName = '';
let selectedFullStateSubpage = 'variables';
let selectedTrackName = '';
let selectedTrackSubpage = 'overview';
let selectedTrackCardIndexes = {};
let selectedWardrobeName = '';
let selectedRaceEncyclopedia = '';
let selectedDerivedEncyclopedia = '';
let racePhysiologyEditorOpen = false;
let derivedTypeEditorOpen = false;
let selectedEncyclopediaSubpage = 'race';
let worldbookEntrySearch = '';
let latestWorldbookEntries = [];
let globalWorldbookEntrySearch = '';
let latestGlobalWorldbookEntries = [];
let selectedWorldbookScopeTab = 'character';
let racePaletteState = {
  targetInputId: '',
  isOpen: false,
  selectedRace: '人类',
  selectedDerivedType: '',
  derivedSubtype: '',
  subtype: '',
  raceTags: [],
};

function normalizeWorldbookMode(value) {
  const mode = String(value || 'exclude').trim();
  if (mode === 'mainflow' || mode === 'allowlist_all' || mode === 'exclude') return mode;
  return 'exclude';
}
let debugInjectDraft = {
  father: '',
  race: '人类',
  fetusCount: '1',
  genders: '女',
  equivalentDays: '0',
};
let debugGestationModifierDraft = {
  owner: '',
  name: '',
  multiplier: '',
  description: '',
};
let debugFetalActivityDraft = {
  owner: '',
  text: '',
};

const RACE_PALETTE_GROUPS = [
  { label: '胎生', races: VIVIPAROUS_RACES },
  { label: '卵生', races: OVIPAROUS_RACES },
  { label: '卵胎生', races: OVOVIVIPAROUS_RACES },
  { label: '胎转卵生', races: METOVIVIPAROUS_RACES },
  { label: '不定型', races: AMORPHOUS_RACES },
];
const RACE_ENCYCLOPEDIA_LIST = Array.from(
  new Set([
    ...VIVIPAROUS_RACES,
    ...OVIPAROUS_RACES,
    ...OVOVIVIPAROUS_RACES,
    ...METOVIVIPAROUS_RACES,
    ...AMORPHOUS_RACES,
  ]),
).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
const RACE_ENCYCLOPEDIA_GROUPS = RACE_PALETTE_GROUPS.map((group) => ({
  label: group.label,
  races: Array.from(new Set(group.races)),
})).filter((group) => group.races.length > 0);
const DERIVED_ENCYCLOPEDIA_LIST = Array.from(new Set(DERIVED_TYPE_RACES)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
const RACE_PHYSIOLOGY_FIELD_LABELS = Object.freeze({
  menstrualLengthRatio: '经期长度倍率',
  gestationSpeciesSpeed: '妊娠速度倍率',
  birthDifficulty: '分娩难度',
  breedTolerance: '承载耐受',
  impregnationDifficulty: '受精难度',
  orgasmOvulationAmount: '额外排卵倾向',
  identicalProbability: '同卵多胎概率(%)',
  genderRatio: '男胎比例',
});
const RACE_PHYSIOLOGY_FIELD_HINTS = Object.freeze({
  genderRatio: '0-100；空白=双性，-1=无性',
});
const EDITABLE_RACE_PHYSIOLOGY_FIELDS = Object.freeze(RACE_PHYSIOLOGY_FIELDS.filter((field) => field !== 'recoveryDays'));
const RACE_INTRODUCTION_LABEL = '物种短敘述';

function setConnectStatus(message, isError = false) {
  const el = document.getElementById('bs-bt-connect-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = isError ? 'error' : 'normal';
}

function setRegisterStatus(message, isError = false) {
  const el = document.getElementById('bs-bt-register-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = isError ? 'error' : 'normal';
}

function setRegisterTab(tab) {
  const requested = String(tab || 'inference');
  const next = ['inference', 'registry', 'wardrobe', 'diary'].includes(requested) ? requested : 'inference';
  document.querySelectorAll('#bs-bt-register-tabs [data-register-tab]').forEach((node) => {
    node.classList.toggle('is-active', String(node.getAttribute('data-register-tab') || '') === next);
  });
  document.querySelectorAll('#bs-bt-view-register [data-register-page]').forEach((node) => {
    const active = String(node.getAttribute('data-register-page') || '') === next;
    node.classList.toggle('is-active', active);
    node.hidden = !active;
  });
}


function setWardrobePrepStatus(message, isError = false) {
  const el = document.getElementById('bs-bt-wardrobe-prep-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = isError ? 'error' : 'normal';
}

async function runWardrobePrepInference(ctx, button = null) {
  const values = getRegisterFormValues();
  if (!values.targetName) {
    setWardrobePrepStatus('请先输入要备装的已注册角色名。', true);
    globalThis.toastr?.warning?.('[BS BioTracker] 请先输入角色名');
    return;
  }
  readSettingsFromForm(ctx);
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const targetName = resolveRegisteredCharacterName(chatState, values.targetName);
  if (!targetName) {
    setWardrobePrepStatus(`尚未找到已注册角色：${values.targetName}。请先完成注册，再备装。`, true);
    globalThis.toastr?.warning?.('[BS BioTracker] 备装需要已注册角色');
    return;
  }
  const wardrobePrepPrompt = String(document.getElementById('bs-bt-wardrobe-prep-prompt')?.value || settings.wardrobePrepPrompt || '').trim();
  const wardrobePrepMainCount = Math.max(1, Math.min(12, Math.floor(Number(document.getElementById('bs-bt-wardrobe-prep-main-count')?.value || settings.wardrobePrepMainCount || 3))));
  const wardrobePrepAccessoryCount = Math.max(0, Math.min(12, Math.floor(Number(document.getElementById('bs-bt-wardrobe-prep-accessory-count')?.value || settings.wardrobePrepAccessoryCount || 3))));
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '生成中...';
  }
  setWardrobePrepStatus(`正在为 ${targetName} 生成衣柜 JSON...`);
  try {
    const result = await runRegistryWardrobeInference(ctx, { ...values, targetName, wardrobePrepPrompt, wardrobePrepMainCount, wardrobePrepAccessoryCount });
    const editor = document.getElementById('bs-bt-wardrobe-prep-json');
    if (editor) editor.value = JSON.stringify(result, null, 2);
    setWardrobePrepStatus('备装生成完成。可以手动微调 JSON，再套用备装。');
    globalThis.toastr?.success?.(`[BS BioTracker] 已生成 ${targetName} 的备装 JSON`);
  } catch (error) {
    console.error('[BS BioTracker] runRegistryWardrobeInference failed', error);
    const message = String(error?.message || error);
    setWardrobePrepStatus(message, true);
    globalThis.toastr?.error?.(message, '[BS BioTracker]');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || '生成备装';
    }
  }
}

function applyWardrobePrep(ctx) {
  const values = getRegisterFormValues();
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const targetName = resolveRegisteredCharacterName(chatState, values.targetName);
  const character = targetName ? chatState.characters?.[targetName] : null;
  if (!values.targetName || !character) {
    setWardrobePrepStatus('请先在注册角色名输入一个已注册角色。', true);
    globalThis.toastr?.warning?.('[BS BioTracker] 备装需要已注册角色');
    return;
  }
  const raw = String(document.getElementById('bs-bt-wardrobe-prep-json')?.value || '').trim();
  if (!raw) {
    setWardrobePrepStatus('备装 JSON 为空。', true);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    setWardrobePrepStatus(`备装 JSON 无法解析：${String(error?.message || error)}`, true);
    return;
  }
  const items = Array.isArray(parsed?.wardrobe?.items) ? parsed.wardrobe.items : Array.isArray(parsed?.items) ? parsed.items : [];
  if (items.length === 0) {
    setWardrobePrepStatus('备装 JSON 需要 wardrobe.items。', true);
    return;
  }
  const outfit = parsed?.outfit && typeof parsed.outfit === 'object' ? parsed.outfit : {};
  let outfitDescription = getWardrobePrepOutfitDescription(parsed);
  let outfitSelfView = getWardrobePrepOutfitSelfView(parsed);
  const workingState = cloneJsonValue(chatState);
  const workingCharacter = workingState.characters?.[targetName];
  if (!workingCharacter?.profile) {
    setWardrobePrepStatus('备装目标状态异常。', true);
    return;
  }
  workingCharacter.profile.wardrobe = {
    enabled: true,
    items: [{ id: 0, name: '全裸', note: '未着衣物。', slot: 'main', masking: 0, support: 0, capacity: 10, convenience: 10 }],
  };
  workingCharacter.profile.outfit = { mainItemId: 0, accessoryItemIds: [], temporaryItems: [], pregFit: null };
  const logs = [];
  for (const item of items) {
    if (Number(item?.id) === 0 || String(item?.id || '').trim() === 'nude') continue;
    logs.push(applyToolCall(workingState, { name: 'bsAddWardrobeItem', arguments: { female: targetName, item } }));
  }
  logs.push(applyToolCall(workingState, {
    name: 'bsChangeOutfit',
    arguments: {
      female: targetName,
      mainItemId: Number.isInteger(Number(outfit.mainItemId)) ? Number(outfit.mainItemId) : 0,
      accessoryItemIds: Array.isArray(outfit.accessoryItemIds) ? outfit.accessoryItemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id >= 0) : [],
      temporaryItems: Array.isArray(outfit.temporaryItems) ? outfit.temporaryItems : [],
    },
  }));
  const failed = logs.find((item) => item && item.applied === false);
  if (failed) {
    setWardrobePrepStatus(failed.message || '备装失败。', true);
    return;
  }
  if (!outfitDescription) outfitDescription = buildWardrobePrepFallbackOutfitDescription(items, outfit);
  if (!outfitSelfView) outfitSelfView = buildWardrobePrepFallbackOutfitSelfView(items, outfit);
  if (!outfitDescription || !outfitSelfView) {
    setWardrobePrepStatus('备装 JSON 需要 outfitDescription 与 outfitSelfView。请重新生成或手动补上。', true);
    return;
  }
  const preparedCharacter = workingState.characters?.[targetName];
  if (!preparedCharacter?.profile) {
    setWardrobePrepStatus('备装目标状态异常。', true);
    return;
  }
  let normalDescription = preparedCharacter.profile.descriptions?.normalDescription || '';
  normalDescription = upsertDescriptionField(normalDescription, '衣着动态', outfitDescription, ['衣着動態', '衣著动态', '衣著動態', '衣着', '衣著', '当前衣着', '當前衣著']);
  normalDescription = upsertDescriptionField(normalDescription, '衣着自评', outfitSelfView, ['衣著自評', '衣着自評', '衣著自评', '服装自评', '服裝自評']);
  preparedCharacter.profile.descriptions = {
    ...(preparedCharacter.profile.descriptions || {}),
    normalDescription,
  };
  chatState.characters[targetName] = preparedCharacter;
  recordChatStateSnapshot(ctx, chatState, { reason: 'wardrobe_prep' });
  saveSettings(ctx);
  resetPoller(ctx, trackerDeps);
  renderStatusPanel(ctx);
  renderWardrobePage(ctx);
  setWardrobePrepStatus(`已为 ${targetName} 重新套用备装；旧衣柜已由本次 JSON 覆盖。`);
  globalThis.toastr?.success?.(`[BS BioTracker] 已备装 ${targetName}`);
}

function setDiaryStatus(message, isError = false) {
  const node = document.getElementById('bs-bt-diary-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = isError ? 'error' : 'normal';
}

async function generateRegistryDiary(ctx, button = null) {
  const values = getRegisterFormValues();
  if (!values.targetName) {
    setDiaryStatus('请先输入要写日记的已注册角色名。', true);
    return;
  }
  readSettingsFromForm(ctx);
  const settings = getSettings(ctx);
  const requestedDate = String(document.getElementById('bs-bt-diary-date')?.value || '').trim();
  const diaryWritingPrompt = String(document.getElementById('bs-bt-diary-writing-prompt')?.value || settings.diaryWritingPrompt || '').trim();
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '生成中...';
  }
  setDiaryStatus(`正在为 ${values.targetName} 生成日记...`);
  try {
    const result = await runRegistryDiaryInference(ctx, { ...values, requestedDate, diaryWritingPrompt });
    const editor = document.getElementById('bs-bt-diary-result');
    if (editor) editor.value = JSON.stringify(result, null, 2);
    setDiaryStatus('生成完成。可修改日期与正文后再写入。');
  } catch (error) {
    const message = String(error?.message || error);
    setDiaryStatus(message, true);
    globalThis.toastr?.error?.(message, '[BS BioTracker]');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || '生成日记';
    }
  }
}

function applyRegistryDiary(ctx) {
  const values = getRegisterFormValues();
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const targetName = resolveRegisteredCharacterName(chatState, values.targetName);
  if (!targetName) {
    setDiaryStatus('请先输入已注册角色名。', true);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(String(document.getElementById('bs-bt-diary-result')?.value || '').trim());
  } catch (error) {
    setDiaryStatus(`日记 JSON 无法解析：${String(error?.message || error)}`, true);
    return;
  }
  const result = applyToolCall(chatState, {
    name: 'bsWriteDiary',
    arguments: { female: targetName, time: parsed?.time, content: parsed?.content },
  });
  if (!result?.applied) {
    setDiaryStatus(result?.message || '日记写入失败。', true);
    return;
  }
  recordChatStateSnapshot(ctx, chatState, { reason: 'manual_diary' });
  saveSettings(ctx);
  resetPoller(ctx, trackerDeps);
  renderStatusPanel(ctx);
  setDiaryStatus(`已写入 ${targetName} 的日记：${String(parsed.time || '')}`);
  globalThis.toastr?.success?.(`[BS BioTracker] 已写入 ${targetName} 的日记`);
}

function getRegisterFormValues() {
  return {
    targetName: String(document.getElementById('bs-bt-register-name')?.value || '').trim(),
    declaredRace: String(document.getElementById('bs-bt-register-race')?.value || '').trim(),
    customNotes: String(document.getElementById('bs-bt-register-custom-notes')?.value || '').trim(),
    breedingInferencePrompt: String(document.getElementById('bs-bt-breeding-inference-prompt')?.value || '').trim(),
  };
}

function setBreedingInferenceStatus(message, isError = false) {
  const el = document.getElementById('bs-bt-breeding-inference-message');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = isError ? 'error' : 'normal';
}

function setBreedingInferenceEditor(message, isError = false) {
  const el = document.getElementById('bs-bt-breeding-inference-status');
  if (!el) return;
  if ('value' in el) el.value = message;
  else el.textContent = message;
  el.dataset.state = isError ? 'error' : 'normal';
}

function formatBreedingInferencePreview(result) {
  if (!result || typeof result !== 'object') return '尚未执行繁育推演。';
  return JSON.stringify(result, null, 2);
}

function getApplicableBreedingInferenceDraft(values) {
  const draft = registryBreedingInferenceDraft;
  if (!draft?.result) return null;
  if (draft.targetName !== values.targetName) return null;
  if (draft.declaredRace !== values.declaredRace) return null;
  if (draft.customNotes !== values.customNotes) return null;
  if (draft.breedingInferencePrompt !== values.breedingInferencePrompt) return null;
  const editor = document.getElementById('bs-bt-breeding-inference-status');
  const raw = String((editor && 'value' in editor ? editor.value : editor?.textContent) || '').trim();
  if (!raw || raw === '尚未执行繁育推演。直接注册不会生成繁育心理人设。') return draft.result;
  try {
    const edited = JSON.parse(raw);
    if (!edited || typeof edited !== 'object' || Array.isArray(edited)) throw new Error('繁育推演 JSON 必须是对象');
    return edited;
  } catch (error) {
    throw new Error(`繁育推演 JSON 无法解析：${String(error?.message || error)}`);
  }
}

function getWorldbookFilterInputNames(ctx) {
  const settings = getSettings(ctx);
  const mode = normalizeWorldbookMode(settings.trackerWorldbookMode);
  if (mode === 'allowlist_all') return parseWorldbookExcludeNamesInput(settings.trackerWorldbookIncludeNames);
  return parseWorldbookExcludeNamesInput(settings.trackerWorldbookExcludeNames);
}

function getGlobalWorldbookFilterInputNames(ctx) {
  const settings = getSettings(ctx);
  const mode = normalizeWorldbookMode(settings.trackerWorldbookMode);
  if (mode === 'allowlist_all') return parseWorldbookExcludeNamesInput(settings.trackerGlobalWorldbookIncludeNames);
  return parseWorldbookExcludeNamesInput(settings.trackerGlobalWorldbookExcludeNames);
}

function formatGlobalWorldbookSelectionName(bookName, entryName) {
  return `${String(bookName || '').trim()} :: ${String(entryName || '').trim()}`;
}

function syncWorldbookFilterInput(ctx) {
  const settings = getSettings(ctx);
  const mode = normalizeWorldbookMode(settings.trackerWorldbookMode);
  const label = document.getElementById('bs-bt-worldbook-filter-input-label');
  const input = document.getElementById('bs-bt-worldbook-filter-input');
  const names = getWorldbookFilterInputNames(ctx);
  const globalLabel = document.getElementById('bs-bt-global-worldbook-filter-input-label');
  const globalInput = document.getElementById('bs-bt-global-worldbook-filter-input');
  const globalNames = getGlobalWorldbookFilterInputNames(ctx);
  if (label) label.textContent = mode === 'allowlist_all' ? '角色可参考' : '角色可排除';
  if (globalLabel) globalLabel.textContent = mode === 'allowlist_all' ? '全域可参考' : '全域可排除';
  if (input) {
    input.value = names.join('\n');
    input.placeholder = mode === 'allowlist_all'
      ? '每行一个条目名。参考模式下，仅这些条目会传给 tracker；即使它们目前是 disabled 也会保留。'
      : mode === 'mainflow'
        ? '每行一个条目名。主流模式下，tracker 优先引用上次 ST 主流 request 上下文；没有快照时会按常驻/关键字触发，并套用这些排除条目。'
        : '每行一个条目名。正常模式下，这些条目会从 worldbook 传输中排除。';
  }
  if (globalInput) {
    globalInput.value = globalNames.join('\n');
    globalInput.placeholder = mode === 'allowlist_all'
      ? '每行一个“书名 :: 条目名”。参考模式下，仅这些全域条目会传给 tracker。'
      : '每行一个“书名 :: 条目名”。正常模式下，这些全域条目会从 worldbook 传输中排除。';
  }
}

function trimMainflowSnapshotContent(content) {
  return String(content || '');
}

function normalizeMainflowSnapshotMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === 'object')
    .slice(-MAX_MAINFLOW_SNAPSHOT_MESSAGES)
    .map((message) => ({
      role: String(message.role || 'user'),
      content: trimMainflowSnapshotContent(message.content ?? message.text ?? ''),
      name: message.name ? String(message.name) : undefined,
    }))
    .filter((message) => message.content);
}

function captureMainflowRequestBody(body, source = 'fetch') {
  if (!body || typeof body !== 'object') return;
  const messages = normalizeMainflowSnapshotMessages(body.messages);
  if (messages.length === 0) return;
  globalThis[MAINFLOW_CONTEXT_SNAPSHOT_KEY] = {
    source,
    capturedAt: Date.now(),
    model: body.model ? String(body.model) : '',
    messages,
  };
  globalThis[DEBUG_LAST_MAINFLOW_SNAPSHOT_KEY] = globalThis[MAINFLOW_CONTEXT_SNAPSHOT_KEY];
}

function parseJsonText(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseFetchBodyFromInit(init) {
  const raw = init?.body;
  return parseJsonText(raw);
}

async function parseFetchBodyFromRequest(input) {
  if (!input || typeof input !== 'object' || typeof input.clone !== 'function') return null;
  try {
    return await input.clone().json();
  } catch {
    return null;
  }
}

function installMainflowRequestCapture() {
  if (globalThis[FETCH_CAPTURE_READY_KEY] || typeof globalThis.fetch !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis[ORIGINAL_FETCH_KEY] = originalFetch;
  globalThis.fetch = async (...args) => {
    if (!globalThis.__bs_biotracker_async_request__) {
      try {
        const body = parseFetchBodyFromInit(args[1]) || await parseFetchBodyFromRequest(args[0]);
        captureMainflowRequestBody(body, 'fetch');
      } catch (error) {
        console.warn('[BS BioTracker] mainflow request capture failed', error);
      }
    }
    return originalFetch(...args);
  };
  globalThis[FETCH_CAPTURE_READY_KEY] = true;
}

function saveWorldbookExcludeNamesFromList(ctx, names) {
  const normalized = Array.from(new Set((Array.isArray(names) ? names : []).map((item) => String(item || '').trim()).filter(Boolean)));
  const settings = getSettings(ctx);
  settings.trackerWorldbookExcludeNames = normalized.join('\n');
  syncWorldbookFilterInput(ctx);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
}

function saveWorldbookIncludeNamesFromList(ctx, names) {
  const normalized = Array.from(new Set((Array.isArray(names) ? names : []).map((item) => String(item || '').trim()).filter(Boolean)));
  const settings = getSettings(ctx);
  settings.trackerWorldbookIncludeNames = normalized.join('\n');
  syncWorldbookFilterInput(ctx);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
}

function saveGlobalWorldbookExcludeNamesFromList(ctx, names) {
  const normalized = Array.from(new Set((Array.isArray(names) ? names : []).map((item) => String(item || '').trim()).filter(Boolean)));
  const settings = getSettings(ctx);
  settings.trackerGlobalWorldbookExcludeNames = normalized.join('\n');
  syncWorldbookFilterInput(ctx);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
}

function saveGlobalWorldbookIncludeNamesFromList(ctx, names) {
  const normalized = Array.from(new Set((Array.isArray(names) ? names : []).map((item) => String(item || '').trim()).filter(Boolean)));
  const settings = getSettings(ctx);
  settings.trackerGlobalWorldbookIncludeNames = normalized.join('\n');
  syncWorldbookFilterInput(ctx);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
}

function applyWorldbookFilterSelection(ctx, entries = []) {
  latestWorldbookEntries = Array.isArray(entries) ? entries : [];
  renderWorldbookEntryList(ctx, latestWorldbookEntries);
}

function applyGlobalWorldbookFilterSelection(ctx, entries = []) {
  latestGlobalWorldbookEntries = Array.isArray(entries) ? entries : [];
  renderWorldbookEntryList(ctx, latestGlobalWorldbookEntries, { scope: 'global' });
}

function setWorldbookScopeTab(scope = 'character') {
  selectedWorldbookScopeTab = scope === 'global' ? 'global' : 'character';
  document.querySelectorAll('#bs-bt-worldbook-scope-tabs [data-worldbook-scope-tab]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.worldbookScopeTab === selectedWorldbookScopeTab);
  });
  document.querySelectorAll('#bs-bt-view-worldbook-filter [data-worldbook-scope-panel]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.worldbookScopePanel === selectedWorldbookScopeTab);
  });
}

function renderWorldbookEntryList(ctx, entries = [], { scope = 'character' } = {}) {
  const isGlobal = scope === 'global';
  const container = document.getElementById(isGlobal ? 'bs-bt-global-worldbook-entry-list' : 'bs-bt-worldbook-entry-list');
  const title = isGlobal
    ? document.getElementById('bs-bt-global-worldbook-title')
    : document.querySelector('#bs-bt-view-worldbook-filter .bs-bt-status-title');
  const searchInput = document.getElementById(isGlobal ? 'bs-bt-global-worldbook-entry-search' : 'bs-bt-worldbook-entry-search');
  if (!container) return;
  const settings = getSettings(ctx);
  const mode = normalizeWorldbookMode(settings.trackerWorldbookMode);
  const activeSearch = isGlobal ? globalWorldbookEntrySearch : worldbookEntrySearch;
  if (searchInput && searchInput.value !== activeSearch) searchInput.value = activeSearch;
  const selected = new Set(isGlobal ? getGlobalWorldbookFilterInputNames(ctx) : getWorldbookFilterInputNames(ctx));

  const normalizedEntries = [];
  for (const item of (Array.isArray(entries) ? entries : [])) {
    if (!item) continue;
    if (typeof item === 'string') {
      const name = item.trim();
      if (name && !normalizedEntries.find((e) => e.name === name)) normalizedEntries.push({ name, mode: '' });
    } else if (item.name) {
      const name = String(item.name).trim();
      const bookName = String(item.bookName || '').trim();
      const selectionName = isGlobal ? formatGlobalWorldbookSelectionName(bookName, name) : name;
      if (name && !normalizedEntries.find((e) => e.selectionName === selectionName)) {
        normalizedEntries.push({ name, bookName, selectionName, mode: item.mode || '' });
      }
    }
  }
  const keyword = String(activeSearch || '').trim().toLowerCase();
  const filteredEntries = keyword
    ? normalizedEntries.filter((entry) =>
      String(entry?.name || '').toLowerCase().includes(keyword)
      || String(entry?.bookName || '').toLowerCase().includes(keyword)
      || String(entry?.mode || '').toLowerCase().includes(keyword))
    : normalizedEntries;

  container.innerHTML = '';
  if (title) {
    title.textContent = isGlobal
      ? (mode === 'allowlist_all' ? '全域世界书条目（仅供参考）' : '全域世界书条目')
      : (mode === 'allowlist_all' ? '角色世界书条目（仅供参考）' : '角色世界书条目');
  }

  if (normalizedEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bs-bt-connect-status';
    empty.textContent = isGlobal ? '目前没有启用中的全域世界书条目' : '当前角色世界书暂无可识别条目';
    container.appendChild(empty);
    return;
  }

  if (filteredEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bs-bt-connect-status';
    empty.textContent = '没有匹配当前搜索条件的条目';
    container.appendChild(empty);
    return;
  }

  for (const entryObj of filteredEntries) {
    const { name, bookName, selectionName = name, mode } = entryObj;
    const label = document.createElement('label');
    label.className = 'bs-bt-theme-option';
    label.style.display = 'grid';
    label.style.gridTemplateColumns = '20px minmax(0, 1fr)';
    label.style.alignItems = 'start';
    label.style.gap = '8px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(selectionName);

    const toggleEntrySelection = () => {
      const nextSelected = new Set(isGlobal ? getGlobalWorldbookFilterInputNames(ctx) : getWorldbookFilterInputNames(ctx));
      if (nextSelected.has(selectionName)) nextSelected.delete(selectionName);
      else nextSelected.add(selectionName);
      if (normalizeWorldbookMode(getSettings(ctx).trackerWorldbookMode) === 'allowlist_all') {
        if (isGlobal) saveGlobalWorldbookIncludeNamesFromList(ctx, Array.from(nextSelected));
        else saveWorldbookIncludeNamesFromList(ctx, Array.from(nextSelected));
      } else {
        if (isGlobal) saveGlobalWorldbookExcludeNamesFromList(ctx, Array.from(nextSelected));
        else saveWorldbookExcludeNamesFromList(ctx, Array.from(nextSelected));
      }
      renderWorldbookEntryList(ctx, isGlobal ? latestGlobalWorldbookEntries : latestWorldbookEntries, { scope });
    };

    label.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleEntrySelection();
    });

    const textWrap = document.createElement('div');
    textWrap.style.display = 'flex';
    textWrap.style.gap = '8px';
    textWrap.style.alignItems = 'baseline';

    if (isGlobal && bookName) {
      const bookBadge = document.createElement('span');
      bookBadge.textContent = `[${bookName}]`;
      bookBadge.style.fontSize = '0.8em';
      bookBadge.style.color = 'var(--bs-bt-text-dim, #888)';
      textWrap.appendChild(bookBadge);
    }

    if (mode) {
      const badge = document.createElement('span');
      badge.textContent = mode === 'always' ? '[常駐]' : (mode === 'keyword' ? '[關鍵字]' : `[${mode}]`);
      badge.style.fontSize = '0.8em';
      badge.style.color = 'var(--bs-bt-text-dim, #888)';
      textWrap.appendChild(badge);
    }

    const text = document.createElement('span');
    text.textContent = name;
    text.style.wordBreak = 'break-word';
    textWrap.appendChild(text);

    label.appendChild(checkbox);
    label.appendChild(textWrap);
    container.appendChild(label);
  }
}

const MAINFLOW_PROMPT_TOKEN_INPUT_KEY = '__bs_biotracker_mainflow_prompt_token_input__';
const MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY = '__bs_biotracker_mainflow_prompt_token_count_cache__';

function estimateTokens(text) {
  const value = String(text || '');
  let cjk = 0;
  for (const char of value) {
    if (/[぀-ヿ㐀-鿿豈-﫿]/u.test(char)) cjk += 1;
  }
  const other = Math.max(0, value.length - cjk);
  return Math.ceil((cjk * 0.75 + other * 0.25) * 1.12);
}

function formatTokenEstimate(value, approximate = true) {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  const prefix = approximate ? '~' : '';
  return tokens >= 1000 ? `${prefix}${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : `${prefix}${tokens}`;
}

function getHostTokenCounter() {
  const ctx = getContextSafe();
  if (typeof ctx?.getTokenCountAsync === 'function') return { owner: ctx, count: ctx.getTokenCountAsync };
  if (typeof ctx?.tokenizers?.getTokenCountAsync === 'function') return { owner: ctx.tokenizers, count: ctx.tokenizers.getTokenCountAsync };
  return null;
}

function queueHostTokenCount(input, settings) {
  if (!input?.text || !input.key) return;
  const existing = globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] || {};
  if (existing.key === input.key || existing.pendingKey === input.key) return;
  const tokenizer = getHostTokenCounter();
  if (!tokenizer) return;
  globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] = { ...existing, pendingKey: input.key };
  Promise.resolve(tokenizer.count.call(tokenizer.owner, input.text))
    .then((count) => {
      const tokenCount = Number(count);
      const current = globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] || {};
      if (!Number.isFinite(tokenCount) || tokenCount < 0) throw new Error('invalid host token count');
      globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] = {
        ...current,
        key: input.key,
        tokenCount: Math.round(tokenCount),
        source: 'host tokenizer',
        pendingKey: '',
      };
      updateBatteryIndicator(settings);
    })
    .catch((error) => {
      console.warn('[BS BioTracker] host token count failed; using local estimate', error);
      const current = globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] || {};
      globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] = {
        ...current,
        key: input.key,
        tokenCount: estimateTokens(input.text),
        source: 'local estimate',
        pendingKey: '',
      };
      updateBatteryIndicator(settings);
    });
}

function updateBatteryIndicator(settings = null) {
  const icons = document.getElementById('bs-bt-status-icons');
  const fill = document.getElementById('bs-bt-battery-fill');
  if (!icons || !fill) return;
  const budget = Math.max(500, Math.floor(Number(settings?.trackerTokenBudget) || 4096));
  const injected = globalThis[MAINFLOW_PROMPT_TOKEN_INPUT_KEY];
  const input = {
    text: String(injected?.prompt || ''),
    key: injected?.capturedAt ? String(injected.capturedAt) : '',
  };
  const cache = globalThis[MAINFLOW_PROMPT_TOKEN_COUNT_CACHE_KEY] || {};
  const usingCachedCount = cache.key === input.key && Number.isFinite(Number(cache.tokenCount));
  const tokenCount = usingCachedCount ? Number(cache.tokenCount) : estimateTokens(input.text);
  const source = usingCachedCount ? String(cache.source || 'local estimate') : 'local estimate';
  const usageRatio = tokenCount / budget;
  const chargeRatio = Math.max(0, 1 - usageRatio);
  const width = Math.round(16 * chargeRatio);
  fill.setAttribute('width', String(width));
  icons.dataset.batteryState = usageRatio >= 1 ? 'critical' : usageRatio >= 0.75 ? 'low' : usageRatio >= 0.45 ? 'mid' : 'high';
  icons.setAttribute('aria-label', input.text
    ? `BioTracker 主流注入 ${formatTokenEstimate(tokenCount, source !== 'host tokenizer')} / ${budget.toLocaleString()} token（${source}）；仅作注意力预算警示`
    : `尚无追踪请求；注意力预算 ${budget.toLocaleString()} token`);
  icons.title = icons.getAttribute('aria-label');
  if (input.text && !usingCachedCount) queueHostTokenCount(input, settings);
}

function syncRacePhysiologyOverrides(settings) {
  setRacePhysiologyOverrides(settings?.racePhysiologyOverrides || {});
  setDerivedTypeOverrides(settings?.derivedTypeOverrides || {});
}

function setEncyclopediaSubpage(page) {
  selectedEncyclopediaSubpage = page === 'derived' ? 'derived' : 'race';
  document.querySelectorAll('#bs-bt-encyclopedia-tabs [data-encyclopedia-tab]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.encyclopediaTab === selectedEncyclopediaSubpage);
  });
  document.querySelectorAll('[data-encyclopedia-page]').forEach((node) => {
    const active = node.dataset.encyclopediaPage === selectedEncyclopediaSubpage;
    node.classList.toggle('is-active', active);
    node.hidden = !active;
  });
}

function scrollEncyclopediaToTop() {
  const view = document.getElementById('bs-bt-view-race-encyclopedia');
  const scroller = view?.closest('.bs-bt-screen-content');
  if (scroller) scroller.scrollTop = 0;
}

function getRacePhysiologyFieldStep(field) {
  if (field === 'orgasmOvulationAmount' || field === 'genderRatio') return '1';
  return '0.01';
}

function getRacePhysiologyFieldMin(field) {
  return field === 'genderRatio' ? '-1' : '0';
}

function getRacePhysiologyInputValue(race, field) {
  const override = getRacePhysiologyOverride(race);
  if (override && Object.prototype.hasOwnProperty.call(override, field)) {
    return override[field] === null ? '' : String(override[field]);
  }
  const builtin = getBuiltinRacePhysiologyProfile(race);
  if (!builtin || !Object.prototype.hasOwnProperty.call(builtin, field)) return '';
  return builtin[field] === null ? '' : String(builtin[field]);
}

function getRaceIntroductionInputValue(race) {
  return getRaceIntroductionLine(race);
}

function renderRacePhysiologyEditor(race) {
  const editorNode = document.getElementById('bs-bt-race-editor');
  const statusNode = document.getElementById('bs-bt-race-editor-status');
  if (!editorNode) return;
  editorNode.innerHTML = '';
  if (statusNode) statusNode.textContent = '物种短敘述可留空；数值只保存与内置值不同的字段；产后恢复天数由系统公式与指令流程处理。';
  if (!race) {
    editorNode.textContent = '请选择种族后编辑参数。';
    return;
  }
  const override = getRacePhysiologyOverride(race);
  const builtin = getBuiltinRacePhysiologyProfile(race);
  if (!builtin) {
    editorNode.textContent = '此种族没有内置生理资料。';
    return;
  }

  const introductionLabel = document.createElement('label');
  introductionLabel.className = 'bs-bt-race-editor-field bs-bt-race-editor-field-wide';
  introductionLabel.setAttribute('for', 'bs-bt-race-introduction-line');

  const introductionText = document.createElement('span');
  introductionText.textContent = RACE_INTRODUCTION_LABEL;
  introductionLabel.appendChild(introductionText);

  const introductionInput = document.createElement('textarea');
  introductionInput.id = 'bs-bt-race-introduction-line';
  introductionInput.className = 'text_pole bs-bt-race-introduction-input';
  introductionInput.rows = 2;
  introductionInput.dataset.raceIntroductionField = RACE_INTRODUCTION_FIELD;
  introductionInput.value = getRaceIntroductionInputValue(race);
  introductionInput.placeholder = '可留空；填入后会作为该物种的提示词短句。';
  introductionLabel.appendChild(introductionInput);

  if (override && Object.prototype.hasOwnProperty.call(override, RACE_INTRODUCTION_FIELD)) {
    const badge = document.createElement('span');
    badge.className = 'bs-bt-race-editor-badge';
    badge.textContent = '已覆盖';
    introductionLabel.appendChild(badge);
  }

  editorNode.appendChild(introductionLabel);

  for (const field of EDITABLE_RACE_PHYSIOLOGY_FIELDS) {
    const label = document.createElement('label');
    label.className = 'bs-bt-race-editor-field';
    label.setAttribute('for', `bs-bt-race-field-${field}`);

    const text = document.createElement('span');
    text.textContent = RACE_PHYSIOLOGY_FIELD_LABELS[field] || field;
    label.appendChild(text);

    const input = document.createElement('input');
    input.id = `bs-bt-race-field-${field}`;
    input.className = 'text_pole';
    input.type = 'number';
    input.step = getRacePhysiologyFieldStep(field);
    input.min = getRacePhysiologyFieldMin(field);
    if (field === 'genderRatio') input.max = '100';
    if (field === 'identicalProbability') input.max = '100';
    input.dataset.racePhysiologyField = field;
    input.value = getRacePhysiologyInputValue(race, field);
    input.placeholder = RACE_PHYSIOLOGY_FIELD_HINTS[field] || '';
    label.appendChild(input);

    if (override && Object.prototype.hasOwnProperty.call(override, field)) {
      const badge = document.createElement('span');
      badge.className = 'bs-bt-race-editor-badge';
      badge.textContent = '已覆盖';
      label.appendChild(badge);
    }

    editorNode.appendChild(label);
  }
}

function collectRacePhysiologyEditorProfile(race, { onlyDiff = false } = {}) {
  const builtin = getBuiltinRacePhysiologyProfile(race);
  if (!builtin) return null;
  const result = {};
  const introductionInput = document.querySelector(`[data-race-introduction-field="${RACE_INTRODUCTION_FIELD}"]`);
  if (introductionInput instanceof HTMLTextAreaElement) {
    const value = String(introductionInput.value || '').trim();
    const baseValue = '';
    const changed = value !== baseValue;
    if (value && (!onlyDiff || changed)) result[RACE_INTRODUCTION_FIELD] = value;
  }
  for (const field of EDITABLE_RACE_PHYSIOLOGY_FIELDS) {
    const input = document.querySelector(`[data-race-physiology-field="${field}"]`);
    if (!(input instanceof HTMLInputElement)) continue;
    let value;
    if (field === 'genderRatio' && String(input.value || '').trim() === '') value = null;
    else {
      const num = Number(input.value);
      if (!Number.isFinite(num)) continue;
      value = (field === 'orgasmOvulationAmount' || field === 'genderRatio') ? Math.round(num) : num;
    }
    const baseValue = builtin[field];
    const changed = value === null ? baseValue !== null : Math.abs(Number(value) - Number(baseValue)) > 0.0001;
    if (!onlyDiff || changed) result[field] = value;
  }
  return result;
}

function saveRacePhysiologyOverrideFromEditor(ctx, mode = 'diff') {
  if (!ctx || !selectedRaceEncyclopedia) return;
  const settings = getSettings(ctx);
  const currentOverrides = settings.racePhysiologyOverrides && typeof settings.racePhysiologyOverrides === 'object'
    ? { ...settings.racePhysiologyOverrides }
    : {};
  const profile = collectRacePhysiologyEditorProfile(selectedRaceEncyclopedia, { onlyDiff: mode === 'diff' });
  if (!profile) return;
  if (Object.keys(profile).length === 0) delete currentOverrides[selectedRaceEncyclopedia];
  else currentOverrides[selectedRaceEncyclopedia] = profile;
  settings.racePhysiologyOverrides = currentOverrides;
  syncRacePhysiologyOverrides(settings);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  racePhysiologyEditorOpen = false;
  renderRaceEncyclopediaPage(ctx);
}

function resetRacePhysiologyOverride(ctx) {
  if (!ctx || !selectedRaceEncyclopedia) return;
  const settings = getSettings(ctx);
  const currentOverrides = settings.racePhysiologyOverrides && typeof settings.racePhysiologyOverrides === 'object'
    ? { ...settings.racePhysiologyOverrides }
    : {};
  delete currentOverrides[selectedRaceEncyclopedia];
  settings.racePhysiologyOverrides = currentOverrides;
  syncRacePhysiologyOverrides(settings);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  racePhysiologyEditorOpen = false;
  renderRaceEncyclopediaPage(ctx);
}

function copyHumanPhysiologyToEditor() {
  const human = getBuiltinRacePhysiologyProfile('人类');
  if (!human) return;
  const introductionInput = document.querySelector(`[data-race-introduction-field="${RACE_INTRODUCTION_FIELD}"]`);
  if (introductionInput instanceof HTMLTextAreaElement) introductionInput.value = '';
  for (const field of EDITABLE_RACE_PHYSIOLOGY_FIELDS) {
    const input = document.querySelector(`[data-race-physiology-field="${field}"]`);
    if (!(input instanceof HTMLInputElement)) continue;
    input.value = human[field] === null ? '' : String(human[field]);
  }
}

function openRacePhysiologyEditor(ctx) {
  if (!selectedRaceEncyclopedia) return;
  racePhysiologyEditorOpen = true;
  renderRaceEncyclopediaPage(ctx);
}

function closeRacePhysiologyEditor() {
  racePhysiologyEditorOpen = false;
  const modal = document.getElementById('bs-bt-race-editor-modal');
  if (modal) modal.hidden = true;
}

function renderDerivedTypeEditor(derivedType) {
  const editor = document.getElementById('bs-bt-derived-editor');
  const builtinFlux = DERIVED_TYPE_FLUX_PROFILES[derivedType];
  const builtinInheritance = DERIVED_TYPE_INHERITANCE_PROFILES[derivedType];
  if (!editor || !builtinFlux || !builtinInheritance) return;
  const flux = getDerivedTypeFluxProfile(derivedType) || builtinFlux;
  const introductionLine = getDerivedTypeIntroductionLine(derivedType);
  const inheritance = getDerivedTypeInheritanceProfile(derivedType) || builtinInheritance;
  editor.innerHTML =
    '<label class="bs-bt-race-editor-field bs-bt-race-editor-field-wide"><span>衍生短敘述</span><textarea id="bs-bt-derived-introduction-line" class="text_pole bs-bt-race-introduction-input">' + escapeHtml(introductionLine) + '</textarea></label>' +
    '<label class="bs-bt-race-editor-field bs-bt-race-editor-field-wide"><span>Flux 描述</span><textarea id="bs-bt-derived-flux-definition" class="text_pole bs-bt-race-introduction-input">' + escapeHtml(flux.fluxDefinition || '') + '</textarea></label>' +
    '<label class="bs-bt-race-editor-field"><span>遗传速度</span><input id="bs-bt-derived-inheritance-speed" class="text_pole" type="number" min="0" step="0.01" value="' + escapeHtml(inheritance.inheritanceSpeed) + '" /></label>';
}

function collectDerivedTypeEditorOverride(derivedType) {
  const builtinFlux = DERIVED_TYPE_FLUX_PROFILES[derivedType];
  const builtinInheritance = DERIVED_TYPE_INHERITANCE_PROFILES[derivedType];
  if (!builtinFlux || !builtinInheritance) return null;
  const result = {};
  const introductionLine = String(document.getElementById('bs-bt-derived-introduction-line')?.value || '').trim();
  const fluxDefinition = String(document.getElementById('bs-bt-derived-flux-definition')?.value || '').trim();
  const speed = Number(document.getElementById('bs-bt-derived-inheritance-speed')?.value);
  if (introductionLine) result.introductionLine = introductionLine;
  if (fluxDefinition && fluxDefinition !== builtinFlux.fluxDefinition) result.fluxDefinition = fluxDefinition;
  if (Number.isFinite(speed) && speed >= 0 && Math.abs(speed - builtinInheritance.inheritanceSpeed) > 0.0001) result.inheritanceSpeed = speed;
  return result;
}

function closeDerivedTypeEditor() {
  derivedTypeEditorOpen = false;
  const modal = document.getElementById('bs-bt-derived-editor-modal');
  if (modal) modal.hidden = true;
}

function saveDerivedTypeOverrideFromEditor(ctx) {
  if (!ctx || !selectedDerivedEncyclopedia) return;
  const settings = getSettings(ctx);
  const overrides = { ...(settings.derivedTypeOverrides || {}) };
  const profile = collectDerivedTypeEditorOverride(selectedDerivedEncyclopedia);
  if (!profile) return;
  if (Object.keys(profile).length) overrides[selectedDerivedEncyclopedia] = profile;
  else delete overrides[selectedDerivedEncyclopedia];
  settings.derivedTypeOverrides = overrides;
  syncRacePhysiologyOverrides(settings);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  closeDerivedTypeEditor();
  renderRaceEncyclopediaPage(ctx);
}

function resetDerivedTypeOverride(ctx) {
  if (!ctx || !selectedDerivedEncyclopedia) return;
  const settings = getSettings(ctx);
  const overrides = { ...(settings.derivedTypeOverrides || {}) };
  delete overrides[selectedDerivedEncyclopedia];
  settings.derivedTypeOverrides = overrides;
  syncRacePhysiologyOverrides(settings);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  closeDerivedTypeEditor();
  renderRaceEncyclopediaPage(ctx);
}

function renderRaceEncyclopediaPage(ctx = null) {
  if (ctx) syncRacePhysiologyOverrides(getSettings(ctx));
  setEncyclopediaSubpage(selectedEncyclopediaSubpage);
  const countNode = document.getElementById('bs-bt-race-count');
  const selectNode = document.getElementById('bs-bt-race-select');
  const outputNode = document.getElementById('bs-bt-race-output');
  const derivedSelectNode = document.getElementById('bs-bt-derived-select');
  const derivedOutputNode = document.getElementById('bs-bt-derived-output');
  const derivedEditButton = document.getElementById('bs-bt-derived-open-editor');
  const derivedEditorModal = document.getElementById('bs-bt-derived-editor-modal');
  const derivedEditorTitle = document.getElementById('bs-bt-derived-editor-title');
  const editButton = document.getElementById('bs-bt-race-open-editor');
  const editorModal = document.getElementById('bs-bt-race-editor-modal');
  const editorTitle = document.getElementById('bs-bt-race-editor-title');
  if (!countNode || !selectNode || !outputNode || !derivedSelectNode || !derivedOutputNode) return;

  countNode.innerHTML = `内置种族数量：${RACE_ENCYCLOPEDIA_LIST.length}<br>衍生类型数量：${DERIVED_ENCYCLOPEDIA_LIST.length}`;
  if (!selectedRaceEncyclopedia || !RACE_ENCYCLOPEDIA_LIST.includes(selectedRaceEncyclopedia)) {
    selectedRaceEncyclopedia = RACE_ENCYCLOPEDIA_LIST[0] || '';
  }
  if (!selectedDerivedEncyclopedia || !DERIVED_ENCYCLOPEDIA_LIST.includes(selectedDerivedEncyclopedia)) {
    selectedDerivedEncyclopedia = DERIVED_ENCYCLOPEDIA_LIST[0] || '';
  }

  selectNode.innerHTML = '';
  for (const group of RACE_ENCYCLOPEDIA_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `${group.label} (${group.races.length})`;
    for (const race of group.races) {
      const option = document.createElement('option');
      option.value = race;
      option.textContent = race;
      option.selected = race === selectedRaceEncyclopedia;
      optgroup.appendChild(option);
    }
    selectNode.appendChild(optgroup);
  }
  derivedSelectNode.innerHTML = '';
  for (const derivedType of DERIVED_ENCYCLOPEDIA_LIST) {
    const option = document.createElement('option');
    option.value = derivedType;
    option.textContent = derivedType;
    option.selected = derivedType === selectedDerivedEncyclopedia;
    derivedSelectNode.appendChild(option);
  }

  if (!selectedRaceEncyclopedia) {
    outputNode.textContent = '暂无可显示的种族资料。';
    if (editButton) editButton.disabled = true;
    closeRacePhysiologyEditor();
  } else {
    if (editButton) {
      editButton.disabled = false;
      editButton.textContent = getRacePhysiologyOverride(selectedRaceEncyclopedia) ? '编辑覆盖' : '调整参数';
    }
    if (editorModal) editorModal.hidden = !racePhysiologyEditorOpen;
    if (editorTitle) editorTitle.textContent = `${selectedRaceEncyclopedia} 参数覆盖`;
    if (racePhysiologyEditorOpen) renderRacePhysiologyEditor(selectedRaceEncyclopedia);
    const embryoType = getEmbryoTypeByRace(selectedRaceEncyclopedia);
    const embryoText = getEmbryoTypeReferenceText(embryoType);
    const physiologyText = buildSingleRacePhysiologyText(selectedRaceEncyclopedia);
    outputNode.textContent = [physiologyText, embryoText].filter(Boolean).join('\n\n');
  }

  if (!selectedDerivedEncyclopedia) {
    derivedOutputNode.textContent = '暂无可显示的衍生资料。';
    if (derivedEditButton) derivedEditButton.disabled = true;
    closeDerivedTypeEditor();
    return;
  }

  if (derivedEditButton) {
    derivedEditButton.disabled = false;
    derivedEditButton.textContent = getDerivedTypeOverride(selectedDerivedEncyclopedia) ? '编辑覆盖' : '调整参数';
  }
  if (derivedEditorModal) derivedEditorModal.hidden = !derivedTypeEditorOpen;
  if (derivedEditorTitle) derivedEditorTitle.textContent = selectedDerivedEncyclopedia + ' 参数覆盖';
  if (derivedTypeEditorOpen) renderDerivedTypeEditor(selectedDerivedEncyclopedia);

  const fluxProfile = getDerivedTypeFluxProfile(selectedDerivedEncyclopedia);
  const introductionLine = getDerivedTypeIntroductionLine(selectedDerivedEncyclopedia);
  const fluxName = String(fluxProfile?.fluxName || '未知').trim() || '未知';
  const fluxDefinition = String(fluxProfile?.fluxDefinition || '').trim();
  const exemptions = getDerivedTypeMetabolismExemptions(selectedDerivedEncyclopedia);
  const inheritanceSpeed = Number(getDerivedTypeInheritanceProfile(selectedDerivedEncyclopedia)?.inheritanceSpeed);
  derivedOutputNode.textContent = [
    `【${selectedDerivedEncyclopedia}】`,
    ...(introductionLine ? [introductionLine] : []),
    `- Flux: ${fluxName}`,
    `- 代谢抵免: ${exemptions.length > 0 ? exemptions.join(' / ') : '无'}`,
    `- 遗传速度: ${Number.isFinite(inheritanceSpeed) ? inheritanceSpeed : '未知'}x`,
    fluxDefinition || '- 暂无额外说明。',
  ].join('\n\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatIntegerDisplay(value, fallback = '未知') {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return String(Math.round(next));
}

function formatFixedDisplay(value, digits = 1, fallback = '未知') {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return next.toFixed(digits);
}

function getTrackCardIndexKey(kind) {
  return `${selectedTrackName || ''}:${kind || ''}`;
}

function getTrackCardIndex(kind, length) {
  const key = getTrackCardIndexKey(kind);
  const maxLength = Math.max(0, Number(length) || 0);
  if (maxLength <= 0) return 0;
  const raw = Number(selectedTrackCardIndexes[key]);
  if (!Number.isInteger(raw) || raw < 0) return 0;
  return Math.min(raw, maxLength - 1);
}

function setTrackCardIndex(kind, index, length) {
  const key = getTrackCardIndexKey(kind);
  const maxLength = Math.max(0, Number(length) || 0);
  if (maxLength <= 0) {
    delete selectedTrackCardIndexes[key];
    return 0;
  }
  const next = Math.max(0, Math.min(maxLength - 1, Number(index) || 0));
  selectedTrackCardIndexes[key] = next;
  return next;
}

function formatRaceLabel(race, derivedType) {
  const cleanRace = String(race || '').trim();
  const cleanDerived = String(derivedType || '').trim();
  if (cleanDerived && cleanRace) return `[${cleanDerived}]${cleanRace}`;
  return cleanRace || cleanDerived || '未设定';
}

function getCharacterStateForDisplay(character) {
  if (!character || typeof character !== 'object') return character;
  const cloned = typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(character)
    : JSON.parse(JSON.stringify(character));
  const derivedType = String(cloned?.profile?.base?.derivedType || '').trim();
  const metabolism = cloned?.profile?.metabolism;
  if (!metabolism || typeof metabolism !== 'object') return cloned;
  if (derivedType) {
    for (const key of getDerivedTypeMetabolismExemptions(derivedType)) {
      delete metabolism[key];
    }
  } else {
    delete metabolism.flux;
  }
  return cloned;
}

function cloneJsonValue(value) {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function parseWorldbookExcludeNamesInput(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/\r?\n+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function collectWorldbookEntryNames(value) {
  const includeDisabled = Boolean(arguments[1]?.includeDisabled);
  if (!value || typeof value !== 'object') return [];

  let entryList = [];
  if (Array.isArray(value.entries)) {
    entryList = [...value.entries];
  } else if (value.entries && typeof value.entries === 'object') {
    entryList = Object.values(value.entries);
  } else if (Array.isArray(value)) {
    entryList = [...value];
  }

  // 依照 ST 的邏輯，優先使用 displayIndex，其次使用 order
  entryList.sort((a, b) => {
    if (!a || typeof a !== 'object') return 1;
    if (!b || typeof b !== 'object') return -1;
    const aOrder = typeof a.displayIndex === 'number' ? a.displayIndex : (typeof a.order === 'number' ? a.order : 0);
    const bOrder = typeof b.displayIndex === 'number' ? b.displayIndex : (typeof b.order === 'number' ? b.order : 0);
    return aOrder - bOrder;
  });

  const results = [];
  const seen = new Set();

  for (const entry of entryList) {
    if (!entry || typeof entry !== 'object') continue;
    if (!includeDisabled && (entry.enabled === false || entry.disable === true)) continue;

    // 匹配 filterTrackerWorldbookEntries 的擷取邏輯
    const name = String(entry.name || entry.comment || entry.title || entry.displayName || entry.uid || '').trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      let mode = entry.activationMode || '';
      if (!mode) {
        if (entry.constant === true || entry.always === true) mode = 'always';
        else if (entry.selective === true || (Array.isArray(entry.key) && entry.key.length > 0)) mode = 'keyword';
      }
      results.push({ name, mode });
    }
  }

  return results;
}

function getCharacterWorldbookCandidates(ctx) {
  const card = getResolvedCharacter(ctx)?.card || null;
  const baseCandidates = [
    { label: 'card.worldBook', value: card?.worldBook },
    { label: 'card.character_book', value: card?.character_book },
    { label: 'card.data.character_book', value: card?.data?.character_book },
    { label: 'bound world name', value: getCharacterWorldBookName(ctx) || null },
    { label: 'card.data.extensions.world', value: card?.data?.extensions?.world },
    { label: 'card.data.extensions.depth_prompt.worldInfo', value: card?.data?.extensions?.depth_prompt?.worldInfo },
  ];
  return baseCandidates.filter((candidate) => candidate.value !== undefined);
}

function summarizeValueShape(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'object') return `object keys: ${Object.keys(value).join(', ') || '(none)'}`;
  return typeof value;
}

function safeJsonPreview(value, maxLength = 1200) {
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text) return String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...<truncated>` : text;
  } catch {
    return String(value);
  }
}

async function getCurrentCharacterWorldbook(ctx) {
  const candidates = getCharacterWorldbookCandidates(ctx);
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    if (candidate.label === 'bound world name') {
      if (canLoadHostWorldInfo(ctx)) {
        try {
          return await loadHostWorldInfo(ctx, String(candidate.value));
        } catch (error) {
          console.warn('[BS BioTracker] getCurrentCharacterWorldbook loadWorldInfo failed', error);
        }
      }
      continue;
    }
    if (collectWorldbookEntryNames(candidate.value, { includeDisabled: true }).length === 0) continue;
    return candidate.value;
  }
  const scriptWorldBookName = await getCharacterWorldBookNameViaSTscript();
  if (scriptWorldBookName && canLoadHostWorldInfo(ctx)) {
    try {
      return await loadHostWorldInfo(ctx, String(scriptWorldBookName));
    } catch (error) {
      console.warn('[BS BioTracker] getCurrentCharacterWorldbook STscript/loadWorldInfo failed', error);
    }
  }
  try {
    return await getHostWorldBook(getCharacterWorldBookName(ctx) || scriptWorldBookName || 'Current Chat', 'character');
  } catch (error) {
    console.warn('[BS BioTracker] inspectCurrentCharacterWorldbook fallback failed', error);
  }
  return null;
}

async function getGlobalWorldbookEntries(ctx) {
  const boundWorldBookName = String(getCharacterWorldBookName(ctx) || await getCharacterWorldBookNameViaSTscript() || '').trim();
  try {
    const bookNames = (await getActiveGlobalWorldBookNames()).filter((name) => name !== boundWorldBookName);
    const books = await Promise.all(bookNames.map(async (bookName) => {
      try {
        const worldBook = await loadGlobalWorldBook(ctx, bookName);
        return collectWorldbookEntryNames(worldBook, { includeDisabled: normalizeWorldbookMode(getSettings(ctx).trackerWorldbookMode) === 'allowlist_all' })
          .map((entry) => ({ ...entry, bookName }));
      } catch (error) {
        console.warn(`[BS BioTracker] get global worldbook "${bookName}" failed`, error);
        return [];
      }
    }));
    return books.flat();
  } catch (error) {
    console.warn('[BS BioTracker] load active global worldbooks failed', error);
    return [];
  }
}

async function inspectCurrentCharacterWorldbook(ctx) {
  const worldBook = await getCurrentCharacterWorldbook(ctx);
  const globalEntries = await getGlobalWorldbookEntries(ctx);
  const settings = getSettings(ctx);
  const mode = normalizeWorldbookMode(settings.trackerWorldbookMode);
  const foundEntries = collectWorldbookEntryNames(worldBook, { includeDisabled: mode === 'allowlist_all' });
  const foundNames = foundEntries.map(e => e.name);
  const filterInputValue = document.getElementById('bs-bt-worldbook-filter-input')?.value;
  const trackedNames = filterInputValue === undefined
    ? getWorldbookFilterInputNames(ctx)
    : parseWorldbookExcludeNamesInput(filterInputValue);
  const foundSet = new Set(foundNames);
  const matched = trackedNames.filter((name) => foundSet.has(name));
  const missing = trackedNames.filter((name) => !foundSet.has(name));
  const resolvedCharacter = getResolvedCharacter(ctx);
  const characterName = String(resolvedCharacter?.card?.name || '').trim() || '当前角色';
  const characterId = ctx?.characterId;
  const resolvedCharacterId = resolvedCharacter?.id;
  const resolvedSource = resolvedCharacter?.source || 'none';
  const groupId = ctx?.groupId;
  const topLevelKeys = worldBook && typeof worldBook === 'object' && !Array.isArray(worldBook) ? Object.keys(worldBook) : [];
  const candidateLines = getCharacterWorldbookCandidates(ctx).map((candidate) => `${candidate.label}: ${summarizeValueShape(candidate.value)}`);
  const stscriptWorldBookName = await getCharacterWorldBookNameViaSTscript();
  let apiSourceSummary = '不可用';
  let apiSourcePreview = '无';
  try {
    const worldBook = await getHostWorldBook('Current Chat', 'character');
    apiSourceSummary = summarizeValueShape(worldBook);
    apiSourcePreview = safeJsonPreview(worldBook);
  } catch (error) {
    apiSourceSummary = `调用失败: ${String(error?.message || error)}`;
  }
  const lines = [
    `角色：${characterName}`,
    `characterId：${characterId === undefined ? 'undefined' : String(characterId)}`,
    `resolvedCharacterId：${resolvedCharacterId === null || resolvedCharacterId === undefined ? '无' : String(resolvedCharacterId)}`,
    `resolvedSource：${resolvedSource}`,
    `groupId：${groupId === undefined || groupId === null || groupId === '' ? '无' : String(groupId)}`,
    `loadWorldInfo：${canLoadHostWorldInfo(ctx) ? '可用' : '不可用'}`,
    `STscript(/getcharbook)：${stscriptWorldBookName || '无'}`,
    `世界书来源：${worldBook ? '已取得' : '未取得'}`,
    `找到的条目名数量：${foundNames.length}`,
    `${mode === 'allowlist_all' ? '白名单数量' : '排除名单数量'}：${trackedNames.length}`,
    `世界书顶层键：${topLevelKeys.length > 0 ? topLevelKeys.join(', ') : '无'}`,
    '',
    '[候选路径概览]',
    candidateLines.length > 0 ? candidateLines.join('\n') : '无',
    '',
    '[ST_API.worldBook.get(character) 概览]',
    apiSourceSummary,
    '',
    mode === 'allowlist_all' ? '[白名单命中]' : '[排除名单命中]',
    matched.length > 0 ? matched.join('\n') : '无',
    '',
    mode === 'allowlist_all' ? '[白名单未命中]' : '[排除名单未命中]',
    missing.length > 0 ? missing.join('\n') : '无',
    '',
    '[世界书内抓到的全部条目名]',
    foundNames.length > 0 ? foundNames.join('\n') : '未从当前角色世界书中抓到可识别的 name/title/key 条目。',
    '',
    '[ST_API.worldBook.get(character) 预览]',
    apiSourcePreview,
  ];
  return {
    entryNames: foundNames,
    foundEntries,
    foundNames,
    matched,
    missing,
    globalEntries,
  };
}

function buildRacePaletteDescriptor(state = racePaletteState) {
  const raceLabel = Array.isArray(state?.raceTags) ? state.raceTags.map((item) => String(item || '').trim()).filter(Boolean).join('x') : '';
  const derivedBase = String(state?.selectedDerivedType || '').trim();
  const derivedSubtype = String(state?.derivedSubtype || '').trim();
  const derivedType = derivedBase ? `${derivedBase}${derivedSubtype ? `-${derivedSubtype}` : ''}` : '';
  if (derivedType && raceLabel) return `[${derivedType}]${raceLabel}`;
  return raceLabel || (derivedType ? `[${derivedType}]` : '');
}

function isRegisterRaceTarget(targetInputId = '') {
  return String(targetInputId || '') === 'bs-bt-register-race';
}

function renderRacePaletteSelect(selectId, currentValue, includeEmpty = false) {
  const options = [];
  if (includeEmpty) options.push('<option value="">不设</option>');
  for (const group of RACE_PALETTE_GROUPS) {
    const groupOptions = group.races.map((race) => `<option value="${escapeHtml(race)}"${race === currentValue ? ' selected' : ''}>${escapeHtml(race)}</option>`).join('');
    options.push(`<optgroup label="${escapeHtml(`${group.label} (${group.races.length})`)}">${groupOptions}</optgroup>`);
  }
  return `<select id="${selectId}">${options.join('')}</select>`;
}

function renderRacePaletteBody() {
  const isRegister = isRegisterRaceTarget(racePaletteState.targetInputId);
  const derivedOptions = [`<option value="">不设</option>`, ...DERIVED_TYPE_RACES.map((value) => `<option value="${escapeHtml(value)}"${racePaletteState.selectedDerivedType === value ? ' selected' : ''}>${escapeHtml(value)}</option>`)];
  const raceTags = Array.isArray(racePaletteState.raceTags) && racePaletteState.raceTags.length > 0
    ? racePaletteState.raceTags.map((entry, index) => `
        <button type="button" class="bs-bt-race-tag" data-race-remove-index="${index}" title="移除此项">
          <span>${escapeHtml(entry)}</span>
          <span aria-hidden="true">×</span>
        </button>
      `).join('')
    : `<div class="bs-bt-race-preview-hint">${isRegister ? '尚未加入角色种族 tag。' : '尚未加入这位父亲的种族 tag。'}</div>`;
  return `
    <div class="bs-bt-race-palette">
      <div class="bs-bt-race-palette-head">
        <div class="bs-bt-race-palette-title">${isRegister ? '角色种族调色盘' : '父源调色盘'}</div>
        <button type="button" class="bs-bt-race-close-button" data-race-action="cancel" aria-label="关闭调色盘" title="关闭调色盘">×</button>
      </div>
      <div class="bs-bt-race-preview-hint">${isRegister ? '先把角色种族逐个加入 tag，衍生型会套在整体种族上；确认后会直接写入注册种族并关闭。' : '先把种族逐个加入 tag，衍生型会套在整位父亲上；确认后会直接写入父亲种族并关闭。'}</div>
      <div class="bs-bt-race-tag-list">${raceTags}</div>
      <label class="bs-bt-track-debug-field">
        <span class="bs-bt-track-debug-label">衍生型</span>
        <select id="bs-bt-race-derived">${derivedOptions.join('')}</select>
      </label>
      <label class="bs-bt-track-debug-field">
        <span class="bs-bt-track-debug-label">衍生子项(自定义)</span>
        <input id="bs-bt-race-derived-subtype" class="text_pole" type="text" value="${escapeHtml(racePaletteState.derivedSubtype || '')}" placeholder="例如：魔女、僵尸" />
      </label>
      <label class="bs-bt-track-debug-field">
        <span class="bs-bt-track-debug-label">种族</span>
        ${renderRacePaletteSelect('bs-bt-race-primary', racePaletteState.selectedRace || '人类')}
      </label>
      <label class="bs-bt-track-debug-field">
        <span class="bs-bt-track-debug-label">子项(自定义)</span>
        <input id="bs-bt-race-subtype" class="text_pole" type="text" value="${escapeHtml(racePaletteState.subtype || '')}" placeholder="例如：鼠族、炎裔" />
      </label>
      <div class="bs-bt-race-actions">
        <button type="button" class="menu_button" data-race-action="append">加入种族 tag</button>
        <button type="button" class="menu_button" data-race-action="confirm">确认</button>
      </div>
    </div>
  `;
}

function isPregnantStage(stage) {
  return ['已着床', ...PREGNANCY_STAGES, '产兆前驱', ...LABOR_STAGES].includes(String(stage || ''));
}

function getStageProgress(profile) {
  const base = profile?.base || {};
  const pregnant = profile?.pregnant || {};
  const stage = String(base.stage || '').trim();
  if (!stage) return null;
  if (LABOR_STAGES.includes(stage)) {
    if (stage === '第一产程') {
      const phase = String(pregnant.laborPhase || '潜伏期');
      const max = getLaborStageThreshold(profile, stage, { fullStage: true }) || 12;
      const phaseOffset = phase === '过渡期'
        ? max * 0.85
        : phase === '活跃期'
          ? max * 0.5
          : 0;
      return {
        label: '产程进度',
        value: phaseOffset + (Number(pregnant.effectiveLaborHours) || 0),
        max,
        unit: 'h',
        integerDisplay: true,
      };
    }
    if (stage === '第三产程') {
      const phase = String(pregnant.laborPhase || '供养器官娩出');
      const organHours = getLaborStageThreshold(profile, stage, { phase: '供养器官娩出' }) || 0.5;
      const observationHours = getLaborStageThreshold(profile, stage, { phase: '产后观察' }) || LABOR_POSTPARTUM_OBSERVATION_HOURS;
      return {
        label: '产程进度',
        value: (phase === '产后观察' ? organHours : 0) + (Number(pregnant.effectiveLaborHours) || 0),
        max: organHours + observationHours,
        unit: 'h',
        integerDisplay: true,
      };
    }
    return {
      label: '产程进度',
      value: Number(pregnant.effectiveLaborHours) || 0,
      max: getLaborStageThreshold(profile, stage) || (stage === '第一产程' ? 12 : stage === '第二产程' ? 2 : 1),
      unit: 'h',
      integerDisplay: true,
    };
  }
  if (stage === '产兆前驱') {
    const max = 48 * Math.max(0.1, Math.min(100, Number(profile?.bio?.birthDifficulty) || 1));
    const remaining = Math.max(0, Number(pregnant.prodromalRemainingHours) || 0);
    return { label: '前驱进展', value: Math.max(0, max - remaining), max, unit: 'h', integerDisplay: true };
  }
  if (Object.prototype.hasOwnProperty.call(PREGNANCY_STAGE_DAYS, stage)) {
    return {
      label: '阶段进度',
      value: Number(base.days) || 0,
      max: PREGNANCY_STAGE_DAYS[stage],
      unit: 'd',
      displayStartAtOne: true,
    };
  }
  if (stage === '逾期') {
    return { label: '阶段进度', value: Number(base.days) || 0, unbounded: true, unit: 'd', displayStartAtOne: true };
  }
  if (Object.prototype.hasOwnProperty.call(MENSTRUAL_STAGE_DAYS, stage)) {
    const ratio = Math.max(0.1, Math.min(20, Number(profile?.bio?.menstrualLengthRatio) || 1));
    return {
      label: '阶段进度',
      value: Number(base.days) || 0,
      max: Math.max(1, MENSTRUAL_STAGE_DAYS[stage] * ratio),
      unit: 'd',
      displayStartAtOne: true,
    };
  }
  return { label: '阶段进度', value: Number(base.days) || 0, max: 1, unit: 'd', displayStartAtOne: true };
}

function wrapLaborAngle(angle) {
  const normalized = Number(angle);
  if (!Number.isFinite(normalized)) return 0;
  return ((normalized % 360) + 360) % 360;
}

function getLaborPositionDifficulty(angle, fetus) {
  const normalized = wrapLaborAngle(angle);
  const embryoType = String(fetus?.embryoType || '胎生');

  if (embryoType === '胎转卵生') {
    const targetAngles = [0, 90, 180, 270, 360];
    let minDistance = 360;
    for (const targetAngle of targetAngles) {
      let distance = Math.abs(normalized - targetAngle);
      if (targetAngle === 360) distance = Math.min(distance, Math.abs(normalized - 0));
      if (distance < minDistance) minDistance = distance;
    }
    if (minDistance <= 5) return 1.5;
    return Math.min(2.25, 1.5 + ((minDistance - 5) * 0.075));
  }

  if (embryoType === '不定型') {
    const race = String(fetus?.race || '人类');
    const combinedSeed = Math.round(normalized * 1000) + race.charCodeAt(0) + race.charCodeAt(Math.max(0, race.length - 1));
    const seededValue = ((combinedSeed * 1664525 + 1013904223) % 2147483648) / 2147483648;
    return 1.0 + seededValue;
  }

  if (embryoType === '卵胎生') {
    if ((normalized >= 0 && normalized <= 5) || (normalized >= 355 && normalized <= 360)) return 1.0;
    if ((normalized >= 0 && normalized <= 15) || (normalized >= 345 && normalized <= 360)) return 1.25;
    if (normalized >= 175 && normalized <= 185) return 1.5;
    if (normalized >= 165 && normalized <= 195) return 1.75;
    if ((normalized >= 85 && normalized <= 95) || (normalized >= 275 && normalized <= 285)) return 2.0;
    if ((normalized >= 75 && normalized <= 105) || (normalized >= 265 && normalized <= 285)) return 2.25;
    return 1.33;
  }

  if (embryoType === '卵生') {
    if ((normalized >= 0 && normalized <= 15) || (normalized >= 345 && normalized <= 360)) return 1.0;
    if (normalized >= 165 && normalized <= 195) return 1.0;
    if ((normalized >= 75 && normalized <= 105) || (normalized >= 265 && normalized <= 285)) return 1.5;
    return 1.33;
  }

  if ((normalized >= 0 && normalized <= 15) || (normalized >= 345 && normalized <= 360)) return 1.0;
  if (normalized >= 165 && normalized <= 195) return 1.5;
  if ((normalized >= 75 && normalized <= 105) || (normalized >= 265 && normalized <= 285)) return 2.0;
  return 1.33;
}

function getLaborStageThreshold(profile, stage, options = {}) {
  if (!LABOR_STAGES.includes(stage)) return null;
  const pregnant = profile?.pregnant || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  const phase = String(options.phase || pregnant.laborPhase || '');
  const birthDifficulty = Math.max(0.1, Math.min(100, Number(profile?.bio?.birthDifficulty) || 1));
  const safeCount = Math.max(1, fetuses.length);
  const baseHours = Number(LABOR_STAGE_BASE_HOURS[stage]) || 0;
  const increment = Number(LABOR_STAGE_INCREMENT[stage]) || 0;
  let threshold = (baseHours + ((safeCount - 1) * increment)) * birthDifficulty;

  if (stage === '第一产程') {
    const naturalBirthCount = Math.min(
      FIRST_STAGE_NATURAL_BIRTH_EXPERIENCE.maxCount,
      Math.floor(Math.max(0, Number(profile?.experience?.naturalBirthExperience) || 0)),
    );
    threshold *= Math.max(
      FIRST_STAGE_NATURAL_BIRTH_EXPERIENCE.minMultiplier,
      1 - (naturalBirthCount * FIRST_STAGE_NATURAL_BIRTH_EXPERIENCE.reductionPerBirth),
    );
    if (options.fullStage) return Math.max(0.1, threshold);
    if (phase === '潜伏期') threshold *= 0.5;
    else if (phase === '活跃期') threshold *= 0.35;
    else if (phase === '过渡期') threshold *= 0.15;
  }
  if (stage === '第二产程' && fetuses.length > 0) {
    if (phase === '间歇期') return Math.max(0.5, birthDifficulty * 0.5);
    const firstFetus = fetuses[0];
    const fetalAngle = Number.isFinite(Number(firstFetus?.tendencyAngle)) ? wrapLaborAngle(firstFetus.tendencyAngle) : 0;
    const positionDifficulty = getLaborPositionDifficulty(fetalAngle, firstFetus);
    const fetalWeight = Math.max(0.33, Math.min(3.0, Number(firstFetus?.weight) || 1.0));
    threshold = ((Number(LABOR_STAGE_BASE_HOURS['第二产程']) || 0) * birthDifficulty) * positionDifficulty * fetalWeight;
    threshold *= phase === '胎体娩出' ? 0.4 : 0.6;
  }
  if (stage === '第三产程') {
    threshold = phase === '产后观察'
      ? Math.max(LABOR_POSTPARTUM_OBSERVATION_HOURS, birthDifficulty * LABOR_POSTPARTUM_OBSERVATION_HOURS)
      : Math.max(0.5, (Number(LABOR_STAGE_BASE_HOURS['第三产程']) || 0) * birthDifficulty);
  }

  return Math.max(0.1, threshold);
}

function getLibidoCap(stage, profile = null) {
  const isTruePregnancy = ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产兆前驱', '第一产程', '第二产程', '第三产程'].includes(stage);
  if (isTruePregnancy && profile) {
    const effectivePregnantDays = Number(profile.pregnant?.effectivePregnantDays) || 0;
    const months = Math.floor(effectivePregnantDays / 28);
    const progress = Math.max(0, Math.min(10, months)) / 10;
    return Math.round(100 + (150 - 100) * progress);
  }
  return 100;
}

function getUterinePressureCap(stage, profile = null) {
  const isTruePregnancy = ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产兆前驱', '第一产程', '第二产程', '第三产程'].includes(stage);
  if (isTruePregnancy && profile) {
    const effectivePregnantDays = Number(profile.pregnant?.effectivePregnantDays) || 0;
    const months = Math.floor(effectivePregnantDays / 28);
    const progress = Math.max(0, Math.min(10, months)) / 10;
    return Math.round(50 + (150 - 50) * progress);
  }
  return 50;
}

function getMetabolismLevel(value, cap = 150) {
  const next = Number(value) || 0;
  const scale = Math.max(1, Number(cap) || 150) / 150;
  if (next >= 125 * scale) return '爆';
  if (next >= 100 * scale) return '满';
  if (next >= 75 * scale) return '高';
  if (next >= 50 * scale) return '中';
  if (next >= 25 * scale) return '低';
  return '无';
}

function getDerivedFluxSummary(value, cap = 150) {
  const next = Number(value) || 0;
  const abs = Math.abs(next);
  const scale = Math.max(1, Number(cap) || 150) / 150;
  const polarity = next >= 0 ? '正极' : '负极';
  let stage = '平衡';
  let description = '需求接近平衡，暂时没有明显偏向。';

  if (abs >= 125 * scale) {
    stage = `${polarity}爆发`;
    description = `需求已严重偏向${polarity}，应尽快解放，否则容易压过理智与自控。`;
  } else if (abs >= 100 * scale) {
    stage = `${polarity}饱和`;
    description = `需求已高度集中于${polarity}，再继续累积就会逼近失衡边缘。`;
  } else if (abs >= 75 * scale) {
    stage = `${polarity}高涨`;
    description = `需求明显偏向${polarity}，已进入需要认真处理的危险区。`;
  } else if (abs >= 50 * scale) {
    stage = `${polarity}活跃`;
    description = `需求正稳定向${polarity}偏移，已经能感受到持续牵引。`;
  } else if (abs >= 25 * scale) {
    stage = `${polarity}浮动`;
    description = `需求轻度偏向${polarity}，目前仍属于可控范围。`;
  }

  return `${stage} (${Math.round(next)})：${description}`;
}

const METABOLISM_NEED_LABELS = Object.freeze({
  excretion: '泄意',
  hunger: '饿意',
  sleep: '困意',
  milk: '乳意',
  odor: '臭意',
  companionship: '伴意',
  flux: '极需',
});

const DEBUG_BLOCKAGE_LABELS = Object.freeze({
  excretion: '泄意',
  hunger: '饿意',
  sleep: '困意',
  milk: '乳意',
  odor: '臭意',
  companionship: '伴意',
  fluxPositive: '极需正极',
  fluxNegative: '极需负极',
});

const DEBUG_BLOCKAGE_DEFAULT_SEVERITY = Object.freeze({
  excretion: 0.70,
  hunger: 0.55,
  sleep: 0.55,
  milk: 0.55,
  odor: 0.45,
  companionship: 0.55,
  fluxPositive: 0.65,
  fluxNegative: 0.65,
});

function clampUiNumber(value, min, max, fallback = 0) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function normalizeMetabolismNeed(key, metabolism = {}, blockage = null, acceleration = null, expansion = null) {
  const expansionKey = String(expansion?.key || '');
  const rawValue = Number(metabolism[key]) || 0;
  const expanded = key === 'flux'
    ? (rawValue > 0 && expansionKey === 'fluxPositive') || (rawValue < 0 && expansionKey === 'fluxNegative')
    : expansionKey === key;
  const cap = expanded ? 200 : 150;
  const value = key === 'flux'
    ? clampUiNumber(metabolism[key], -cap, cap, 0)
    : clampUiNumber(metabolism[key], 0, cap, 0);
  const blockageKey = String(blockage?.key || '');
  const accelerationKey = String(acceleration?.key || '');
  const blocked = key === 'flux'
    ? (value > 0 && blockageKey === 'fluxPositive') || (value < 0 && blockageKey === 'fluxNegative')
    : blockageKey === key;
  const accelerated = key === 'flux'
    ? (value > 0 && accelerationKey === 'fluxPositive') || (value < 0 && accelerationKey === 'fluxNegative')
    : accelerationKey === key;
  return {
    key,
    label: METABOLISM_NEED_LABELS[key] || key,
    value,
    cap,
    level: key === 'flux' ? getDerivedFluxSummary(value, cap) : getMetabolismLevel(value, cap),
    blocked,
    blockageSeverity: blocked ? clampUiNumber(blockage?.severity, 0, 1, 0) : 0,
    accelerated,
    accelerationSeverity: accelerated ? clampUiNumber(acceleration?.severity, 0, 1, 0) : 0,
    expanded,
  };
}

function getMetabolismSummary(metabolism = {}, immune = {}, derivedType = null, blockage = null, acceleration = null, expansion = null) {
  if (immune?.metabolism) return '代谢免疫';
  if (derivedType) {
    const exemptions = new Set(getDerivedTypeMetabolismExemptions(derivedType));
    const visible = (key) => (exemptions.has(key) ? null : normalizeMetabolismNeed(key, metabolism, blockage, acceleration, expansion));
    return {
      flux: normalizeMetabolismNeed('flux', metabolism, blockage, acceleration, expansion),
      hunger: visible('hunger'),
      sleep: visible('sleep'),
      excretion: visible('excretion'),
      milk: visible('milk'),
      odor: visible('odor'),
      companionship: visible('companionship'),
      derived: true,
    };
  }
  return {
    hunger: normalizeMetabolismNeed('hunger', metabolism, blockage, acceleration, expansion),
    sleep: normalizeMetabolismNeed('sleep', metabolism, blockage, acceleration, expansion),
    excretion: normalizeMetabolismNeed('excretion', metabolism, blockage, acceleration, expansion),
    milk: normalizeMetabolismNeed('milk', metabolism, blockage, acceleration, expansion),
    odor: normalizeMetabolismNeed('odor', metabolism, blockage, acceleration, expansion),
    companionship: normalizeMetabolismNeed('companionship', metabolism, blockage, acceleration, expansion),
  };
}

const METABOLISM_DISPLAY_ORDER = Object.freeze(['excretion', 'hunger', 'sleep', 'milk', 'odor', 'companionship']);

function getMetabolismNeedItems(summary) {
  if (!summary || typeof summary !== 'object') return [];
  const items = summary.derived ? [summary.flux] : [];
  for (const key of METABOLISM_DISPLAY_ORDER) {
    if (summary[key]) items.push(summary[key]);
  }
  return items.filter(Boolean);
}

function renderMetabolismNeedIcon(item) {
  const key = String(item?.key || '');
  const value = Number(item?.value) || 0;
  const cap = Number(item?.cap) === 200 ? 200 : 150;
  const fillValue = key === 'flux' ? Math.abs(value) : value;
  const fill = key === 'flux'
    ? Math.max(0, Math.min(100, (fillValue / cap) * 100))
    : Math.max(0, Math.min(100, (fillValue / 100) * 100));
  const overfill = key === 'flux'
    ? 0
    : Math.max(0, Math.min(100, ((fillValue - 100) / (cap - 100)) * 100));
  const tone = key === 'flux'
    ? value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'
    : value >= 100 ? 'high' : 'normal';
  const title = `${item.label}: ${item.level}${key === 'flux' ? '' : ` (${Math.round(value)})`}${item.blocked ? `；阻塞 ${Math.round((item.blockageSeverity || 0) * 100)}%` : ''}${item.accelerated ? `；快积 ${Math.round((item.accelerationSeverity || 0) * 100)}%` : ''}${item.expanded ? '；扩容至 200' : ''}`;
  const displayValue = key === 'flux'
    ? (value > 0 ? '正极' : value < 0 ? '负极' : '平衡')
    : String(Math.round(value));
  return `
    <div class="bs-bt-need-tile bs-bt-need-tile--${escapeHtml(key)} bs-bt-need-tile--${tone}${item.blocked ? ' is-blocked' : ''}${item.accelerated ? ' is-accelerated' : ''}${item.expanded ? ' is-expanded' : ''}" aria-label="${escapeHtml(title)}">
      ${item.blocked ? '<span class="bs-bt-need-blockage" aria-hidden="true"></span>' : ''}
      ${item.accelerated ? '<span class="bs-bt-need-acceleration" aria-hidden="true"></span>' : ''}
      ${item.expanded ? '<span class="bs-bt-need-expansion" aria-hidden="true"></span>' : ''}
      <span class="bs-bt-need-icon-wrap" style="--bs-bt-need-fill: ${fill.toFixed(1)}%; --bs-bt-need-overfill: ${overfill.toFixed(1)}%;">
        <span class="bs-bt-need-icon bs-bt-need-icon--${escapeHtml(key)} bs-bt-need-icon-base" aria-hidden="true"></span>
        <span class="bs-bt-need-icon-fill" aria-hidden="true">
          <span class="bs-bt-need-icon bs-bt-need-icon--${escapeHtml(key)}"></span>
        </span>
        ${key === 'flux' ? '' : `<span class="bs-bt-need-icon-overfill" aria-hidden="true">
          <span class="bs-bt-need-icon bs-bt-need-icon--${escapeHtml(key)}"></span>
        </span>`}
      </span>
      <span class="bs-bt-need-label">${escapeHtml(item.label)}</span>
      <span class="bs-bt-need-value">${escapeHtml(displayValue)}</span>
    </div>
  `;
}

function renderMetabolismSummary(summary) {
  if (typeof summary === 'string') return `<div>${escapeHtml(summary)}</div>`;
  const items = getMetabolismNeedItems(summary);
  return `<div class="bs-bt-track-metabolism-grid${summary?.derived ? ' is-derived' : ''}">${items.map(renderMetabolismNeedIcon).join('')}</div>`;
}

function parseDescriptionBlocks(text) {
  if (!text || !String(text).trim()) return [];
  const fields = String(text).split(';;');
  return fields
    .map((field) => {
      const trimmed = field.trim();
      if (!trimmed) return null;
      const parts = trimmed.split('|');
      if (parts.length >= 2) {
        return {
          title: parts[0].trim(),
          content: parts.slice(1).join('|').trim(),
        };
      }
      return null;
    })
    .filter((item) => item !== null);
}

function getDescriptionFieldContent(text, preferredNames = [], options = {}) {
  const preferred = new Set(preferredNames.map((name) => String(name || '').trim()).filter(Boolean));
  const blocks = parseDescriptionBlocks(text);
  if (preferred.size > 0) {
    const matched = blocks.find((block) => preferred.has(block.title));
    if (matched) return matched.content;
    if (options.fallback === false) return '';
  }
  return blocks.length > 0 ? blocks[0].content : String(text || '').trim();
}

function upsertDescriptionField(text, fieldName, content, aliases = []) {
  const nextContent = String(content || '').replace(/\s+/g, ' ').trim();
  if (!nextContent) return String(text || '').trim();
  const targetName = String(fieldName || '').trim();
  const aliasSet = new Set([targetName, ...aliases].map((name) => String(name || '').trim()).filter(Boolean));
  const blocks = parseDescriptionBlocks(text);
  if (blocks.length === 0) return targetName + '|' + nextContent + ';;';
  let replaced = false;
  const nextBlocks = blocks.map((block) => {
    if (aliasSet.has(block.title)) {
      replaced = true;
      return { title: targetName, content: nextContent };
    }
    return block;
  });
  if (!replaced) nextBlocks.push({ title: targetName, content: nextContent });
  return nextBlocks.map((block) => block.title + '|' + block.content + ';;').join('');
}

function getWardrobePrepOutfitDescription(parsed = {}) {
  const sources = [
    parsed?.outfitDescription,
    parsed?.wearDescription,
    parsed?.descriptions?.normalDescription,
    parsed?.normalDescription,
  ];
  for (const source of sources) {
    const text = String(source || '').trim();
    if (!text) continue;
    return getDescriptionFieldContent(text, ['衣着动态', '衣着動態', '衣著动态', '衣著動態', '衣着', '衣著', '当前衣着', '當前衣著']);
  }
  return '';
}

function getWardrobePrepOutfitSelfView(parsed = {}) {
  const directSources = [parsed?.outfitSelfView, parsed?.wearSelfView, parsed?.selfView];
  for (const source of directSources) {
    const text = String(source || '').trim();
    if (!text) continue;
    return getDescriptionFieldContent(text, ['衣着自评', '衣著自評', '衣着自評', '衣著自评', '服装自评', '服裝自評']);
  }
  const descriptionSources = [parsed?.descriptions?.normalDescription, parsed?.normalDescription];
  for (const source of descriptionSources) {
    const text = String(source || '').trim();
    if (!text) continue;
    const matched = getDescriptionFieldContent(text, ['衣着自评', '衣著自評', '衣着自評', '衣著自评', '服装自评', '服裝自評'], { fallback: false });
    if (matched) return matched;
  }
  return '';
}

function getWardrobePrepCurrentItems(items = [], outfit = {}) {
  const temporaryItems = Array.isArray(outfit?.temporaryItems) ? outfit.temporaryItems : [];
  const availableItems = [...items, ...temporaryItems]
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ ...item, id: Number(item.id) }));
  const mainItemId = Number.isInteger(Number(outfit?.mainItemId)) ? Number(outfit.mainItemId) : 0;
  const main = mainItemId === 0
    ? { id: 0, name: '全裸', slot: 'main' }
    : availableItems.find((item) => item.id === mainItemId && String(item.slot || 'main') === 'main');
  const accessoryIds = Array.isArray(outfit?.accessoryItemIds) ? outfit.accessoryItemIds.map((id) => Number(id)) : [];
  const accessories = accessoryIds
    .map((id) => availableItems.find((item) => item.id === id && String(item.slot || '') === 'accessory'))
    .filter(Boolean);
  return { main, accessories };
}

function buildWardrobePrepFallbackOutfitDescription(items = [], outfit = {}) {
  const current = getWardrobePrepCurrentItems(items, outfit);
  const mainName = String(current.main?.name || '全裸').trim();
  const accessoryNames = current.accessories.map((item) => String(item.name || '').trim()).filter(Boolean);
  const accessoryText = accessoryNames.length > 0 ? `，搭配${accessoryNames.join('、')}` : '';
  return `当前以${mainName}作为主件${accessoryText}，遮掩、支撑、容身与便捷表现按衣物四维参与叙事。`;
}

function buildWardrobePrepFallbackOutfitSelfView(items = [], outfit = {}) {
  const current = getWardrobePrepCurrentItems(items, outfit);
  const mainName = String(current.main?.name || '全裸').trim();
  return `角色暂以${mainName}判断自己的当前穿着与遮掩效果；若合身程度变化，后续叙事会据孕期衣着压力更新感受。`;
}

function getPsychologyView(profile = {}) {
  const preg = profile?.psychology?.preg || {};
  const mens = profile?.psychology?.mens || {};
  const stage = String(profile?.base?.stage || '');
  if (isPregnantStage(stage)) {
    return {
      title: '繁育心理',
      items: [
        { label: '察觉', value: preg.cognition_value ?? 0, prompt: preg.cognition_interpret || '' },
        { label: '依附', value: preg.bonding_value ?? 0, prompt: preg.bonding_interpret || '' },
        { label: '导向', value: preg.stance_value ?? 0, prompt: preg.stance_interpret || '' },
      ],
      flags: [
        { label: '知晓父源', active: Boolean(preg.knowsFatherSource) },
        { label: '专业产检', active: Boolean(preg.hasProfessionalPrenatalCare) },
      ],
    };
  }
  return {
    title: '繁育心理',
    items: [
      { label: '掌控', value: mens.mastery_value ?? 0, prompt: mens.mastery_interpret || '' },
      { label: '欲望', value: mens.desire_value ?? 0, prompt: mens.desire_interpret || '' },
      { label: '自主', value: mens.autonomy_value ?? 0, prompt: mens.autonomy_interpret || '' },
    ],
    flags: [
      { label: '贞洁/单伴侣', active: Boolean(mens.isChaste) },
      { label: '避孕措施', active: Boolean(mens.hasContraception) },
    ],
  };
}

function hasBreedingPsychologyProfile(profile = {}) {
  const stageProfiles = profile?.psychology?.stageProfiles;
  return Boolean(stageProfiles && typeof stageProfiles === 'object' && !Array.isArray(stageProfiles)
    && Object.keys(stageProfiles).length > 0);
}

function buildRadarSvg(items) {
  const cx = 90;
  const cy = 88;
  const radius = 58;
  const points = items.map((item, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / items.length;
    const ratio = Math.max(0, Math.min(100, Number(item.value) || 0)) / 100;
    return {
      ...item,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      px: cx + Math.cos(angle) * radius * ratio,
      py: cy + Math.sin(angle) * radius * ratio,
      lx: cx + Math.cos(angle) * (radius + 18),
      ly: cy + Math.sin(angle) * (radius + 18),
    };
  });
  const frame = points.map((item) => `${item.x},${item.y}`).join(' ');
  const valuePolygon = points.map((item) => `${item.px},${item.py}`).join(' ');
  const labels = points
    .map(
      (item) =>
        `<text x="${item.lx}" y="${item.ly}" text-anchor="middle" dominant-baseline="middle" font-size="11">${escapeHtml(item.label)} ${Math.round(
          Number(item.value) || 0,
        )}</text>`,
    )
    .join('');
  const axes = points.map((item) => `<line x1="${cx}" y1="${cy}" x2="${item.x}" y2="${item.y}" stroke="currentColor" opacity="0.25" />`).join('');
  return `<svg class="bs-bt-track-radar" viewBox="0 0 180 180" aria-label="psychology radar">
    <polygon points="${frame}" fill="none" stroke="currentColor" opacity="0.35" />
    ${axes}
    <polygon points="${valuePolygon}" fill="currentColor" opacity="0.25" stroke="currentColor" />
    <circle cx="${cx}" cy="${cy}" r="2.5" fill="currentColor" />
    ${labels}
  </svg>`;
}

function renderPsychologyPrompts(items) {
  const prompts = (Array.isArray(items) ? items : [])
    .map((item) => ({
      label: String(item?.label || '').trim(),
      value: item?.value,
      prompt: String(item?.prompt || '').trim(),
    }))
    .filter((item) => item.prompt);
  if (prompts.length === 0) {
    return '<div class="bs-bt-track-description-empty bs-bt-track-psych-prompt-empty">暂无阶段提示</div>';
  }
  return `
    <div class="bs-bt-track-psych-prompts">
      ${prompts
    .map(
      (item) => `
        <div class="bs-bt-track-psych-prompt">
          <div class="bs-bt-track-description-title">${escapeHtml(item.label)} · ${escapeHtml(formatIntegerDisplay(item.value))}</div>
          <div>${escapeHtml(item.prompt)}</div>
        </div>
      `,
    )
    .join('')}
    </div>
  `;
}

function getWardrobeItems(profile = {}) {
  return Array.isArray(profile?.wardrobe?.items) ? profile.wardrobe.items : [];
}

function getTemporaryOutfitItems(profile = {}) {
  return Array.isArray(profile?.outfit?.temporaryItems) ? profile.outfit.temporaryItems : [];
}

function getOutfitViewItems(profile = {}) {
  return [...getWardrobeItems(profile), ...getTemporaryOutfitItems(profile).map((item) => ({ ...item, source: 'temporary' }))];
}

function findWardrobeViewItem(profile = {}, itemId = '', slot = '') {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id < 0) return null;
  return getWardrobeItems(profile).find((item) => Number(item?.id) === id && (!slot || item?.slot === slot)) || null;
}

function findOutfitViewItem(profile = {}, itemId = '', slot = '') {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id < 0) return null;
  return getOutfitViewItems(profile).find((item) => Number(item?.id) === id && (!slot || item?.slot === slot)) || null;
}

function formatWardrobeMetricValue(value, signed = false) {
  const number = Number.isFinite(Number(value)) ? Number(value) : 0;
  const text = formatIntegerDisplay(number);
  return signed && number > 0 ? '+' + text : text;
}

function renderWardrobeMetricMap(values = {}, labels = WARDROBE_DIMENSION_LABELS, options = {}) {
  return '<div class="bs-bt-wardrobe-metrics">' + Object.entries(labels).map(([key, label]) => {
    const value = Number.isFinite(Number(values?.[key])) ? Number(values[key]) : 0;
    return '<div class="bs-bt-wardrobe-metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(formatWardrobeMetricValue(value, options.signed)) + '</strong></div>';
  }).join('') + '</div>';
}

function getWardrobeItemKind(item = {}) {
  return item.slot === 'accessory' ? '配件' : '主件';
}

function renderWardrobeItemRow(item = {}, options = {}) {
  return `
    <button class="bs-bt-wardrobe-row${options.current ? ' is-current' : ''}" type="button" data-wardrobe-item-id="${escapeHtml(item.id)}">
      <span class="bs-bt-wardrobe-row-main">
        <span class="bs-bt-wardrobe-row-title">${escapeHtml(item.name || item.id || '未命名')}</span>
        ${item.note ? `<span class="bs-bt-wardrobe-row-note">${escapeHtml(item.note)}</span>` : ''}
      </span>
    </button>
  `;
}

function buildOutfitView(profile = {}) {
  if (profile?.wardrobe?.enabled !== true) return { enabled: false, main: null, accessories: [], pregFit: null };
  const outfit = profile?.outfit && typeof profile.outfit === 'object' ? profile.outfit : {};
  const main = findOutfitViewItem(profile, outfit.mainItemId, 'main') || findWardrobeViewItem(profile, 0, 'main') || { id: 0, name: '全裸', note: '未着衣物。', slot: 'main' };
  const accessories = Array.isArray(outfit.accessoryItemIds)
    ? outfit.accessoryItemIds.map((id) => findOutfitViewItem(profile, id, 'accessory')).filter(Boolean)
    : [];
  return { enabled: true, main, accessories, pregFit: outfit.pregFit || null };
}

function getOutfitSummary(outfit = {}) {
  if (!outfit.enabled) return '尚未备装';
  const names = [outfit.main?.name || '全裸', ...(outfit.accessories || []).map((item) => item.name || item.id)].filter(Boolean);
  return names.length > 0 ? names.join(' + ') : '无';
}

function getDescriptionBlockByNames(blocks = [], names = []) {
  const nameSet = new Set(names.map((name) => String(name || '').trim()).filter(Boolean));
  return (Array.isArray(blocks) ? blocks : []).find((block) => nameSet.has(String(block?.title || '').trim())) || null;
}

function isWardrobeDescriptionBlock(block = {}) {
  return new Set([
    '衣着动态', '衣着動態', '衣著动态', '衣著動態',
    '衣着自评', '衣著自評', '衣着自評', '衣著自评',
    '衣着', '衣著', '当前衣着', '當前衣著', '服装自评', '服裝自評',
  ]).has(String(block?.title || '').trim());
}

function renderWardrobeDescriptionSection(viewModel = {}) {
  const outfitView = viewModel.outfit || {};
  const blocks = viewModel.description?.normalBlocks || [];
  const dynamicBlock = getDescriptionBlockByNames(blocks, ['衣着动态', '衣着動態', '衣著动态', '衣著動態', '衣着', '衣著', '当前衣着', '當前衣著']);
  const selfViewBlock = getDescriptionBlockByNames(blocks, ['衣着自评', '衣著自評', '衣着自評', '衣著自评', '服装自评', '服裝自評']);
  if (!outfitView.enabled && !dynamicBlock && !selfViewBlock) return '';
  const accessories = Array.isArray(outfitView.accessories) ? outfitView.accessories : [];
  const currentHtml = outfitView.enabled
    ? '<div class="bs-bt-track-meta">'
      + '<div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">主件</span><span class="bs-bt-track-meta-value">' + escapeHtml(outfitView.main?.name || '全裸') + '</span></div>'
      + '<div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">配件</span><span class="bs-bt-track-meta-value">' + (accessories.length > 0 ? escapeHtml(accessories.map((item) => item.name || item.id).join('、')) : '无') + '</span></div>'
      + '</div>'
    : '<div class="bs-bt-track-description-empty">尚未备装</div>';
  const descriptionItems = [
    dynamicBlock ? { title: '动态', content: dynamicBlock.content } : null,
    selfViewBlock ? { title: '自评', content: selfViewBlock.content } : null,
  ].filter(Boolean);
  const detailHtml = descriptionItems.length > 0
    ? '<div class="bs-bt-track-description-list bs-bt-track-description-list--wardrobe">' + descriptionItems.map((item) => '<div class="bs-bt-track-description-item"><div class="bs-bt-track-description-title">' + escapeHtml(item.title) + '</div><div>' + escapeHtml(item.content || '') + '</div></div>').join('') + '</div>'
    : '';
  return '<div class="bs-bt-track-section bs-bt-track-section--wardrobe-description"><div class="bs-bt-track-section-title">衣着</div>' + currentHtml + detailHtml + '</div>';
}

function renderCurrentOutfitSection(outfitView = {}) {
  if (!outfitView.enabled) return '';
  const accessories = Array.isArray(outfitView.accessories) ? outfitView.accessories : [];
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">当前穿着</div>
      <div class="bs-bt-track-meta">
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">主件</span><span class="bs-bt-track-meta-value">${escapeHtml(outfitView.main?.name || '全裸')}</span></div>
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">配件</span><span class="bs-bt-track-meta-value">${accessories.length > 0 ? escapeHtml(accessories.map((item) => item.name || item.id).join('、')) : '无'}</span></div>
      </div>
    </div>
  `;
}

function renderWardrobeCharacterList(characters = []) {
  return characters.filter((character) => character?.profile?.wardrobe?.enabled === true).map((character) => {
    const profile = character?.profile || {};
    const outfit = buildOutfitView(profile);
    const items = getWardrobeItems(profile).filter((item) => Number(item?.id) !== 0);
    const mainCount = items.filter((item) => item.slot !== 'accessory').length;
    const accessoryCount = items.filter((item) => item.slot === 'accessory').length;
    return `
      <button class="bs-bt-wardrobe-character-card" type="button" data-wardrobe-character="${escapeHtml(character?.name || '')}">
        <span class="bs-bt-wardrobe-character-head">
          <strong>${escapeHtml(character?.name || '未命名')}</strong>
        </span>
        <span class="bs-bt-wardrobe-summary"><b>当前</b>${escapeHtml(getOutfitSummary(outfit))}</span>
        <span class="bs-bt-wardrobe-summary"><b>衣柜</b>${escapeHtml(`${mainCount} 主件 / ${accessoryCount} 配件`)}</span>
      </button>
    `;
  }).join('');
}

function renderWardrobeCharacterPage(character) {
  const profile = character?.profile || {};
  const outfit = buildOutfitView(profile);
  const pressure = Number(outfit?.pregFit?.pregWearPressure);
  const pressureTag = Number.isFinite(pressure) ? '<span class="bs-bt-wardrobe-pressure-tag">孕衣压 ' + escapeHtml(formatFixedDisplay(pressure, 1)) + '</span>' : '';
  const currentIds = new Set([outfit.main?.id, ...(outfit.accessories || []).map((item) => item.id)].filter((id) => id !== undefined && id !== null));
  const items = getWardrobeItems(profile).filter((item) => Number(item?.id) !== 0);
  const mainItems = items.filter((item) => item.slot !== 'accessory');
  const accessoryItems = items.filter((item) => item.slot === 'accessory');
  const renderGroup = (title, groupItems) => `
    <div class="bs-bt-wardrobe-group">
      <div class="bs-bt-wardrobe-group-title">${escapeHtml(title)}</div>
      ${groupItems.length > 0 ? groupItems.map((item) => renderWardrobeItemRow(item, { current: currentIds.has(item.id) })).join('') : '<div class="bs-bt-track-description-empty">无</div>'}
    </div>
  `;
  return `
    <div class="bs-bt-wardrobe-character">
      <div class="bs-bt-wardrobe-character-title">
        <button class="menu_button" type="button" data-wardrobe-back>返回衣柜</button>
      </div>
      <div class="bs-bt-wardrobe-page-title">${escapeHtml(character?.name || '未命名')}</div>
      <div class="bs-bt-wardrobe-current">
        <div class="bs-bt-wardrobe-current-head"><div class="bs-bt-wardrobe-group-title">当前穿着</div>${pressureTag}</div>
        <div class="bs-bt-wardrobe-summary"><b>主件</b>${escapeHtml(outfit.main?.name || '全裸')}</div>
        <div class="bs-bt-wardrobe-summary"><b>配件</b>${escapeHtml((outfit.accessories || []).length > 0 ? outfit.accessories.map((item) => item.name || item.id).join('、') : '无')}</div>
      </div>
      ${profile?.wardrobe?.enabled === true ? `${renderGroup('主件', mainItems)}${renderGroup('配件', accessoryItems)}` : '<div class="bs-bt-track-description-empty">尚未备装。</div>'}
    </div>
  `;
}

function renderWardrobePage(ctx) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const container = document.getElementById('bs-bt-wardrobe-list');
  if (!container) return;
  const characters = Object.values(chatState.characters || {});
  if (characters.length === 0) {
    selectedWardrobeName = '';
    container.innerHTML = '<div class="bs-bt-track-description-empty">尚无注册角色。</div>';
    return;
  }
  const preparedCharacters = characters.filter((character) => character?.profile?.wardrobe?.enabled === true);
  if (preparedCharacters.length === 0) {
    selectedWardrobeName = '';
    container.innerHTML = '<div class="bs-bt-track-description-empty">尚无已备装角色。请先在「注册 → 备装」生成并套用衣柜。</div>';
    return;
  }
  const selected = preparedCharacters.find((character) => character?.name === selectedWardrobeName);
  if (!selected) {
    selectedWardrobeName = '';
    container.innerHTML = renderWardrobeCharacterList(preparedCharacters);
    return;
  }
  container.innerHTML = renderWardrobeCharacterPage(selected);
}

function getWardrobeDetailItem(profile = {}, itemId = '') {
  return findOutfitViewItem(profile, itemId) || findWardrobeViewItem(profile, itemId) || null;
}

function closeWardrobeItemBubble() {
  document.querySelectorAll('.bs-bt-wardrobe-detail-bubble').forEach((node) => node.remove());
}

function positionWardrobeItemBubble(bubble, anchor) {
  if (!bubble || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const gap = 8;
  const margin = 10;
  let top = rect.bottom + gap;
  let left = rect.left + Math.min(24, Math.max(0, rect.width * 0.12));
  if (top + bubbleRect.height > window.innerHeight - margin) top = rect.top - bubbleRect.height - gap;
  if (top < margin) top = margin;
  if (left + bubbleRect.width > window.innerWidth - margin) left = window.innerWidth - bubbleRect.width - margin;
  if (left < margin) left = margin;
  bubble.style.top = top + 'px';
  bubble.style.left = left + 'px';
}

function showWardrobeItemBubble(ctx, characterName, itemId, anchor) {
  closeWardrobeItemBubble();
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const character = chatState.characters?.[characterName];
  const profile = character?.profile || {};
  const item = getWardrobeDetailItem(profile, itemId);
  if (!item || !anchor) return;
  const bubble = document.createElement('div');
  bubble.className = 'bs-bt-wardrobe-detail-bubble';
  bubble.innerHTML = renderWardrobeMetricMap(item, WARDROBE_DIMENSION_LABELS, { signed: item.slot === 'accessory' });
  document.body.appendChild(bubble);
  positionWardrobeItemBubble(bubble, anchor);
}
function buildTrackCharacterViewModel(character) {
  const runtimeCtx = getContextSafe();
  const runtimeSettings = runtimeCtx ? getSettings(runtimeCtx) : null;
  const diaryEnabled = Math.max(0, Math.min(20, Math.floor(Number(runtimeSettings?.diaryRecentLimit) || 0))) > 0;
  const profile = character?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const experience = profile.experience || {};
  const descriptions = profile.descriptions || {};
  const outfitView = buildOutfitView(profile);
  const immune = profile.immune || {};
  const bio = profile.bio || {};
  const gestationSpeciesSpeed = getGestationSpeciesSpeed(profile);
  const gestationEffectiveSpeed = getGestationEffectiveSpeed(profile);
  const gestationModifierMultiplier = Number.isFinite(Number(bio.gestationModifierMultiplier)) ? Number(bio.gestationModifierMultiplier) : 1;
  const stage = String(base.stage || '未设定');
  const totalSperm = (Array.isArray(base.sperms) ? base.sperms : []).reduce((sum, item) => sum + (Number(item?.value) || 0), 0);
  return {
    name: character?.name || '未命名',
    base: {
      stage,
    },
    overview: {
      raceLabel: formatRaceLabel(base.race, base.derivedType),
      age: Number.isFinite(Number(base.age)) ? Math.round(Number(base.age)) : null,
      stage,
      stageProgress: getStageProgress(profile),
      stats: [
        {
          label: '活力',
          value: Number(base.vitality) || 0,
          cap: VITALITY_CAPS[Math.max(1, Math.min(7, Math.round(Number(base.vitalityLevel) || 4)))] || 125,
        },
        { label: '性欲', value: Number(base.libido) || 0, cap: getLibidoCap(stage, profile) },
        {
          label: '情压',
          value: Number(base.psyStress) || 0,
          cap: PSY_STRESS_CAPS[Math.max(1, Math.min(7, Math.round(Number(base.psyStressLevel) || 4)))] || 110,
        },
        { label: '宫压', value: Number(base.uterinePressure) || 0, cap: getUterinePressureCap(stage, profile) },
      ],
      metabolismSummary: getMetabolismSummary(profile.metabolism, immune, base.derivedType, pregnant.blockage, pregnant.acceleration, pregnant.expansion),
    },
    description: {
      normalBlocks: parseDescriptionBlocks(descriptions.normalDescription),
      psychology: hasBreedingPsychologyProfile(profile) ? getPsychologyView(profile) : null,
    },
    pregnancy: {
      eggs: Number(base.eggs) || 0,
      fertilizationDays: Number(base.fertilizationDays) || 0,
      totalSperm,
      sperms: Array.isArray(base.sperms) ? base.sperms : [],
      pregnantDays: Number(pregnant.pregnantDays) || 0,
      effectivePregnantDays: Number(pregnant.effectivePregnantDays) || 0,
      laborHours: Number(pregnant.laborHours) || 0,
      laborPhase: pregnant.laborPhase ?? null,
      laborFetusIndex: Number(pregnant.laborFetusIndex) || 0,
      laborPain: Number(pregnant.laborPain) || 0,
      prodromalOriginStage: pregnant.prodromalOriginStage ?? null,
      prodromalRemainingHours: Number(pregnant.prodromalRemainingHours) || 0,
      prodromalDelayProgressHours: Number(pregnant.prodromalDelayProgressHours) || 0,
      amnionDurability: Number(pregnant.amnionDurability) || 0,
      fetuses: Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [],
      pregnantBlocks: parseDescriptionBlocks(descriptions.pregnantDescription),
      showPregnantFields: isPregnantStage(stage),
      showLaborFields: LABOR_STAGES.includes(stage),
      showLaborPainBadge: stage === '产兆前驱' || LABOR_STAGES.includes(stage),
      gestationModifier: {
        name: String(bio.gestationModifierName || '').trim(),
        multiplier: gestationModifierMultiplier,
        description: String(bio.gestationModifierDescription || '').trim(),
        effectiveSpeed: gestationEffectiveSpeed,
        speciesSpeed: gestationSpeciesSpeed,
      },
    },
    experience: {
      items: [
        ['初次对象', experience.virginity ?? '无'],
        ['最近对象', experience.latestSexPartner ?? '无'],
        ['情感对象', experience.emotionalMate ?? '无'],
        ['婚姻对象', experience.marriageMate ?? '无'],
        ['怀孕次数', `${Number(experience.pregnantExperience) || 0}次`],
        ['自然产', `${Number(experience.naturalBirthExperience) || 0}次`],
        ['手术产', `${Number(experience.surgicalBirthExperience) || 0}次`],
        ['流产/堕胎', `${Number(experience.miscarriageExperience) || 0}次`],
      ],
      children: Array.isArray(profile.children) ? profile.children : [],
    },
    diary: {
      enabled: diaryEnabled,
      entries: Array.isArray(profile.diary) ? profile.diary : [],
    },
    outfit: outfitView,
    debug: {
      immune: {
        metabolism: Boolean(immune.metabolism),
        miscarriage: Boolean(immune.miscarriage),
        realisticLabor: Boolean(immune.realisticLabor),
      },
      isHere: base.isHere !== false,
      gestationModifier: {
        name: String(bio.gestationModifierName || '').trim(),
        multiplier: gestationModifierMultiplier,
        description: String(bio.gestationModifierDescription || '').trim(),
        effectiveSpeed: gestationEffectiveSpeed,
        speciesSpeed: gestationSpeciesSpeed,
      },
      counts: {
        sperms: Array.isArray(base.sperms) ? base.sperms.length : 0,
        fetuses: Array.isArray(pregnant.fetuses) ? pregnant.fetuses.length : 0,
        children: Array.isArray(profile.children) ? profile.children.length : 0,
      },
      derivedType: String(base.derivedType || '').trim(),
      blockage: pregnant.blockage && typeof pregnant.blockage === 'object' ? {
        key: String(pregnant.blockage.key || ''),
        severity: Number(pregnant.blockage.severity) || 0,
      } : null,
      acceleration: pregnant.acceleration && typeof pregnant.acceleration === 'object' ? {
        key: String(pregnant.acceleration.key || ''),
        severity: Number(pregnant.acceleration.severity) || 0,
      } : null,
      expansion: pregnant.expansion && typeof pregnant.expansion === 'object' ? {
        key: String(pregnant.expansion.key || ''),
      } : null,
      hasConceptionState: (Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0)
        || (Number(base.fertilizationDays) || 0) > 0
        || isPregnantStage(stage),
    },
  };
}

function renderDescriptionGroup(title, blocks, options = {}) {
  const items = Array.isArray(blocks) ? blocks : [];
  const sectionClass = `bs-bt-track-section${options.sectionClass ? ` ${escapeHtml(options.sectionClass)}` : ''}`;
  const sectionStyle = options.sectionStyle ? ` style="${escapeHtml(options.sectionStyle)}"` : '';
  const html =
    items.length > 0
      ? items
        .map(
          (item) => `<div class="bs-bt-track-description-item">
        <div class="bs-bt-track-description-title">${escapeHtml(item.title || '内容')}</div>
        <div>${escapeHtml(item.content || '')}</div>
      </div>`,
        )
        .join('')
      : '<div class="bs-bt-track-description-empty">暂无内容</div>';
  return `<div class="${sectionClass}"${sectionStyle}><div class="bs-bt-track-section-title">${escapeHtml(title)}</div><div class="bs-bt-track-description-list">${html}</div></div>`;
}

function renderProgressList(items) {
  return items
    .map((item) => {
      const value = Math.max(0, Number(item.value) || 0);
      const unbounded = item.unbounded === true;
      const cap = Math.max(1, Number(item.cap) || 1);
      const displayOffset = item.displayStartAtOne ? 1 : 0;
      const fillValue = item.displayStartAtOne ? Math.min(cap, value + 1) : value;
      const fill = unbounded ? '100%' : `${Math.min(100, (fillValue / cap) * 100)}%`;
      const scale = unbounded ? '100%' : `${Math.max(25, (cap / MAX_PROGRESS_BAR_CAP) * 100)}%`;
      const displayCap = item.integerDisplay ? Math.ceil(cap) : cap;
      const displayCurrent = unbounded
        ? Math.floor(value) + displayOffset
        : Math.min(displayCap, Math.floor(value) + displayOffset);
      const displayValue = unbounded ? String(displayCurrent) : `${displayCurrent} / ${displayCap}`;
      return `<div class="bs-bt-track-progress">
        <div class="bs-bt-track-progress-head"><span>${escapeHtml(item.label)}</span><span>${displayValue}</span></div>
        <div class="bs-bt-track-progress-bar" style="width:${scale};"><div class="bs-bt-track-progress-fill" style="width:${fill};"></div></div>
      </div>`;
    })
    .join('');
}

function renderCardList(items, renderCard, emptyText) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="bs-bt-track-card-empty">${escapeHtml(emptyText)}</div>`;
  }
  return `<div class="bs-bt-track-cards">${items.map((item, index) => renderCard(item, index)).join('')}</div>`;
}

function renderTrackTitle(title, badge = '') {
  const badgeHtml = String(badge || '').trim()
    ? `<span class="bs-bt-track-title-badge">${escapeHtml(badge)}</span>`
    : '';
  return `<span class="bs-bt-track-title-main">${escapeHtml(title)}</span>${badgeHtml}`;
}

function formatOneBasedDay(value) {
  return Math.max(1, Math.floor(Math.max(0, Number(value) || 0)) + 1);
}

function renderCardCarouselSection(title, items, renderCard, emptyText, kind, options = {}) {
  const titleHtml = renderTrackTitle(title, options.badge);
  const sectionClass = `bs-bt-track-section${options.sectionClass ? ` ${escapeHtml(options.sectionClass)}` : ''}`;
  const sectionStyle = options.sectionStyle ? ` style="${escapeHtml(options.sectionStyle)}"` : '';
  if (!Array.isArray(items) || items.length === 0) {
    return `
      <div class="${sectionClass}"${sectionStyle}>
        <div class="bs-bt-track-section-title">${titleHtml}</div>
        <div class="bs-bt-track-card-empty">${escapeHtml(emptyText)}</div>
      </div>
    `;
  }

  const currentIndex = setTrackCardIndex(kind, getTrackCardIndex(kind, items.length), items.length);
  const currentItem = items[currentIndex];
  const showNav = items.length > 1;
  return `
    <div class="${sectionClass}"${sectionStyle}>
      <div class="bs-bt-track-section-title bs-bt-track-section-title--split">
        <span class="bs-bt-track-title-left">${titleHtml}</span>
        <span style="display:flex;align-items:center;gap:8px;">
          ${showNav
            ? `<button type="button" class="menu_button" data-card-nav="${escapeHtml(kind)}" data-card-step="-1" data-card-count="${items.length}" style="min-width:32px;padding:2px 8px;">◀</button>
               <button type="button" class="menu_button" data-card-nav="${escapeHtml(kind)}" data-card-step="1" data-card-count="${items.length}" style="min-width:32px;padding:2px 8px;">▶</button>`
            : ''
          }
        </span>
      </div>
      <div class="bs-bt-track-cards bs-bt-track-cards--single">${renderCard(currentItem, currentIndex)}</div>
    </div>
  `;
}

function renderTrackOverview(viewModel) {
  const progress = viewModel.overview.stageProgress;
  const currentStage = viewModel.overview.stage;
  const stageBadge = viewModel.pregnancy?.showLaborFields
    ? `${viewModel.pregnancy?.laborPhase || '产程'}${Number(viewModel.pregnancy?.laborFetusIndex) > 0 ? ` ${viewModel.pregnancy.laborFetusIndex}胎` : ''}`
    : '';
  const laborPain = Math.max(0, Math.min(10, Number(viewModel.pregnancy?.laborPain) || 0));
  const stageSectionClass = viewModel.pregnancy?.showLaborPainBadge
    ? ` bs-bt-track-section--labor-pain${laborPain >= 9 ? ' is-critical' : ''}`
    : '';
  const stageSectionStyle = viewModel.pregnancy?.showLaborPainBadge
    ? ` style="--bsbt-labor-pain:${laborPain / 10};"`
    : '';
  const progressLabel = currentStage === '第二产程'
    ? `第二产程·第${Math.max(1, Number(viewModel.pregnancy?.laborFetusIndex) || 1)}胎${viewModel.pregnancy?.laborPhase || '胎体下降'}`
    : currentStage;
  const progressHtml = progress
    ? renderProgressList([{ label: progressLabel, value: progress.value, cap: progress.max, unbounded: progress.unbounded, integerDisplay: progress.integerDisplay }])
    : '';
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">角色概览</div>
      <div class="bs-bt-track-meta">
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">姓名</span><span class="bs-bt-track-meta-value">${escapeHtml(viewModel.name)}</span></div>
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">种族</span><span class="bs-bt-track-meta-value">${escapeHtml(viewModel.overview.raceLabel)}</span></div>
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">年龄</span><span class="bs-bt-track-meta-value">${escapeHtml(viewModel.overview.age ?? '未知')}</span></div>
      </div>
    </div>
    <div class="bs-bt-track-section${stageSectionClass}"${stageSectionStyle}>
      <div class="bs-bt-track-section-title">${renderTrackTitle('阶段', stageBadge)}</div>
      ${progressHtml}
    </div>
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">状态值</div>
      <div class="bs-bt-track-progress-list">${renderProgressList(viewModel.overview.stats)}</div>
    </div>
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">代谢需求</div>
      ${renderMetabolismSummary(viewModel.overview.metabolismSummary)}
    </div>
  `;
}

function renderTrackDescription(viewModel) {
  const normalBlocks = (Array.isArray(viewModel.description?.normalBlocks) ? viewModel.description.normalBlocks : []).filter((block) => !isWardrobeDescriptionBlock(block));
  return `
    ${renderWardrobeDescriptionSection(viewModel)}
    ${renderDescriptionGroup('基本描述', normalBlocks)}
  `;
}

function renderTrackPsychology(viewModel) {
  const psychology = viewModel.description.psychology;
  if (!psychology) return '';
  const flags = Array.isArray(psychology.flags) ? psychology.flags : [];
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">${escapeHtml(psychology.title)}</div>
      <div class="bs-bt-track-radar-wrap">${buildRadarSvg(psychology.items)}</div>
      ${renderPsychologyPrompts(psychology.items)}
      <div class="bs-bt-track-psych-flags">
        ${flags
      .map(
        (item) =>
          `<div class="bs-bt-track-tag${item.active ? ' is-active' : ''}">${escapeHtml(item.label)}: ${item.active ? '是' : '否'}</div>`,
      )
      .join('')}
      </div>
    </div>
  `;
}

function renderTrackPregnancy(viewModel) {
  const data = viewModel.pregnancy;
  const gestationModifier = data.gestationModifier || {};
  const fertilityBadge = data.showPregnantFields
    ? '已怀孕'
    : (Number(data.eggs) > 0 || Number(data.fertilizationDays) > 0 || (Array.isArray(data.fetuses) && data.fetuses.length > 0))
      ? '危险期'
      : '安全期';
  const pregnantDaysBadge = data.showPregnantFields
    ? `孕龄 ${formatOneBasedDay(data.pregnantDays)}d`
    : '';
  const amnionDurability = Math.max(0, Math.min(100, Number(data.amnionDurability) || 0));
  const pregnantDescriptionOptions = data.showLaborFields
    ? {
      sectionClass: 'bs-bt-track-section--amnion',
      sectionStyle: `--bsbt-amnion-ratio:${amnionDurability / 100};`,
    }
    : {};
  const hasGestationModifier = Boolean(
    String(gestationModifier.name || '').trim()
    || String(gestationModifier.description || '').trim()
    || Math.abs(Number(gestationModifier.multiplier ?? 1) - 1) > 0.000001,
  );
  return `
    ${hasGestationModifier ? `<div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">妊娠变速效果</div>
      <div class="bs-bt-track-meta">
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">效果名称</span><span class="bs-bt-track-meta-value">${escapeHtml(gestationModifier.name || '无')}</span></div>
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">当前倍率</span><span class="bs-bt-track-meta-value">${Number(gestationModifier.multiplier || 0).toFixed(3)}x</span></div>
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">说明</span><span class="bs-bt-track-meta-value">${escapeHtml(gestationModifier.description || '无')}</span></div>
      </div>
    </div>` : ''}
    ${renderCardCarouselSection(
      '精液来源',
      data.sperms,
      (item, index) => `<div class="bs-bt-track-card">
          <div class="bs-bt-track-card-title">来源 ${index + 1}</div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">对象</span><span class="bs-bt-track-list-value">${escapeHtml(item?.male || '未知')}</span></div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">种族</span><span class="bs-bt-track-list-value">${escapeHtml(formatRaceLabel(item?.race, item?.derivedType))}</span></div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">残留量</span><span class="bs-bt-track-list-value">${Math.round(Number(item?.value) || 0)}</span></div>
        </div>`,
      '当前无精液残留',
      'sperms',
      { badge: fertilityBadge },
    )}
    ${data.showPregnantFields
      ? `${renderCardCarouselSection(
            '胎儿信息',
        data.fetuses,
        (item, index) => `<div class="bs-bt-track-card">
                <div class="bs-bt-track-card-title">胎儿 ${index + 1}</div>
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">父方姓名</span><span class="bs-bt-track-list-value">${escapeHtml(item?.fathers || '未知')}</span></div>
                ${item?.provider
            ? `<div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">provider</span><span class="bs-bt-track-list-value">${escapeHtml(item.provider)}</span></div>`
            : ''
          }
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">父方种族</span><span class="bs-bt-track-list-value">${escapeHtml(formatRaceLabel(item?.fatherRace, item?.fatherDerivedType))}</span></div>
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">胚型</span><span class="bs-bt-track-list-value">${escapeHtml(item?.embryoType || '未知')}</span></div>
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">性别</span><span class="bs-bt-track-list-value">${escapeHtml(item?.gender || '未知')}</span></div>
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">体重倍率</span><span class="bs-bt-track-list-value">${escapeHtml(formatFixedDisplay(item?.weight, 2))}</span></div>
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">胎位角</span><span class="bs-bt-track-list-value">${escapeHtml(`${formatIntegerDisplay(item?.tendencyAngle)}°`)}</span></div>
                <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">亲和</span><span class="bs-bt-track-list-value">${escapeHtml(formatIntegerDisplay(item?.affinity))}</span></div>
              </div>`,
        '当前无妊娠胎儿资料',
        'fetuses',
        { badge: pregnantDaysBadge },
      )}
          ${renderDescriptionGroup('孕态描述', data.pregnantBlocks, pregnantDescriptionOptions)}`
      : ''
    }
  `;
}

function renderTrackExperience(viewModel) {
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">经历记录</div>
      <div class="bs-bt-track-meta">
        ${viewModel.experience.items
      .map(
        ([label, value]) =>
          `<div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">${escapeHtml(label)}</span><span class="bs-bt-track-meta-value">${escapeHtml(value)}</span></div>`,
      )
      .join('')}
      </div>
    </div>
    ${renderCardCarouselSection(
      '孩子记录',
        viewModel.experience.children,
        (item, index) => `<div class="bs-bt-track-card">
          <div class="bs-bt-track-card-title">${escapeHtml(item?.name || `孩子 ${index + 1}`)}</div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">父方</span><span class="bs-bt-track-list-value">${escapeHtml(item?.fathers || '未知')}</span></div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">性别</span><span class="bs-bt-track-list-value">${escapeHtml(item?.gender || '未知')}</span></div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">种族</span><span class="bs-bt-track-list-value">${escapeHtml(formatRaceLabel(item?.race, item?.derivedType))}</span></div>
          <div class="bs-bt-track-list-row"><span class="bs-bt-track-list-label">年龄</span><span class="bs-bt-track-list-value">${escapeHtml(formatIntegerDisplay(item?.age))}</span></div>
        </div>`,
        '当前无孩子记录',
      'children',
    )}
  `;
}

function renderTrackDiary(viewModel) {
  const diaryEnabled = viewModel.diary?.enabled !== false;
  const entries = Array.isArray(viewModel.diary?.entries) ? viewModel.diary.entries : [];
  return `
    ${viewModel.description?.psychology ? renderTrackPsychology(viewModel) : ''}
    ${diaryEnabled ? renderCardCarouselSection(
      '日记',
      entries,
      (item, index) => `<div class="bs-bt-track-card">
        <div class="bs-bt-track-card-title">${escapeHtml(item?.time || `日记 ${index + 1}`)}</div>
        <div class="bs-bt-track-card-note">${escapeHtml(item?.content || '')}</div>
      </div>`,
      '当前无日记记录',
      'diary',
    ) : ''}
  `;
}

function renderTrackDebug(viewModel) {
  const immune = viewModel.debug?.immune || {};
  const isHere = viewModel.debug?.isHere !== false;
  const counts = viewModel.debug?.counts || {};
  const hasConceptionState = Boolean(viewModel.debug?.hasConceptionState);
  const gestationModifier = viewModel.debug?.gestationModifier || {};
  const derivedType = String(viewModel.debug?.derivedType || '').trim();
  const currentStage = viewModel.base?.stage || '';
  const currentBlockageKey = String(viewModel.debug?.blockage?.key || '');
  const currentAccelerationKey = String(viewModel.debug?.acceleration?.key || '');
  const currentExpansionKey = String(viewModel.debug?.expansion?.key || '');
  const blockageExemptions = derivedType ? new Set(getDerivedTypeMetabolismExemptions(derivedType)) : new Set();
  const blockageKeys = METABOLISM_DISPLAY_ORDER.filter((key) => !blockageExemptions.has(key));
  if (derivedType) blockageKeys.push('fluxPositive', 'fluxNegative');
  const blockageOptions = [
    `<option value=""${currentBlockageKey ? '' : ' selected'}>无</option>`,
    ...blockageKeys.map((key) =>
      `<option value="${escapeHtml(key)}"${currentBlockageKey === key ? ' selected' : ''}>${escapeHtml(DEBUG_BLOCKAGE_LABELS[key] || key)}</option>`,
    ),
  ].join('');
  const accelerationOptions = [
    `<option value=""${currentAccelerationKey ? '' : ' selected'}>无</option>`,
    ...blockageKeys.map((key) =>
      `<option value="${escapeHtml(key)}"${currentAccelerationKey === key ? ' selected' : ''}>${escapeHtml(DEBUG_BLOCKAGE_LABELS[key] || key)}</option>`,
    ),
  ].join('');
  const expansionOptions = [
    `<option value=""${currentExpansionKey ? '' : ' selected'}>无</option>`,
    ...blockageKeys.map((key) =>
      `<option value="${escapeHtml(key)}"${currentExpansionKey === key ? ' selected' : ''}>${escapeHtml(DEBUG_BLOCKAGE_LABELS[key] || key)}</option>`,
    ),
  ].join('');

  const hasProtectedPregnancyState = hasConceptionState || ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产兆前驱', '第一产程', '第二产程', '第三产程'].includes(currentStage);
  const canEnterProdromal = ['孕晚期', '临产期', '逾期'].includes(currentStage);
  const isProdromal = currentStage === '产兆前驱';
  const canSetProdromal = canEnterProdromal || isProdromal;
  const canTriggerFetalActivity = Number(counts.fetuses) > 0
    && ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产兆前驱', '第一产程', '第二产程', '第三产程'].includes(currentStage);
  const prodromalProgress = isProdromal && Number(viewModel.overview?.stageProgress?.max) > 0
    ? Math.round(Math.max(0, Math.min(100, (Number(viewModel.overview.stageProgress.value) / Number(viewModel.overview.stageProgress.max)) * 100)))
    : 0;

  const phaseOptions = ['卵泡期', '排卵期', '黄体期', '月经期', '假孕期', '产后恢复'].map(phase =>
    `<option value="${phase}"${currentStage === phase ? ' selected' : ''}>${phase}</option>`
  ).join('');

  const defaultFather = String(getContextSafe()?.name1 || '').trim();
  const fatherValue = escapeHtml(debugInjectDraft.father || defaultFather);
  const raceValue = escapeHtml(debugInjectDraft.race || '人类');
  const countValue = escapeHtml(debugInjectDraft.fetusCount || '1');
  const gendersValue = escapeHtml(debugInjectDraft.genders || '女');
  const daysValue = escapeHtml(debugInjectDraft.equivalentDays || '0');
  const modifierDraftActive = debugGestationModifierDraft.owner === selectedTrackName;
  const modifierNameValue = escapeHtml(modifierDraftActive ? debugGestationModifierDraft.name : (gestationModifier.name || ''));
  const modifierMultiplierValue = escapeHtml(modifierDraftActive ? debugGestationModifierDraft.multiplier : String(gestationModifier.multiplier ?? 1));
  const modifierDescriptionValue = escapeHtml(modifierDraftActive ? debugGestationModifierDraft.description : (gestationModifier.description || ''));
  const fetalActivityTextValue = escapeHtml(debugFetalActivityDraft.owner === selectedTrackName ? debugFetalActivityDraft.text : '');
  const palette = racePaletteState.targetInputId === 'bs-bt-debug-race' && racePaletteState.isOpen
    ? `<div class="bs-bt-race-popover">${renderRacePaletteBody()}</div>`
    : '';
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">快捷调试</div>
      <div class="bs-bt-track-debug-list">
        <button type="button" class="bs-bt-track-debug-button${immune.metabolism ? ' is-active' : ''}" data-debug-immune="metabolism">
          <span class="bs-bt-track-debug-title">代谢免疫</span>
          <span class="bs-bt-track-debug-state">${immune.metabolism ? 'ON' : 'OFF'}</span>
        </button>
        <button type="button" class="bs-bt-track-debug-button${immune.miscarriage ? ' is-active' : ''}" data-debug-immune="miscarriage">
          <span class="bs-bt-track-debug-title">流产免疫</span>
          <span class="bs-bt-track-debug-state">${immune.miscarriage ? 'ON' : 'OFF'}</span>
        </button>
        <button type="button" class="bs-bt-track-debug-button${immune.realisticLabor ? ' is-active' : ''}" data-debug-immune="realisticLabor">
          <span class="bs-bt-track-debug-title">真实产程</span>
          <span class="bs-bt-track-debug-state">${immune.realisticLabor ? 'ON' : 'OFF'}</span>
        </button>
        <button type="button" class="bs-bt-track-debug-button${isHere ? ' is-active' : ''}" data-debug-action="toggle-presence">
          <span class="bs-bt-track-debug-title">在场</span>
          <span class="bs-bt-track-debug-state">${isHere ? 'ON' : 'OFF'}</span>
        </button>
        <button type="button" class="bs-bt-track-debug-button" data-debug-clear="sperms">
          <span class="bs-bt-track-debug-title">淨空精液</span>
          <span class="bs-bt-track-debug-state">${Number(counts.sperms) || 0}</span>
        </button>
        <button type="button" class="bs-bt-track-debug-button" data-debug-clear="fetuses">
          <span class="bs-bt-track-debug-title">淨空胎儿</span>
          <span class="bs-bt-track-debug-state">${Number(counts.fetuses) || 0}</span>
        </button>
        <button type="button" class="bs-bt-track-debug-button" data-debug-clear="children">
          <span class="bs-bt-track-debug-title">淨空孩子</span>
          <span class="bs-bt-track-debug-state">${Number(counts.children) || 0}</span>
        </button>
      </div>
      <div class="bs-bt-track-debug-hint">淨空胎儿时，若当前已是着床后的妊娠状态，会追加一次流产/堕胎经验；尚未着床的受精卵不计入。</div>
    </div>
    <div class="bs-bt-track-section" style="margin-top: 10px;">
      <div class="bs-bt-track-section-title">妊娠需求症状调试</div>
      <fieldset class="bs-bt-track-debug-form">
        <div class="bs-bt-track-debug-field">
          <div class="bs-bt-track-debug-label">阻塞：降低排解效果（当前强度 ${Number(viewModel.debug?.blockage?.severity || 0).toFixed(2)}）</div>
          <div class="bs-bt-track-inline-action">
            <select id="bs-bt-debug-blockage-select" class="text_pole">
              ${blockageOptions}
            </select>
            <button type="button" class="menu_button bs-bt-inline-button" data-debug-action="set-blockage">应用阻塞</button>
          </div>
        </div>
        <div class="bs-bt-track-debug-field">
          <div class="bs-bt-track-debug-label">快积：增加累积速度（当前强度 ${Number(viewModel.debug?.acceleration?.severity || 0).toFixed(2)}）</div>
          <div class="bs-bt-track-inline-action">
            <select id="bs-bt-debug-acceleration-select" class="text_pole">
              ${accelerationOptions}
            </select>
            <button type="button" class="menu_button bs-bt-inline-button" data-debug-action="set-acceleration">应用快积</button>
          </div>
        </div>
        <div class="bs-bt-track-debug-field">
          <div class="bs-bt-track-debug-label">扩容：需求上限由 150 提高到 200</div>
          <div class="bs-bt-track-inline-action">
            <select id="bs-bt-debug-expansion-select" class="text_pole">
              ${expansionOptions}
            </select>
            <button type="button" class="menu_button bs-bt-inline-button" data-debug-action="set-expansion">应用扩容</button>
          </div>
        </div>
      </fieldset>
      <div class="bs-bt-track-debug-hint">阻塞、快积与扩容不能作用于同一需求；设置冲突项时会自动替换原症状。</div>
    </div>
    <div class="bs-bt-track-section" style="margin-top: 10px;">
      <div class="bs-bt-track-section-title">生理周期强制切換</div>
      <fieldset class="bs-bt-track-debug-form"${hasProtectedPregnancyState ? ' disabled' : ''}>
        <div class="bs-bt-track-inline-action">
          <select id="bs-bt-debug-phase-select" class="text_pole">
            ${phaseOptions}
          </select>
          <button type="button" class="menu_button bs-bt-inline-button" data-debug-action="set-phase">执行切換</button>
        </div>
      </fieldset>
      <div class="bs-bt-track-debug-hint">${hasProtectedPregnancyState ? '当前角色处于妊娠/分娩状态，已禁用此操作。' : '强制切換阶段，會連帶重置階段天數與觸發狀態。'}</div>
    </div>
    <div class="bs-bt-track-section" style="margin-top: 10px;">
      <div class="bs-bt-track-section-title">注入胎儿并怀孕 X 天</div>
      <fieldset class="bs-bt-track-debug-form"${hasConceptionState ? ' disabled' : ''}>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">父亲名字</span>
          <input id="bs-bt-debug-father" class="text_pole" type="text" value="${fatherValue}" placeholder="可用逗号分隔，默认当前 user" />
        </label>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">父亲种族</span>
          <div class="bs-bt-race-picker-wrap">
            <div class="bs-bt-race-input-row">
              <input id="bs-bt-debug-race" class="text_pole" type="text" value="${raceValue}" placeholder="可用逗号分隔，默认人类" />
              <button type="button" class="bs-bt-race-picker-button" data-race-picker-target="bs-bt-debug-race" title="种族调色盘" aria-label="种族调色盘">☥</button>
            </div>
            ${palette}
          </div>
        </label>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">胎数</span>
          <input id="bs-bt-debug-count" class="text_pole" type="number" min="1" max="9" value="${countValue}" />
        </label>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">性别</span>
          <input id="bs-bt-debug-genders" class="text_pole" type="text" value="${gendersValue}" placeholder="男/女/双/无，多胎用逗号分隔" />
        </label>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">孕龄天数(人類等效产科孕期，0代表刚受精)</span>
          <input id="bs-bt-debug-days" class="text_pole" type="number" min="0" max="300" value="${daysValue}" />
        </label>
        <button type="button" class="menu_button" data-debug-action="inject-pregnancy">执行注入</button>
      </fieldset>
      <div class="bs-bt-track-debug-hint">${hasConceptionState ? '当前角色已有受精或妊娠状态，已禁用此操作。' : '父亲名字、父亲种族、性别都可用逗号逐胎填写；填一位父亲 + 胎数 > 1 = 同父多胎；填多位父亲 = 异父妊娠。'}</div>
    </div>
    <div class="bs-bt-track-section" style="margin-top: 10px;">
      <div class="bs-bt-track-section-title">产兆前驱调试</div>
      <fieldset class="bs-bt-track-debug-form"${canSetProdromal ? '' : ' disabled'}>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">前驱进度 <output id="bs-bt-debug-prodromal-output">${prodromalProgress}%</output></span>
          <input id="bs-bt-debug-prodromal-progress" type="range" min="0" max="100" step="1" value="${prodromalProgress}" />
        </label>
        <button type="button" class="menu_button" data-debug-action="set-prodromal">${isProdromal ? '应用进度' : '切换并应用'}</button>
      </fieldset>
      <div class="bs-bt-track-debug-hint">${canSetProdromal ? '0% 为刚进入产兆前驱，100% 为剩余时间耗尽；设为 100% 后，下一次时间推进会进入第一产程。' : '只有孕晚期、临产期或逾期角色可以切换至产兆前驱。'}</div>
    </div>
    <div class="bs-bt-track-section" style="margin-top: 10px;">
      <div class="bs-bt-track-section-title">胎儿自主活动调试</div>
      <fieldset class="bs-bt-track-debug-form"${canTriggerFetalActivity ? '' : ' disabled'}>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">事件内容</span>
          <textarea id="bs-bt-debug-fetal-activity" class="text_pole bs-bt-textarea" rows="3" placeholder="例如：腹中的双胎忽然一前一后踢动，腹部轮廓短暂隆起">${fetalActivityTextValue}</textarea>
        </label>
        <button type="button" class="menu_button" data-debug-action="fetal-activity">触发活动</button>
      </fieldset>
      <div class="bs-bt-track-debug-hint">${canTriggerFetalActivity ? '内容会追加写入 secondly，作为下一段故事可自然承接的胎儿活动事件。' : '只有已有胎儿且仍在妊娠或产程中的角色可以触发。'}</div>
    </div>
    <div class="bs-bt-track-section" style="margin-top: 10px;">
      <div class="bs-bt-track-section-title">妊娠变速效果</div>
      <fieldset class="bs-bt-track-debug-form">
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">效果名称</span>
          <input id="bs-bt-debug-gestation-name" class="text_pole" type="text" value="${modifierNameValue}" placeholder="例如：地母神的祝福" />
        </label>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">倍率</span>
          <input id="bs-bt-debug-gestation-multiplier" class="text_pole" type="number" min="0" max="20" step="0.1" value="${modifierMultiplierValue}" />
        </label>
        <label class="bs-bt-track-debug-field">
          <span class="bs-bt-track-debug-label">说明</span>
          <textarea id="bs-bt-debug-gestation-description" class="text_pole bs-bt-textarea" rows="3" placeholder="例如：地母神赐与女性冒险者的祝福，使妊娠速度变为 0.5 倍；若倍率为 0，则代表胎儿发育冻结">${modifierDescriptionValue}</textarea>
        </label>
        <div class="bs-bt-track-inline-action bs-bt-track-inline-action-equal">
          <button type="button" class="menu_button bs-bt-inline-button" data-debug-action="set-gestation-modifier">应用效果</button>
          <button type="button" class="menu_button bs-bt-inline-button" data-debug-action="clear-gestation-modifier">清除效果</button>
        </div>
      </fieldset>
      <div class="bs-bt-track-debug-hint">当前倍率 ${Number(gestationModifier.multiplier || 0).toFixed(3)}x，物种妊娠速度 ${Number(gestationModifier.speciesSpeed || 1).toFixed(3)}，当前生效速度 ${Number(gestationModifier.effectiveSpeed || 0).toFixed(3)}。倍率为 0 代表胎儿发育冻结。</div>
    </div>
  `;
}

function renderTrackCharacterContent(viewModel) {
  if (selectedTrackSubpage === 'description') return renderTrackDescription(viewModel);
  if (selectedTrackSubpage === 'pregnancy') return renderTrackPregnancy(viewModel);
  if (selectedTrackSubpage === 'experience') return renderTrackExperience(viewModel);
  if (selectedTrackSubpage === 'diary') return renderTrackDiary(viewModel);
  return renderTrackOverview(viewModel);
}

function toggleSelectedTrackImmune(ctx, immuneKey) {
  if (!selectedTrackName) return;
  if (!['metabolism', 'miscarriage', 'realisticLabor'].includes(immuneKey)) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const character = chatState.characters?.[selectedTrackName];
  if (!character?.profile) return;

  const nextValue = !Boolean(character.profile.immune?.[immuneKey]);
  character.profile.immune = {
    ...(character.profile.immune || {}),
    [immuneKey]: nextValue,
  };
  recordChatStateSnapshot(ctx, chatState, { reason: `debug_immune_${immuneKey}` });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(
    `[BS BioTracker] ${selectedTrackName} 的 ${immuneKey === 'metabolism' ? '代谢免疫' : immuneKey === 'miscarriage' ? '流产免疫' : '真实产程'}已${nextValue ? '开启' : '关闭'}`,
  );
}

function toggleSelectedTrackPresence(ctx) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const character = chatState.characters?.[selectedTrackName];
  if (!character?.profile) return;

  const nextValue = character.profile.base?.isHere === false;
  const result = applyToolCall(chatState, {
    name: 'bsSetCharacterPresence',
    arguments: {
      female: selectedTrackName,
      isPresent: nextValue,
    },
  });
  if (!result?.applied) {
    globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 在场状态切换失败');
    return;
  }
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_toggle_presence' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
  globalThis.toastr?.success?.(`[BS BioTracker] ${selectedTrackName} 已${nextValue ? '标记为在场' : '标记为离场'}`);
}

function injectSelectedTrackPregnancy(ctx) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  debugInjectDraft = {
    father: String(document.getElementById('bs-bt-debug-father')?.value || '').trim(),
    race: String(document.getElementById('bs-bt-debug-race')?.value || '人类').trim() || '人类',
    fetusCount: String(document.getElementById('bs-bt-debug-count')?.value || '1'),
    genders: String(document.getElementById('bs-bt-debug-genders')?.value || '').trim(),
    equivalentDays: String(document.getElementById('bs-bt-debug-days')?.value || '0'),
  };
  const result = applyToolCall(chatState, {
    name: 'bsDebugInjectPregnancy',
    arguments: {
      female: selectedTrackName,
      father: debugInjectDraft.father || String(getContextSafe()?.name1 || '').trim(),
      race: debugInjectDraft.race || '人类',
      fetusCount: Number(debugInjectDraft.fetusCount || 1),
      genders: debugInjectDraft.genders,
      equivalentDays: Number(debugInjectDraft.equivalentDays || 0),
    },
  });
  if (!result?.applied) {
    globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 注入失败');
    return;
  }
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_inject_pregnancy' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(`[BS BioTracker] 已为 ${selectedTrackName} 注入调试妊娠状态`);
}

function applySelectedTrackGestationModifier(ctx, clear = false) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const name = String(document.getElementById('bs-bt-debug-gestation-name')?.value || '').trim();
  const multiplier = String(document.getElementById('bs-bt-debug-gestation-multiplier')?.value || '').trim();
  const description = String(document.getElementById('bs-bt-debug-gestation-description')?.value || '').trim();
  debugGestationModifierDraft = {
    owner: selectedTrackName,
    name,
    multiplier,
    description,
  };
  const result = applyToolCall(chatState, {
    name: 'bsDebugSetGestationModifier',
    arguments: {
      female: selectedTrackName,
      clear,
      name,
      multiplier: Number(multiplier || 1),
      description,
    },
  });
  if (!result?.applied) {
    globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 妊娠变速效果设置失败');
    return;
  }
  if (clear) {
    debugGestationModifierDraft = {
      owner: selectedTrackName,
      name: '',
      multiplier: '',
      description: '',
    };
  }
  recordChatStateSnapshot(ctx, chatState, { reason: clear ? 'debug_clear_gestation_modifier' : 'debug_set_gestation_modifier' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(
    clear
      ? `[BS BioTracker] 已清除 ${selectedTrackName} 的妊娠变速效果`
      : `[BS BioTracker] 已为 ${selectedTrackName} 设置妊娠变速效果`,
  );
}

function setSelectedTrackProdromal(ctx, progressPercent) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const result = applyToolCall(chatState, {
    name: 'bsDebugSetProdromal',
    arguments: {
      female: selectedTrackName,
      progressPercent: Number(progressPercent) || 0,
    },
  });
  if (!result?.applied) {
    globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 产兆前驱调试设置失败');
    return;
  }
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_set_prodromal' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(`[BS BioTracker] 已将 ${selectedTrackName} 的产兆前驱进度设为 ${Math.round(Number(progressPercent) || 0)}%`);
}

function triggerSelectedTrackFetalActivity(ctx, activityText) {
  if (!selectedTrackName) return;
  const text = String(activityText || '').trim();
  debugFetalActivityDraft = { owner: selectedTrackName, text };
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const result = applyToolCall(chatState, {
    name: 'bsDebugFetalActivity',
    arguments: {
      female: selectedTrackName,
      activityText: text,
    },
  });
  if (!result?.applied) {
    globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 胎儿自主活动触发失败');
    return;
  }
  debugFetalActivityDraft = { owner: selectedTrackName, text: '' };
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_fetal_activity' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(`[BS BioTracker] 已为 ${selectedTrackName} 触发胎儿自主活动`);
}

function clearSelectedTrackContainer(ctx, container) {
  if (!selectedTrackName) return;
  if (!['sperms', 'fetuses', 'children'].includes(container)) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const result = applyToolCall(chatState, {
    name: 'bsDebugClearContainers',
    arguments: {
      female: selectedTrackName,
      container,
    },
  });
  if (!result?.applied) {
    globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 容器淨空失败');
    return;
  }
  recordChatStateSnapshot(ctx, chatState, { reason: `debug_clear_${container}` });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  const label = container === 'sperms' ? '精液' : container === 'fetuses' ? '胎儿' : '孩子';
  globalThis.toastr?.success?.(`[BS BioTracker] 已为 ${selectedTrackName} 淨空${label}`);
}

function clampSelectedTrackExpansionCapacity(profile) {
  const metabolism = profile?.metabolism;
  if (!metabolism || typeof metabolism !== 'object') return;
  const expansionKey = String(profile?.pregnant?.expansion?.key || '');
  for (const key of METABOLISM_DISPLAY_ORDER) {
    const cap = expansionKey === key ? 200 : 150;
    metabolism[key] = Math.max(0, Math.min(cap, Number(metabolism[key]) || 0));
  }
  const flux = Number(metabolism.flux) || 0;
  const isExpandedFlux = (flux > 0 && expansionKey === 'fluxPositive') || (flux < 0 && expansionKey === 'fluxNegative');
  const fluxCap = isExpandedFlux ? 200 : 150;
  metabolism.flux = Math.max(-fluxCap, Math.min(fluxCap, flux));
}

function setSelectedTrackBlockage(ctx, key) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const character = chatState.characters?.[selectedTrackName];
  if (!character?.profile) return;

  const profile = character.profile;
  const derivedType = String(profile?.base?.derivedType || '').trim();
  const exemptions = derivedType ? new Set(getDerivedTypeMetabolismExemptions(derivedType)) : new Set();
  const allowed = new Set(METABOLISM_DISPLAY_ORDER.filter((item) => !exemptions.has(item)));
  if (derivedType) {
    allowed.add('fluxPositive');
    allowed.add('fluxNegative');
  }

  const nextKey = String(key || '').trim();
  profile.pregnant = profile.pregnant && typeof profile.pregnant === 'object' ? profile.pregnant : {};
  if (!nextKey) {
    profile.pregnant.blockage = null;
  } else if (!allowed.has(nextKey)) {
    globalThis.toastr?.warning?.('[BS BioTracker] 该角色不能使用这个妊娠阻塞项');
    return;
  } else {
    profile.pregnant.blockage = {
      key: nextKey,
      severity: DEBUG_BLOCKAGE_DEFAULT_SEVERITY[nextKey] || 0.5,
    };
    if (profile.pregnant.acceleration?.key === nextKey) profile.pregnant.acceleration = null;
    if (profile.pregnant.expansion?.key === nextKey) profile.pregnant.expansion = null;
  }

  clampSelectedTrackExpansionCapacity(profile);
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_set_pregnancy_blockage' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(
    nextKey
      ? `[BS BioTracker] 已设置 ${selectedTrackName} 的妊娠阻塞：${DEBUG_BLOCKAGE_LABELS[nextKey] || nextKey}`
      : `[BS BioTracker] 已清除 ${selectedTrackName} 的妊娠阻塞`,
  );
}

function setSelectedTrackAcceleration(ctx, key) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const character = chatState.characters?.[selectedTrackName];
  if (!character?.profile) return;

  const profile = character.profile;
  const derivedType = String(profile?.base?.derivedType || '').trim();
  const exemptions = derivedType ? new Set(getDerivedTypeMetabolismExemptions(derivedType)) : new Set();
  const allowed = new Set(METABOLISM_DISPLAY_ORDER.filter((item) => !exemptions.has(item)));
  if (derivedType) {
    allowed.add('fluxPositive');
    allowed.add('fluxNegative');
  }
  const nextKey = String(key || '').trim();
  profile.pregnant = profile.pregnant && typeof profile.pregnant === 'object' ? profile.pregnant : {};
  if (!nextKey) {
    profile.pregnant.acceleration = null;
  } else if (!allowed.has(nextKey)) {
    globalThis.toastr?.warning?.('[BS BioTracker] 该角色不能使用这个妊娠快积项');
    return;
  } else {
    profile.pregnant.acceleration = {
      key: nextKey,
      severity: DEBUG_BLOCKAGE_DEFAULT_SEVERITY[nextKey] || 0.5,
    };
    if (profile.pregnant.blockage?.key === nextKey) profile.pregnant.blockage = null;
    if (profile.pregnant.expansion?.key === nextKey) profile.pregnant.expansion = null;
  }
  clampSelectedTrackExpansionCapacity(profile);
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_set_pregnancy_acceleration' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(
    nextKey
      ? `[BS BioTracker] 已设置 ${selectedTrackName} 的妊娠快积：${DEBUG_BLOCKAGE_LABELS[nextKey] || nextKey}`
      : `[BS BioTracker] 已清除 ${selectedTrackName} 的妊娠快积`,
  );
}

function setSelectedTrackExpansion(ctx, key) {
  if (!selectedTrackName) return;
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const character = chatState.characters?.[selectedTrackName];
  if (!character?.profile) return;

  const profile = character.profile;
  const derivedType = String(profile?.base?.derivedType || '').trim();
  const exemptions = derivedType ? new Set(getDerivedTypeMetabolismExemptions(derivedType)) : new Set();
  const allowed = new Set(METABOLISM_DISPLAY_ORDER.filter((item) => !exemptions.has(item)));
  if (derivedType) {
    allowed.add('fluxPositive');
    allowed.add('fluxNegative');
  }
  const nextKey = String(key || '').trim();
  profile.pregnant = profile.pregnant && typeof profile.pregnant === 'object' ? profile.pregnant : {};
  if (!nextKey) {
    profile.pregnant.expansion = null;
  } else if (!allowed.has(nextKey)) {
    globalThis.toastr?.warning?.('[BS BioTracker] 该角色不能使用这个妊娠扩容项');
    return;
  } else {
    profile.pregnant.expansion = { key: nextKey, severity: 1 };
    if (profile.pregnant.blockage?.key === nextKey) profile.pregnant.blockage = null;
    if (profile.pregnant.acceleration?.key === nextKey) profile.pregnant.acceleration = null;
  }
  clampSelectedTrackExpansionCapacity(profile);
  recordChatStateSnapshot(ctx, chatState, { reason: 'debug_set_pregnancy_expansion' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  globalThis.toastr?.success?.(
    nextKey
      ? `[BS BioTracker] 已设置 ${selectedTrackName} 的妊娠扩容：${DEBUG_BLOCKAGE_LABELS[nextKey] || nextKey}`
      : `[BS BioTracker] 已清除 ${selectedTrackName} 的妊娠扩容`,
  );
}

function bindDebugPanelControls(ctx, root, refresh = () => renderFullStatePage(ctx)) {
  if (!root) return;
  root.querySelectorAll('[data-debug-immune]').forEach((node) =>
    node.addEventListener('click', () => {
      toggleSelectedTrackImmune(ctx, String(node.dataset.debugImmune || ''));
    }),
  );
  root.querySelectorAll('[data-debug-action="inject-pregnancy"]').forEach((node) =>
    node.addEventListener('click', () => {
      injectSelectedTrackPregnancy(ctx);
    }),
  );
  root.querySelectorAll('[data-debug-action="toggle-presence"]').forEach((node) =>
    node.addEventListener('click', () => {
      toggleSelectedTrackPresence(ctx);
    }),
  );
  root.querySelectorAll('[data-debug-action="set-gestation-modifier"]').forEach((node) =>
    node.addEventListener('click', () => {
      applySelectedTrackGestationModifier(ctx, false);
    }),
  );
  root.querySelectorAll('[data-debug-action="clear-gestation-modifier"]').forEach((node) =>
    node.addEventListener('click', () => {
      applySelectedTrackGestationModifier(ctx, true);
    }),
  );
  root.querySelectorAll('[data-debug-action="set-prodromal"]').forEach((node) =>
    node.addEventListener('click', () => {
      const progressPercent = root.querySelector('#bs-bt-debug-prodromal-progress')?.value || '0';
      setSelectedTrackProdromal(ctx, progressPercent);
    }),
  );
  root.querySelectorAll('[data-debug-action="fetal-activity"]').forEach((node) =>
    node.addEventListener('click', () => {
      const activityText = root.querySelector('#bs-bt-debug-fetal-activity')?.value || '';
      triggerSelectedTrackFetalActivity(ctx, activityText);
    }),
  );
  root.querySelectorAll('[data-debug-action="set-phase"]').forEach((node) =>
    node.addEventListener('click', () => {
      const stage = root.querySelector('#bs-bt-debug-phase-select')?.value;
      if (!stage || !selectedTrackName) return;
      const settings = getSettings(ctx);
      const chatState = getChatState(ctx, settings);
      const result = applyToolCall(chatState, {
        name: 'bsSetMenstrualPhases',
        arguments: { female: selectedTrackName, stage },
      });
      if (!result?.applied) {
        globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 切换失败');
        return;
      }
      recordChatStateSnapshot(ctx, chatState, { reason: 'debug_set_phase' });
      saveSettings(ctx);
      renderStatusPanel(ctx);
      renderFullStatePage(ctx);
      globalThis.toastr?.success?.(`[BS BioTracker] 已强制将 ${selectedTrackName} 切換至 ${stage}`);
    }),
  );
  root.querySelectorAll('[data-debug-action="set-blockage"]').forEach((node) =>
    node.addEventListener('click', () => {
      const key = root.querySelector('#bs-bt-debug-blockage-select')?.value || '';
      setSelectedTrackBlockage(ctx, key);
    }),
  );
  root.querySelectorAll('[data-debug-action="set-acceleration"]').forEach((node) =>
    node.addEventListener('click', () => {
      const key = root.querySelector('#bs-bt-debug-acceleration-select')?.value || '';
      setSelectedTrackAcceleration(ctx, key);
    }),
  );
  root.querySelectorAll('[data-debug-action="set-expansion"]').forEach((node) =>
    node.addEventListener('click', () => {
      const key = root.querySelector('#bs-bt-debug-expansion-select')?.value || '';
      setSelectedTrackExpansion(ctx, key);
    }),
  );
  root.querySelectorAll('[data-debug-clear]').forEach((node) =>
    node.addEventListener('click', () => {
      clearSelectedTrackContainer(ctx, String(node.getAttribute('data-debug-clear') || ''));
    }),
  );
  root.querySelector('#bs-bt-debug-father')?.addEventListener('input', (event) => {
    debugInjectDraft.father = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-debug-race')?.addEventListener('input', (event) => {
    debugInjectDraft.race = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-debug-count')?.addEventListener('input', (event) => {
    debugInjectDraft.fetusCount = String(event.target?.value || '1');
  });
  root.querySelector('#bs-bt-debug-genders')?.addEventListener('input', (event) => {
    debugInjectDraft.genders = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-debug-days')?.addEventListener('input', (event) => {
    debugInjectDraft.equivalentDays = String(event.target?.value || '0');
  });
  root.querySelector('#bs-bt-debug-prodromal-progress')?.addEventListener('input', (event) => {
    const output = root.querySelector('#bs-bt-debug-prodromal-output');
    if (output) output.textContent = `${String(event.target?.value || '0')}%`;
  });
  root.querySelector('#bs-bt-debug-fetal-activity')?.addEventListener('input', (event) => {
    debugFetalActivityDraft.owner = selectedTrackName;
    debugFetalActivityDraft.text = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-debug-gestation-name')?.addEventListener('input', (event) => {
    debugGestationModifierDraft.owner = selectedTrackName;
    debugGestationModifierDraft.name = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-debug-gestation-multiplier')?.addEventListener('input', (event) => {
    debugGestationModifierDraft.owner = selectedTrackName;
    debugGestationModifierDraft.multiplier = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-debug-gestation-description')?.addEventListener('input', (event) => {
    debugGestationModifierDraft.owner = selectedTrackName;
    debugGestationModifierDraft.description = String(event.target?.value || '');
  });
  root.querySelectorAll('[data-race-picker-target]').forEach((node) =>
    node.addEventListener('click', () => {
      const target = String(node.dataset.racePickerTarget || '');
      if (racePaletteState.isOpen && racePaletteState.targetInputId === target) closeRacePalettePopover();
      else openRacePalettePopover(target);
      refresh();
    }),
  );
  root.querySelector('#bs-bt-race-derived')?.addEventListener('change', (event) => {
    racePaletteState.selectedDerivedType = String(event.target?.value || '');
    refresh();
  });
  root.querySelector('#bs-bt-race-derived-subtype')?.addEventListener('input', (event) => {
    racePaletteState.derivedSubtype = String(event.target?.value || '');
  });
  root.querySelector('#bs-bt-race-primary')?.addEventListener('change', (event) => {
    racePaletteState.selectedRace = String(event.target?.value || '人类');
    refresh();
  });
  root.querySelector('#bs-bt-race-subtype')?.addEventListener('input', (event) => {
    racePaletteState.subtype = String(event.target?.value || '');
  });
  root.querySelectorAll('[data-race-remove-index]').forEach((node) =>
    node.addEventListener('click', () => {
      const index = Number(node.getAttribute('data-race-remove-index'));
      if (!Number.isInteger(index) || index < 0) return;
      racePaletteState.raceTags = racePaletteState.raceTags.filter((_, entryIndex) => entryIndex !== index);
      refresh();
    }),
  );
  root.querySelector('[data-race-action="append"]')?.addEventListener('click', () => {
    const raceName = String(racePaletteState.selectedRace || '').trim();
    const subtype = String(racePaletteState.subtype || '').trim();
    const raceTag = raceName ? `${raceName}${subtype ? `-${subtype}` : ''}` : '';
    if (!raceTag) {
      globalThis.toastr?.warning?.('[BS BioTracker] 请先选择种族');
      return;
    }
    racePaletteState.raceTags = [...racePaletteState.raceTags, raceTag];
    racePaletteState.selectedRace = '人类';
    racePaletteState.subtype = '';
    refresh();
  });
  root.querySelector('[data-race-action="cancel"]')?.addEventListener('click', () => {
    closeRacePalettePopover();
    refresh();
    refreshRegisterRacePalette();
  });
  root.querySelector('[data-race-action="confirm"]')?.addEventListener('click', () => {
    const descriptor = buildRacePaletteDescriptor(racePaletteState);
    if (!descriptor) {
      globalThis.toastr?.warning?.('[BS BioTracker] 请先加入至少一个种族 tag');
      return;
    }
    const target = document.getElementById(racePaletteState.targetInputId);
    if (!target) return;
    const current = String(target.value || '').trim();
    target.value = isRegisterRaceTarget(racePaletteState.targetInputId) ? descriptor : (current ? `${current},${descriptor}` : descriptor);
    if (racePaletteState.targetInputId === 'bs-bt-debug-race') {
      debugInjectDraft.race = target.value;
    }
    closeRacePalettePopover();
    refresh();
    refreshRegisterRacePalette();
  });
}

function openRacePalettePopover(targetInputId) {
  racePaletteState = {
    targetInputId,
    isOpen: true,
    selectedRace: '人类',
    selectedDerivedType: '',
    derivedSubtype: '',
    subtype: '',
    raceTags: [],
  };
}

function closeRacePalettePopover() {
  racePaletteState.isOpen = false;
}

function refreshRegisterRacePalette() {
  const anchor = document.getElementById('bs-bt-register-race-palette-anchor');
  if (!anchor) return;
  anchor.innerHTML = racePaletteState.targetInputId === 'bs-bt-register-race' && racePaletteState.isOpen
    ? `<div class="bs-bt-race-popover">${renderRacePaletteBody()}</div>`
    : '';
}

function populateModelList(settings) {
  const select = document.getElementById('bs-bt-model-list');
  if (!select) return;
  const models = Array.isArray(settings.modelOptions) ? settings.modelOptions : [];
  select.innerHTML = '';
  if (models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '请先连接并拉取模型';
    select.appendChild(option);
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选择一个模型';
  select.appendChild(placeholder);
  for (const modelId of models) {
    const option = document.createElement('option');
    option.value = modelId;
    option.textContent = modelId;
    if (modelId === settings.model) option.selected = true;
    select.appendChild(option);
  }
}

async function connectAndLoadModels(ctx) {
  const settings = getSettings(ctx);
  const button = document.getElementById('bs-bt-connect');
  if (button) button.disabled = true;
  setConnectStatus('连接中，正在拉取模型...');
  try {
    const models = await fetchModelList(settings);
    settings.modelOptions = models;
    if (!settings.model || !models.includes(settings.model)) settings.model = models[0];
    saveSettings(ctx);
    populateModelList(settings);
    const modelInput = document.getElementById('bs-bt-model');
    if (modelInput) modelInput.value = settings.model;
    setConnectStatus(`已连接，拉取到 ${models.length} 个模型`);
    globalThis.toastr?.success?.(`[BS BioTracker] 已拉取 ${models.length} 个模型`);
  } catch (error) {
    console.error('[BS BioTracker] connectAndLoadModels failed', error);
    setConnectStatus(String(error?.message || error), true);
    globalThis.toastr?.error?.(String(error?.message || error), '[BS BioTracker]');
  } finally {
    if (button) button.disabled = false;
  }
}

function renderStatusPanel(ctx) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const characters = Object.values(chatState.characters || {});
  const list = document.getElementById('bs-bt-track-character-list');
  const latestCall = document.getElementById('bs-bt-track-last-call');
  const content = document.getElementById('bs-bt-track-content');
  const tabs = document.querySelectorAll('#bs-bt-track-tabs .bs-bt-track-tab');
  if (!list) return;
  updateBatteryIndicator(settings);

  list.innerHTML = '';
  if (latestCall) {
    const toolCalls = Array.isArray(chatState.lastRawResult?.tool_calls) ? chatState.lastRawResult.tool_calls : [];
    const operationLogs = Array.isArray(chatState.lastOperationLogs) ? chatState.lastOperationLogs : [];
    if (toolCalls.length > 0 || operationLogs.length > 0) {
      const toolCallView = { tool_calls: toolCalls };
      if (chatState.lastRawResult?.message) toolCallView.message = chatState.lastRawResult.message;
      if (chatState.lastRawResult?.error) toolCallView.error = chatState.lastRawResult.error;
      latestCall.innerHTML = [
        `<pre class="bs-bt-debug-json">${escapeHtml(JSON.stringify(toolCallView, null, 2))}</pre>`,
        operationLogs.length > 0
          ? `<details class="bs-bt-debug-details"><summary>执行结果 (${operationLogs.length})</summary><pre class="bs-bt-debug-json">${escapeHtml(JSON.stringify(operationLogs, null, 2))}</pre></details>`
          : '',
      ].join('');
    } else {
      latestCall.textContent = chatState.lastRawResult
        ? JSON.stringify(chatState.lastRawResult, null, 2)
        : '尚无数据';
    }
  }

  if (characters.length === 0) {
    selectedTrackName = '';
    if (content) content.innerHTML = '';
    return;
  }

  const activeNames = characters.filter((item) => item?.profile?.base?.isHere !== false).map((item) => item.name).filter(Boolean);
  if (!activeNames.includes(selectedTrackName)) selectedTrackName = '';
  if (!TRACK_SUBPAGES.includes(selectedTrackSubpage)) selectedTrackSubpage = 'overview';

  for (const item of characters) {
    const name = item.name;
    const stage = String(item?.profile?.base?.stage || '未设定');
    const isDisabled = item?.profile?.base?.isHere === false;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `bs-bt-track-character-button${name === selectedTrackName ? ' is-active' : ''}`;
    button.disabled = isDisabled;
    button.innerHTML = `<span class="bs-bt-track-character-name">${escapeHtml(name)}</span><span class="bs-bt-track-character-stage">${escapeHtml(stage)}</span>`;
    if (!isDisabled) {
      button.addEventListener('click', () => {
        selectedTrackName = name;
        renderStatusPanel(ctx);
        setView('track-char');
      });
    }
    list.appendChild(button);
  }

  if (!content) return;
  tabs.forEach((node) => {
    node.classList.toggle('is-active', node.dataset.trackTab === selectedTrackSubpage);
  });

  if (!selectedTrackName) {
    content.innerHTML = '';
    return;
  }

  const current = characters.find((item) => item.name === selectedTrackName);
  const viewModel = buildTrackCharacterViewModel(current);
  content.innerHTML = renderTrackCharacterContent(viewModel);
  content.querySelectorAll('[data-card-nav]').forEach((node) =>
    node.addEventListener('click', () => {
      const kind = String(node.getAttribute('data-card-nav') || '').trim();
      const step = Number(node.getAttribute('data-card-step') || 0);
      if (!kind || !step) return;
      let items = [];
      if (kind === 'sperms') items = Array.isArray(viewModel?.pregnancy?.sperms) ? viewModel.pregnancy.sperms : [];
      if (kind === 'fetuses') items = Array.isArray(viewModel?.pregnancy?.fetuses) ? viewModel.pregnancy.fetuses : [];
      if (kind === 'children') items = Array.isArray(viewModel?.experience?.children) ? viewModel.experience.children : [];
      if (kind === 'diary') items = Array.isArray(viewModel?.diary?.entries) ? viewModel.diary.entries : [];
      if (items.length <= 1) return;
      const currentIndex = getTrackCardIndex(kind, items.length);
      const nextIndex = (currentIndex + step + items.length) % items.length;
      setTrackCardIndex(kind, nextIndex, items.length);
      renderStatusPanel(ctx);
    }),
  );
  content.querySelectorAll('[data-debug-immune]').forEach((node) =>
    node.addEventListener('click', () => {
      toggleSelectedTrackImmune(ctx, String(node.dataset.debugImmune || ''));
    }),
  );
  content.querySelectorAll('[data-debug-action="inject-pregnancy"]').forEach((node) =>
    node.addEventListener('click', () => {
      injectSelectedTrackPregnancy(ctx);
    }),
  );
  content.querySelectorAll('[data-debug-action="set-gestation-modifier"]').forEach((node) =>
    node.addEventListener('click', () => {
      applySelectedTrackGestationModifier(ctx, false);
    }),
  );
  content.querySelectorAll('[data-debug-action="clear-gestation-modifier"]').forEach((node) =>
    node.addEventListener('click', () => {
      applySelectedTrackGestationModifier(ctx, true);
    }),
  );
  content.querySelectorAll('[data-debug-action="set-blockage"]').forEach((node) =>
    node.addEventListener('click', () => {
      const key = content.querySelector('#bs-bt-debug-blockage-select')?.value || '';
      setSelectedTrackBlockage(ctx, key);
    }),
  );
  content.querySelectorAll('[data-debug-action="set-acceleration"]').forEach((node) =>
    node.addEventListener('click', () => {
      const key = content.querySelector('#bs-bt-debug-acceleration-select')?.value || '';
      setSelectedTrackAcceleration(ctx, key);
    }),
  );
  content.querySelectorAll('[data-debug-action="set-expansion"]').forEach((node) =>
    node.addEventListener('click', () => {
      const key = content.querySelector('#bs-bt-debug-expansion-select')?.value || '';
      setSelectedTrackExpansion(ctx, key);
    }),
  );
  content.querySelectorAll('[data-debug-action="set-prodromal"]').forEach((node) =>
    node.addEventListener('click', () => {
      const progressPercent = content.querySelector('#bs-bt-debug-prodromal-progress')?.value || '0';
      setSelectedTrackProdromal(ctx, progressPercent);
    }),
  );
  content.querySelectorAll('[data-debug-action="fetal-activity"]').forEach((node) =>
    node.addEventListener('click', () => {
      const activityText = content.querySelector('#bs-bt-debug-fetal-activity')?.value || '';
      triggerSelectedTrackFetalActivity(ctx, activityText);
    }),
  );
  content.querySelectorAll('[data-debug-action="set-phase"]').forEach((node) =>
    node.addEventListener('click', () => {
      const stage = content.querySelector('#bs-bt-debug-phase-select')?.value;
      if (!stage || !selectedTrackName) return;
      const settings = getSettings(ctx);
      const chatState = getChatState(ctx, settings);
      const result = applyToolCall(chatState, {
        name: 'bsSetMenstrualPhases',
        arguments: { female: selectedTrackName, stage },
      });
      if (!result?.applied) {
        globalThis.toastr?.warning?.(result?.message || '[BS BioTracker] 切换失败');
        return;
      }
      recordChatStateSnapshot(ctx, chatState, { reason: 'debug_set_phase' });
      saveSettings(ctx);
      renderStatusPanel(ctx);
      globalThis.toastr?.success?.(`[BS BioTracker] 已强制将 ${selectedTrackName} 切換至 ${stage}`);
    }),
  );
  content.querySelectorAll('[data-debug-clear]').forEach((node) =>
    node.addEventListener('click', () => {
      clearSelectedTrackContainer(ctx, String(node.getAttribute('data-debug-clear') || ''));
    }),
  );
  content.querySelector('#bs-bt-debug-father')?.addEventListener('input', (event) => {
    debugInjectDraft.father = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-debug-race')?.addEventListener('input', (event) => {
    debugInjectDraft.race = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-debug-count')?.addEventListener('input', (event) => {
    debugInjectDraft.fetusCount = String(event.target?.value || '1');
  });
  content.querySelector('#bs-bt-debug-genders')?.addEventListener('input', (event) => {
    debugInjectDraft.genders = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-debug-days')?.addEventListener('input', (event) => {
    debugInjectDraft.equivalentDays = String(event.target?.value || '0');
  });
  content.querySelector('#bs-bt-debug-prodromal-progress')?.addEventListener('input', (event) => {
    const output = content.querySelector('#bs-bt-debug-prodromal-output');
    if (output) output.textContent = `${String(event.target?.value || '0')}%`;
  });
  content.querySelector('#bs-bt-debug-fetal-activity')?.addEventListener('input', (event) => {
    debugFetalActivityDraft.owner = selectedTrackName;
    debugFetalActivityDraft.text = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-debug-gestation-name')?.addEventListener('input', (event) => {
    debugGestationModifierDraft.owner = selectedTrackName;
    debugGestationModifierDraft.name = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-debug-gestation-multiplier')?.addEventListener('input', (event) => {
    debugGestationModifierDraft.owner = selectedTrackName;
    debugGestationModifierDraft.multiplier = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-debug-gestation-description')?.addEventListener('input', (event) => {
    debugGestationModifierDraft.owner = selectedTrackName;
    debugGestationModifierDraft.description = String(event.target?.value || '');
  });
  content.querySelectorAll('[data-race-picker-target]').forEach((node) =>
    node.addEventListener('click', () => {
      const target = String(node.dataset.racePickerTarget || '');
      if (racePaletteState.isOpen && racePaletteState.targetInputId === target) closeRacePalettePopover();
      else openRacePalettePopover(target);
      renderStatusPanel(ctx);
    }),
  );
  content.querySelector('#bs-bt-race-derived')?.addEventListener('change', (event) => {
    racePaletteState.selectedDerivedType = String(event.target?.value || '');
    renderStatusPanel(ctx);
  });
  content.querySelector('#bs-bt-race-derived-subtype')?.addEventListener('input', (event) => {
    racePaletteState.derivedSubtype = String(event.target?.value || '');
  });
  content.querySelector('#bs-bt-race-primary')?.addEventListener('change', (event) => {
    racePaletteState.selectedRace = String(event.target?.value || '人类');
    renderStatusPanel(ctx);
  });
  content.querySelector('#bs-bt-race-subtype')?.addEventListener('input', (event) => {
    racePaletteState.subtype = String(event.target?.value || '');
  });
  content.querySelectorAll('[data-race-remove-index]').forEach((node) =>
    node.addEventListener('click', () => {
      const index = Number(node.getAttribute('data-race-remove-index'));
      if (!Number.isInteger(index) || index < 0) return;
      racePaletteState.raceTags = racePaletteState.raceTags.filter((_, entryIndex) => entryIndex !== index);
      renderStatusPanel(ctx);
    }),
  );
  content.querySelector('[data-race-action="append"]')?.addEventListener('click', () => {
    const raceName = String(racePaletteState.selectedRace || '').trim();
    const subtype = String(racePaletteState.subtype || '').trim();
    const raceTag = raceName ? `${raceName}${subtype ? `-${subtype}` : ''}` : '';
    if (!raceTag) {
      globalThis.toastr?.warning?.('[BS BioTracker] 请先选择种族');
      return;
    }
    racePaletteState.raceTags = [...racePaletteState.raceTags, raceTag];
    racePaletteState.selectedRace = '人类';
    racePaletteState.subtype = '';
    renderStatusPanel(ctx);
  });
  content.querySelector('[data-race-action="cancel"]')?.addEventListener('click', () => {
    closeRacePalettePopover();
    renderStatusPanel(ctx);
    refreshRegisterRacePalette();
  });
  content.querySelector('[data-race-action="confirm"]')?.addEventListener('click', () => {
    const descriptor = buildRacePaletteDescriptor(racePaletteState);
    if (!descriptor) {
      globalThis.toastr?.warning?.('[BS BioTracker] 请先加入至少一个种族 tag');
      return;
    }
    const target = document.getElementById(racePaletteState.targetInputId);
    if (!target) return;
    const current = String(target.value || '').trim();
    target.value = isRegisterRaceTarget(racePaletteState.targetInputId) ? descriptor : (current ? `${current},${descriptor}` : descriptor);
    if (racePaletteState.targetInputId === 'bs-bt-debug-race') {
      debugInjectDraft.race = target.value;
    }
    closeRacePalettePopover();
    renderStatusPanel(ctx);
    refreshRegisterRacePalette();
  });
}

function closeFullStateConfirm() {
  const box = document.getElementById('bs-bt-full-state-confirm');
  const textEl = document.getElementById('bs-bt-full-state-confirm-text');
  if (box) box.style.display = 'none';
  if (textEl) textEl.textContent = '请选择角色。';
}

function setFullStateEditStatus(message, kind = 'info') {
  const status = document.getElementById('bs-bt-full-state-edit-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function updateFullStateControls() {
  const button = document.getElementById('bs-bt-full-state-unregister');
  const applyButton = document.getElementById('bs-bt-full-state-apply');
  const resetButton = document.getElementById('bs-bt-full-state-reset');
  if (!selectedFullStateName) {
    if (button) {
      button.disabled = true;
      button.textContent = '注销当前角色';
    }
    if (applyButton) applyButton.disabled = true;
    if (resetButton) resetButton.disabled = true;
    return;
  }
  if (button) {
    button.disabled = false;
    button.textContent = `注销当前角色：${selectedFullStateName}`;
  }
  if (applyButton) applyButton.disabled = false;
  if (resetButton) resetButton.disabled = false;
}

function updateFullStateSubpage() {
  if (!['variables', 'debug'].includes(selectedFullStateSubpage)) selectedFullStateSubpage = 'variables';
  const hasSelectedCharacter = Boolean(selectedFullStateName);
  const tabs = document.getElementById('bs-bt-full-state-tabs');
  const varsPanel = document.getElementById('bs-bt-full-state-vars-panel');
  const debugSection = document.getElementById('bs-bt-full-state-debug-section');
  if (tabs?.parentElement) tabs.parentElement.hidden = !hasSelectedCharacter;
  if (varsPanel) varsPanel.hidden = !hasSelectedCharacter || selectedFullStateSubpage !== 'variables';
  if (debugSection) debugSection.hidden = !hasSelectedCharacter || selectedFullStateSubpage !== 'debug';
  document.querySelectorAll('#bs-bt-full-state-tabs [data-full-state-tab]').forEach((node) => {
    node.classList.toggle('is-active', String(node.getAttribute('data-full-state-tab') || '') === selectedFullStateSubpage);
  });
}

function getFullStateEditorText(character) {
  return JSON.stringify(cloneJsonValue(character), null, 2);
}

function renderSelectedFullStateEditor(ctx) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const output = document.getElementById('bs-bt-full-state-output');
  if (!output) return;
  if (selectedFullStateName && chatState.characters?.[selectedFullStateName]) {
    output.value = getFullStateEditorText(chatState.characters[selectedFullStateName]);
    setFullStateEditStatus('可直接编辑 JSON，应用前会检查格式与基础结构。');
  } else {
    output.value = '请选择角色查看完整变量。';
    setFullStateEditStatus('请选择角色后再编辑。');
  }
  updateFullStateControls();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateManualCharacterState(next, currentName) {
  const errors = [];
  if (!isPlainObject(next)) errors.push('顶层必须是 JSON 对象。');
  if (!errors.length && String(next.name || '').trim() !== currentName) errors.push('不能在这里修改角色 name；请保持与当前选中角色一致。');
  if (!isPlainObject(next.profile)) errors.push('profile 必须是对象。');

  const profile = isPlainObject(next.profile) ? next.profile : {};
  for (const path of ['base', 'pregnant', 'experience', 'bio', 'metabolism', 'notify', 'immune', 'psychology', 'wardrobe', 'outfit', 'descriptions', 'cooldown']) {
    if (profile[path] !== undefined && !isPlainObject(profile[path])) errors.push(`profile.${path} 必须是对象。`);
  }
  if (profile.children !== undefined && !Array.isArray(profile.children)) errors.push('profile.children 必须是数组。');
  if (profile.base?.sperms !== undefined && !Array.isArray(profile.base.sperms)) errors.push('profile.base.sperms 必须是数组。');
  if (profile.pregnant?.fetuses !== undefined && !Array.isArray(profile.pregnant.fetuses)) errors.push('profile.pregnant.fetuses 必须是数组。');
  if (profile.base?.stage !== undefined && typeof profile.base.stage !== 'string') errors.push('profile.base.stage 必须是文字。');

  const numericPaths = [
    ['profile', 'base', 'days'],
    ['profile', 'base', 'age'],
    ['profile', 'base', 'vitality'],
    ['profile', 'base', 'vitalityLevel'],
    ['profile', 'base', 'psyStress'],
    ['profile', 'base', 'psyStressLevel'],
    ['profile', 'base', 'libido'],
    ['profile', 'base', 'fertilizationDays'],
    ['profile', 'base', 'uterinePressure'],
    ['profile', 'pregnant', 'pregnantDays'],
    ['profile', 'pregnant', 'effectivePregnantDays'],
    ['profile', 'pregnant', 'laborHours'],
    ['profile', 'pregnant', 'effectiveLaborHours'],
    ['profile', 'pregnant', 'laborFetusIndex'],
    ['profile', 'pregnant', 'laborPain'],
    ['profile', 'pregnant', 'prodromalRemainingHours'],
    ['profile', 'pregnant', 'prodromalDelayProgressHours'],
    ['profile', 'pregnant', 'fetusesCount'],
    ['profile', 'pregnant', 'fetalEnergyDrain'],
    ['profile', 'pregnant', 'amnionDurability'],
  ];
  for (const path of numericPaths) {
    let current = next;
    for (const key of path) current = current?.[key];
    if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current))) errors.push(`${path.join('.')} 必须是有限数字。`);
  }

  if (typeof profile.base?.days === 'number' && profile.base.days < 1) errors.push('profile.base.days 必须大于等于 1。');
  if (typeof profile.base?.vitalityLevel === 'number' && (profile.base.vitalityLevel < 1 || profile.base.vitalityLevel > 7)) errors.push('profile.base.vitalityLevel 必须在 1 到 7 之间。');
  if (typeof profile.base?.psyStressLevel === 'number' && (profile.base.psyStressLevel < 1 || profile.base.psyStressLevel > 7)) errors.push('profile.base.psyStressLevel 必须在 1 到 7 之间。');

  if (errors.length > 0) return { ok: false, errors };

  const normalized = normalizeCharacterPsychologyState(cloneJsonValue(next));
  if (Array.isArray(normalized.profile?.pregnant?.fetuses)) {
    normalized.profile.pregnant.fetusesCount = normalized.profile.pregnant.fetuses.length;
  }
  return { ok: true, value: normalized };
}

function applyFullStateManualEdit(ctx) {
  if (!selectedFullStateName) {
    globalThis.toastr?.warning?.('[BS BioTracker] 请先选择角色');
    return;
  }
  const output = document.getElementById('bs-bt-full-state-output');
  if (!output) return;
  let parsed;
  try {
    parsed = JSON.parse(String(output.value || ''));
  } catch (error) {
    const message = `JSON 格式错误：${String(error?.message || error)}`;
    setFullStateEditStatus(message, 'error');
    globalThis.toastr?.error?.(`[BS BioTracker] ${message}`);
    return;
  }

  const result = validateManualCharacterState(parsed, selectedFullStateName);
  if (!result.ok) {
    const message = `无法应用修改：\n${result.errors.map((item) => `- ${item}`).join('\n')}`;
    setFullStateEditStatus(message, 'error');
    globalThis.toastr?.error?.('[BS BioTracker] 变量检查未通过');
    return;
  }

  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  if (!chatState.characters?.[selectedFullStateName]) {
    globalThis.toastr?.warning?.(`[BS BioTracker] 找不到角色 ${selectedFullStateName}`);
    renderFullStatePage(ctx);
    return;
  }
  chatState.characters[selectedFullStateName] = result.value;
  recordChatStateSnapshot(ctx, chatState, { reason: 'manual_full_state_edit' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
  setFullStateEditStatus(`已应用 ${selectedFullStateName} 的变量修改。`, 'success');
  globalThis.toastr?.success?.(`[BS BioTracker] 已应用 ${selectedFullStateName} 的变量修改`);
}

function showFullState(ctx, name) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const target = chatState.characters[name];
  if (!target) {
    globalThis.toastr?.warning?.(`[BS BioTracker] 找不到角色 ${name}`);
    return;
  }
  selectedFullStateName = name;
  selectedFullStateSubpage = ['variables', 'debug'].includes(selectedFullStateSubpage) ? selectedFullStateSubpage : 'variables';
  renderFullStatePage(ctx);
  setView('full-state');
  globalThis.toastr?.success?.(`[BS BioTracker] 已显示 ${name} 的完整变量`);
}

function openFullStateMenu(ctx) {
  selectedFullStateName = '';
  selectedFullStateSubpage = 'variables';
  closeFullStateConfirm();
  renderFullStatePage(ctx);
  setView('full-state');
}

function openFullStateConfirm() {
  if (!selectedFullStateName) {
    globalThis.toastr?.warning?.('[BS BioTracker] 请先选择角色');
    return;
  }
  const box = document.getElementById('bs-bt-full-state-confirm');
  const textEl = document.getElementById('bs-bt-full-state-confirm-text');
  if (textEl) textEl.textContent = `确定要注销角色 ${selectedFullStateName} 吗？`;
  if (box) {
    box.style.display = '';
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function unregisterCharacter(ctx, name) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  if (!chatState.characters[name]) {
    globalThis.toastr?.warning?.(`[BS BioTracker] 找不到角色 ${name}`);
    return;
  }
  delete chatState.characters[name];
  recordChatStateSnapshot(ctx, chatState, { reason: 'unregister' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  updateMainFlowPrompt(ctx);
  globalThis.toastr?.success?.(`[BS BioTracker] 已注销 ${name}`);
}

function renderFullStatePage(ctx) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const list = document.getElementById('bs-bt-home-full-state-list');
  const output = document.getElementById('bs-bt-full-state-output');
  const debugPanel = document.getElementById('bs-bt-full-state-debug-panel');
  if (!list || !output) return;
  const names = Object.keys(chatState.characters || {});
  list.innerHTML = '';
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bs-bt-connect-status';
    empty.textContent = '当前聊天没有已注册角色';
    list.appendChild(empty);
    selectedFullStateName = '';
    output.value = '请选择角色查看完整变量。';
    setFullStateEditStatus('请选择角色后再编辑。');
    if (debugPanel) debugPanel.innerHTML = '<div class="bs-bt-connect-status">请选择角色后使用调试工具。</div>';
    updateFullStateControls();
    updateFullStateSubpage();
    closeFullStateConfirm();
    return;
  }

  if (selectedFullStateName && !chatState.characters[selectedFullStateName]) selectedFullStateName = '';

  for (const name of names) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `bs-bt-theme-option${name === selectedFullStateName ? ' is-active' : ''}`;
    button.textContent = name;
    button.addEventListener('click', () => showFullState(ctx, name));
    list.appendChild(button);
  }

  if (selectedFullStateName && chatState.characters[selectedFullStateName]) {
    const current = chatState.characters[selectedFullStateName];
    selectedTrackName = selectedFullStateName;
    output.value = getFullStateEditorText(current);
    setFullStateEditStatus('可直接编辑 JSON，应用前会检查格式与基础结构。');
    if (debugPanel) {
      debugPanel.innerHTML = renderTrackDebug(buildTrackCharacterViewModel(current));
      bindDebugPanelControls(ctx, debugPanel, () => renderFullStatePage(ctx));
    }
  } else {
    output.value = '请选择角色查看完整变量。';
    setFullStateEditStatus('请选择角色后再编辑。');
    if (debugPanel) debugPanel.innerHTML = '<div class="bs-bt-connect-status">请选择角色后使用调试工具。</div>';
  }
  updateFullStateControls();
  updateFullStateSubpage();
  closeFullStateConfirm();
}

function updateClock(settings) {
  const timeEl = document.getElementById('bs-bt-time');
  if (!timeEl) return;
  const ctx = getContextSafe();
  if (!ctx) return;
  const currentSettings = settings || getSettings(ctx);
  const chatState = getChatState(ctx, currentSettings);
  const totalMins = Math.max(0, Number(chatState?.minutesPassed) || 0);

  let days = Math.floor(totalMins / 1440);
  const hrs = Math.floor((totalMins % 1440) / 60);
  const mins = Math.floor(totalMins % 60);

  if (days >= 365) {
    const y = Math.floor(days / 365);
    days = days % 365;
    const m = Math.floor(days / 30);
    timeEl.textContent = m > 0 ? `${y}年${m}月` : `${y}年`;
  } else if (days >= 30) {
    const m = Math.floor(days / 30);
    days = days % 30;
    timeEl.textContent = days > 0 ? `${m}个月${days}天` : `${m}个月`;
  } else if (days > 0) {
    timeEl.textContent = `第 ${days + 1} 天`;
  } else if (hrs > 0) {
    timeEl.textContent = `${hrs} 小时`;
  } else if (mins > 0) {
    timeEl.textContent = `${mins} 分钟`;
  } else {
    timeEl.textContent = '【初始】';
  }
}

function applyTheme(settings) {
  const root = document.getElementById(PANEL_ID);
  const sphere = document.getElementById('bs-bt-floating-sphere');
  if (!root) return;
  for (const key of Object.keys(THEME_CONFIG)) {
    root.classList.remove(`theme-${key}`);
    if (sphere) sphere.classList.remove(`theme-${key}`);
  }
  root.classList.add(`theme-${settings.theme}`);
  if (sphere) sphere.classList.add(`theme-${settings.theme}`);
  root.classList.remove('size-phone', 'size-tablet', 'font-compact', 'font-standard', 'font-large');
  const deviceSize = String(settings.deviceSize || 'phone').trim() === 'tablet' ? 'tablet' : 'phone';
  const fontSize = ['compact', 'standard', 'large'].includes(String(settings.fontSize || '').trim()) ? String(settings.fontSize).trim() : 'standard';
  root.classList.add(`size-${deviceSize}`);
  root.classList.add(`font-${fontSize}`);
  document.querySelectorAll('#bs-biotracker-settings [data-device-size-option]').forEach((node) => {
    node.classList.toggle('is-active', String(node.dataset.deviceSizeOption || 'phone') === deviceSize);
  });
  document.querySelectorAll('#bs-biotracker-settings [data-font-size-option]').forEach((node) => {
    node.classList.toggle('is-active', String(node.dataset.fontSizeOption || 'standard') === fontSize);
  });
  const brand = document.getElementById('bs-bt-brand');
  if (brand) brand.textContent = 'Bastneth Pager';
  updateBatteryIndicator(settings);
  updateClock();
}

function setView(view) {
  const root = document.getElementById(PANEL_ID);
  if (!root) return;
  const normalizedView = view === 'time-lapse' ? 'full-state' : view;
  const next = ['home', 'theme', 'system', 'register', 'worldbook-filter', 'track-list', 'track-char', 'full-state', 'race-encyclopedia', 'tracker-preset', 'wardrobe'].includes(normalizedView) ? normalizedView : 'home';
  root.dataset.view = next;
  try {
    globalThis.localStorage?.setItem(LAST_VIEW_STORAGE_KEY, next);
  } catch {}
  document.querySelectorAll('#bs-biotracker-settings .bs-bt-view').forEach((node) => node.classList.toggle('is-active', node.dataset.view === next));
  const title = document.getElementById('bs-bt-title');
  if (title) title.textContent = next === 'theme' ? 'THEME' : next === 'system' ? 'SYSTEM' : next === 'register' ? 'REGISTRY' : next === 'worldbook-filter' ? 'WORLDBOOK' : next === 'track-list' ? 'TRACK LIST' : next === 'track-char' ? 'TRACK CHAR' : next === 'full-state' ? 'FULL STATE' : next === 'race-encyclopedia' ? 'RACE DATA' : next === 'tracker-preset' ? 'PRESET' : next === 'wardrobe' ? 'WARDROBE' : 'HOME';
}

function getLastPagerView() {
  try {
    const value = String(globalThis.localStorage?.getItem(LAST_VIEW_STORAGE_KEY) || '').trim();
    if (value === 'time-lapse') return 'full-state';
    if (['home', 'theme', 'system', 'register', 'worldbook-filter', 'track-list', 'track-char', 'full-state', 'race-encyclopedia', 'tracker-preset', 'wardrobe'].includes(value)) {
      return value;
    }
  } catch {}
  return 'home';
}

function applySettingsToForm(ctx) {
  const settings = getSettings(ctx);
  syncRacePhysiologyOverrides(settings);
  const setValue = (id, value) => {
    const node = document.getElementById(id);
    if (!node) return;
    if (node.type === 'checkbox') node.checked = Boolean(value);
    else node.value = value ?? '';
  };
  setValue('bs-bt-enabled', settings.enabled);
  setValue('bs-bt-tracker-preset-list', settings.useStPresetForAsync ? CURRENT_PRESET_OPTION_VALUE : (settings.trackerPresetName || NO_PRESET_OPTION_VALUE));
  setValue('bs-bt-api-url', settings.apiUrl);
  setValue('bs-bt-api-key', settings.apiKey);
  setValue('bs-bt-model', settings.model);
  setValue('bs-bt-trigger', settings.triggerTiming);
  setValue('bs-bt-poll-ms', settings.pollMs);
  setValue('bs-bt-context-size', settings.contextSize);
  setValue('bs-bt-tracker-token-budget', settings.trackerTokenBudget);
  setValue('bs-bt-require-full-description-updates', settings.requireFullDescriptionUpdates);
  setValue('bs-bt-luker-multi-agent-manual-only', settings.lukerMultiAgentManualOnly);
  setValue('bs-bt-diary-recent-limit', settings.diaryRecentLimit);
  setValue('bs-bt-targets', settings.targetNames);
  setValue('bs-bt-tracker-worldbook-mode', normalizeWorldbookMode(settings.trackerWorldbookMode));
  setValue('bs-bt-system-prompt', settings.systemPrompt);
  setValue('bs-bt-register-custom-notes', settings.registryCustomNotes);
  setValue('bs-bt-registry-normal-description', settings.registryDescriptionGuides?.normalDescription);
  setValue('bs-bt-registry-pregnant-description', settings.registryDescriptionGuides?.pregnantDescription);
  setValue('bs-bt-diary-writing-prompt', settings.diaryWritingPrompt);
  setValue('bs-bt-wardrobe-prep-prompt', settings.wardrobePrepPrompt);
  setValue('bs-bt-wardrobe-prep-main-count', settings.wardrobePrepMainCount);
  setValue('bs-bt-wardrobe-prep-accessory-count', settings.wardrobePrepAccessoryCount);
  populateModelList(settings);
  setConnectStatus(settings.modelOptions.length > 0 ? `已缓存 ${settings.modelOptions.length} 个模型` : '尚未连接');
  registryBreedingInferenceDraft = null;
  setRegisterTab('inference');
  setBreedingInferenceEditor('尚未执行繁育推演。直接注册不会生成繁育心理人设。');
  setBreedingInferenceStatus('');
  setWardrobePrepStatus('角色必须已注册，才能准备衣柜与当前穿着。');
  setDiaryStatus('角色必须已注册，且同一故事日尚未写过日记。');
  setRegisterStatus('输入名字与 Description 规则后发送注册请求，完成后可在“角色追踪”查看该角色状态变量。');
  syncWorldbookFilterInput(ctx);
  renderWorldbookEntryList(ctx, parseWorldbookExcludeNamesInput(settings.trackerWorldbookExcludeNames));
  renderWorldbookEntryList(ctx, [], { scope: 'global' });
  setWorldbookScopeTab(selectedWorldbookScopeTab);
  applyTheme(settings);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  renderRaceEncyclopediaPage(ctx);
  refreshRegisterRacePalette();
  syncTrackerPresetSelectionUi(ctx);
  setView(getLastPagerView());
}

const trackerDeps = { renderStatusPanel, updateClock };

function getWorldbookFilterSnapshot(ctx) {
  const settings = getSettings(ctx);
  const mode = normalizeWorldbookMode(settings.trackerWorldbookMode);
  const names = mode === 'allowlist_all'
    ? settings.trackerWorldbookIncludeNames
    : settings.trackerWorldbookExcludeNames;
  const globalNames = mode === 'allowlist_all'
    ? settings.trackerGlobalWorldbookIncludeNames
    : settings.trackerGlobalWorldbookExcludeNames;
  return `${mode}\n${String(names || '').trim()}\n---global---\n${String(globalNames || '').trim()}`;
}

function persistWorldbookFilterIfChanged(ctx, beforeSnapshot) {
  if (getWorldbookFilterSnapshot(ctx) === beforeSnapshot) return;
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
}

async function refreshWorldbookFilterPage(ctx) {
  const beforeSnapshot = getWorldbookFilterSnapshot(ctx);
  try {
    const result = await inspectCurrentCharacterWorldbook(ctx);
    applyWorldbookFilterSelection(ctx, result.foundEntries);
    applyGlobalWorldbookFilterSelection(ctx, result.globalEntries);
    persistWorldbookFilterIfChanged(ctx, beforeSnapshot);
  } catch (error) {
    applyWorldbookFilterSelection(ctx, []);
    applyGlobalWorldbookFilterSelection(ctx, []);
    throw error;
  }
}

let cachedPresetManager = null;
let cachedPresetData = null;
const cachedPresetPromptMap = new Map();
const cachedPresetDetailsMap = new Map();
let cachedActivePresetName = '';
const CURRENT_PRESET_OPTION_VALUE = '__bsbt_current_preset__';
const NO_PRESET_OPTION_VALUE = '__bsbt_no_preset__';

function normalizeTrackerPresetSelectionValue(name) {
  const next = String(name || '').trim();
  return next === NO_PRESET_OPTION_VALUE || next === CURRENT_PRESET_OPTION_VALUE ? '' : next;
}

function syncTrackerPresetSelectionUi(ctx) {
  const select = document.getElementById('bs-bt-tracker-preset-list');
  if (!(select instanceof HTMLSelectElement)) return;
  select.disabled = false;
  select.title = '';
}

async function refreshTrackerPresetPage(ctx) {
  const select = document.getElementById('bs-bt-tracker-preset-list');
  if (!select) return;
  const settings = getSettings(ctx);
  const savedName = String(settings.trackerPresetName || '').trim();
  const previousValue = String(select.value || '').trim();
  cachedPresetPromptMap.clear();
  cachedPresetDetailsMap.clear();

  let presetNames = [];
  let activeName = '';

  // 策略 1: bastneth 自訂 API — ST_API.preset.list()
  try {
    {
      const result = await listHostPresets();
      if (Array.isArray(result?.presets)) {
        result.presets.forEach((preset) => {
          const name = String(preset?.name || '').trim();
          if (!name) return;
          cachedPresetDetailsMap.set(name, preset);
          if (Array.isArray(preset?.prompts) && preset.prompts.length > 0) {
            cachedPresetPromptMap.set(name, preset.prompts);
          }
        });
        presetNames = result.presets.map((p) => String(p?.name || '').trim()).filter(Boolean);
        activeName = String(result?.active || '').trim();
      }
    }
  } catch {}

  // 策略 2: SillyTavern PresetManager
  try {
    try {
      const stCtx = getHostContext();
      const pm = getHostPresetManager(stCtx, 'openai');
      if (pm) {
        cachedPresetManager = pm;
        // getAllPresets() 返回 select 中選項文字陣列
        if (typeof pm.getAllPresets === 'function') {
          const names = pm.getAllPresets();
          if (Array.isArray(names) && names.length > 0) {
            presetNames = names.map((n) => String(n || '').trim()).filter(Boolean);
          }
        }
        // getPresetList() 返回 { presets, preset_names, settings }
        if (typeof pm.getPresetList === 'function') {
          const data = pm.getPresetList();
          cachedPresetData = data;
          if (presetNames.length === 0) {
            if (data?.preset_names && typeof data.preset_names === 'object') {
              presetNames = Object.keys(data.preset_names).filter(Boolean);
            } else if (data?.presets && typeof data.presets === 'object') {
              presetNames = Object.keys(data.presets).filter(Boolean);
            }
          }
          if (Array.isArray(presetNames) && typeof pm.getCompletionPresetByName === 'function') {
            presetNames.forEach((name) => {
              try {
                const preset = pm.getCompletionPresetByName(name);
                if (preset && typeof preset === 'object') {
                  cachedPresetDetailsMap.set(name, preset);
                  if (Array.isArray(preset.prompts) && preset.prompts.length > 0) {
                    cachedPresetPromptMap.set(name, preset.prompts);
                  }
                }
              } catch {}
            });
          }
        }
        // 從 oai_settings 獲取 active preset name
        try {
          if (typeof pm.getSelectedPresetName === 'function') {
            activeName = String(pm.getSelectedPresetName() || '').trim();
          }
          const oai = getHostChatCompletionSettings(stCtx);
          if (!activeName && oai?.preset_settings_openai) activeName = String(oai.preset_settings_openai).trim();
        } catch {}
      }
    } catch {}
  } catch {}

  // 策略 3: 至少保留使用者目前存的 trackerPresetName
  if (presetNames.length === 0 && savedName) {
    presetNames = [savedName];
  }
  cachedActivePresetName = activeName;

  // 填充 dropdown
  select.innerHTML = `<option value="${CURRENT_PRESET_OPTION_VALUE}">跟随 ST 当前预设</option><option value="${NO_PRESET_OPTION_VALUE}">裸请求（不套用预设）</option>`;
  presetNames.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name + (name === activeName ? ' (当前)' : '');
    select.appendChild(option);
  });

  if (presetNames.length === 0 && !savedName && !settings.useStPresetForAsync) {
    const opt = document.createElement('option');
    opt.value = NO_PRESET_OPTION_VALUE;
    opt.disabled = true;
    opt.textContent = '未找到任何 ST 预设，请检查 ST 是否已配置预设';
    select.appendChild(opt);
  }

  const preferredSelectedValue = previousValue && previousValue !== NO_PRESET_OPTION_VALUE
    ? previousValue
    : '';
  const uiSelectedValue = preferredSelectedValue || (settings.useStPresetForAsync
    ? CURRENT_PRESET_OPTION_VALUE
    : (savedName || NO_PRESET_OPTION_VALUE));
  select.value = Array.from(select.options).some((option) => option.value === uiSelectedValue)
    ? uiSelectedValue
    : NO_PRESET_OPTION_VALUE;
  syncTrackerPresetSelectionUi(ctx);

  // 渲染 prompt toggle 列表
  const targetPresetName = settings.useStPresetForAsync
    ? resolveTrackerPresetName(CURRENT_PRESET_OPTION_VALUE, true)
    : resolveTrackerPresetName(select.value || savedName, false);
  await renderPromptToggles(ctx, targetPresetName);
}

function resolveTrackerPresetName(name, fallbackToActive = true) {
  const raw = String(name || '').trim();
  if (raw === CURRENT_PRESET_OPTION_VALUE) {
    return String(cachedActivePresetName || '').trim();
  }
  if (raw === NO_PRESET_OPTION_VALUE) {
    return '';
  }
  const next = normalizeTrackerPresetSelectionValue(raw);
  if (next) return next;
  return fallbackToActive ? String(cachedActivePresetName || '').trim() : '';
}

function getTrackerPromptOverrideMap(settings, presetName) {
  const allOverrides = settings?.trackerPromptToggleOverrides;
  if (!allOverrides || typeof allOverrides !== 'object') return {};
  const presetOverrides = allOverrides[presetName];
  return presetOverrides && typeof presetOverrides === 'object' ? presetOverrides : {};
}

function getPromptOrderEntriesFromSettings(settings, stCtx = null) {
  const direct = Array.isArray(settings?.prompt_order) ? settings.prompt_order : null;
  if (direct) return direct;
  const chatCompletionSettings = getHostChatCompletionSettings(stCtx);
  const runtime = Array.isArray(chatCompletionSettings?.prompt_order) ? chatCompletionSettings.prompt_order : null;
  return runtime || [];
}

function pickPromptOrderList(promptOrderEntries, stCtx = null) {
  if (!Array.isArray(promptOrderEntries) || promptOrderEntries.length === 0) return [];
  const groupId = stCtx?.groupId;
  const characterId = stCtx?.characterId;
  const candidates = [
    promptOrderEntries.find((entry) => String(entry?.character_id) === String(groupId) && Array.isArray(entry?.order)),
    promptOrderEntries.find((entry) => String(entry?.character_id) === String(characterId) && Array.isArray(entry?.order)),
    promptOrderEntries.find((entry) => Array.isArray(entry?.order) && entry.order.length > 0),
  ];
  return candidates.find(Boolean)?.order || [];
}

function normalizePromptListForDisplay(prompts, presetName) {
  const list = Array.isArray(prompts)
    ? prompts.filter((prompt) => prompt && typeof prompt === 'object' && prompt.identifier)
    : [];
  const stCtx = getHostContext();
  const isActivePreset = presetName && presetName === String(cachedActivePresetName || '').trim();
  const promptOrderEntries = isActivePreset
    ? pickPromptOrderList(getPromptOrderEntriesFromSettings(cachedPresetData?.settings, stCtx), stCtx)
    : [];

  if (!Array.isArray(promptOrderEntries) || promptOrderEntries.length === 0) {
    return list.map((prompt) => ({
      ...prompt,
      _sourceEnabled: prompt.enabled !== false,
    }));
  }

  const byId = new Map(list.map((prompt) => [prompt.identifier, prompt]));
  const ordered = promptOrderEntries
    .map((entry) => {
      const prompt = byId.get(entry?.identifier);
      if (!prompt) return null;
      return {
        ...prompt,
        _sourceEnabled: entry?.enabled !== false,
      };
    })
    .filter(Boolean);
  return ordered;
}

function getPromptDisplayMeta(prompt) {
  const isMarkerPrompt = !!prompt?.marker && Number(prompt?.injection_position) !== 1;
  const isImportantPrompt = !prompt?.marker && !!prompt?.system_prompt && Number(prompt?.injection_position) !== 1 && !!prompt?.forbid_overrides;
  const isSystemPrompt = !prompt?.marker && !!prompt?.system_prompt && Number(prompt?.injection_position) !== 1 && !prompt?.forbid_overrides;
  const isUserPrompt = !prompt?.marker && !prompt?.system_prompt && Number(prompt?.injection_position) !== 1;
  const isInjectionPrompt = Number(prompt?.injection_position) === 1;
  if (isMarkerPrompt) return { icon: 'fa-thumb-tack', title: 'Marker' };
  if (isImportantPrompt) return { icon: 'fa-star', title: 'Important Prompt' };
  if (isSystemPrompt) return { icon: 'fa-square-poll-horizontal', title: 'Global Prompt' };
  if (isUserPrompt) return { icon: 'fa-asterisk', title: 'Preset Prompt' };
  if (isInjectionPrompt) return { icon: 'fa-syringe', title: 'In-Chat Injection' };
  return { icon: 'fa-asterisk', title: 'Prompt' };
}

function getPromptTypeGlyph(prompt) {
  const isMarkerPrompt = !!prompt?.marker && Number(prompt?.injection_position) !== 1;
  const isImportantPrompt = !prompt?.marker && !!prompt?.system_prompt && Number(prompt?.injection_position) !== 1 && !!prompt?.forbid_overrides;
  const isSystemPrompt = !prompt?.marker && !!prompt?.system_prompt && Number(prompt?.injection_position) !== 1 && !prompt?.forbid_overrides;
  const isInjectionPrompt = Number(prompt?.injection_position) === 1;
  if (isMarkerPrompt) return '•';
  if (isImportantPrompt) return '★';
  if (isSystemPrompt) return '■';
  if (isInjectionPrompt) return '↳';
  return '✶';
}

function extractVisibleText(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('input, button, select, textarea, svg, img, i').forEach((child) => child.remove());
  return String(clone.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAccessibleDocuments() {
  const docs = [document];
  try {
    if (globalThis.parent?.document && globalThis.parent.document !== document) docs.push(globalThis.parent.document);
  } catch {}
  try {
    if (globalThis.top?.document && !docs.includes(globalThis.top.document)) docs.push(globalThis.top.document);
  } catch {}
  return docs;
}

function getToggleState(node) {
  if (!node || !(node instanceof HTMLElement)) return null;
  if (node.matches('input[type="checkbox"]')) return !!node.checked;
  const ariaChecked = node.getAttribute('aria-checked');
  if (ariaChecked === 'true') return true;
  if (ariaChecked === 'false') return false;
  if (node.getAttribute('data-value') === 'true') return true;
  if (node.getAttribute('data-value') === 'false') return false;
  return null;
}

function collectToggleNodes(root) {
  return Array.from(root.querySelectorAll([
    'input[type="checkbox"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[aria-checked]',
    '.toggle-control',
    '.menu_toggle',
    '.checkbox',
  ].join(', ')));
}

function findPromptListScopes(doc) {
  const nodes = Array.from(doc.querySelectorAll('div, section, form'));
  return nodes.filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const text = String(node.textContent || '');
    if (!/名称|name/i.test(text) || !/token/i.test(text)) return false;
    const toggleCount = collectToggleNodes(node).length;
    return toggleCount >= 3 && toggleCount <= 80;
  }).sort((a, b) => a.textContent.length - b.textContent.length);
}

function isPromptListRow(row) {
  if (!(row instanceof HTMLElement)) return false;
  const text = extractVisibleText(row);
  if (!text || text.length < 2 || text.length > 120) return false;
  if (/刷新预设列表|跟随 ST 当前预设|裸请求|Tracker 专用预设|总 Token 数量/.test(text)) return false;
  const toggleCount = collectToggleNodes(row).length;
  if (toggleCount !== 1) return false;
  const actionButtons = row.querySelectorAll('button, [role="button"]');
  return actionButtons.length >= 2;
}

function scrapePromptManagerDomBlocks() {
  const rows = [];
  const seen = new Set();
  const docs = getAccessibleDocuments();
  let debugCounts = [];

  docs.forEach((doc, docIndex) => {
    const scopes = findPromptListScopes(doc);
    debugCounts.push(`doc${docIndex}:scopes=${scopes.length}`);
    scopes.forEach((scope, scopeIndex) => {
      const toggleNodes = collectToggleNodes(scope);
      debugCounts.push(`doc${docIndex}.scope${scopeIndex}:toggles=${toggleNodes.length}`);
      toggleNodes.forEach((toggleNode, index) => {
        const candidates = [
          toggleNode.closest('li'),
          toggleNode.closest('tr'),
          toggleNode.closest('div'),
        ].filter(Boolean);
        const row = candidates.find(isPromptListRow);
        if (!row || seen.has(row)) return;
        seen.add(row);
        const name = extractVisibleText(row);
        const enabled = getToggleState(toggleNode);
        rows.push({
          identifier: `dom-${docIndex}-${scopeIndex}-${index}-${name}`,
          name,
          enabled: enabled !== false,
          source: 'dom',
        });
      });
    });
  });

  const filtered = rows.filter((row) => {
    const text = String(row.name || '');
    return text.length >= 2
      && !/^Token$/i.test(text)
      && !/^名称$/i.test(text)
      && !/刷新预设列表|跟随 ST 当前预设|裸请求|Tracker 专用预设/.test(text);
  });
  filtered._debugSummary = debugCounts.join(' ; ');
  return filtered;
}

async function getPresetPromptList(presetName) {
  const targetPresetName = resolveTrackerPresetName(presetName, false);
  if (!targetPresetName) return [];
  try {
    if (cachedPresetManager && typeof cachedPresetManager.getCompletionPresetByName === 'function') {
      const preset = cachedPresetManager.getCompletionPresetByName(targetPresetName);
      if (preset && typeof preset === 'object') {
        cachedPresetDetailsMap.set(targetPresetName, preset);
        if (Array.isArray(preset.prompts) && preset.prompts.length > 0) {
          cachedPresetPromptMap.set(targetPresetName, preset.prompts);
          return preset.prompts;
        }
      }
    }
    if (cachedPresetDetailsMap.has(targetPresetName)) {
      const prompts = cachedPresetDetailsMap.get(targetPresetName)?.prompts;
      if (Array.isArray(prompts) && prompts.length > 0) {
        cachedPresetPromptMap.set(targetPresetName, prompts);
        return prompts;
      }
    }
    // 從 getPresetList 取得的 presets 物件中撈
    if (cachedPresetData?.presets?.[targetPresetName]?.prompts) {
      return cachedPresetData.presets[targetPresetName].prompts;
    }
    if (cachedPresetPromptMap.has(targetPresetName)) {
      return cachedPresetPromptMap.get(targetPresetName) || [];
    }
    const stCtx = getHostContext();
    const hostPreset = await getHostPreset(targetPresetName, stCtx);
    const prompts = Array.isArray(hostPreset?.prompts) ? hostPreset.prompts : [];
    if (prompts.length > 0) cachedPresetPromptMap.set(targetPresetName, prompts);
    if (prompts.length > 0) return prompts;
  } catch {}
  const domPrompts = scrapePromptManagerDomBlocks();
  if (domPrompts.length > 0) return domPrompts;
  return [];
}

async function renderPromptToggles(ctx, presetName) {
  const container = document.getElementById('bs-bt-prompt-toggles');
  if (!container) return;
  const settings = getSettings(ctx);
  const targetPresetName = settings?.useStPresetForAsync
    ? resolveTrackerPresetName(presetName, true)
    : resolveTrackerPresetName(presetName, false);
  const prompts = normalizePromptListForDisplay(await getPresetPromptList(targetPresetName), targetPresetName);

  if (!targetPresetName || prompts.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = '';
  const presetOverrides = getTrackerPromptOverrideMap(settings, targetPresetName);
  container.innerHTML = prompts
    .map((p) => {
      const isEnabled = Object.hasOwn(presetOverrides, p.identifier)
        ? !!presetOverrides[p.identifier]
        : p._sourceEnabled !== false;
      const disabledClass = isEnabled ? '' : ' is-disabled';
      const glyph = getPromptTypeGlyph(p);
      return `<div class="bs-bt-prompt-toggle-item${disabledClass}" data-prompt-id="${escapeHtml(p.identifier)}">
        <span class="bs-bt-prompt-toggle-name" title="${escapeHtml(String(p.name || p.identifier || 'Unnamed Prompt'))}">
          <span class="bs-bt-prompt-toggle-glyph">${escapeHtml(glyph)}</span>
          <span>${escapeHtml(String(p.name || p.identifier || 'Unnamed Prompt'))}</span>
        </span>
        <button type="button" class="bs-bt-prompt-toggle-action${isEnabled ? ' is-on' : ''}" data-prompt-id="${escapeHtml(p.identifier)}" aria-pressed="${isEnabled ? 'true' : 'false'}" title="${isEnabled ? 'Disable' : 'Enable'}">
          <span class="bs-bt-prompt-toggle-thumb"></span>
        </button>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.bs-bt-prompt-toggle-action').forEach((button) => {
    button.addEventListener('click', () => {
      const pid = button.dataset.promptId;
      if (!pid) return;
      if (!settings.trackerPromptToggleOverrides || typeof settings.trackerPromptToggleOverrides !== 'object') {
        settings.trackerPromptToggleOverrides = {};
      }
      if (!settings.trackerPromptToggleOverrides[targetPresetName] || typeof settings.trackerPromptToggleOverrides[targetPresetName] !== 'object') {
        settings.trackerPromptToggleOverrides[targetPresetName] = {};
      }
      const sourcePrompt = prompts.find((prompt) => prompt.identifier === pid);
      const currentEnabled = Object.hasOwn(settings.trackerPromptToggleOverrides[targetPresetName], pid)
        ? !!settings.trackerPromptToggleOverrides[targetPresetName][pid]
        : sourcePrompt?._sourceEnabled !== false;
      settings.trackerPromptToggleOverrides[targetPresetName][pid] = !currentEnabled;
      saveSettings(ctx);
      void renderPromptToggles(ctx, targetPresetName);
    });
  });
}

function scheduleWorldbookFilterReload(ctx, reason = 'chat_changed') {
  globalThis.clearTimeout?.(globalThis[WORLDBOOK_RELOAD_TIMER_KEY]);
  globalThis[WORLDBOOK_RELOAD_TIMER_KEY] = globalThis.setTimeout?.(async () => {
    try {
      await refreshWorldbookFilterPage(ctx);
    } catch (error) {
      console.error(`[BS BioTracker] refreshWorldbookFilterPage after ${reason} failed`, error);
    }
  }, 250);
}

async function clearCurrentWorldbookExcludeSelections(ctx) {
  const result = await inspectCurrentCharacterWorldbook(ctx);
  const settings = getSettings(ctx);
  if (normalizeWorldbookMode(settings.trackerWorldbookMode) === 'allowlist_all') {
    saveWorldbookIncludeNamesFromList(ctx, []);
  } else {
    const currentEntryNames = new Set((Array.isArray(result?.foundEntries) ? result.foundEntries : []).map((entry) => String(entry?.name || '').trim()).filter(Boolean));
    const preserved = parseWorldbookExcludeNamesInput(settings.trackerWorldbookExcludeNames).filter((name) => !currentEntryNames.has(name));
    saveWorldbookExcludeNamesFromList(ctx, preserved);
  }
  await refreshWorldbookFilterPage(ctx);
}

async function clearCurrentGlobalWorldbookSelections(ctx) {
  const settings = getSettings(ctx);
  if (normalizeWorldbookMode(settings.trackerWorldbookMode) === 'allowlist_all') {
    saveGlobalWorldbookIncludeNamesFromList(ctx, []);
  } else {
    saveGlobalWorldbookExcludeNamesFromList(ctx, []);
  }
  await refreshWorldbookFilterPage(ctx);
}

function updateMainFlowPrompt(ctx) {
  const settings = getSettings(ctx);
  syncRacePhysiologyOverrides(settings);
  const prompt = buildMainFlowPrompt(ctx, settings);
  globalThis[MAINFLOW_PROMPT_TOKEN_INPUT_KEY] = { capturedAt: Date.now(), prompt };
  try {
    ctx.setExtensionPrompt?.(MAINFLOW_PROMPT_KEY, prompt, 1, Math.max(2, Number(settings.contextSize) || 12), false);
  } catch (error) {
    console.warn('[BS BioTracker] setExtensionPrompt failed', error);
  }
  updateBatteryIndicator(settings);
}

function readSettingsFromForm(ctx) {
  const settings = getSettings(ctx);
  const getValue = (id) => document.getElementById(id)?.value ?? '';
  settings.enabled = !!document.getElementById('bs-bt-enabled')?.checked;
  const trackerPresetSelectionValue = String(getValue('bs-bt-tracker-preset-list')).trim();
  if (trackerPresetSelectionValue) {
    settings.useStPresetForAsync = trackerPresetSelectionValue === CURRENT_PRESET_OPTION_VALUE;
    settings.trackerPresetName = normalizeTrackerPresetSelectionValue(trackerPresetSelectionValue);
  }
  settings.apiUrl = String(getValue('bs-bt-api-url')).trim();
  settings.apiKey = String(getValue('bs-bt-api-key')).trim();
  settings.model = String(getValue('bs-bt-model')).trim();
  settings.triggerTiming = String(getValue('bs-bt-trigger')).trim() || 'after_ai';
  settings.pollMs = Math.max(800, Number(getValue('bs-bt-poll-ms')) || 1800);
  settings.contextSize = Math.max(2, Number(getValue('bs-bt-context-size')) || 12);
  settings.trackerTokenBudget = Math.max(500, Math.min(100000, Math.floor(Number(getValue('bs-bt-tracker-token-budget')) || 4096)));
  settings.requireFullDescriptionUpdates = Boolean(document.getElementById('bs-bt-require-full-description-updates')?.checked);
  settings.lukerMultiAgentManualOnly = Boolean(document.getElementById('bs-bt-luker-multi-agent-manual-only')?.checked);
  settings.diaryRecentLimit = Math.max(0, Math.min(20, Math.floor(Number(getValue('bs-bt-diary-recent-limit')) || 0)));
  settings.diaryWritingPrompt = String(getValue('bs-bt-diary-writing-prompt')).trim();
  settings.wardrobePrepPrompt = String(getValue('bs-bt-wardrobe-prep-prompt')).trim();
  settings.wardrobePrepMainCount = Math.max(1, Math.min(12, Math.floor(Number(getValue('bs-bt-wardrobe-prep-main-count')) || 3)));
  settings.wardrobePrepAccessoryCount = Math.max(0, Math.min(12, Math.floor(Number(getValue('bs-bt-wardrobe-prep-accessory-count')) || 0)));
  settings.targetNames = String(getValue('bs-bt-targets')).trim();
  settings.trackerWorldbookMode = normalizeWorldbookMode(getValue('bs-bt-tracker-worldbook-mode'));
  const filterNames = String(getValue('bs-bt-worldbook-filter-input')).trim();
  if (settings.trackerWorldbookMode === 'allowlist_all') settings.trackerWorldbookIncludeNames = filterNames;
  else settings.trackerWorldbookExcludeNames = filterNames;
  const globalFilterNames = String(getValue('bs-bt-global-worldbook-filter-input')).trim();
  if (settings.trackerWorldbookMode === 'allowlist_all') settings.trackerGlobalWorldbookIncludeNames = globalFilterNames;
  else settings.trackerGlobalWorldbookExcludeNames = globalFilterNames;
  settings.systemPrompt = String(getValue('bs-bt-system-prompt')).trim() || DEFAULT_SYSTEM_PROMPT;
  settings.registryCustomNotes = String(getValue('bs-bt-register-custom-notes')).trim();
  settings.registryDescriptionGuides = {
    normalDescription: String(getValue('bs-bt-registry-normal-description')).trim(),
    pregnantDescription: String(getValue('bs-bt-registry-pregnant-description')).trim(),
  };
  syncRacePhysiologyOverrides(settings);
  saveSettings(ctx);
  updateMainFlowPrompt(ctx);
  resetPoller(ctx, trackerDeps);
}

function closeModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function clampModalPosition(left, top, dialog) {
  const width = dialog?.offsetWidth || 420;
  const height = dialog?.offsetHeight || 540;
  const maxLeft = Math.max(MODAL_EDGE_GAP, window.innerWidth - width - MODAL_EDGE_GAP);
  const maxTop = Math.max(MODAL_EDGE_GAP, window.innerHeight - height - MODAL_EDGE_GAP);
  return {
    left: Math.max(MODAL_EDGE_GAP, Math.min(left, maxLeft)),
    top: Math.max(MODAL_EDGE_GAP, Math.min(top, maxTop)),
  };
}

function setModalPosition(modal, left, top) {
  const dialog = modal?.querySelector('.bs-bt-modal__dialog');
  if (!modal || !dialog) return;
  const next = clampModalPosition(left, top, dialog);
  dialog.style.left = `${next.left}px`;
  dialog.style.top = `${next.top}px`;
  modal.dataset.left = String(next.left);
  modal.dataset.top = String(next.top);
  modal.dataset.positioned = 'true';
}

function clampFloatingSpherePositionForElement(sphere, left, top) {
  const width = sphere?.offsetWidth || 56;
  const height = sphere?.offsetHeight || 56;
  const maxLeft = Math.max(0, window.innerWidth - width);
  const maxTop = Math.max(0, window.innerHeight - height);
  return {
    left: Math.max(0, Math.min(left, maxLeft)),
    top: Math.max(0, Math.min(top, maxTop)),
  };
}

function setFloatingSpherePositionForElement(sphere, left, top, persist = true) {
  if (!sphere) return;
  const next = clampFloatingSpherePositionForElement(sphere, left, top);
  sphere.style.left = `${next.left}px`;
  sphere.style.top = `${next.top}px`;
  if (!persist) return;
  try {
    globalThis.localStorage?.setItem(FLOATING_SPHERE_POSITION_KEY, JSON.stringify(next));
  } catch {}
}

function restoreFloatingSpherePositionForElement(sphere, persist = false) {
  if (!sphere) return false;
  try {
    const raw = globalThis.localStorage?.getItem(FLOATING_SPHERE_POSITION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const left = Number(parsed?.left);
      const top = Number(parsed?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        setFloatingSpherePositionForElement(sphere, left, top, persist);
        return true;
      }
    }
  } catch {}

  const currentLeft = Number.parseFloat(sphere.style.left);
  const currentTop = Number.parseFloat(sphere.style.top);
  if (Number.isFinite(currentLeft) && Number.isFinite(currentTop)) {
    setFloatingSpherePositionForElement(sphere, currentLeft, currentTop, persist);
    return true;
  }
  return false;
}

function ensureModalPosition(modal) {
  const dialog = modal?.querySelector('.bs-bt-modal__dialog');
  if (!modal || !dialog) return;
  const storedLeft = Number(modal.dataset.left);
  const storedTop = Number(modal.dataset.top);
  if (Number.isFinite(storedLeft) && Number.isFinite(storedTop)) {
    setModalPosition(modal, storedLeft, storedTop);
    return;
  }
  const defaultLeft = window.innerWidth - dialog.offsetWidth - MODAL_EDGE_GAP;
  const defaultTop = MODAL_EDGE_GAP;
  setModalPosition(modal, defaultLeft, defaultTop);
}

function initDraggableModal(modal) {
  if (!modal || modal.dataset.dragReady === 'true') return;
  const dialog = modal.querySelector('.bs-bt-modal__dialog');
  const dragHandles = modal.querySelectorAll('.bs-bt-drag-handle');
  if (!dialog || dragHandles.length === 0) return;

  let dragState = null;

  const stopDragging = () => {
    dragState = null;
    dialog.classList.remove('is-dragging');
  };

  const onPointerMove = (event) => {
    if (!dragState) return;
    setModalPosition(modal, event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  };

  const onPointerUp = () => {
    stopDragging();
  };

  dragHandles.forEach((handle) =>
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragState = {
        offsetX: event.clientX - dialog.offsetLeft,
        offsetY: event.clientY - dialog.offsetTop,
      };
      dialog.classList.add('is-dragging');
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }),
  );

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', () => ensureModalPosition(modal));
  modal.dataset.dragReady = 'true';
}

function initDraggableSphere(sphere, ctx) {
  let dragState = null;
  let hasMoved = false;
  let longPressTriggered = false;
  let longPressTimer = null;
  let pointerDownX = 0;
  let pointerDownY = 0;

  const clearLongPressTimer = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  const dismissFloatingSphere = () => {
    if (getHostKind() === 'tauritavern' && !hasFloatingSphereRecoveryEntry()) {
      globalThis.toastr?.warning?.('TauriTavern 的扩展菜单入口尚未就绪；为避免无法重新打开，悬浮球不会隐藏。');
      return;
    }
    clearLongPressTimer();
    dragState = null;
    longPressTriggered = true;
    sphere.classList.remove('is-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    sphere.classList.add('is-shrinking');
    setTimeout(() => {
      sphere.style.display = 'none';
      sphere.classList.remove('is-shrinking');
    }, 200);
  };

  const persistFloatingSpherePosition = () => {
    const left = Number.parseFloat(sphere.style.left);
    const top = Number.parseFloat(sphere.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    setFloatingSpherePositionForElement(sphere, left, top);
  };

  const setFloatingSpherePosition = (left, top, persist = true) => {
    setFloatingSpherePositionForElement(sphere, left, top, persist);
  };

  const onPointerMove = (event) => {
    if (!dragState) return;
    const deltaX = event.clientX - pointerDownX;
    const deltaY = event.clientY - pointerDownY;
    if (!hasMoved && Math.hypot(deltaX, deltaY) >= FLOATING_SPHERE_DRAG_THRESHOLD) {
      hasMoved = true;
      clearLongPressTimer();
    }
    if (!hasMoved) return;
    const left = event.clientX - dragState.offsetX;
    const top = event.clientY - dragState.offsetY;
    setFloatingSpherePosition(left, top, false);
  };

  const onPointerUp = () => {
    if (!dragState) return;
    clearLongPressTimer();
    dragState = null;
    sphere.classList.remove('is-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);

    if (longPressTriggered) {
      longPressTriggered = false;
    } else if (hasMoved) {
      persistFloatingSpherePosition();
    } else {
      sphere.classList.add('is-shrinking');
      setTimeout(() => {
        sphere.style.display = 'none';
        sphere.classList.remove('is-shrinking');
        openModal(ctx);
      }, 200);
    }
  };

  sphere.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragState = {
      offsetX: event.clientX - sphere.offsetLeft,
      offsetY: event.clientY - sphere.offsetTop,
    };
    pointerDownX = event.clientX;
    pointerDownY = event.clientY;
    hasMoved = false;
    longPressTriggered = false;
    sphere.classList.add('is-dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      if (dragState && !hasMoved) dismissFloatingSphere();
    }, FLOATING_SPHERE_LONG_PRESS_MS);
    event.preventDefault();
  });

  if (!restoreFloatingSpherePositionForElement(sphere)) {
    const defaultLeft = window.innerWidth - sphere.offsetWidth - MODAL_EDGE_GAP;
    const defaultTop = Math.max(MODAL_EDGE_GAP, Math.round(window.innerHeight * 0.4));
    setFloatingSpherePosition(defaultLeft, defaultTop, false);
  }
  window.addEventListener('resize', () => {
    const left = Number.parseFloat(sphere.style.left);
    const top = Number.parseFloat(sphere.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    setFloatingSpherePosition(left, top);
  });
}

function clearFloatingSphereUpdateCue() {
  const sphere = document.getElementById('bs-bt-floating-sphere');
  if (!sphere) return;
  sphere.classList.remove('has-update', 'is-pulsing');
}

function triggerFloatingSphereUpdateCue(detail = {}) {
  const sphere = document.getElementById('bs-bt-floating-sphere');
  if (!sphere || detail?.hasChanges === false) return;
  sphere.classList.add('has-update');
  sphere.classList.remove('is-pulsing');
  void sphere.offsetWidth;
  sphere.classList.add('is-pulsing');
  globalThis.clearTimeout?.(sphere._bsBtPulseTimer);
  sphere._bsBtPulseTimer = globalThis.setTimeout(() => {
    sphere.classList.remove('is-pulsing');
  }, 1200);
}


function openModal(ctx) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  clearFloatingSphereUpdateCue();
  applySettingsToForm(ctx);
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  ensureModalPosition(modal);

  const sphere = document.getElementById('bs-bt-floating-sphere');
  if (sphere && sphere.style.display !== 'none') {
    sphere.classList.add('is-shrinking');
    setTimeout(() => {
      sphere.style.display = 'none';
      sphere.classList.remove('is-shrinking');
    }, 200);
  }
}

function toggleModal(ctx) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.contains('is-open') ? closeModal() : openModal(ctx);
}

async function ensureModal(ctx) {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;
  const settingsUrl = new URL('./settings.html', import.meta.url);
  const html = await fetch(settingsUrl).then((response) => response.text());
  modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'bs-bt-modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `<div class="bs-bt-modal__backdrop"></div><div class="bs-bt-modal__dialog" role="dialog" aria-modal="false"><div class="bs-bt-modal__body">${html}</div></div>`;
  document.body.appendChild(modal);
  applySettingsToForm(ctx);
  document.querySelector('#bs-biotracker-settings .bs-bt-brand')?.classList.add('bs-bt-drag-handle');
  document.querySelector('#bs-biotracker-settings .bs-bt-screen-header')?.classList.add('bs-bt-drag-handle');
  initDraggableModal(modal);

  let sphere = document.getElementById('bs-bt-floating-sphere');
  if (!sphere) {
    sphere = document.createElement('div');
    sphere.id = 'bs-bt-floating-sphere';
    sphere.className = `bs-bt-floating-sphere theme-${getSettings(ctx).theme || 'retro'}`;
    sphere.style.display = 'none';
    sphere.innerHTML = `𓃠`;
    document.body.appendChild(sphere);
    initDraggableSphere(sphere, ctx);
  }
  if (!globalThis.__bsBtUpdateCueHandler__) {
    globalThis.__bsBtUpdateCueHandler__ = (event) => {
      triggerFloatingSphereUpdateCue(event?.detail || {});
    };
    globalThis.addEventListener(UPDATE_CUE_EVENT, globalThis.__bsBtUpdateCueHandler__);
  }

  document.querySelectorAll('#bs-biotracker-settings [data-nav-view]').forEach((node) =>
    node.addEventListener('click', async () => {
      const nextView = node.dataset.navView || 'home';
      if (nextView === 'track-list') {
        renderStatusPanel(ctx);
        selectedTrackName = '';
      }
      if (nextView === 'worldbook-filter') {
        readSettingsFromForm(ctx);
        await refreshWorldbookFilterPage(ctx).catch((error) => {
          console.error('[BS BioTracker] refreshWorldbookFilterPage failed', error);
        });
      }
      if (nextView === 'full-state') {
        openFullStateMenu(ctx);
        return;
      }
      if (nextView === 'race-encyclopedia') renderRaceEncyclopediaPage(ctx);
      if (nextView === 'wardrobe') renderWardrobePage(ctx);
      if (nextView === 'tracker-preset') {
        await refreshTrackerPresetPage(ctx).catch((error) => {
          console.error('[BS BioTracker] refreshTrackerPresetPage failed', error);
        });
      }
      setView(nextView);
    }),
  );
  const wardrobeList = document.getElementById('bs-bt-wardrobe-list');
  wardrobeList?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const characterButton = target.closest('[data-wardrobe-character]');
    if (characterButton) {
      const characterName = String(characterButton.getAttribute('data-wardrobe-character') || '');
      const character = getChatState(ctx, getSettings(ctx)).characters?.[characterName];
      if (character?.profile?.wardrobe?.enabled === true) {
        selectedWardrobeName = characterName;
        renderWardrobePage(ctx);
      }
      return;
    }
    if (target.closest('[data-wardrobe-back]')) {
      selectedWardrobeName = '';
      renderWardrobePage(ctx);
    }
  });
  wardrobeList?.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const itemButton = target.closest('[data-wardrobe-item-id]');
    if (!itemButton || !selectedWardrobeName) return;
    event.preventDefault();
    itemButton.setPointerCapture?.(event.pointerId);
    showWardrobeItemBubble(ctx, selectedWardrobeName, itemButton.getAttribute('data-wardrobe-item-id'), itemButton);
  });
  wardrobeList?.addEventListener('pointerup', closeWardrobeItemBubble);
  wardrobeList?.addEventListener('pointercancel', closeWardrobeItemBubble);
  wardrobeList?.addEventListener('pointerleave', closeWardrobeItemBubble);
  document.querySelectorAll('#bs-bt-track-tabs .bs-bt-track-tab').forEach((node) =>
    node.addEventListener('click', () => {
      const nextTab = String(node.dataset.trackTab || 'overview');
      if (!TRACK_SUBPAGES.includes(nextTab)) return;
      selectedTrackSubpage = nextTab;
      renderStatusPanel(ctx);
    }),
  );
  document.querySelectorAll('#bs-bt-full-state-tabs [data-full-state-tab]').forEach((node) =>
    node.addEventListener('click', () => {
      const nextTab = String(node.getAttribute('data-full-state-tab') || 'variables');
      if (!['variables', 'debug'].includes(nextTab)) return;
      selectedFullStateSubpage = nextTab;
      updateFullStateSubpage();
      if (nextTab === 'debug') renderFullStatePage(ctx);
    }),
  );
  document.querySelectorAll('#bs-biotracker-settings [data-theme-option]').forEach((node) =>
    node.addEventListener('click', () => {
      const settings = getSettings(ctx);
      settings.theme = node.dataset.themeOption || 'retro';
      saveSettings(ctx);
      applyTheme(settings);
      setView('theme');
    }),
  );
  document.querySelectorAll('#bs-biotracker-settings [data-device-size-option]').forEach((node) =>
    node.addEventListener('click', () => {
      const settings = getSettings(ctx);
      settings.deviceSize = String(node.dataset.deviceSizeOption || 'phone') === 'tablet' ? 'tablet' : 'phone';
      saveSettings(ctx);
      applyTheme(settings);
      setView('theme');
    }),
  );
  document.querySelectorAll('#bs-biotracker-settings [data-font-size-option]').forEach((node) =>
    node.addEventListener('click', () => {
      const settings = getSettings(ctx);
      const nextFontSize = String(node.dataset.fontSizeOption || 'standard').trim();
      settings.fontSize = ['compact', 'standard', 'large'].includes(nextFontSize) ? nextFontSize : 'standard';
      saveSettings(ctx);
      applyTheme(settings);
      setView('theme');
    }),
  );
  document.getElementById('bs-bt-system-button')?.addEventListener('click', () => setView('system'));
  document.getElementById('bs-bt-home-button')?.addEventListener('click', () => setView('home'));
  document.getElementById('bs-bt-track-back')?.addEventListener('click', () => setView('track-list'));
  document.getElementById('bs-bt-model-list')?.addEventListener('change', (event) => {
    const nextModel = String(event.target?.value || '').trim();
    if (!nextModel) return;
    const modelInput = document.getElementById('bs-bt-model');
    if (modelInput) modelInput.value = nextModel;
  });
  document.getElementById('bs-bt-tracker-preset-list')?.addEventListener('change', async () => {
    readSettingsFromForm(ctx);
    saveSettings(ctx);
    const settings = getSettings(ctx);
    const selectedValue = String(document.getElementById('bs-bt-tracker-preset-list')?.value || '').trim();
    const targetPresetName = settings?.useStPresetForAsync
      ? resolveTrackerPresetName(selectedValue, true)
      : resolveTrackerPresetName(selectedValue, false);
    await renderPromptToggles(ctx, targetPresetName).catch((error) => {
      console.error('[BS BioTracker] renderPromptToggles failed', error);
    });
  });
  document.getElementById('bs-bt-refresh-presets')?.addEventListener('click', async () => {
    await refreshTrackerPresetPage(ctx).catch((error) => {
      console.error('[BS BioTracker] refreshTrackerPresetPage failed', error);
    });
  });
  document.getElementById('bs-bt-race-select')?.addEventListener('change', (event) => {
    selectedRaceEncyclopedia = String(event.target?.value || '');
    racePhysiologyEditorOpen = false;
    renderRaceEncyclopediaPage(ctx);
  });
  document.getElementById('bs-bt-tracker-worldbook-mode')?.addEventListener('change', async () => {
    readSettingsFromForm(ctx);
    syncWorldbookFilterInput(ctx);
    try {
      await refreshWorldbookFilterPage(ctx);
    } catch (error) {
      console.error('[BS BioTracker] refreshWorldbookFilterPage after mode change failed', error);
    }
  });
  document.getElementById('bs-bt-worldbook-filter-input')?.addEventListener('change', async (event) => {
    const names = parseWorldbookExcludeNamesInput(String(event.target?.value || ''));
    if (normalizeWorldbookMode(getSettings(ctx).trackerWorldbookMode) === 'allowlist_all') saveWorldbookIncludeNamesFromList(ctx, names);
    else saveWorldbookExcludeNamesFromList(ctx, names);
    try {
      await refreshWorldbookFilterPage(ctx);
    } catch (error) {
      console.error('[BS BioTracker] refreshWorldbookFilterPage after filter change failed', error);
    }
  });
  document.querySelectorAll('#bs-bt-worldbook-scope-tabs [data-worldbook-scope-tab]').forEach((node) => {
    node.addEventListener('click', () => setWorldbookScopeTab(node.dataset.worldbookScopeTab));
  });
  document.getElementById('bs-bt-global-worldbook-filter-input')?.addEventListener('change', async (event) => {
    const names = parseWorldbookExcludeNamesInput(String(event.target?.value || ''));
    if (normalizeWorldbookMode(getSettings(ctx).trackerWorldbookMode) === 'allowlist_all') saveGlobalWorldbookIncludeNamesFromList(ctx, names);
    else saveGlobalWorldbookExcludeNamesFromList(ctx, names);
    try {
      await refreshWorldbookFilterPage(ctx);
    } catch (error) {
      console.error('[BS BioTracker] refreshWorldbookFilterPage after global filter change failed', error);
    }
  });
  document.getElementById('bs-bt-worldbook-entry-search')?.addEventListener('input', (event) => {
    worldbookEntrySearch = String(event.target?.value || '').trim();
    renderWorldbookEntryList(ctx, latestWorldbookEntries);
  });
  document.getElementById('bs-bt-global-worldbook-entry-search')?.addEventListener('input', (event) => {
    globalWorldbookEntrySearch = String(event.target?.value || '').trim();
    renderWorldbookEntryList(ctx, latestGlobalWorldbookEntries, { scope: 'global' });
  });
  document.getElementById('bs-bt-derived-select')?.addEventListener('change', (event) => {
    selectedDerivedEncyclopedia = String(event.target?.value || '');
    derivedTypeEditorOpen = false;
    renderRaceEncyclopediaPage(ctx);
  });
  document.getElementById('bs-bt-derived-open-editor')?.addEventListener('click', () => {
    if (!selectedDerivedEncyclopedia) return;
    setEncyclopediaSubpage('derived');
    scrollEncyclopediaToTop();
    derivedTypeEditorOpen = true;
    renderRaceEncyclopediaPage(ctx);
  });
  document.getElementById('bs-bt-derived-editor-close')?.addEventListener('click', closeDerivedTypeEditor);
  document.getElementById('bs-bt-derived-editor-modal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeDerivedTypeEditor();
  });
  document.getElementById('bs-bt-derived-save-override')?.addEventListener('click', () => {
    const name = selectedDerivedEncyclopedia;
    saveDerivedTypeOverrideFromEditor(ctx);
    globalThis.toastr?.success?.(`[BS BioTracker] 已保存 ${name} 的衍生参数覆盖`);
  });
  document.getElementById('bs-bt-derived-reset-override')?.addEventListener('click', () => {
    const name = selectedDerivedEncyclopedia;
    resetDerivedTypeOverride(ctx);
    globalThis.toastr?.success?.(`[BS BioTracker] 已恢复 ${name} 的内置衍生参数`);
  });
  document.getElementById('bs-bt-race-open-editor')?.addEventListener('click', () => {
    setEncyclopediaSubpage('race');
    openRacePhysiologyEditor(ctx);
  });
  document.getElementById('bs-bt-race-editor-close')?.addEventListener('click', () => {
    closeRacePhysiologyEditor();
  });
  document.getElementById('bs-bt-race-editor-modal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeRacePhysiologyEditor();
  });
  document.getElementById('bs-bt-race-use-human')?.addEventListener('click', () => {
    copyHumanPhysiologyToEditor();
    const status = document.getElementById('bs-bt-race-editor-status');
    if (status) status.textContent = '已填入人类数值，点击“保存覆盖”后生效。';
  });
  document.getElementById('bs-bt-race-save-override')?.addEventListener('click', () => {
    saveRacePhysiologyOverrideFromEditor(ctx, 'diff');
    globalThis.toastr?.success?.(`[BS BioTracker] 已保存 ${selectedRaceEncyclopedia} 的种族参数覆盖`);
  });
  document.getElementById('bs-bt-race-reset-override')?.addEventListener('click', () => {
    resetRacePhysiologyOverride(ctx);
    globalThis.toastr?.success?.(`[BS BioTracker] 已恢复 ${selectedRaceEncyclopedia} 的内置种族参数`);
  });
  document.getElementById('bs-bt-connect')?.addEventListener('click', async () => {
    readSettingsFromForm(ctx);
    await connectAndLoadModels(ctx);
  });
  document.getElementById('bs-bt-save')?.addEventListener('click', () => {
    readSettingsFromForm(ctx);
    globalThis.toastr?.success?.('[BS BioTracker] 设置已保存');
  });
  document.getElementById('bs-bt-worldbook-clear-all')?.addEventListener('click', async () => {
    try {
      await clearCurrentWorldbookExcludeSelections(ctx);
      syncWorldbookFilterInput(ctx);
      const mode = normalizeWorldbookMode(getSettings(ctx).trackerWorldbookMode);
      globalThis.toastr?.success?.(mode === 'allowlist_all'
        ? '[BS BioTracker] 已清空角色可参考条目文本框'
        : '[BS BioTracker] 已清空角色可排除条目文本框');
    } catch (error) {
      console.error('[BS BioTracker] clearCurrentWorldbookExcludeSelections failed', error);
      globalThis.toastr?.error?.(String(error?.message || error), '[BS BioTracker]');
    }
  });
  document.getElementById('bs-bt-global-worldbook-clear-all')?.addEventListener('click', async () => {
    try {
      await clearCurrentGlobalWorldbookSelections(ctx);
      syncWorldbookFilterInput(ctx);
      const mode = normalizeWorldbookMode(getSettings(ctx).trackerWorldbookMode);
      globalThis.toastr?.success?.(mode === 'allowlist_all'
        ? '[BS BioTracker] 已清空全域可参考条目文本框'
        : '[BS BioTracker] 已清空全域可排除条目文本框');
    } catch (error) {
      console.error('[BS BioTracker] clearCurrentGlobalWorldbookSelections failed', error);
      globalThis.toastr?.error?.(String(error?.message || error), '[BS BioTracker]');
    }
  });
  document.querySelectorAll('#bs-bt-register-tabs [data-register-tab]').forEach((node) => {
    node.addEventListener('click', () => {
      setRegisterTab(String(node.getAttribute('data-register-tab') || 'inference'));
    });
  });
  document.querySelectorAll('#bs-bt-encyclopedia-tabs [data-encyclopedia-tab]').forEach((node) => {
    node.addEventListener('click', () => {
      closeRacePhysiologyEditor();
      closeDerivedTypeEditor();
      setEncyclopediaSubpage(String(node.dataset.encyclopediaTab || 'race'));
      scrollEncyclopediaToTop();
    });
  });
  document.getElementById('bs-bt-wardrobe-prep-run')?.addEventListener('click', (event) => runWardrobePrepInference(ctx, event.currentTarget));
  document.getElementById('bs-bt-wardrobe-prep-apply')?.addEventListener('click', () => applyWardrobePrep(ctx));
  document.getElementById('bs-bt-diary-generate')?.addEventListener('click', (event) => generateRegistryDiary(ctx, event.currentTarget));
  document.getElementById('bs-bt-diary-apply')?.addEventListener('click', () => applyRegistryDiary(ctx));
  document.getElementById('bs-bt-breeding-inference-run')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const values = getRegisterFormValues();
    if (!values.targetName) {
      setBreedingInferenceStatus('请先输入要推演的角色名。', true);
      globalThis.toastr?.warning?.('[BS BioTracker] 请先输入角色名');
      return;
    }
    readSettingsFromForm(ctx);
    button.disabled = true;
    button.textContent = '推演中...';
    setBreedingInferenceStatus(`正在推演 ${values.targetName} 的繁育心理...`);
    try {
      const result = await runRegistryBreedingInference(ctx, values);
      registryBreedingInferenceDraft = {
        ...values,
        result,
      };
      setBreedingInferenceEditor(formatBreedingInferencePreview(result));
      setBreedingInferenceStatus('推演完成。可以直接在上方 JSON 文本框微调，再注册或套用。');
      globalThis.toastr?.success?.(`[BS BioTracker] 已完成 ${values.targetName} 的繁育推演`);
    } catch (error) {
      registryBreedingInferenceDraft = null;
      console.error('[BS BioTracker] runRegistryBreedingInference failed', error);
      const message = String(error?.message || error);
      setBreedingInferenceStatus(message, true);
      globalThis.toastr?.error?.(message, '[BS BioTracker]');
    } finally {
      button.disabled = false;
      button.textContent = '繁育推演';
    }
  });
  document.getElementById('bs-bt-breeding-inference-apply')?.addEventListener('click', () => {
    const values = getRegisterFormValues();
    let breedingInference = null;
    try {
      breedingInference = getApplicableBreedingInferenceDraft(values);
    } catch (error) {
      const message = String(error?.message || error);
      setBreedingInferenceStatus(message, true);
      globalThis.toastr?.error?.(message, '[BS BioTracker]');
      return;
    }
    if (!values.targetName) {
      setBreedingInferenceStatus('请先输入要套用推演的角色名。', true);
      globalThis.toastr?.warning?.('[BS BioTracker] 请先输入角色名');
      return;
    }
    if (!breedingInference) {
      setBreedingInferenceStatus('没有可套用的繁育推演，或当前角色名/种族/角色补充设定/额外推演提示已和推演时不同。', true);
      globalThis.toastr?.warning?.('[BS BioTracker] 请先为当前输入执行繁育推演');
      return;
    }
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx, settings);
    if (!chatState.characters?.[values.targetName]) {
      setBreedingInferenceStatus(`尚未找到已注册角色：${values.targetName}。若这是新角色，请切到“注册”分頁按“注册当前角色”；注册会自动套用这份推演。`, true);
      setRegisterTab('registry');
      globalThis.toastr?.info?.('[BS BioTracker] 新角色请用注册分頁套用推演');
      return;
    }
    try {
      const character = applyRegistryBreedingInference(ctx, {
        targetName: values.targetName,
        breedingInference,
      });
      renderStatusPanel(ctx);
      renderFullStatePage(ctx);
      updateMainFlowPrompt(ctx);
      setBreedingInferenceStatus(`已套用到：${character.name}`);
      globalThis.toastr?.success?.(`[BS BioTracker] 已套用 ${character.name} 的繁育推演`);
    } catch (error) {
      console.error('[BS BioTracker] applyRegistryBreedingInference failed', error);
      const message = String(error?.message || error);
      setBreedingInferenceStatus(message, true);
      globalThis.toastr?.error?.(message, '[BS BioTracker]');
    }
  });
  document.getElementById('bs-bt-register-run')?.addEventListener('click', async () => {
    const { targetName, declaredRace, customNotes } = getRegisterFormValues();
    if (!targetName) {
      setRegisterStatus('请先输入要注册的角色名。', true);
      globalThis.toastr?.warning?.('[BS BioTracker] 请先输入角色名');
      return;
    }
    readSettingsFromForm(ctx);
    let breedingInference = null;
    try {
      const breedingInferencePrompt = String(document.getElementById('bs-bt-breeding-inference-prompt')?.value || '').trim();
      breedingInference = getApplicableBreedingInferenceDraft({ targetName, declaredRace, customNotes, breedingInferencePrompt });
    } catch (error) {
      const message = String(error?.message || error);
      setRegisterStatus(message, true);
      globalThis.toastr?.error?.(message, '[BS BioTracker]');
      return;
    }
    setRegisterStatus(breedingInference
      ? `正在使用繁育推演注册 ${targetName}...`
      : `正在注册 ${targetName}...`);
    try {
      const character = await runRegistry(ctx, { targetName, customNotes, declaredRace, breedingInference });
      renderStatusPanel(ctx);
      renderFullStatePage(ctx);
      updateMainFlowPrompt(ctx);
      setRegisterStatus(breedingInference
        ? `注册完成：${character.name}（已套用繁育推演）。可继续备装或写日记。`
        : `注册完成：${character.name}。可继续备装或写日记。`);
      globalThis.toastr?.success?.(`[BS BioTracker] 已注册 ${character.name}`);
    } catch (error) {
      console.error('[BS BioTracker] runRegistry failed', error);
      const message = String(error?.message || error);
      setRegisterStatus(message, true);
      globalThis.toastr?.error?.(message, '[BS BioTracker]');
    }
  });
  document.querySelector('#bs-bt-view-register .bs-bt-race-picker-wrap')?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const pickerButton = target.closest('[data-race-picker-target]');
    if (pickerButton) {
      const inputId = String(pickerButton.getAttribute('data-race-picker-target') || '');
      if (racePaletteState.isOpen && racePaletteState.targetInputId === inputId) closeRacePalettePopover();
      else openRacePalettePopover(inputId);
      refreshRegisterRacePalette();
      return;
    }
    const removeButton = target.closest('[data-race-remove-index]');
    if (removeButton && isRegisterRaceTarget(racePaletteState.targetInputId)) {
      const index = Number(removeButton.getAttribute('data-race-remove-index'));
      if (Number.isInteger(index) && index >= 0) {
        racePaletteState.raceTags = racePaletteState.raceTags.filter((_, entryIndex) => entryIndex !== index);
        refreshRegisterRacePalette();
      }
      return;
    }
    const actionButton = target.closest('[data-race-action]');
    if (!actionButton || !isRegisterRaceTarget(racePaletteState.targetInputId)) return;
    const action = String(actionButton.getAttribute('data-race-action') || '');
    if (action === 'append') {
      const raceName = String(racePaletteState.selectedRace || '').trim();
      const subtype = String(racePaletteState.subtype || '').trim();
      const raceTag = raceName ? `${raceName}${subtype ? `-${subtype}` : ''}` : '';
      if (!raceTag) {
        globalThis.toastr?.warning?.('[BS BioTracker] 请先选择种族');
        return;
      }
      racePaletteState.raceTags = [...racePaletteState.raceTags, raceTag];
      racePaletteState.selectedRace = '人类';
      racePaletteState.subtype = '';
      refreshRegisterRacePalette();
      return;
    }
    if (action === 'cancel') {
      closeRacePalettePopover();
      refreshRegisterRacePalette();
      return;
    }
    if (action === 'confirm') {
      const descriptor = buildRacePaletteDescriptor(racePaletteState);
      if (!descriptor) {
        globalThis.toastr?.warning?.('[BS BioTracker] 请先加入至少一个种族 tag');
        return;
      }
      const input = document.getElementById('bs-bt-register-race');
      if (input) input.value = descriptor;
      closeRacePalettePopover();
      refreshRegisterRacePalette();
    }
  });
  document.querySelector('#bs-bt-view-register .bs-bt-race-picker-wrap')?.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !isRegisterRaceTarget(racePaletteState.targetInputId)) return;
    if (target.id === 'bs-bt-race-derived') racePaletteState.selectedDerivedType = String(target.value || '');
    if (target.id === 'bs-bt-race-primary') racePaletteState.selectedRace = String(target.value || '人类');
    refreshRegisterRacePalette();
  });
  document.querySelector('#bs-bt-view-register .bs-bt-race-picker-wrap')?.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !isRegisterRaceTarget(racePaletteState.targetInputId)) return;
    if (target.id === 'bs-bt-race-derived-subtype') racePaletteState.derivedSubtype = String(target.value || '');
    if (target.id === 'bs-bt-race-subtype') racePaletteState.subtype = String(target.value || '');
  });
  document.getElementById('bs-bt-run')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    try {
      button.disabled = true;
      button.textContent = '分析请求发送中...';
      globalThis.toastr?.info?.('[BS BioTracker] 开始手动发送分析请求...');
      readSettingsFromForm(ctx);
      const result = await runTracker(ctx, trackerDeps, 'manual');
      if (result?.skipped && result.reason === 'already_running') {
        globalThis.toastr?.info?.('[BS BioTracker] 已有一轮追踪正在执行，本次未重复发送');
      } else if (result?.skipped && result.reason === 'empty_chat') {
        globalThis.toastr?.warning?.('[BS BioTracker] 当前对话没有可分析的消息');
      } else if (result?.skipped && result.reason === 'no_registered_targets') {
        globalThis.toastr?.warning?.('[BS BioTracker] 尚无已注册角色，无法发送追踪请求');
      }
    } finally {
      button.disabled = false;
      button.textContent = '立即分析当前对话';
    }
  });
  document.getElementById('bs-bt-full-state-unregister')?.addEventListener('click', () => {
    if (!selectedFullStateName) return;
    openFullStateConfirm();
  });
  document.getElementById('bs-bt-full-state-apply')?.addEventListener('click', () => {
    applyFullStateManualEdit(ctx);
  });
  document.getElementById('bs-bt-full-state-reset')?.addEventListener('click', () => {
    renderSelectedFullStateEditor(ctx);
  });
  document.getElementById('bs-bt-full-state-confirm-yes')?.addEventListener('click', () => {
    if (!selectedFullStateName) return;
    unregisterCharacter(ctx, selectedFullStateName);
  });
  document.getElementById('bs-bt-full-state-confirm-no')?.addEventListener('click', () => {
    closeFullStateConfirm();
  });
  document.getElementById('bs-bt-clear')?.addEventListener('click', () => {
    const settings = getSettings(ctx);
    settings.chatStates[getChatKey(ctx)] = createEmptyChatState();
    saveSettings(ctx);
    renderStatusPanel(ctx);
    renderFullStatePage(ctx);
    updateMainFlowPrompt(ctx);
    setRegisterStatus('当前聊天状态已清除。');
    globalThis.toastr?.success?.('[BS BioTracker] 当前聊天状态已清除');
  });
  const clearAllChatsButton = document.getElementById('bs-bt-clear-all-chats');
  if (clearAllChatsButton && ['tauritavern', 'luker'].includes(getHostKind())) clearAllChatsButton.hidden = true;
  clearAllChatsButton?.addEventListener('click', () => {
    const settings = getSettings(ctx);
    const storedEntries = Object.entries(settings.chatStates || {});
    const chatCount = storedEntries.filter(([, chatState]) => !isChatStateEffectivelyEmpty(chatState)).length;
    if (chatCount <= 0) {
      if (storedEntries.length > 0) {
        settings.chatStates = {};
        saveSettings(ctx);
      }
      globalThis.toastr?.info?.('[BS BioTracker] 没有可清除的聊天追踪状态');
      return;
    }
    const confirmed = globalThis.confirm?.(
      `[BS BioTracker] 确定清空全部 ${chatCount} 个聊天的追踪状态吗？\n\n角色状态、快照、日记与累计时间都会删除，且无法复原。设置与种族参数不会被清除。`,
    );
    if (!confirmed) return;
    settings.chatStates = {};
    selectedTrackName = '';
    selectedFullStateName = '';
    closeFullStateConfirm();
    saveSettings(ctx);
    renderStatusPanel(ctx);
    renderFullStatePage(ctx);
    updateMainFlowPrompt(ctx);
    setRegisterStatus(`已清空全部 ${chatCount} 个聊天的 BioTracker 追踪状态。`);
    globalThis.toastr?.success?.(`[BS BioTracker] 已清空全部 ${chatCount} 个聊天的追踪状态`);
  });
  document.getElementById('bs-bt-close')?.addEventListener('click', () => {
    const modalRoot = document.getElementById(MODAL_ID);
    const dialog = modalRoot?.querySelector('.bs-bt-modal__dialog');
    const sphere = document.getElementById('bs-bt-floating-sphere');

    if (!modalRoot || !dialog || !sphere) {
      closeModal();
      return;
    }

    dialog.classList.add('is-shrinking');
    setTimeout(() => {
      dialog.classList.remove('is-shrinking');
      closeModal();

      restoreFloatingSpherePositionForElement(sphere);
      sphere.style.display = 'flex';
      sphere.classList.add('is-appearing');
      setTimeout(() => sphere.classList.remove('is-appearing'), 300);
    }, 300);
  });

  document.getElementById('bs-bt-time-lapse-submit')?.addEventListener('click', () => {
    const year = Number(document.getElementById('bs-bt-time-year')?.value) || 0;
    const month = Number(document.getElementById('bs-bt-time-month')?.value) || 0;
    const week = Number(document.getElementById('bs-bt-time-week')?.value) || 0;
    const day = Number(document.getElementById('bs-bt-time-day')?.value) || 0;
    const hour = Number(document.getElementById('bs-bt-time-hour')?.value) || 0;
    const minute = Number(document.getElementById('bs-bt-time-minute')?.value) || 0;

    const args = {};
    if (year > 0) args.year = year;
    if (month > 0) args.month = month;
    if (week > 0) args.week = week;
    if (day > 0) args.day = day;
    if (hour > 0) args.hour = hour;
    if (minute > 0) args.minute = minute;

    executeTimeLapse(ctx, args);
  });

  resetClockTicker();
  return modal;
}

function resetClockTicker() {
  if (globalThis[CLOCK_RUNTIME_KEY]) {
    globalThis.clearInterval?.(globalThis[CLOCK_RUNTIME_KEY]);
  }
  globalThis[CLOCK_RUNTIME_KEY] = globalThis.setInterval(() => updateClock(), 1000);
}

function extractDeletedChatKey(ctx, payload) {
  const directCandidates = [
    payload?.chatId,
    payload?.chat_id,
    payload?.id,
    payload?.data?.chatId,
    payload?.data?.chat_id,
    payload?.data?.id,
  ];
  for (const candidate of directCandidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }

  const currentKey = getChatKey(ctx);
  return String(currentKey || '').trim();
}

function cleanupOrphanedChatStateByKey(ctx, chatKey, reason = 'chat_deleted') {
  const settings = getSettings(ctx);
  const normalizedKey = String(chatKey || '').trim();
  if (!normalizedKey) return false;
  if (!settings.chatStates || typeof settings.chatStates !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(settings.chatStates, normalizedKey)) return false;

  delete settings.chatStates[normalizedKey];
  saveSettings(ctx);
  if (normalizedKey === getChatKey(ctx)) {
    renderStatusPanel(ctx);
    renderFullStatePage(ctx);
    updateMainFlowPrompt(ctx);
    setRegisterStatus('当前聊天对应的 BioTracker 状态已随聊天删除清理。');
  }
  console.info(`[BS BioTracker] cleaned orphaned chat state: ${normalizedKey} (${reason})`);
  return true;
}

function tryInheritForkedChatState(ctx, reason = 'chat_changed') {
  const settings = getSettings(ctx);
  const result = inheritChatStateFromMatchingChat(ctx, settings);
  if (result?.inherited || !['empty_chat'].includes(result?.reason || '')) {
    globalThis[PENDING_CHAT_INHERIT_KEY] = false;
  }
  if (!result?.inherited) return result;
  saveSettings(ctx);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  updateMainFlowPrompt(ctx);
  console.info(`[BS BioTracker] inherited chat state from ${result.fromChatKey} to ${getChatKey(ctx)} (${reason})`);
  return result;
}

function executeTimeLapse(ctx, args) {
  const elStatus = document.getElementById('bs-bt-time-lapse-status');
  if (!args || Object.keys(args).length === 0) {
    if (elStatus) elStatus.innerText = '未选择任何时间或时间无效。';
    return;
  }

  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);

  const result = applyToolCall(chatState, {
    name: 'bsPassedTime',
    arguments: args,
  });

  if (!result?.applied) {
    const msg = result?.message || '[BS BioTracker] 时间流逝执行失败';
    globalThis.toastr?.warning?.(msg);
    if (elStatus) elStatus.innerText = msg;
    return;
  }

  recordChatStateSnapshot(ctx, chatState, { reason: 'manual_time_lapse' });
  saveSettings(ctx);
  renderStatusPanel(ctx);
  if (typeof renderFullStatePage === 'function') renderFullStatePage(ctx);
  if (typeof updateMainFlowPrompt === 'function') updateMainFlowPrompt(ctx);

  globalThis.toastr?.success?.('[BS BioTracker] 已推进所有角色的生理时间');

  const timeStr = [];
  if (args.year) timeStr.push(`${args.year}年`);
  if (args.month) timeStr.push(`${args.month}月`);
  if (args.week) timeStr.push(`${args.week}周`);
  if (args.day) timeStr.push(`${args.day}天`);
  if (args.hour) timeStr.push(`${args.hour}小时`);
  if (args.minute) timeStr.push(`${args.minute}分钟`);

  if (elStatus) elStatus.innerText = `执行成功。\n\n受影响角色数量：${Object.keys(chatState.characters || {}).length}\n流逝时间量：${timeStr.join('')}。`;
}

function hasFloatingSphereRecoveryEntry() {
  if (document.getElementById(MENU_ITEM_ID) || document.getElementById(MENU_API_ID)) return true;
  const menu = document.getElementById('extensionsMenu');
  if (!menu) return false;
  return Array.from(menu.children).some((node) => String(node.textContent || '').trim() === 'BS BioTracker');
}

function createManualMenuItem(ctx) {
  if (hasFloatingSphereRecoveryEntry()) return true;
  const menu = document.getElementById('extensionsMenu');
  if (!menu) return false;
  const item = document.createElement('div');
  item.id = MENU_ITEM_ID;
  item.className = 'list-group-item flex-container flexGap5 interactable';
  item.tabIndex = 0;
  item.innerHTML = `<div class="fa-solid fa-person-pregnant extensionsMenuExtensionButton"></div><span>BS BioTracker</span>`;
  const handleActivate = (event) => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    if (event.type === 'keydown') event.preventDefault();
    toggleModal(ctx);
  };
  item.addEventListener('click', handleActivate);
  item.addEventListener('keydown', handleActivate);
  menu.appendChild(item);
  return true;
}

function ensureManualMenuItem(ctx, retries = 20) {
  if (createManualMenuItem(ctx)) return;
  if (retries <= 0) {
    console.warn('[BS BioTracker] 未找到 #extensionsMenu，无法插入菜单项。');
    return;
  }
  setTimeout(() => ensureManualMenuItem(ctx, retries - 1), 500);
}

function ensureTauriMenuRecovery(ctx) {
  const insertRecoveryEntry = () => {
    if (!createManualMenuItem(ctx)) return false;
    document.getElementById('extensionsMenuButton')?.style.setProperty('display', 'flex');
    return true;
  };

  if (insertRecoveryEntry()) return;
  if (globalThis[TAURI_MENU_RECOVERY_OBSERVER_KEY] || typeof MutationObserver !== 'function' || !document.body) return;

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!insertRecoveryEntry()) return;
      observer.disconnect();
      delete globalThis[TAURI_MENU_RECOVERY_OBSERVER_KEY];
    }, 0);
  });
  globalThis[TAURI_MENU_RECOVERY_OBSERVER_KEY] = observer;
  observer.observe(document.body, { childList: true });
}

async function registerMenuItem(ctx) {
  const tauriReady = globalThis.__TAURITAVERN__?.ready || globalThis.__TAURITAVERN_MAIN_READY__;
  if (tauriReady && typeof tauriReady.then === 'function') {
    try {
      await tauriReady;
    } catch (error) {
      console.warn('[BS BioTracker] 等待 TauriTavern 宿主就绪失败。', error);
    }
  }
  const isTauriTavern = getHostKind() === 'tauritavern';
  let registered = false;
  try {
    registered = await registerHostExtensionMenuItem({
        id: MENU_API_ID,
        label: 'BS BioTracker',
        icon: 'fa-solid fa-person-pregnant',
        onClick: () => toggleModal(ctx),
    });
  } catch (error) {
    console.warn('[BS BioTracker] host 菜单注册失败，改用手动注入。', error);
  }
  // TauriTavern starts third-party extensions before its wand menu is
  // necessarily mounted. Observe the actual menu creation instead of relying
  // on a bounded retry or on a host API success value.
  if (isTauriTavern) {
    ensureTauriMenuRecovery(ctx);
    ensureManualMenuItem(ctx, TAURI_MENU_RECOVERY_RETRY_COUNT);
    return;
  }
  if (!registered) ensureManualMenuItem(ctx);
}

async function bootstrap() {
  const ctx = getContextSafe();
  if (!ctx) return;
  if (globalThis[BOOTSTRAP_RUNTIME_KEY]) return;
  globalThis[BOOTSTRAP_RUNTIME_KEY] = true;
  try {
    await hydrateChatStateFromHost(ctx, getSettings(ctx));
    installMainflowRequestCapture();
    await ensureModal(ctx);
    await registerMenuItem(ctx);
    trackerDeps.updateMainFlowPrompt = updateMainFlowPrompt;
    resetPoller(ctx, trackerDeps);
    updateMainFlowPrompt(ctx);
    globalThis[CHAT_CHANGED_HANDLER_KEY] = replaceHostEventSubscription(
      ctx,
      'chatChanged',
      globalThis[CHAT_CHANGED_HANDLER_KEY],
      async () => {
        await hydrateChatStateFromHost(ctx, getSettings(ctx));
        if (globalThis[PENDING_CHAT_INHERIT_KEY]) {
          tryInheritForkedChatState(ctx, 'chat_changed');
        }
        renderStatusPanel(ctx);
        updateMainFlowPrompt(ctx);
        scheduleWorldbookFilterReload(ctx, 'chat_changed');
      },
    );
    globalThis[CHAT_CREATED_HANDLER_KEY] = replaceHostEventSubscription(
      ctx,
      'chatCreated',
      globalThis[CHAT_CREATED_HANDLER_KEY],
      () => {
        globalThis[PENDING_CHAT_INHERIT_KEY] = true;
        tryInheritForkedChatState(ctx, 'chat_created');
        scheduleWorldbookFilterReload(ctx, 'chat_created');
      },
    );
    globalThis[CHAT_DELETED_HANDLER_KEY] = replaceHostEventSubscription(
      ctx,
      'chatDeleted',
      globalThis[CHAT_DELETED_HANDLER_KEY],
      (payload) => {
        const chatKey = extractDeletedChatKey(ctx, payload);
        cleanupOrphanedChatStateByKey(ctx, chatKey, 'chat_deleted');
      },
    );
    globalThis[GROUP_CHAT_DELETED_HANDLER_KEY] = replaceHostEventSubscription(
      ctx,
      'groupChatDeleted',
      globalThis[GROUP_CHAT_DELETED_HANDLER_KEY],
      (payload) => {
        const chatKey = extractDeletedChatKey(ctx, payload);
        cleanupOrphanedChatStateByKey(ctx, chatKey, 'group_chat_deleted');
      },
    );
    globalThis[GROUP_CHAT_CREATED_HANDLER_KEY] = replaceHostEventSubscription(
      ctx,
      'groupChatCreated',
      globalThis[GROUP_CHAT_CREATED_HANDLER_KEY],
      () => {
        globalThis[PENDING_CHAT_INHERIT_KEY] = true;
        tryInheritForkedChatState(ctx, 'group_chat_created');
        scheduleWorldbookFilterReload(ctx, 'group_chat_created');
      },
    );
  } catch (error) {
    globalThis[BOOTSTRAP_RUNTIME_KEY] = false;
    throw error;
  }
}

const ctx = getContextSafe();
globalThis[APP_READY_HANDLER_KEY] = replaceHostEventSubscription(
  ctx,
  'appReady',
  globalThis[APP_READY_HANDLER_KEY],
  bootstrap,
);
if (!globalThis[APP_READY_HANDLER_KEY]) setTimeout(() => {
  bootstrap().catch((error) => console.error('[BS BioTracker] bootstrap failed', error));
}, 1000);
