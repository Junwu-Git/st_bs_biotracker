import { fetchModelList } from './scripts/api.js';
import { runRegistry } from './scripts/registry.js';
import {
  AMORPHOUS_RACES,
  DERIVED_TYPE_RACES,
  getEmbryoTypeByRace,
  getDerivedTypeFluxProfile,
  METOVIVIPAROUS_RACES,
  OVIPAROUS_RACES,
  OVOVIVIPAROUS_RACES,
  VIVIPAROUS_RACES,
} from './scripts/race_config.js';
import { LABOR_STAGES, MENSTRUAL_STAGE_DAYS, PREGNANCY_STAGE_DAYS } from './scripts/stage_config.js';
import { buildMainFlowPrompt, resetPoller, runTracker } from './scripts/tracker.js';
import { applyToolCall } from './scripts/tools.js';
import { getEmbryoTypeReferenceText } from './scripts/embryo_prompt_context.js';
import { buildSingleRacePhysiologyText } from './scripts/race_prompt_context.js';
import {
  createEmptyChatState,
  DEFAULT_SYSTEM_PROMPT,
  getCharacterWorldBookName,
  getCharacterWorldBookNameViaSTscript,
  getGestationEffectiveSpeed,
  getGestationSpeciesSpeed,
  getChatKey,
  getChatState,
  getContextSafe,
  inheritChatStateFromMatchingChat,
  getResolvedCharacter,
  getSettings,
  MODULE_NAME,
  normalizeCharacterPsychologyState,
  recordChatStateSnapshot,
  saveSettings,
  THEME_CONFIG,
} from './scripts/state.js';

const PANEL_ID = 'bs-biotracker-settings';
const MODAL_ID = 'bs-biotracker-modal';
const MENU_ITEM_ID = 'bs-biotracker-menu-item';
const MENU_API_ID = 'bs-biotracker-menu-api';
const MAINFLOW_PROMPT_KEY = `${MODULE_NAME}_mainflow`;
const LAST_VIEW_STORAGE_KEY = `${MODULE_NAME}_last_view`;
const TRACK_SUBPAGES = ['overview', 'description', 'pregnancy', 'experience', 'debug'];
const MAX_PROGRESS_BAR_CAP = 200;
const MODAL_EDGE_GAP = 24;
const UPDATE_CUE_EVENT = 'bs-biotracker:update-cue';
const FLOATING_SPHERE_POSITION_KEY = `${MODULE_NAME}_floating_sphere_position`;
const FLOATING_SPHERE_DRAG_THRESHOLD = 8;
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
const VITALITY_CAPS = { 1: 50, 2: 75, 3: 100, 4: 125, 5: 150, 6: 175, 7: 200 };
const PSY_STRESS_CAPS = { 1: 20, 2: 50, 3: 80, 4: 110, 5: 140, 6: 170, 7: 200 };

let selectedFullStateName = '';
let selectedTrackName = '';
let selectedTrackSubpage = 'overview';
let selectedTrackCardIndexes = {};
let selectedRaceEncyclopedia = '';
let selectedDerivedEncyclopedia = '';
let worldbookEntrySearch = '';
let latestWorldbookEntries = [];
let racePaletteState = {
  targetInputId: '',
  isOpen: false,
  selectedRace: '人类',
  selectedDerivedType: '',
  derivedSubtype: '',
  subtype: '',
  raceTags: [],
};
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

function getWorldbookFilterInputNames(ctx) {
  const settings = getSettings(ctx);
  const mode = String(settings.trackerWorldbookMode || 'exclude').trim();
  if (mode === 'allowlist_all') return parseWorldbookExcludeNamesInput(settings.trackerWorldbookIncludeNames);
  return parseWorldbookExcludeNamesInput(settings.trackerWorldbookExcludeNames);
}

function syncWorldbookFilterInput(ctx) {
  const settings = getSettings(ctx);
  const mode = String(settings.trackerWorldbookMode || 'exclude').trim();
  const label = document.getElementById('bs-bt-worldbook-filter-input-label');
  const input = document.getElementById('bs-bt-worldbook-filter-input');
  const names = getWorldbookFilterInputNames(ctx);
  if (label) label.textContent = mode === 'allowlist_all' ? '可参考' : '可排除';
  if (input) {
    input.value = names.join('\n');
    input.placeholder = mode === 'allowlist_all'
      ? '每行一个条目名。参考模式下，仅这些条目会传给 tracker；即使它们目前是 disabled 也会保留。'
      : '每行一个条目名。正常模式下，这些条目会从 worldbook 传输中排除。';
  }
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

function applyWorldbookFilterSelection(ctx, entries = [], selectedNames = []) {
  latestWorldbookEntries = Array.isArray(entries) ? entries : [];
  const settings = getSettings(ctx);
  const mode = String(settings.trackerWorldbookMode || 'exclude').trim();
  if (mode === 'allowlist_all') {
    settings.trackerWorldbookIncludeNames = parseWorldbookExcludeNamesInput(selectedNames.join('\n')).join('\n');
  } else {
    settings.trackerWorldbookExcludeNames = parseWorldbookExcludeNamesInput(selectedNames.join('\n')).join('\n');
  }
  syncWorldbookFilterInput(ctx);
  renderWorldbookEntryList(ctx, latestWorldbookEntries, selectedNames);
}

function renderWorldbookEntryList(ctx, entries = [], selectedNames = null) {
  const container = document.getElementById('bs-bt-worldbook-entry-list');
  const title = document.querySelector('#bs-bt-view-worldbook-filter .bs-bt-status-title');
  const clearButton = document.getElementById('bs-bt-worldbook-clear-all');
  const searchInput = document.getElementById('bs-bt-worldbook-entry-search');
  if (!container) return;
  const settings = getSettings(ctx);
  const mode = String(settings.trackerWorldbookMode || 'exclude').trim();
  if (searchInput && searchInput.value !== worldbookEntrySearch) searchInput.value = worldbookEntrySearch;
  const selected = new Set(
    Array.isArray(selectedNames)
      ? parseWorldbookExcludeNamesInput(selectedNames.join('\n'))
      : getWorldbookFilterInputNames(ctx),
  );

  const normalizedEntries = [];
  for (const item of (Array.isArray(entries) ? entries : [])) {
    if (!item) continue;
    if (typeof item === 'string') {
      const name = item.trim();
      if (name && !normalizedEntries.find((e) => e.name === name)) normalizedEntries.push({ name, mode: '' });
    } else if (item.name) {
      const name = String(item.name).trim();
      if (name && !normalizedEntries.find((e) => e.name === name)) normalizedEntries.push({ name, mode: item.mode || '' });
    }
  }
  const keyword = String(worldbookEntrySearch || '').trim().toLowerCase();
  const filteredEntries = keyword
    ? normalizedEntries.filter((entry) =>
      String(entry?.name || '').toLowerCase().includes(keyword)
      || String(entry?.mode || '').toLowerCase().includes(keyword))
    : normalizedEntries;

  container.innerHTML = '';
  if (title) title.textContent = mode === 'allowlist_all' ? '当前世界书条目（仅供参考）' : '可排除条目';
  if (clearButton) clearButton.textContent = '清空当前文本框';

  if (normalizedEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bs-bt-connect-status';
    empty.textContent = '当前角色世界书暂无可识别条目';
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
    const { name, mode } = entryObj;
    const label = document.createElement('label');
    label.className = 'bs-bt-theme-option';
    label.style.display = 'grid';
    label.style.gridTemplateColumns = '20px minmax(0, 1fr)';
    label.style.alignItems = 'start';
    label.style.gap = '8px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(name);
    checkbox.addEventListener('change', async () => {
      const nextSelected = new Set(getWorldbookFilterInputNames(ctx));
      if (checkbox.checked) nextSelected.add(name);
      else nextSelected.delete(name);
      if (String(getSettings(ctx).trackerWorldbookMode || 'exclude').trim() === 'allowlist_all') {
        saveWorldbookIncludeNamesFromList(ctx, Array.from(nextSelected));
      } else {
        saveWorldbookExcludeNamesFromList(ctx, Array.from(nextSelected));
      }
      try {
        await refreshWorldbookFilterPage(ctx);
      } catch (error) {
        console.error('[BS BioTracker] refreshWorldbookFilterPage after checkbox change failed', error);
      }
    });

    const textWrap = document.createElement('div');
    textWrap.style.display = 'flex';
    textWrap.style.gap = '8px';
    textWrap.style.alignItems = 'baseline';

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

function updateBatteryIndicator(activeCharacterCount = 0) {
  const icons = document.getElementById('bs-bt-status-icons');
  const fill = document.getElementById('bs-bt-battery-fill');
  if (!icons || !fill) return;
  const count = Math.max(0, Math.floor(Number(activeCharacterCount) || 0));
  const chargeRatio = count >= 3 ? 0.18 : count === 2 ? 0.38 : count === 1 ? 0.62 : 0.88;
  const width = Math.max(3, Math.round(16 * chargeRatio));
  fill.setAttribute('width', String(width));
  icons.dataset.batteryState = count >= 3 ? 'critical' : count === 2 ? 'low' : count === 1 ? 'mid' : 'high';
  icons.setAttribute('aria-label', `battery ${width}/16 with ${count} tracked active character${count === 1 ? '' : 's'}`);
}

function renderRaceEncyclopediaPage() {
  const countNode = document.getElementById('bs-bt-race-count');
  const selectNode = document.getElementById('bs-bt-race-select');
  const outputNode = document.getElementById('bs-bt-race-output');
  const derivedSelectNode = document.getElementById('bs-bt-derived-select');
  const derivedOutputNode = document.getElementById('bs-bt-derived-output');
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
  } else {
    const embryoType = getEmbryoTypeByRace(selectedRaceEncyclopedia);
    const embryoText = getEmbryoTypeReferenceText(embryoType);
    const physiologyText = buildSingleRacePhysiologyText(selectedRaceEncyclopedia);
    outputNode.textContent = [physiologyText, embryoText].filter(Boolean).join('\n\n');
  }

  if (!selectedDerivedEncyclopedia) {
    derivedOutputNode.textContent = '暂无可显示的衍生资料。';
    return;
  }

  const fluxProfile = getDerivedTypeFluxProfile(selectedDerivedEncyclopedia);
  const fluxName = String(fluxProfile?.fluxName || '未知').trim() || '未知';
  const fluxDefinition = String(fluxProfile?.fluxDefinition || '').trim();
  derivedOutputNode.textContent = [
    `【${selectedDerivedEncyclopedia}】`,
    `- Flux: ${fluxName}`,
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
    delete metabolism.urine;
    delete metabolism.stool;
    delete metabolism.hunger;
    delete metabolism.sleep;
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
        .split(/[\r\n,]+/)
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
      if (typeof ctx?.loadWorldInfo === 'function') {
        try {
          return await ctx.loadWorldInfo(String(candidate.value));
        } catch (error) {
          console.warn('[BS BioTracker] getCurrentCharacterWorldbook loadWorldInfo failed', error);
        }
      }
      continue;
    }
    return candidate.value;
  }
  const scriptWorldBookName = await getCharacterWorldBookNameViaSTscript();
  if (scriptWorldBookName && typeof ctx?.loadWorldInfo === 'function') {
    try {
      return await ctx.loadWorldInfo(String(scriptWorldBookName));
    } catch (error) {
      console.warn('[BS BioTracker] getCurrentCharacterWorldbook STscript/loadWorldInfo failed', error);
    }
  }
  if (globalThis.ST_API?.worldBook?.get) {
    try {
      const result = await globalThis.ST_API.worldBook.get({ name: getCharacterWorldBookName(ctx) || scriptWorldBookName || 'Current Chat', scope: 'character' });
      return result?.worldBook || null;
    } catch (error) {
      console.warn('[BS BioTracker] inspectCurrentCharacterWorldbook fallback failed', error);
    }
  }
  return null;
}

async function inspectCurrentCharacterWorldbook(ctx) {
  const worldBook = await getCurrentCharacterWorldbook(ctx);
  const settings = getSettings(ctx);
  const mode = String(settings.trackerWorldbookMode || 'exclude').trim();
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
  if (globalThis.ST_API?.worldBook?.get) {
    try {
      const result = await globalThis.ST_API.worldBook.get({ name: 'Current Chat', scope: 'character' });
      apiSourceSummary = summarizeValueShape(result?.worldBook);
      apiSourcePreview = safeJsonPreview(result?.worldBook);
    } catch (error) {
      apiSourceSummary = `调用失败: ${String(error?.message || error)}`;
    }
  }
  const lines = [
    `角色：${characterName}`,
    `characterId：${characterId === undefined ? 'undefined' : String(characterId)}`,
    `resolvedCharacterId：${resolvedCharacterId === null || resolvedCharacterId === undefined ? '无' : String(resolvedCharacterId)}`,
    `resolvedSource：${resolvedSource}`,
    `groupId：${groupId === undefined || groupId === null || groupId === '' ? '无' : String(groupId)}`,
    `loadWorldInfo：${typeof ctx?.loadWorldInfo === 'function' ? '可用' : '不可用'}`,
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
  return ['已着床', ...Object.keys(PREGNANCY_STAGE_DAYS), ...LABOR_STAGES].includes(String(stage || ''));
}

function getStageProgress(profile) {
  const base = profile?.base || {};
  const pregnant = profile?.pregnant || {};
  const stage = String(base.stage || '').trim();
  if (!stage) return null;
  if (LABOR_STAGES.includes(stage)) {
    return {
      label: '产程进度',
      value: Number(pregnant.effectiveLaborHours) || 0,
      max: stage === '第一产程' ? 12 : stage === '第二产程' ? 2 : 1,
      unit: 'h',
    };
  }
  if (Object.prototype.hasOwnProperty.call(PREGNANCY_STAGE_DAYS, stage)) {
    return { label: '阶段进度', value: Number(base.days) || 0, max: PREGNANCY_STAGE_DAYS[stage], unit: 'd' };
  }
  if (stage === '逾期') {
    return { label: '阶段进度', value: Number(base.days) || 0, max: 28, unit: 'd' };
  }
  if (Object.prototype.hasOwnProperty.call(MENSTRUAL_STAGE_DAYS, stage)) {
    return { label: '阶段进度', value: Number(base.days) || 0, max: MENSTRUAL_STAGE_DAYS[stage], unit: 'd' };
  }
  return { label: '阶段进度', value: Number(base.days) || 0, max: 1, unit: 'd' };
}

function getLibidoCap(stage, profile = null) {
  const isTruePregnancy = ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产前阵痛', '第一产程', '第二产程', '第三产程'].includes(stage);
  if (isTruePregnancy && profile) {
    const effectivePregnantDays = Number(profile.pregnant?.effectivePregnantDays) || 0;
    const months = Math.floor(effectivePregnantDays / 28);
    const progress = Math.max(0, Math.min(10, months)) / 10;
    return Math.round(100 + (150 - 100) * progress);
  }
  return 100;
}

function getUterinePressureCap(stage, profile = null) {
  const isTruePregnancy = ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产前阵痛', '第一产程', '第二产程', '第三产程'].includes(stage);
  if (isTruePregnancy && profile) {
    const effectivePregnantDays = Number(profile.pregnant?.effectivePregnantDays) || 0;
    const months = Math.floor(effectivePregnantDays / 28);
    const progress = Math.max(0, Math.min(10, months)) / 10;
    return Math.round(50 + (150 - 50) * progress);
  }
  return 50;
}

function getMetabolismLevel(value) {
  const next = Number(value) || 0;
  if (next >= 125) return '爆';
  if (next >= 100) return '满';
  if (next >= 75) return '高';
  if (next >= 50) return '中';
  if (next >= 25) return '低';
  return '无';
}

function getDerivedFluxSummary(value) {
  const next = Number(value) || 0;
  const abs = Math.abs(next);
  const polarity = next >= 0 ? '正极' : '负极';
  let stage = '平衡';
  let description = '需求接近平衡，暂时没有明显偏向。';

  if (abs >= 125) {
    stage = `${polarity}爆发`;
    description = `需求已严重偏向${polarity}，应尽快解放，否则容易压过理智与自控。`;
  } else if (abs >= 100) {
    stage = `${polarity}饱和`;
    description = `需求已高度集中于${polarity}，再继续累积就会逼近失衡边缘。`;
  } else if (abs >= 75) {
    stage = `${polarity}高涨`;
    description = `需求明显偏向${polarity}，已进入需要认真处理的危险区。`;
  } else if (abs >= 50) {
    stage = `${polarity}活跃`;
    description = `需求正稳定向${polarity}偏移，已经能感受到持续牵引。`;
  } else if (abs >= 25) {
    stage = `${polarity}浮动`;
    description = `需求轻度偏向${polarity}，目前仍属于可控范围。`;
  }

  return `${stage} (${Math.round(next)})：${description}`;
}

function getMetabolismSummary(metabolism = {}, immune = {}, derivedType = null) {
  if (immune?.metabolism) return '代谢免疫';
  if (derivedType) return getDerivedFluxSummary(metabolism.flux);
  return {
    hunger: getMetabolismLevel(metabolism.hunger),
    sleep: getMetabolismLevel(metabolism.sleep),
    urine: getMetabolismLevel(metabolism.urine),
    stool: getMetabolismLevel(metabolism.stool),
  };
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

function getPsychologyView(profile = {}) {
  const preg = profile?.psychology?.preg || {};
  const mens = profile?.psychology?.mens || {};
  const stage = String(profile?.base?.stage || '');
  if (isPregnantStage(stage)) {
    return {
      title: '繁育心理',
      items: [
        { label: '察觉', value: preg.cognition_value ?? 0 },
        { label: '依附', value: preg.bonding_value ?? 0 },
        { label: '导向', value: preg.stance_value ?? 0 },
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
      { label: '掌控', value: mens.mastery_value ?? 0 },
      { label: '欲望', value: mens.desire_value ?? 0 },
      { label: '自主', value: mens.autonomy_value ?? 0 },
    ],
    flags: [
      { label: '贞洁/单伴侣', active: Boolean(mens.isChaste) },
      { label: '避孕措施', active: Boolean(mens.hasContraception) },
    ],
  };
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

function buildTrackCharacterViewModel(character) {
  const profile = character?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const experience = profile.experience || {};
  const descriptions = profile.descriptions || {};
  const immune = profile.immune || {};
  const bio = profile.bio || {};
  const gestationSpeciesSpeed = getGestationSpeciesSpeed(profile);
  const gestationEffectiveSpeed = getGestationEffectiveSpeed(profile);
  const gestationModifierMultiplier = Number.isFinite(Number(bio.gestationModifierMultiplier)) ? Number(bio.gestationModifierMultiplier) : 1;
  const stage = String(base.stage || '未设定');
  const totalSperm = (Array.isArray(base.sperms) ? base.sperms : []).reduce((sum, item) => sum + (Number(item?.value) || 0), 0);
  return {
    name: character?.name || '未命名',
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
      metabolismSummary: getMetabolismSummary(profile.metabolism, immune, base.derivedType),
    },
    description: {
      normalBlocks: parseDescriptionBlocks(descriptions.normalDescription),
      closeupBlocks: parseDescriptionBlocks(descriptions.closeupDescription),
      psychology: getPsychologyView(profile),
    },
    pregnancy: {
      eggs: Number(base.eggs) || 0,
      totalSperm,
      sperms: Array.isArray(base.sperms) ? base.sperms : [],
      pregnantDays: Number(pregnant.pregnantDays) || 0,
      effectivePregnantDays: Number(pregnant.effectivePregnantDays) || 0,
      laborHours: Number(pregnant.laborHours) || 0,
      amnionDurability: Number(pregnant.amnionDurability) || 0,
      fetuses: Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [],
      pregnantBlocks: parseDescriptionBlocks(descriptions.pregnantDescription),
      showPregnantFields: isPregnantStage(stage) || (Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0),
      showLaborFields: LABOR_STAGES.includes(stage),
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
    debug: {
      immune: {
        metabolism: Boolean(immune.metabolism),
        miscarriage: Boolean(immune.miscarriage),
      },
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
      hasConceptionState: (Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0)
        || (Number(base.fertilizationDays) || 0) > 0
        || isPregnantStage(stage),
    },
  };
}

function renderDescriptionGroup(title, blocks) {
  const items = Array.isArray(blocks) ? blocks : [];
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
  return `<div class="bs-bt-track-section"><div class="bs-bt-track-section-title">${escapeHtml(title)}</div><div class="bs-bt-track-description-list">${html}</div></div>`;
}

function renderProgressList(items) {
  return items
    .map((item) => {
      const value = Math.max(0, Number(item.value) || 0);
      const cap = Math.max(1, Number(item.cap) || 1);
      const fill = `${Math.min(100, (value / cap) * 100)}%`;
      const scale = `${Math.max(25, (cap / MAX_PROGRESS_BAR_CAP) * 100)}%`;
      return `<div class="bs-bt-track-progress">
        <div class="bs-bt-track-progress-head"><span>${escapeHtml(item.label)}</span><span>${Math.round(value)} / ${cap}</span></div>
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

function renderCardCarouselSection(title, items, renderCard, emptyText, kind) {
  if (!Array.isArray(items) || items.length === 0) {
    return `
      <div class="bs-bt-track-section">
        <div class="bs-bt-track-section-title">${escapeHtml(title)}</div>
        <div class="bs-bt-track-card-empty">${escapeHtml(emptyText)}</div>
      </div>
    `;
  }

  const currentIndex = setTrackCardIndex(kind, getTrackCardIndex(kind, items.length), items.length);
  const currentItem = items[currentIndex];
  const showNav = items.length > 1;
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span>${escapeHtml(title)}</span>
        <span style="display:flex;align-items:center;gap:8px;">
          ${showNav
            ? `<button type="button" class="menu_button" data-card-nav="${escapeHtml(kind)}" data-card-step="-1" style="min-width:32px;padding:2px 8px;">◀</button>
               <button type="button" class="menu_button" data-card-nav="${escapeHtml(kind)}" data-card-step="1" style="min-width:32px;padding:2px 8px;">▶</button>`
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
  const progressHtml = progress
    ? renderProgressList([{ label: viewModel.overview.stage, value: progress.value, cap: progress.max }])
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
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">阶段</div>
      ${progressHtml}
    </div>
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">状态值</div>
      <div class="bs-bt-track-progress-list">${renderProgressList(viewModel.overview.stats)}</div>
    </div>
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">代谢需求</div>
      ${typeof viewModel.overview.metabolismSummary === 'string'
      ? `<div>${escapeHtml(viewModel.overview.metabolismSummary)}</div>`
      : `<div class="bs-bt-track-metabolism-grid">
              <div class="bs-bt-track-metabolism-item"><span class="bs-bt-track-metabolism-label">饿意:</span><span>${escapeHtml(viewModel.overview.metabolismSummary.hunger)}</span></div>
              <div class="bs-bt-track-metabolism-item"><span class="bs-bt-track-metabolism-label">困意:</span><span>${escapeHtml(viewModel.overview.metabolismSummary.sleep)}</span></div>
              <div class="bs-bt-track-metabolism-item"><span class="bs-bt-track-metabolism-label">尿意:</span><span>${escapeHtml(viewModel.overview.metabolismSummary.urine)}</span></div>
              <div class="bs-bt-track-metabolism-item"><span class="bs-bt-track-metabolism-label">便意:</span><span>${escapeHtml(viewModel.overview.metabolismSummary.stool)}</span></div>
            </div>`
    }
    </div>
  `;
}

function renderTrackDescription(viewModel) {
  const psychology = viewModel.description.psychology;
  const flags = Array.isArray(psychology.flags) ? psychology.flags : [];
  return `
    ${renderDescriptionGroup('基本描述', viewModel.description.normalBlocks)}
    ${renderDescriptionGroup('特写描述', viewModel.description.closeupBlocks)}
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">${escapeHtml(psychology.title)}</div>
      <div class="bs-bt-track-radar-wrap">${buildRadarSvg(psychology.items)}</div>
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
  const hasGestationModifier = Boolean(
    String(gestationModifier.name || '').trim()
    || String(gestationModifier.description || '').trim()
    || Math.abs(Number(gestationModifier.multiplier ?? 1) - 1) > 0.000001,
  );
  return `
    <div class="bs-bt-track-section">
      <div class="bs-bt-track-section-title">孕育概况</div>
      <div class="bs-bt-track-meta">
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">卵子</span><span class="bs-bt-track-meta-value">${data.eggs}</span></div>
        <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">精液</span><span class="bs-bt-track-meta-value">${Math.round(data.totalSperm)}</span></div>
        ${data.showPregnantFields
      ? `<div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">妊娠天数</span><span class="bs-bt-track-meta-value">${Math.floor(Number(data.pregnantDays) || 0)}</span></div>`
      : ''
    }
        ${data.showLaborFields
      ? `<div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">分娩时数</span><span class="bs-bt-track-meta-value">${Math.floor(Number(data.laborHours) || 0)}</span></div>
               <div class="bs-bt-track-meta-row"><span class="bs-bt-track-meta-label">羊膜耐久</span><span class="bs-bt-track-meta-value">${data.amnionDurability}</span></div>`
      : ''
    }
      </div>
    </div>
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
              </div>`,
        '当前无妊娠胎儿资料',
        'fetuses',
      )}
          ${renderDescriptionGroup('孕态描述', data.pregnantBlocks)}`
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

function renderTrackDebug(viewModel) {
  const immune = viewModel.debug?.immune || {};
  const counts = viewModel.debug?.counts || {};
  const hasConceptionState = Boolean(viewModel.debug?.hasConceptionState);
  const gestationModifier = viewModel.debug?.gestationModifier || {};

  const currentStage = viewModel.base?.stage || '';
  const hasProtectedPregnancyState = hasConceptionState || ['孕早期', '孕中期', '孕晚期', '临产期', '逾期', '产前阵痛', '第一产程', '第二产程', '第三产程'].includes(currentStage);

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
          <span class="bs-bt-track-debug-label">怀孕天数(人類等效孕期，0代表刚受精)</span>
          <input id="bs-bt-debug-days" class="text_pole" type="number" min="0" max="300" value="${daysValue}" />
        </label>
        <button type="button" class="menu_button" data-debug-action="inject-pregnancy">执行注入</button>
      </fieldset>
      <div class="bs-bt-track-debug-hint">${hasConceptionState ? '当前角色已有受精或妊娠状态，已禁用此操作。' : '父亲名字、父亲种族、性别都可用逗号逐胎填写；填一位父亲 + 胎数 > 1 = 同父多胎；填多位父亲 = 异父妊娠。'}</div>
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
  if (selectedTrackSubpage === 'debug') return renderTrackDebug(viewModel);
  return renderTrackOverview(viewModel);
}

function toggleSelectedTrackImmune(ctx, immuneKey) {
  if (!selectedTrackName) return;
  if (!['metabolism', 'miscarriage'].includes(immuneKey)) return;
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
  globalThis.toastr?.success?.(
    `[BS BioTracker] ${selectedTrackName} 的 ${immuneKey === 'metabolism' ? '代谢免疫' : '流产免疫'}已${nextValue ? '开启' : '关闭'}`,
  );
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
  globalThis.toastr?.success?.(
    clear
      ? `[BS BioTracker] 已清除 ${selectedTrackName} 的妊娠变速效果`
      : `[BS BioTracker] 已为 ${selectedTrackName} 设置妊娠变速效果`,
  );
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
  const label = container === 'sperms' ? '精液' : container === 'fetuses' ? '胎儿' : '孩子';
  globalThis.toastr?.success?.(`[BS BioTracker] 已为 ${selectedTrackName} 淨空${label}`);
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
  updateBatteryIndicator(characters.filter((item) => item?.profile?.base?.isHere !== false).length);

  list.innerHTML = '';
  if (latestCall) {
    const toolCalls = Array.isArray(chatState.lastRawResult?.tool_calls) ? chatState.lastRawResult.tool_calls : [];
    latestCall.textContent =
      toolCalls.length > 0
        ? JSON.stringify(toolCalls, null, 2)
        : chatState.lastRawResult
          ? JSON.stringify(chatState.lastRawResult, null, 2)
          : '尚无数据';
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
  for (const path of ['base', 'pregnant', 'experience', 'bio', 'metabolism', 'notify', 'immune', 'psychology', 'descriptions', 'cooldown']) {
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
  renderSelectedFullStateEditor(ctx);
  updateFullStateControls();
  closeFullStateConfirm();
  setView('full-state');
  globalThis.toastr?.success?.(`[BS BioTracker] 已显示 ${name} 的完整变量`);
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
    updateFullStateControls();
    closeFullStateConfirm();
    return;
  }

  if (!chatState.characters[selectedFullStateName]) {
    selectedFullStateName = names[0];
  }

  for (const name of names) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bs-bt-theme-option';
    button.textContent = name;
    button.addEventListener('click', () => showFullState(ctx, name));
    list.appendChild(button);
  }

  if (selectedFullStateName && chatState.characters[selectedFullStateName]) {
    output.value = getFullStateEditorText(chatState.characters[selectedFullStateName]);
    setFullStateEditStatus('可直接编辑 JSON，应用前会检查格式与基础结构。');
  } else {
    output.value = '请选择角色查看完整变量。';
    setFullStateEditStatus('请选择角色后再编辑。');
  }
  updateFullStateControls();
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
    timeEl.textContent = `第 ${days} 天`;
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
  const brand = document.getElementById('bs-bt-brand');
  if (brand) brand.textContent = 'Bastneth Pager';
  updateBatteryIndicator(0);
  updateClock();
}

function setView(view) {
  const root = document.getElementById(PANEL_ID);
  if (!root) return;
  const next = ['home', 'system', 'register', 'worldbook-filter', 'track-list', 'track-char', 'full-state', 'time-lapse', 'race-encyclopedia'].includes(view) ? view : 'home';
  root.dataset.view = next;
  try {
    globalThis.localStorage?.setItem(LAST_VIEW_STORAGE_KEY, next);
  } catch {}
  document.querySelectorAll('#bs-biotracker-settings .bs-bt-view').forEach((node) => node.classList.toggle('is-active', node.dataset.view === next));
  const title = document.getElementById('bs-bt-title');
  if (title) title.textContent = next === 'system' ? 'SYSTEM' : next === 'register' ? 'REGISTRY' : next === 'worldbook-filter' ? 'WORLDBOOK' : next === 'track-list' ? 'TRACK LIST' : next === 'track-char' ? 'TRACK CHAR' : next === 'full-state' ? 'FULL STATE' : next === 'time-lapse' ? 'TIME LAPSE' : next === 'race-encyclopedia' ? 'RACE DATA' : 'HOME';
}

function getLastPagerView() {
  try {
    const value = String(globalThis.localStorage?.getItem(LAST_VIEW_STORAGE_KEY) || '').trim();
    if (['home', 'system', 'register', 'worldbook-filter', 'track-list', 'track-char', 'full-state', 'time-lapse', 'race-encyclopedia'].includes(value)) {
      return value;
    }
  } catch {}
  return 'home';
}

function applySettingsToForm(ctx) {
  const settings = getSettings(ctx);
  const setValue = (id, value) => {
    const node = document.getElementById(id);
    if (!node) return;
    if (node.type === 'checkbox') node.checked = Boolean(value);
    else node.value = value ?? '';
  };
  setValue('bs-bt-enabled', settings.enabled);
  setValue('bs-bt-use-st-preset', settings.useStPresetForAsync);
  setValue('bs-bt-api-url', settings.apiUrl);
  setValue('bs-bt-api-key', settings.apiKey);
  setValue('bs-bt-model', settings.model);
  setValue('bs-bt-trigger', settings.triggerTiming);
  setValue('bs-bt-poll-ms', settings.pollMs);
  setValue('bs-bt-context-size', settings.contextSize);
  setValue('bs-bt-targets', settings.targetNames);
  setValue('bs-bt-tracker-worldbook-mode', settings.trackerWorldbookMode);
  setValue('bs-bt-system-prompt', settings.systemPrompt);
  setValue('bs-bt-register-custom-notes', settings.registryCustomNotes);
  setValue('bs-bt-registry-normal-description', settings.registryDescriptionGuides?.normalDescription);
  setValue('bs-bt-registry-closeup-description', settings.registryDescriptionGuides?.closeupDescription);
  setValue('bs-bt-registry-pregnant-description', settings.registryDescriptionGuides?.pregnantDescription);
  populateModelList(settings);
  setConnectStatus(settings.modelOptions.length > 0 ? `已缓存 ${settings.modelOptions.length} 个模型` : '尚未连接');
  setRegisterStatus('输入名字与 Description 规则后发送注册请求，完成后可在“角色追踪”查看该角色状态变量。');
  syncWorldbookFilterInput(ctx);
  renderWorldbookEntryList(ctx, parseWorldbookExcludeNamesInput(settings.trackerWorldbookExcludeNames));
  applyTheme(settings);
  renderStatusPanel(ctx);
  renderFullStatePage(ctx);
  renderRaceEncyclopediaPage();
  refreshRegisterRacePalette();
  setView(getLastPagerView());
}

const trackerDeps = { renderStatusPanel, updateClock };

function getWorldbookFilterSnapshot(ctx) {
  const settings = getSettings(ctx);
  const mode = String(settings.trackerWorldbookMode || 'exclude').trim();
  const names = mode === 'allowlist_all'
    ? settings.trackerWorldbookIncludeNames
    : settings.trackerWorldbookExcludeNames;
  return `${mode}\n${String(names || '').trim()}`;
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
    applyWorldbookFilterSelection(ctx, result.foundEntries, result.matched);
    persistWorldbookFilterIfChanged(ctx, beforeSnapshot);
  } catch (error) {
    applyWorldbookFilterSelection(ctx, [], []);
    throw error;
  }
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
  if (String(settings.trackerWorldbookMode || 'exclude').trim() === 'allowlist_all') {
    saveWorldbookIncludeNamesFromList(ctx, []);
  } else {
    const currentEntryNames = new Set((Array.isArray(result?.foundEntries) ? result.foundEntries : []).map((entry) => String(entry?.name || '').trim()).filter(Boolean));
    const preserved = parseWorldbookExcludeNamesInput(settings.trackerWorldbookExcludeNames).filter((name) => !currentEntryNames.has(name));
    saveWorldbookExcludeNamesFromList(ctx, preserved);
  }
  await refreshWorldbookFilterPage(ctx);
}

function updateMainFlowPrompt(ctx) {
  const settings = getSettings(ctx);
  const prompt = buildMainFlowPrompt(ctx, settings);
  try {
    ctx.setExtensionPrompt?.(MAINFLOW_PROMPT_KEY, prompt, 1, Math.max(2, Number(settings.contextSize) || 12), false);
  } catch (error) {
    console.warn('[BS BioTracker] setExtensionPrompt failed', error);
  }
}

function readSettingsFromForm(ctx) {
  const settings = getSettings(ctx);
  const getValue = (id) => document.getElementById(id)?.value ?? '';
  settings.enabled = !!document.getElementById('bs-bt-enabled')?.checked;
  settings.useStPresetForAsync = !!document.getElementById('bs-bt-use-st-preset')?.checked;
  settings.apiUrl = String(getValue('bs-bt-api-url')).trim();
  settings.apiKey = String(getValue('bs-bt-api-key')).trim();
  settings.model = String(getValue('bs-bt-model')).trim();
  settings.triggerTiming = String(getValue('bs-bt-trigger')).trim() || 'after_ai';
  settings.pollMs = Math.max(800, Number(getValue('bs-bt-poll-ms')) || 1800);
  settings.contextSize = Math.max(2, Number(getValue('bs-bt-context-size')) || 12);
  settings.targetNames = String(getValue('bs-bt-targets')).trim();
  settings.trackerWorldbookMode = String(getValue('bs-bt-tracker-worldbook-mode')).trim() || 'exclude';
  const filterNames = String(getValue('bs-bt-worldbook-filter-input')).trim();
  if (settings.trackerWorldbookMode === 'allowlist_all') settings.trackerWorldbookIncludeNames = filterNames;
  else settings.trackerWorldbookExcludeNames = filterNames;
  settings.systemPrompt = String(getValue('bs-bt-system-prompt')).trim() || DEFAULT_SYSTEM_PROMPT;
  settings.registryCustomNotes = String(getValue('bs-bt-register-custom-notes')).trim();
  settings.registryDescriptionGuides = {
    normalDescription: String(getValue('bs-bt-registry-normal-description')).trim(),
    closeupDescription: String(getValue('bs-bt-registry-closeup-description')).trim(),
    pregnantDescription: String(getValue('bs-bt-registry-pregnant-description')).trim(),
  };
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
  let pointerDownX = 0;
  let pointerDownY = 0;

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
    }
    if (!hasMoved) return;
    const left = event.clientX - dragState.offsetX;
    const top = event.clientY - dragState.offsetY;
    setFloatingSpherePosition(left, top, false);
  };

  const onPointerUp = () => {
    if (!dragState) return;
    dragState = null;
    sphere.classList.remove('is-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);

    if (hasMoved) {
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
    sphere.classList.add('is-dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
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
      if (nextView === 'full-state') renderFullStatePage(ctx);
      if (nextView === 'race-encyclopedia') renderRaceEncyclopediaPage();
      setView(nextView);
    }),
  );
  document.querySelectorAll('#bs-bt-track-tabs .bs-bt-track-tab').forEach((node) =>
    node.addEventListener('click', () => {
      const nextTab = String(node.dataset.trackTab || 'overview');
      if (!TRACK_SUBPAGES.includes(nextTab)) return;
      selectedTrackSubpage = nextTab;
      renderStatusPanel(ctx);
    }),
  );
  document.querySelectorAll('#bs-biotracker-settings [data-theme-option]').forEach((node) =>
    node.addEventListener('click', () => {
      const settings = getSettings(ctx);
      settings.theme = node.dataset.themeOption || 'retro';
      saveSettings(ctx);
      applyTheme(settings);
      setView('system');
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
  document.getElementById('bs-bt-race-select')?.addEventListener('change', (event) => {
    selectedRaceEncyclopedia = String(event.target?.value || '');
    renderRaceEncyclopediaPage();
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
    if (String(getSettings(ctx).trackerWorldbookMode || 'exclude').trim() === 'allowlist_all') saveWorldbookIncludeNamesFromList(ctx, names);
    else saveWorldbookExcludeNamesFromList(ctx, names);
    try {
      await refreshWorldbookFilterPage(ctx);
    } catch (error) {
      console.error('[BS BioTracker] refreshWorldbookFilterPage after filter change failed', error);
    }
  });
  document.getElementById('bs-bt-worldbook-entry-search')?.addEventListener('input', (event) => {
    worldbookEntrySearch = String(event.target?.value || '').trim();
    renderWorldbookEntryList(ctx, latestWorldbookEntries);
  });
  document.getElementById('bs-bt-derived-select')?.addEventListener('change', (event) => {
    selectedDerivedEncyclopedia = String(event.target?.value || '');
    renderRaceEncyclopediaPage();
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
      const mode = String(getSettings(ctx).trackerWorldbookMode || 'exclude').trim();
      globalThis.toastr?.success?.(mode === 'allowlist_all'
        ? '[BS BioTracker] 已清空当前角色的可参考条目文本框'
        : '[BS BioTracker] 已清空当前角色的可排除条目文本框');
    } catch (error) {
      console.error('[BS BioTracker] clearCurrentWorldbookExcludeSelections failed', error);
      globalThis.toastr?.error?.(String(error?.message || error), '[BS BioTracker]');
    }
  });
  document.getElementById('bs-bt-register-run')?.addEventListener('click', async () => {
    const targetName = String(document.getElementById('bs-bt-register-name')?.value || '').trim();
    const declaredRace = String(document.getElementById('bs-bt-register-race')?.value || '').trim();
    const customNotes = String(document.getElementById('bs-bt-register-custom-notes')?.value || '').trim();
    if (!targetName) {
      setRegisterStatus('请先输入要注册的角色名。', true);
      globalThis.toastr?.warning?.('[BS BioTracker] 请先输入角色名');
      return;
    }
    readSettingsFromForm(ctx);
    setRegisterStatus(`正在注册 ${targetName}...`);
    try {
      const character = await runRegistry(ctx, { targetName, customNotes, declaredRace });
      renderStatusPanel(ctx);
      renderFullStatePage(ctx);
      updateMainFlowPrompt(ctx);
      setRegisterStatus(`注册完成：${character.name}`);
      setView('track-list');
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

function createManualMenuItem(ctx) {
  if (document.getElementById(MENU_ITEM_ID)) return true;
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

async function registerMenuItem(ctx) {
  if (globalThis.ST_API?.ui?.registerExtensionsMenuItem) {
    try {
      await globalThis.ST_API.ui.registerExtensionsMenuItem({
        id: MENU_API_ID,
        label: 'BS BioTracker',
        icon: 'fa-solid fa-person-pregnant',
        onClick: () => toggleModal(ctx),
      });
      return;
    } catch (error) {
      console.warn('[BS BioTracker] ST_API 菜单注册失败，改用手动注入。', error);
    }
  }
  ensureManualMenuItem(ctx);
}

async function bootstrap() {
  const ctx = getContextSafe();
  if (!ctx) return;
  if (globalThis[BOOTSTRAP_RUNTIME_KEY]) return;
  globalThis[BOOTSTRAP_RUNTIME_KEY] = true;
  try {
    await ensureModal(ctx);
    await registerMenuItem(ctx);
    trackerDeps.updateMainFlowPrompt = updateMainFlowPrompt;
    resetPoller(ctx, trackerDeps);
    updateMainFlowPrompt(ctx);
    const { eventSource, event_types } = ctx;
    if (eventSource && event_types?.CHAT_CHANGED) {
      if (globalThis[CHAT_CHANGED_HANDLER_KEY] && typeof eventSource.off === 'function') {
        eventSource.off(event_types.CHAT_CHANGED, globalThis[CHAT_CHANGED_HANDLER_KEY]);
      }
      globalThis[CHAT_CHANGED_HANDLER_KEY] = () => {
        if (globalThis[PENDING_CHAT_INHERIT_KEY]) {
          tryInheritForkedChatState(ctx, 'chat_changed');
        }
        renderStatusPanel(ctx);
        updateMainFlowPrompt(ctx);
        scheduleWorldbookFilterReload(ctx, 'chat_changed');
      };
      eventSource.on(event_types.CHAT_CHANGED, globalThis[CHAT_CHANGED_HANDLER_KEY]);
    }
    if (eventSource && event_types?.CHAT_CREATED) {
      if (globalThis[CHAT_CREATED_HANDLER_KEY] && typeof eventSource.off === 'function') {
        eventSource.off(event_types.CHAT_CREATED, globalThis[CHAT_CREATED_HANDLER_KEY]);
      }
      globalThis[CHAT_CREATED_HANDLER_KEY] = () => {
        globalThis[PENDING_CHAT_INHERIT_KEY] = true;
        tryInheritForkedChatState(ctx, 'chat_created');
        scheduleWorldbookFilterReload(ctx, 'chat_created');
      };
      eventSource.on(event_types.CHAT_CREATED, globalThis[CHAT_CREATED_HANDLER_KEY]);
    }
    if (eventSource && event_types?.CHAT_DELETED) {
      if (globalThis[CHAT_DELETED_HANDLER_KEY] && typeof eventSource.off === 'function') {
        eventSource.off(event_types.CHAT_DELETED, globalThis[CHAT_DELETED_HANDLER_KEY]);
      }
      globalThis[CHAT_DELETED_HANDLER_KEY] = (payload) => {
        const chatKey = extractDeletedChatKey(ctx, payload);
        cleanupOrphanedChatStateByKey(ctx, chatKey, 'chat_deleted');
      };
      eventSource.on(event_types.CHAT_DELETED, globalThis[CHAT_DELETED_HANDLER_KEY]);
    }
    if (eventSource && event_types?.GROUP_CHAT_DELETED) {
      if (globalThis[GROUP_CHAT_DELETED_HANDLER_KEY] && typeof eventSource.off === 'function') {
        eventSource.off(event_types.GROUP_CHAT_DELETED, globalThis[GROUP_CHAT_DELETED_HANDLER_KEY]);
      }
      globalThis[GROUP_CHAT_DELETED_HANDLER_KEY] = (payload) => {
        const chatKey = extractDeletedChatKey(ctx, payload);
        cleanupOrphanedChatStateByKey(ctx, chatKey, 'group_chat_deleted');
      };
      eventSource.on(event_types.GROUP_CHAT_DELETED, globalThis[GROUP_CHAT_DELETED_HANDLER_KEY]);
    }
    if (eventSource && event_types?.GROUP_CHAT_CREATED) {
      if (globalThis[GROUP_CHAT_CREATED_HANDLER_KEY] && typeof eventSource.off === 'function') {
        eventSource.off(event_types.GROUP_CHAT_CREATED, globalThis[GROUP_CHAT_CREATED_HANDLER_KEY]);
      }
      globalThis[GROUP_CHAT_CREATED_HANDLER_KEY] = () => {
        globalThis[PENDING_CHAT_INHERIT_KEY] = true;
        tryInheritForkedChatState(ctx, 'group_chat_created');
        scheduleWorldbookFilterReload(ctx, 'group_chat_created');
      };
      eventSource.on(event_types.GROUP_CHAT_CREATED, globalThis[GROUP_CHAT_CREATED_HANDLER_KEY]);
    }
  } catch (error) {
    globalThis[BOOTSTRAP_RUNTIME_KEY] = false;
    throw error;
  }
}

const ctx = getContextSafe();
if (ctx?.eventSource && ctx?.event_types?.APP_READY) {
  if (globalThis[APP_READY_HANDLER_KEY] && typeof ctx.eventSource.off === 'function') {
    ctx.eventSource.off(ctx.event_types.APP_READY, globalThis[APP_READY_HANDLER_KEY]);
  }
  globalThis[APP_READY_HANDLER_KEY] = bootstrap;
  ctx.eventSource.on(ctx.event_types.APP_READY, globalThis[APP_READY_HANDLER_KEY]);
}
else setTimeout(() => {
  bootstrap().catch((error) => console.error('[BS BioTracker] bootstrap failed', error));
}, 1000);
