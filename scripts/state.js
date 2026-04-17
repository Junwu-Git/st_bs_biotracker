import { DEFAULT_REGISTRY_DESCRIPTION_GUIDES } from './registry_config.js';
import {
  buildEmptyPsychologyGroup,
  normalizePsychologyGroup,
  PSY_MENS_FIELDS,
  PSY_MENS_BOOL_FIELDS,
  PSY_PREG_FIELDS,
  PSY_PREG_BOOL_FIELDS,
} from './registry_psy_config.js';
import { LABOR_STAGES, MENSTRUAL_STAGES, MENSTRUAL_STAGE_DAYS, PREGNANCY_STAGE_DAYS } from './stage_config.js';

export const MODULE_NAME = 'bs_biotracker';
const MAX_CHAT_STATE_SNAPSHOTS = 48;
const MAX_RAW_RESULT_TEXT_LENGTH = 1200;
const MIN_CHAT_INHERIT_MESSAGE_COUNT = 2;

export const THEME_CONFIG = {
  retro: {},
  cultivation: {},
  fantasy: {},
  'cyber-egypt': {},
  wasteland: {},
  sakura: {},
};

export const DEFAULT_SYSTEM_PROMPT = [
  '你是 AIRP 女性角色生理状态追踪器的工具调度器。',
  '你要根据角色卡、最近对话、已有状态，决定这次应调用哪些工具更新状态。',
  '只输出 JSON，不要输出额外解释。',
  'JSON 结构必须是：',
  '{',
  '  "tool_calls": [',
  '    {',
  '      "name": "string",',
  '      "arguments": {}',
  '    }',
  '  ]',
  '}',
  '可用工具会通过 available_tools 传入。只能调用其中存在的工具，参数名必须完全匹配。',
  '没有足够依据时，tool_calls 返回空数组。',
  '如果对话明确发生了时间流逝，优先调用 bsPassedTime。',
  '如果只是活力、情压、性欲、宫压波动，使用 bsUpdateCharacterStatus。',
  '如果只是心理数值变化，使用 bsUpdatePsychology；其数值参数一律表示变化量(delta)而不是目标值，例如当前为 78 时传 2 会变成 80。应优先做单一心理项的小幅调整，单次建议只动一个字段，幅度尽量控制在 ±1 到 ±3，±5 已属于偏大变化。如果只是经验或关系记录变化，使用 bsUpdateExperience。',
  '如果只是描述文字变化，使用 bsSetDescription。',
  '性交留精用 bsAddSperm；排出残留精液用 bsDrainSperm；缓解生理需求用 bsExcreteMetabolism。',
  '月经阶段、排卵期、假孕期切换用 bsSetMenstrualPhases；不要用它覆盖正在进行的受精、真妊娠或产程。',
  '流产用 bsAbortion；立即结束分娩用 bsChildbirth；角色在场状态变化用 bsSetCharacterPresence。',
  '母胎互动用 bsMaternalFetalInteraction；当角色处于产前阵痛且 direction=maternal 时，它表示分娩抵抗。',
  '不要编造怀孕天数、胎数、流产、分娩或其他高影响事件。',
].join('\n');

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'retro',
  enabled: false,
  useStPresetForAsync: false,
  apiUrl: '',
  apiKey: '',
  model: 'gpt-4.1-mini',
  modelOptions: [],
  triggerTiming: 'after_ai',
  pollMs: 1800,
  contextSize: 12,
  targetNames: '',
  trackerWorldbookExcludeNames: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  registryCustomNotes: '',
  registryDescriptionGuides: DEFAULT_REGISTRY_DESCRIPTION_GUIDES,
  chatStates: {},
});

const VITALITY_CAPS = Object.freeze({
  1: 50,
  2: 75,
  3: 100,
  4: 125,
  5: 150,
  6: 175,
  7: 200,
});

const PSY_STRESS_CAPS = Object.freeze({
  1: 20,
  2: 50,
  3: 80,
  4: 110,
  5: 140,
  6: 170,
  7: 200,
});

function clampLevel(value, fallback = 4) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(1, Math.min(7, Math.round(next)));
}

function sanitizeInteger(value, { min = -999999, max = 999999 } = {}) {
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function sanitizeNumber(value, { min = -999999, max = 999999 } = {}) {
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return Math.max(min, Math.min(max, next));
}

function sanitizeString(value) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return String(value);
}

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item ?? '')).filter(Boolean);
}

function pickFirstString(obj, paths) {
  for (const path of paths) {
    const keys = String(path || '').split('.');
    let current = obj;
    for (const key of keys) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (typeof current === 'string' && current.trim()) return current.trim();
  }
  return '';
}

function normalizePsychologyState(value) {
  return {
    mens: normalizePsychologyGroup(value?.mens, PSY_MENS_FIELDS, { booleanFields: PSY_MENS_BOOL_FIELDS }),
    preg: normalizePsychologyGroup(value?.preg, PSY_PREG_FIELDS, { booleanFields: PSY_PREG_BOOL_FIELDS }),
  };
}

export function normalizeCharacterPsychologyState(characterState) {
  if (!characterState || typeof characterState !== 'object') return characterState;
  if (!characterState.profile || typeof characterState.profile !== 'object') return characterState;
  characterState.profile.psychology = normalizePsychologyState(characterState.profile.psychology);
  return characterState;
}

function sanitizeObjectPatch(value, allowedFields, sanitizerMap = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of allowedFields) {
    if (value[field] === undefined) continue;
    const sanitizer = sanitizerMap[field];
    const next = sanitizer ? sanitizer(value[field]) : value[field];
    if (next !== undefined) result[field] = next;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function getVitalityInitByLevel(level) {
  return VITALITY_CAPS[clampLevel(level)] || VITALITY_CAPS[4];
}

export function getPsyStressInitByLevel(level) {
  return Math.floor((PSY_STRESS_CAPS[clampLevel(level)] || PSY_STRESS_CAPS[4]) / 2);
}

function randomInt(min, max) {
  const nextMin = Math.ceil(min);
  const nextMax = Math.floor(max);
  return Math.floor(Math.random() * (nextMax - nextMin + 1)) + nextMin;
}

export function deriveMenstrualStageState() {
  const stage = MENSTRUAL_STAGES[randomInt(0, MENSTRUAL_STAGES.length - 1)];
  const days = randomInt(1, MENSTRUAL_STAGE_DAYS[stage]);
  return { stage, days };
}

export function derivePregnancyStageState(pregnantDays, gestationSpeed = 1) {
  const actualPregnantDays = Math.max(1, Math.floor(Number(pregnantDays) || 1));
  const speed = Math.max(0.1, Number(gestationSpeed) || 1);
  const stageNames = ['孕早期', '孕中期', '孕晚期', '临产期'];
  let totalPregnancyDays = 0;
  for (const stageName of stageNames) totalPregnancyDays += PREGNANCY_STAGE_DAYS[stageName] / speed;

  if (actualPregnantDays > totalPregnancyDays) {
    return {
      stage: '逾期',
      days: Math.floor(actualPregnantDays - totalPregnancyDays),
    };
  }

  let stage = '孕早期';
  let baseDays = 1;
  let currentStageDays = 1;
  for (const stageName of stageNames) {
    const nextBaseDays = baseDays + PREGNANCY_STAGE_DAYS[stageName] / speed;
    if (actualPregnantDays >= baseDays && actualPregnantDays < nextBaseDays) {
      stage = stageName;
      currentStageDays = Math.floor(actualPregnantDays - baseDays + 1);
      break;
    }
    baseDays = nextBaseDays;
  }
  return { stage, days: currentStageDays };
}

export function syncCharacterStageFromProfile(characterState) {
  const next = characterState;
  const profile = next?.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const bio = profile.bio || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  const currentStage = String(base.stage || '');

  if (fetuses.length > 0) {
    if (currentStage === '产前阵痛' || LABOR_STAGES.includes(currentStage)) {
      next.profile.base = {
        ...base,
        days: Math.max(1, Math.floor(Number(base.days) || 1)),
      };
      return next;
    }

    const derived = derivePregnancyStageState(pregnant.pregnantDays, bio.gestationSpeed);
    next.profile.base = {
      ...base,
      stage: derived.stage,
      days: derived.days,
    };
    return next;
  }

  if (
    MENSTRUAL_STAGES.includes(currentStage)
    || currentStage === '假孕期'
    || currentStage === '产前阵痛'
    || currentStage === '产后恢复'
    || LABOR_STAGES.includes(currentStage)
    || currentStage === '无经期'
    || currentStage === '未激活'
  ) {
    next.profile.base = {
      ...base,
      days: Math.max(1, Math.floor(Number(base.days) || 1)),
    };
    return next;
  }

  const derived = deriveMenstrualStageState();
  next.profile.base = {
    ...base,
    stage: derived.stage,
    days: derived.days,
  };
  return next;
}

export function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() || null;
}

export function cloneValue(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function sanitizeSpermList(value) {
  if (!Array.isArray(value)) return null;
  const result = value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const next = {
        male: sanitizeString(item.male) ?? null,
        race: sanitizeString(item.race) ?? null,
        derivedType: sanitizeString(item.derivedType) ?? null,
        value: sanitizeInteger(item.value, { min: 0, max: 9999 }) ?? 0,
      };
      return next;
    });
  return result;
}

function sanitizeFetusList(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const fetus = {};
      const stringFields = ['fathers', 'provider', 'race', 'fatherRace', 'gender', 'embryoType', 'fatherDerivedType'];
      for (const field of stringFields) {
        const next = sanitizeString(item[field]);
        if (next !== undefined) fetus[field] = next;
      }
      const numberFields = {
        weight: { min: 0.5, max: 2.0 },
        tendencyAngle: { min: 0, max: 360 },
        affinity: { min: -50, max: 50 },
        maternalDerivedTypeProgress: { min: -100, max: 100 },
      };
      for (const [field, rule] of Object.entries(numberFields)) {
        if (item[field] === undefined) continue;
        const next = sanitizeNumber(item[field], rule);
        if (next !== null) fetus[field] = next;
      }
      return fetus;
    });
}

function sanitizeChildrenList(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: sanitizeString(item.name) ?? null,
      fathers: sanitizeString(item.fathers) ?? null,
      gender: sanitizeString(item.gender) ?? null,
      race: sanitizeString(item.race) ?? null,
      derivedType: sanitizeString(item.derivedType) ?? null,
      age: sanitizeNumber(item.age, { min: 0, max: 9999 }) ?? null,
    }));
}

function sanitizeProfilePatch(profilePatch) {
  if (!profilePatch || typeof profilePatch !== 'object' || Array.isArray(profilePatch)) return null;
  const cooldown = sanitizeObjectPatch(profilePatch.cooldown, ['orgasmOvulationUsed', 'laborResistanceUsed', 'pregnancyPressureWarning'], {
    orgasmOvulationUsed: (value) => Boolean(value),
    laborResistanceUsed: (value) => Boolean(value),
    pregnancyPressureWarning: (value) => Boolean(value),
  });
  const base = sanitizeObjectPatch(
    profilePatch.base,
    [
      'isHere',
      'days',
      'fertilizationDays',
      'latestSexDays',
      'age',
      'stage',
      'race',
      'derivedType',
      'sperms',
      'eggs',
      'libido',
      'uterinePressure',
      'vitality',
      'psyStress',
      'vitalityLevel',
      'psyStressLevel',
    ],
    {
      isHere: (value) => Boolean(value),
      days: (value) => sanitizeInteger(value, { min: 0, max: 9999 }),
      fertilizationDays: (value) => sanitizeInteger(value, { min: 0, max: 9999 }),
      latestSexDays: (value) => sanitizeInteger(value, { min: -1, max: 9999 }),
      age: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      stage: sanitizeString,
      race: sanitizeString,
      derivedType: sanitizeString,
      sperms: sanitizeSpermList,
      eggs: (value) => sanitizeInteger(value, { min: 0, max: 999 }),
      libido: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
      uterinePressure: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
      vitality: (value) => sanitizeInteger(value, { min: 0, max: 200 }),
      psyStress: (value) => sanitizeInteger(value, { min: 0, max: 200 }),
      vitalityLevel: (value) => clampLevel(value),
      psyStressLevel: (value) => clampLevel(value),
    },
  );
  const pregnant = sanitizeObjectPatch(
    profilePatch.pregnant,
    ['pregnantDays', 'laborHours', 'effectiveLaborHours', 'fetusesCount', 'fetalEnergyDrain', 'fetuses'],
    {
      pregnantDays: (value) => sanitizeInteger(value, { min: 0, max: 9999 }),
      laborHours: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      effectiveLaborHours: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      fetusesCount: (value) => sanitizeInteger(value, { min: 0, max: 99 }),
      fetalEnergyDrain: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      fetuses: sanitizeFetusList,
    },
  );
  const experience = sanitizeObjectPatch(
    profilePatch.experience,
    [
      'virginity',
      'latestSexPartner',
      'emotionalMate',
      'marriageMate',
      'pregnantExperience',
      'naturalBirthExperience',
      'surgicalBirthExperience',
      'miscarriageExperience',
    ],
    {
      virginity: sanitizeString,
      latestSexPartner: sanitizeString,
      emotionalMate: sanitizeString,
      marriageMate: sanitizeString,
      pregnantExperience: (value) => sanitizeInteger(value, { min: 0, max: 999 }),
      naturalBirthExperience: (value) => sanitizeInteger(value, { min: 0, max: 999 }),
      surgicalBirthExperience: (value) => sanitizeInteger(value, { min: 0, max: 999 }),
      miscarriageExperience: (value) => sanitizeInteger(value, { min: 0, max: 999 }),
    },
  );
  const children = sanitizeChildrenList(profilePatch.children);
  const bio = sanitizeObjectPatch(
    profilePatch.bio,
    [
      'menstrualLengthRatio',
      'gestationSpeed',
      'birthDifficulty',
      'breedTolerance',
      'impregnationDifficulty',
      'orgasmOvulationAmount',
      'identicalProbability',
      'recoveryDays',
    ],
    {
      menstrualLengthRatio: (value) => sanitizeNumber(value, { min: 0.1, max: 20 }),
      gestationSpeed: (value) => sanitizeNumber(value, { min: 0.1, max: 20 }),
      birthDifficulty: (value) => sanitizeNumber(value, { min: 0, max: 100 }),
      breedTolerance: (value) => sanitizeNumber(value, { min: 0, max: 100 }),
      impregnationDifficulty: (value) => sanitizeNumber(value, { min: 0, max: 100 }),
      orgasmOvulationAmount: (value) => sanitizeInteger(value, { min: 0, max: 100 }),
      identicalProbability: (value) => sanitizeNumber(value, { min: 0, max: 100 }),
      recoveryDays: (value) => sanitizeInteger(value, { min: 0, max: 9999 }),
    },
  );
  const mens = normalizePsychologyGroup(profilePatch.psychology?.mens, PSY_MENS_FIELDS, {
    includeDefaults: false,
    booleanFields: PSY_MENS_BOOL_FIELDS,
  });
  const pregPsy = normalizePsychologyGroup(profilePatch.psychology?.preg, PSY_PREG_FIELDS, {
    includeDefaults: false,
    booleanFields: PSY_PREG_BOOL_FIELDS,
  });
  const metabolism = sanitizeObjectPatch(profilePatch.metabolism, ['urine', 'stool', 'hunger', 'sleep', 'flux'], {
    urine: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    stool: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    hunger: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    sleep: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    flux: (value) => sanitizeInteger(value, { min: -150, max: 150 }),
  });
  const descriptions = sanitizeObjectPatch(profilePatch.descriptions, ['normalDescription', 'closeupDescription', 'pregnantDescription'], {
    normalDescription: sanitizeString,
    closeupDescription: sanitizeString,
    pregnantDescription: sanitizeString,
  });
  const notify = sanitizeObjectPatch(profilePatch.notify, ['firstly', 'secondly', 'thirdly'], {
    firstly: sanitizeString,
    secondly: sanitizeString,
    thirdly: sanitizeString,
  });
  const immune = sanitizeObjectPatch(profilePatch.immune, ['metabolism', 'miscarriage'], {
    metabolism: (value) => Boolean(value),
    miscarriage: (value) => Boolean(value),
  });
  const result = {};
  if (cooldown) result.cooldown = cooldown;
  if (base) result.base = base;
  if (pregnant) {
    if (pregnant.fetuses && pregnant.fetusesCount === undefined) pregnant.fetusesCount = pregnant.fetuses.length;
    result.pregnant = pregnant;
  }
  if (experience) result.experience = experience;
  if (children) result.children = children;
  if (bio) result.bio = bio;
  if (mens || pregPsy) result.psychology = {};
  if (mens) result.psychology.mens = mens;
  if (pregPsy) result.psychology.preg = pregPsy;
  if (metabolism) result.metabolism = metabolism;
  if (descriptions) result.descriptions = descriptions;
  if (notify) result.notify = notify;
  if (immune) result.immune = immune;
  return Object.keys(result).length > 0 ? result : null;
}

export function createEmptyChatState() {
  return {
    lastAttemptedSignature: '',
    lastProcessedSignature: '',
    lastRunAt: 0,
    sceneSummary: '',
    minutesPassed: 0,
    characters: {},
    lastRawResult: null,
    snapshots: [],
  };
}

export function createDefaultFemaleState(name = '') {
  const vitalityLevel = 4;
  const psyStressLevel = 4;
  const character = {
    name: String(name || '').trim(),
    initialized: false,
    profile: {
      cooldown: {
        orgasmOvulationUsed: false,
        laborResistanceUsed: false,
        pregnancyPressureWarning: false,
      },
      base: {
        isHere: true,
        days: 1,
        fertilizationDays: 0,
        latestSexDays: null,
        age: 15,
        stage: null,
        race: '人类',
        derivedType: null,
        sperms: [],
        eggs: 0,
        libido: 0,
        uterinePressure: 0,
        vitality: getVitalityInitByLevel(vitalityLevel),
        psyStress: getPsyStressInitByLevel(psyStressLevel),
        vitalityLevel,
        psyStressLevel,
      },
      pregnant: {
        pregnantDays: 0,
        laborHours: 0,
        effectiveLaborHours: 0,
        fetusesCount: 0,
        fetalEnergyDrain: 0,
        amnionDurability: 0,
        fetuses: [],
      },
      experience: {
        virginity: null,
        latestSexPartner: null,
        emotionalMate: null,
        marriageMate: null,
        pregnantExperience: 0,
        naturalBirthExperience: 0,
        surgicalBirthExperience: 0,
        miscarriageExperience: 0,
      },
      psychology: {
        mens: buildEmptyPsychologyGroup(PSY_MENS_FIELDS, PSY_MENS_BOOL_FIELDS),
        preg: buildEmptyPsychologyGroup(PSY_PREG_FIELDS, PSY_PREG_BOOL_FIELDS),
      },
      children: [],
      bio: {
        menstrualLengthRatio: 1.0,
        gestationSpeed: 1.0,
        birthDifficulty: 1.0,
        breedTolerance: 1.0,
        impregnationDifficulty: 1.0,
        orgasmOvulationAmount: 1,
        identicalProbability: 5,
        recoveryDays: 56,
      },
      metabolism: {
        urine: 0,
        stool: 0,
        hunger: 0,
        sleep: 0,
        flux: 0,
      },
      descriptions: {
        normalDescription: '',
        closeupDescription: '',
        pregnantDescription: '',
      },
      notify: {
        firstly: '',
        secondly: '',
        thirdly: '',
      },
      immune: {
        metabolism: false,
        miscarriage: false,
      },
    },
  };
  return syncCharacterStageFromProfile(normalizeCharacterPsychologyState(character));
}

export function getSettings(ctx) {
  const root = ctx.extensionSettings;
  let shouldSave = false;
  if (!root[MODULE_NAME]) root[MODULE_NAME] = cloneValue(DEFAULT_SETTINGS);
  const settings = root[MODULE_NAME];
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (settings[key] === undefined) {
      settings[key] = cloneValue(value);
      shouldSave = true;
    }
  }
  if (!settings.chatStates || typeof settings.chatStates !== 'object') {
    settings.chatStates = {};
    shouldSave = true;
  }
  if (!Array.isArray(settings.modelOptions)) {
    settings.modelOptions = [];
    shouldSave = true;
  }
  if (!settings.registryDescriptionGuides || typeof settings.registryDescriptionGuides !== 'object') {
    settings.registryDescriptionGuides = cloneValue(DEFAULT_REGISTRY_DESCRIPTION_GUIDES);
    shouldSave = true;
  } else {
    const mergedGuides = {
      ...cloneValue(DEFAULT_REGISTRY_DESCRIPTION_GUIDES),
      ...settings.registryDescriptionGuides,
    };
    if (JSON.stringify(mergedGuides) !== JSON.stringify(settings.registryDescriptionGuides)) shouldSave = true;
    settings.registryDescriptionGuides = mergedGuides;
  }
  if (shouldSave) ctx.saveSettingsDebounced?.();
  return settings;
}

export function saveSettings(ctx) {
  ctx.saveSettingsDebounced?.();
}

export function getChatKey(ctx) {
  return String(ctx.getCurrentChatId?.() || ctx.chatId || `${ctx.characterId ?? 'char'}:${ctx.groupId ?? 'solo'}`);
}

export function getChatState(ctx, settings) {
  const chatKey = getChatKey(ctx);
  if (!settings.chatStates[chatKey]) settings.chatStates[chatKey] = createEmptyChatState();
  const chatState = settings.chatStates[chatKey];
  if (!Array.isArray(chatState.snapshots)) chatState.snapshots = [];
  restoreChatStateFromSnapshot(chatState, getLatestMatchingSnapshot(ctx, chatState));
  const characters = chatState.characters;
  if (characters && typeof characters === 'object') {
    for (const item of Object.values(characters)) normalizeCharacterPsychologyState(item);
  }
  return chatState;
}

function isChatStateEffectivelyEmpty(chatState) {
  if (!chatState || typeof chatState !== 'object') return true;
  const hasCharacters = Object.keys(chatState.characters || {}).length > 0;
  const hasSnapshots = Array.isArray(chatState.snapshots) && chatState.snapshots.length > 0;
  const hasSceneSummary = Boolean(String(chatState.sceneSummary || '').trim());
  const hasMinutesPassed = Number(chatState.minutesPassed) > 0;
  const hasAttemptedSignature = Boolean(String(chatState.lastAttemptedSignature || '').trim());
  const hasProcessedSignature = Boolean(String(chatState.lastProcessedSignature || '').trim());
  const hasRawResult = chatState.lastRawResult && typeof chatState.lastRawResult === 'object';
  return !(hasCharacters || hasSnapshots || hasSceneSummary || hasMinutesPassed || hasAttemptedSignature || hasProcessedSignature || hasRawResult);
}

function isMessageSignaturePrefixMatch(sourceSignatures, targetSignatures, count) {
  if (!Array.isArray(sourceSignatures) || !Array.isArray(targetSignatures)) return false;
  if (!Number.isInteger(count) || count < 0) return false;
  if (count > sourceSignatures.length || count > targetSignatures.length) return false;
  for (let index = 0; index < count; index += 1) {
    if (sourceSignatures[index] !== targetSignatures[index]) return false;
  }
  return true;
}

export function inheritChatStateFromMatchingChat(ctx, settings) {
  const chatKey = getChatKey(ctx);
  const currentChat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  if (!chatKey || currentChat.length === 0) return { inherited: false, reason: 'empty_chat' };
  if (currentChat.length < MIN_CHAT_INHERIT_MESSAGE_COUNT) return { inherited: false, reason: 'chat_too_short' };

  if (!settings.chatStates || typeof settings.chatStates !== 'object') settings.chatStates = {};
  if (!settings.chatStates[chatKey]) settings.chatStates[chatKey] = createEmptyChatState();
  const currentState = settings.chatStates[chatKey];
  if (!isChatStateEffectivelyEmpty(currentState)) return { inherited: false, reason: 'state_exists' };

  const currentSignatures = buildMessageSignatures(ctx);
  let bestMatch = null;

  for (const [candidateKey, candidateState] of Object.entries(settings.chatStates)) {
    if (candidateKey === chatKey || !candidateState || typeof candidateState !== 'object') continue;
    const candidateSnapshots = Array.isArray(candidateState.snapshots) ? candidateState.snapshots : [];
    for (const snapshot of candidateSnapshots) {
      const count = Number.isInteger(snapshot?.messageCount)
        ? snapshot.messageCount
        : (Array.isArray(snapshot?.messageSignatures) ? snapshot.messageSignatures.length : 0);
      if (count <= 0 || count !== currentSignatures.length) continue;
      const signatures = Array.isArray(snapshot?.messageSignatures) ? snapshot.messageSignatures : [];
      if (!isMessageSignaturePrefixMatch(signatures, currentSignatures, count)) continue;
      if (!bestMatch || count > bestMatch.count || (count === bestMatch.count && (snapshot.createdAt || 0) > (bestMatch.snapshot?.createdAt || 0))) {
        bestMatch = { candidateKey, candidateState, snapshot, count };
      }
    }
  }

  if (!bestMatch?.snapshot) return { inherited: false, reason: 'no_matching_snapshot' };

  const inheritedSnapshots = (Array.isArray(bestMatch.candidateState.snapshots) ? bestMatch.candidateState.snapshots : [])
    .filter((snapshot) => {
      const count = Number.isInteger(snapshot?.messageCount)
        ? snapshot.messageCount
        : (Array.isArray(snapshot?.messageSignatures) ? snapshot.messageSignatures.length : 0);
      const signatures = Array.isArray(snapshot?.messageSignatures) ? snapshot.messageSignatures : [];
      return count > 0 && count <= currentSignatures.length && isMessageSignaturePrefixMatch(signatures, currentSignatures, count);
    })
    .map((snapshot) => cloneValue(snapshot));

  currentState.snapshots = inheritedSnapshots;
  trimChatStateSnapshots(currentState);
  restoreChatStateFromSnapshot(currentState, bestMatch.snapshot);

  return {
    inherited: true,
    fromChatKey: bestMatch.candidateKey,
    messageCount: bestMatch.count,
  };
}

export function getCharacterCard(ctx) {
  const card = getResolvedCharacter(ctx)?.card;
  if (!card) return {};
  return {
    name: card.name || '',
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || '',
    first_mes: card.first_mes || '',
    mes_example: card.mes_example || '',
    worldBook: card.worldBook || null,
  };
}

export function getCharacterWorldBookName(ctx) {
  const card = getResolvedCharacter(ctx)?.card;
  if (!card || typeof card !== 'object') return '';
  return pickFirstString(card, [
    'data.extensions.world',
    'data.extensions.worldbook',
    'extensions.world',
    'extensions.worldbook',
    'world',
    'character_book',
    'worldBook.name',
  ]);
}

export function getResolvedCharacter(ctx) {
  const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
  const directId = Number.isInteger(ctx?.characterId) ? ctx.characterId : null;
  if (directId !== null && characters[directId]) {
    return { id: directId, card: characters[directId], source: 'characterId' };
  }

  const assistantMessages = (Array.isArray(ctx?.chat) ? ctx.chat : [])
    .filter((message) => message && !message.is_user && !message.is_system)
    .slice()
    .reverse();
  const preferredNames = [];
  for (const message of assistantMessages) {
    const name = String(message?.name || '').trim();
    if (name && !preferredNames.includes(name)) preferredNames.push(name);
  }
  const fallbackName = String(ctx?.name2 || '').trim();
  if (fallbackName && !preferredNames.includes(fallbackName)) preferredNames.push(fallbackName);

  for (const targetName of preferredNames) {
    const matchedId = characters.findIndex((item) => String(item?.name || '').trim() === targetName);
    if (matchedId >= 0) {
      return { id: matchedId, card: characters[matchedId], source: 'chatName' };
    }
  }
  return { id: null, card: null, source: 'none' };
}

export async function getCharacterWorldBookNameViaSTscript() {
  if (typeof globalThis.STscript !== 'function') return '';
  try {
    const result = await globalThis.STscript('/getcharbook');
    const name = String(result?.pipe ?? result ?? '').trim();
    return name;
  } catch (error) {
    console.warn('[BS BioTracker] /getcharbook failed', error);
    return '';
  }
}

export function getTargetNames(ctx, settings) {
  const names = String(settings.targetNames || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (names.length > 0) return names;
  const cardName = ctx.characters?.[ctx.characterId]?.name;
  return cardName ? [cardName] : [];
}

export function getRegisteredTargetNames(ctx, settings, chatState = null) {
  const state = chatState || getChatState(ctx, settings);
  const targetNames = getTargetNames(ctx, settings);
  const registeredNames = Object.entries(state?.characters || {})
    .filter(([, item]) => item?.initialized)
    .map(([name]) => name);
  if (targetNames.length === 0) return registeredNames;
  const filtered = targetNames.filter((name) => state?.characters?.[name]?.initialized);
  return filtered.length > 0 ? filtered : registeredNames;
}

export function buildRecentMessages(ctx, settings, endIndexExclusive = null) {
  const count = Math.max(2, Number(settings.contextSize) || 12);
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(chat.length, endIndexExclusive)) : chat.length;
  return chat.slice(Math.max(0, end - count), end).map((message) => ({
    name: message.name || (message.is_user ? ctx.name1 : ctx.name2) || '',
    role: message.is_user ? 'user' : 'assistant',
    text: String(message.mes || ''),
  }));
}

export function buildMessageSignature(ctx, message) {
  if (!message) return '';
  return [
    message.is_user ? 'user' : 'assistant',
    String(message.name || (message.is_user ? ctx.name1 : ctx.name2) || ''),
    String(message.mes || ''),
  ].join('|');
}

export function buildMessageSignatures(ctx, endIndexExclusive = null) {
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(chat.length, endIndexExclusive)) : chat.length;
  return chat.slice(0, end).map((message) => buildMessageSignature(ctx, message));
}

function exportChatStateSnapshotPayload(chatState) {
  return {
    lastAttemptedSignature: chatState.lastAttemptedSignature || '',
    lastProcessedSignature: chatState.lastProcessedSignature || '',
    lastRunAt: chatState.lastRunAt || 0,
    sceneSummary: chatState.sceneSummary || '',
    minutesPassed: chatState.minutesPassed || 0,
    characters: chatState.characters || {},
    lastRawResult: summarizeRawResult(chatState.lastRawResult),
  };
}

function summarizeRawResult(value) {
  if (!value || typeof value !== 'object') return null;
  const toolCalls = Array.isArray(value.tool_calls)
    ? value.tool_calls.map((call) => ({
        name: String(call?.name || ''),
        arguments: call?.arguments && typeof call.arguments === 'object' ? cloneValue(call.arguments) : (call?.arguments ?? null),
      }))
    : [];
  const message = typeof value.message === 'string' ? value.message.slice(0, MAX_RAW_RESULT_TEXT_LENGTH) : undefined;
  const error = typeof value.error === 'string' ? value.error.slice(0, MAX_RAW_RESULT_TEXT_LENGTH) : undefined;
  const result = {};
  if (message) result.message = message;
  if (error) result.error = error;
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return Object.keys(result).length > 0 ? result : null;
}

function trimChatStateSnapshots(chatState) {
  if (!Array.isArray(chatState?.snapshots)) return;
  if (chatState.snapshots.length <= MAX_CHAT_STATE_SNAPSHOTS) return;
  chatState.snapshots.splice(0, chatState.snapshots.length - MAX_CHAT_STATE_SNAPSHOTS);
}

export function restoreChatStateFromSnapshot(chatState, snapshot) {
  const payload = snapshot?.stateSnapshot ? cloneValue(snapshot.stateSnapshot) : createEmptyChatState();
  chatState.lastAttemptedSignature = payload.lastAttemptedSignature || '';
  chatState.lastProcessedSignature = payload.lastProcessedSignature || '';
  chatState.lastRunAt = payload.lastRunAt || 0;
  chatState.sceneSummary = payload.sceneSummary || '';
  chatState.minutesPassed = payload.minutesPassed || 0;
  chatState.characters = payload.characters || {};
  chatState.lastRawResult = payload.lastRawResult || null;
}

export function recordChatStateSnapshot(ctx, chatState, options = {}) {
  if (!Array.isArray(chatState.snapshots)) chatState.snapshots = [];
  const messageCount = Number.isInteger(options.messageCount)
    ? Math.max(0, options.messageCount)
    : (Array.isArray(ctx.chat) ? ctx.chat.length : 0);
  const snapshot = {
    messageCount,
    messageSignatures: buildMessageSignatures(ctx, messageCount),
    reason: String(options.reason || 'state'),
    createdAt: Date.now(),
    stateSnapshot: cloneValue(exportChatStateSnapshotPayload(chatState)),
  };
  chatState.snapshots.push(snapshot);
  trimChatStateSnapshots(chatState);
  return snapshot;
}

export function getLatestMatchingSnapshot(ctx, chatState, messageCount = null) {
  const currentSignatures = buildMessageSignatures(ctx, messageCount);
  const snapshots = Array.isArray(chatState.snapshots) ? chatState.snapshots : [];
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    const signatures = Array.isArray(snapshot?.messageSignatures) ? snapshot.messageSignatures : [];
    const count = Number.isInteger(snapshot?.messageCount) ? snapshot.messageCount : signatures.length;
    if (count > currentSignatures.length) continue;
    let matched = true;
    for (let sigIndex = 0; sigIndex < count; sigIndex += 1) {
      if (signatures[sigIndex] !== currentSignatures[sigIndex]) {
        matched = false;
        break;
      }
    }
    if (matched) return snapshot;
  }
  return null;
}

export function buildSignature(ctx, endIndexExclusive = null) {
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(chat.length, endIndexExclusive)) : chat.length;
  const last = chat[end - 1];
  if (!last) return '';
  return [getChatKey(ctx), end, last.is_user ? 'user' : 'assistant', String(last.name || ''), String(last.mes || '').slice(0, 300)].join('|');
}

export function shouldTriggerForMessage(settings, lastMessage) {
  if (!lastMessage) return false;
  if (settings.triggerTiming === 'after_ai') return !lastMessage.is_user;
  if (settings.triggerTiming === 'after_user') return !!lastMessage.is_user;
  return false;
}

export function formatStatusText(chatState) {
  const lines = [];
  if (chatState.sceneSummary) lines.push(`Scene: ${chatState.sceneSummary}`);
  if (chatState.minutesPassed) lines.push(`Minutes passed: ${chatState.minutesPassed}`);
  const characters = Object.values(chatState.characters || {});
  if (characters.length === 0) lines.push('No character state yet.');
  for (const item of characters) {
    const profile = item?.profile || {};
    const base = profile.base || {};
    const pregnant = profile.pregnant || {};
    const experience = profile.experience || {};
    const psychology = profile.psychology || {};
    lines.push('', `[${item.name}]`, `Initialized: ${item.initialized ? 'yes' : 'no'}`);
    lines.push(`Base: ${JSON.stringify(base)}`);
    lines.push(`Pregnant: ${JSON.stringify(pregnant)}`);
    if (profile.notify && Object.values(profile.notify).some((value) => String(value || '').trim())) lines.push(`Notify: ${JSON.stringify(profile.notify)}`);
    if (Array.isArray(profile.children) && profile.children.length > 0) lines.push(`Children: ${JSON.stringify(profile.children)}`);
    lines.push(`Experience: ${JSON.stringify(experience)}`);
    if ((psychology.mens && Object.values(psychology.mens).some((value) => value !== null && value !== undefined)) || (psychology.preg && Object.values(psychology.preg).some((value) => value !== null && value !== undefined))) {
      lines.push(`Psychology: ${JSON.stringify(psychology)}`);
    }
    if (profile.descriptions && Object.values(profile.descriptions).some((value) => String(value || '').trim())) {
      lines.push(`Descriptions: ${JSON.stringify(profile.descriptions)}`);
    }
  }
  return lines.join('\n').trim();
}
