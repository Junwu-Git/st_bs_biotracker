import { DEFAULT_DIARY_WRITING_PROMPT, DEFAULT_REGISTRY_DESCRIPTION_GUIDES } from './registry_config.js';
import {
  buildEmptyPsychologyGroup,
  normalizePsychologyGroup,
  PSY_MENS_FIELDS,
  PSY_MENS_BOOL_FIELDS,
  PSY_PREG_FIELDS,
  PSY_PREG_BOOL_FIELDS,
} from './registry_psy_config.js';
import { LABOR_STAGES, MENSTRUAL_STAGES, MENSTRUAL_STAGE_DAYS, PREGNANCY_STAGE_DAYS, PREGNANCY_STAGES } from './stage_config.js';

export const MODULE_NAME = 'bs_biotracker';
const MAX_CHAT_STATE_SNAPSHOTS = 24;
const MAX_RAW_RESULT_TEXT_LENGTH = 600;
const MAX_SNAPSHOT_DEBUG_ITEMS = 24;
const MIN_CHAT_INHERIT_MESSAGE_COUNT = 2;
const MESSAGE_DIGEST_SEED = 2166136261;
const SNAPSHOT_FULL_INTERVAL = 8;
const SNAPSHOT_PATCH_SIZE_RATIO = 0.85;
const SNAPSHOT_DELETE_SENTINEL_KEY = '__bs_bt_deleted__';
const SNAPSHOT_ARRAY_APPEND_KEY = '__bs_bt_array_append__';
const RESTORED_SNAPSHOT_RUNTIME_KEY = Symbol('bsBtRestoredSnapshotKey');

export const THEME_CONFIG = {
  retro: {},
  cultivation: {},
  fantasy: {},
  'cyber-egypt': {},
  wasteland: {},
  sakura: {},
  holo: {},
  gothic: {},
  steampunk: {},
  eldritch: {},
  ink: {},
  constructivism: {},
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
  '跨日、重大事件或 notify 提醒时，可用 bsWriteDiary 为角色追加主观日记。',
  '月经阶段、排卵期、假孕期切换用 bsSetMenstrualPhases；不要用它覆盖正在进行的受精、真妊娠或产程。',
  '流产用 bsAbortion；立即结束分娩用 bsChildbirth；角色在场状态变化用 bsSetCharacterPresence。',
  '母胎互动用 bsMaternalFetalInteraction；当角色处于产前阵痛且 direction=maternal 时，它表示分娩抵抗。若 notify 提示妊娠不适，调用此工具可额外补充营养。',
  '不要编造怀孕天数、胎数、流产、分娩或其他高影响事件。',
].join('\n');

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'retro',
  deviceSize: 'phone',
  fontSize: 'standard',
  enabled: false,
  useStPresetForAsync: false,
  trackerPresetName: '',
  trackerPromptToggles: {},
  trackerPromptToggleOverrides: {},
  apiUrl: '',
  apiKey: '',
  model: 'gpt-4.1-mini',
  modelOptions: [],
  triggerTiming: 'after_ai',
  pollMs: 1800,
  contextSize: 12,
  diaryRecentLimit: 5,
  diaryWritingPrompt: DEFAULT_DIARY_WRITING_PROMPT,
  targetNames: '',
  trackerWorldbookMode: 'exclude',
  trackerWorldbookExcludeNames: '',
  trackerWorldbookIncludeNames: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  registryCustomNotes: '',
  registryDescriptionGuides: DEFAULT_REGISTRY_DESCRIPTION_GUIDES,
  racePhysiologyOverrides: {},
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

function sanitizePregnancyBlockage(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const key = String(value.key || '').trim();
  if (!key) return null;
  return {
    key,
    severity: sanitizeNumber(value.severity, { min: 0, max: 0.75 }) ?? 0,
  };
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
  const days = randomInt(0, MENSTRUAL_STAGE_DAYS[stage]);
  return { stage, days };
}

export function derivePregnancyStageState(pregnantDays, gestationSpeed = 1) {
  const actualPregnantDays = Math.max(0, Number(pregnantDays) || 0);
  const speed = Math.max(0.1, Number(gestationSpeed) || 1);
  const stageNames = ['孕早期', '孕中期', '孕晚期', '临产期'];
  let totalPregnancyDays = 0;
  for (const stageName of stageNames) totalPregnancyDays += PREGNANCY_STAGE_DAYS[stageName] / speed;

  if (actualPregnantDays > totalPregnancyDays) {
    return {
      stage: '逾期',
      days: actualPregnantDays - totalPregnancyDays,
    };
  }

  let stage = '孕早期';
  let baseDays = 0;
  let currentStageDays = 0;
  for (const stageName of stageNames) {
    const stageLimit = PREGNANCY_STAGE_DAYS[stageName] / speed;
    const nextBaseDays = baseDays + stageLimit;
    if (actualPregnantDays >= baseDays && actualPregnantDays <= baseDays + stageLimit) {
      stage = stageName;
      currentStageDays = actualPregnantDays - baseDays;
      break;
    }
    baseDays = nextBaseDays;
  }
  return { stage, days: currentStageDays };
}

export function getGestationSpeciesSpeed(profile) {
  const baseSpeed = Number(profile?.bio?.gestationSpeciesSpeed);
  if (Number.isFinite(baseSpeed) && baseSpeed > 0) return Math.max(0.1, Math.min(20, baseSpeed));
  return 1;
}

export function getGestationModifierMultiplier(profile) {
  const multiplier = Number(profile?.bio?.gestationModifierMultiplier);
  if (Number.isFinite(multiplier) && multiplier >= 0) return Math.max(0, Math.min(20, multiplier));
  return 1;
}

export function getGestationEffectiveSpeed(profile) {
  const hasSpeciesSpeed = Number.isFinite(Number(profile?.bio?.gestationSpeciesSpeed));
  const hasModifierMultiplier = Number.isFinite(Number(profile?.bio?.gestationModifierMultiplier));
  if (hasSpeciesSpeed || hasModifierMultiplier) {
    return Math.max(0, Math.min(20, getGestationSpeciesSpeed(profile) * getGestationModifierMultiplier(profile)));
  }
  const effectiveSpeed = Number(profile?.bio?.gestationEffectiveSpeed);
  if (Number.isFinite(effectiveSpeed) && effectiveSpeed >= 0) return Math.max(0, Math.min(20, effectiveSpeed));
  return 1;
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
    const fertilizationDays = Math.max(0, Number(base.fertilizationDays) || 0);
    const effectivePregnantDays = Math.max(0, Number(pregnant.effectivePregnantDays) || 0);
    if (fertilizationDays > 0 && effectivePregnantDays <= 0) {
      const fallbackStage = PREGNANCY_STAGES.includes(currentStage) ? '排卵期' : currentStage;
      next.profile.base = {
        ...base,
        stage: fallbackStage || '排卵期',
        days: Math.max(0, Number(base.days) || 0),
      };
      return next;
    }

    if (currentStage === '产前阵痛' || LABOR_STAGES.includes(currentStage)) {
      next.profile.base = {
        ...base,
        days: Math.max(0, Number(base.days) || 0),
      };
      return next;
    }

    const derived = derivePregnancyStageState(pregnant.effectivePregnantDays, 1);
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
      days: Math.max(0, Number(base.days) || 0),
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createSnapshotDeleteSentinel() {
  return { [SNAPSHOT_DELETE_SENTINEL_KEY]: true };
}

function isSnapshotDeleteSentinel(value) {
  return isPlainObject(value) && value[SNAPSHOT_DELETE_SENTINEL_KEY] === true;
}

function createSnapshotArrayAppendPatch(previousList, nextList) {
  if (!Array.isArray(previousList) || !Array.isArray(nextList)) return null;
  if (nextList.length <= previousList.length) return null;
  for (let index = 0; index < previousList.length; index += 1) {
    if (!areSnapshotArrayItemsEqual(previousList[index], nextList[index])) return null;
  }
  return {
    [SNAPSHOT_ARRAY_APPEND_KEY]: true,
    length: previousList.length,
    items: cloneValue(nextList.slice(previousList.length)),
  };
}

function isSnapshotArrayAppendPatch(value) {
  return isPlainObject(value)
    && value[SNAPSHOT_ARRAY_APPEND_KEY] === true
    && Number.isInteger(value.length)
    && Array.isArray(value.items);
}

function applySnapshotArrayAppendPatch(previousValue, patch) {
  const base = Array.isArray(previousValue) ? cloneValue(previousValue).slice(0, Math.max(0, patch.length)) : [];
  return base.concat(cloneValue(patch.items));
}

function areSnapshotArrayItemsEqual(left, right) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function areSnapshotArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areSnapshotArrayItemsEqual(left[index], right[index])) return false;
  }
  return true;
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
        weight: { min: 0.33, max: 3.0 },
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
  const cooldown = sanitizeObjectPatch(profilePatch.cooldown, ['orgasmOvulationUsed', 'laborResistanceUsed', 'pregnancyPressureWarning', 'pregnancySymptomActive'], {
    orgasmOvulationUsed: (value) => Boolean(value),
    laborResistanceUsed: (value) => Boolean(value),
    pregnancyPressureWarning: (value) => Boolean(value),
    pregnancySymptomActive: (value) => Boolean(value),
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
      days: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      fertilizationDays: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
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
    ['pregnantDays', 'effectivePregnantDays', 'laborHours', 'effectiveLaborHours', 'fetusesCount', 'fetalEnergyDrain', 'nutrition', 'blockage', 'fetuses'],
    {
      pregnantDays: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      effectivePregnantDays: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      laborHours: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      effectiveLaborHours: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      fetusesCount: (value) => sanitizeInteger(value, { min: 0, max: 99 }),
      fetalEnergyDrain: (value) => sanitizeNumber(value, { min: 0, max: 9999 }),
      nutrition: (value) => sanitizeNumber(value, { min: -999, max: 999 }),
      blockage: sanitizePregnancyBlockage,
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
      'gestationSpeciesSpeed',
      'gestationEffectiveSpeed',
      'gestationModifierMultiplier',
      'gestationModifierName',
      'gestationModifierDescription',
      'birthDifficulty',
      'breedTolerance',
      'impregnationDifficulty',
      'orgasmOvulationAmount',
      'identicalProbability',
      'recoveryDays',
    ],
    {
      menstrualLengthRatio: (value) => sanitizeNumber(value, { min: 0.1, max: 20 }),
      gestationSpeciesSpeed: (value) => sanitizeNumber(value, { min: 0.1, max: 20 }),
      gestationEffectiveSpeed: (value) => sanitizeNumber(value, { min: 0.1, max: 20 }),
      gestationModifierMultiplier: (value) => sanitizeNumber(value, { min: 0, max: 20 }),
      gestationModifierName: sanitizeString,
      gestationModifierDescription: sanitizeString,
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
  const metabolism = sanitizeObjectPatch(profilePatch.metabolism, ['urine', 'stool', 'hunger', 'sleep', 'flux', 'milk', 'odor'], {
    urine: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    stool: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    hunger: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    sleep: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    flux: (value) => sanitizeInteger(value, { min: -150, max: 150 }),
    milk: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
    odor: (value) => sanitizeInteger(value, { min: 0, max: 150 }),
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
    lastOperationLogs: [],
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
        pregnancySymptomActive: false,
      },
      base: {
        isHere: true,
        days: 0,
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
        effectivePregnantDays: 0,
        laborHours: 0,
        effectiveLaborHours: 0,
        fetusesCount: 0,
        fetalEnergyDrain: 0,
        amnionDurability: 0,
        nutrition: 0,
        blockage: null,
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
      diary: [],
      bio: {
        menstrualLengthRatio: 1.0,
        gestationSpeciesSpeed: 1.0,
        gestationEffectiveSpeed: 1.0,
        gestationModifierMultiplier: 1.0,
        gestationModifierName: '',
        gestationModifierDescription: '',
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
        milk: 0,
        odor: 0,
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
  if (!String(settings.diaryWritingPrompt || '').trim()) {
    settings.diaryWritingPrompt = DEFAULT_DIARY_WRITING_PROMPT;
    shouldSave = true;
  }
  const rawDiaryRecentLimit = Number(settings.diaryRecentLimit);
  const diaryRecentLimit = Math.max(0, Math.min(20, Math.floor(Number.isFinite(rawDiaryRecentLimit) ? rawDiaryRecentLimit : DEFAULT_SETTINGS.diaryRecentLimit)));
  if (settings.diaryRecentLimit !== diaryRecentLimit) {
    settings.diaryRecentLimit = diaryRecentLimit;
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
  let shouldSave = false;
  if (!Array.isArray(chatState.snapshots)) chatState.snapshots = [];
  if (!Array.isArray(chatState.lastOperationLogs)) chatState.lastOperationLogs = [];
  const sanitizedCurrentPayload = sanitizeSnapshotPayload(chatState);
  if (
    chatState.lastAttemptedSignature !== sanitizedCurrentPayload.lastAttemptedSignature
    || chatState.lastProcessedSignature !== sanitizedCurrentPayload.lastProcessedSignature
    || JSON.stringify(chatState.lastRawResult || null) !== JSON.stringify(sanitizedCurrentPayload.lastRawResult || null)
    || JSON.stringify(chatState.lastOperationLogs || []) !== JSON.stringify(sanitizedCurrentPayload.lastOperationLogs || [])
  ) {
    chatState.lastAttemptedSignature = sanitizedCurrentPayload.lastAttemptedSignature;
    chatState.lastProcessedSignature = sanitizedCurrentPayload.lastProcessedSignature;
    chatState.lastRawResult = sanitizedCurrentPayload.lastRawResult;
    chatState.lastOperationLogs = sanitizedCurrentPayload.lastOperationLogs;
    shouldSave = true;
  }
  if (compactChatStateSnapshots(chatState)) shouldSave = true;
  if (chatState.snapshots.length > MAX_CHAT_STATE_SNAPSHOTS) {
    trimChatStateSnapshots(chatState);
    shouldSave = true;
  }
  if (needsRepackChatStateSnapshots(chatState) && repackChatStateSnapshots(chatState)) shouldSave = true;
  if (shouldSave) saveSettings(ctx);
  const latestSnapshot = getLatestMatchingSnapshot(ctx, chatState);
  if (latestSnapshot) {
    const latestSnapshotKey = getSnapshotRuntimeKey(latestSnapshot);
    if (chatState[RESTORED_SNAPSHOT_RUNTIME_KEY] !== latestSnapshotKey) {
      restoreChatStateFromSnapshot(chatState, latestSnapshot);
      markRestoredSnapshot(chatState, latestSnapshot);
    }
  }
  const characters = chatState.characters;
  if (characters && typeof characters === 'object') {
    for (const item of Object.values(characters)) {
      normalizeCharacterPsychologyState(item);
      if (item?.profile && !Array.isArray(item.profile.diary)) item.profile.diary = [];
    }
  }
  return chatState;
}

function isChatStateEffectivelyEmpty(chatState) {
  if (!chatState || typeof chatState !== 'object') return true;
  const hasCharacters = Object.keys(chatState.characters || {}).length > 0;
  const hasSnapshots = Array.isArray(chatState.snapshots) && chatState.snapshots.length > 0;
  const hasSceneSummary = Boolean(String(chatState.sceneSummary || '').trim());
  const hasMinutesPassed = Number(chatState.minutesPassed) > 0;
  return !(hasCharacters || hasSnapshots || hasSceneSummary || hasMinutesPassed);
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

  const currentMessageCount = currentChat.length;
  const digestCache = new Map();
  const getDigestForCount = (count) => {
    if (!digestCache.has(count)) digestCache.set(count, buildMessageDigest(ctx, count));
    return digestCache.get(count);
  };
  let bestMatch = null;

  for (const [candidateKey, candidateState] of Object.entries(settings.chatStates)) {
    if (candidateKey === chatKey || !candidateState || typeof candidateState !== 'object') continue;
    compactChatStateSnapshots(candidateState);
    const candidateSnapshots = Array.isArray(candidateState.snapshots) ? candidateState.snapshots : [];
    for (const snapshot of candidateSnapshots) {
      const count = Number.isInteger(snapshot?.messageCount) ? snapshot.messageCount : 0;
      if (count <= 0 || count !== currentMessageCount) continue;
      if (String(snapshot?.messageDigest || '') !== getDigestForCount(count)) continue;
      if (!bestMatch || count > bestMatch.count || (count === bestMatch.count && (snapshot.createdAt || 0) > (bestMatch.snapshot?.createdAt || 0))) {
        bestMatch = { candidateKey, candidateState, snapshot, count };
      }
    }
  }

  if (!bestMatch?.snapshot) return { inherited: false, reason: 'no_matching_snapshot' };

  const inheritedSnapshots = (Array.isArray(bestMatch.candidateState.snapshots) ? bestMatch.candidateState.snapshots : [])
    .filter((snapshot) => {
      const count = Number.isInteger(snapshot?.messageCount) ? snapshot.messageCount : 0;
      if (count <= 0 || count > currentMessageCount) return false;
      return String(snapshot?.messageDigest || '') === getDigestForCount(count);
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

function hashStringFNV1a(value, seed = MESSAGE_DIGEST_SEED) {
  let hash = seed >>> 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function foldMessageSignatureDigest(seed, signature) {
  let hash = seed >>> 0;
  hash ^= hashStringFNV1a(signature, MESSAGE_DIGEST_SEED);
  hash = Math.imul(hash, 16777619) >>> 0;
  return hash >>> 0;
}

export function buildMessageSignatures(ctx, endIndexExclusive = null) {
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(chat.length, endIndexExclusive)) : chat.length;
  return chat.slice(0, end).map((message) => buildMessageSignature(ctx, message));
}

export function buildMessageDigest(ctx, endIndexExclusive = null) {
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(chat.length, endIndexExclusive)) : chat.length;
  let hash = MESSAGE_DIGEST_SEED;
  for (let index = 0; index < end; index += 1) {
    hash = foldMessageSignatureDigest(hash, buildMessageSignature(ctx, chat[index]));
  }
  return hash.toString(16).padStart(8, '0');
}

function buildMessageDigestFromSignatures(signatures, endIndexExclusive = null) {
  const list = Array.isArray(signatures) ? signatures : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(list.length, endIndexExclusive)) : list.length;
  let hash = MESSAGE_DIGEST_SEED;
  for (let index = 0; index < end; index += 1) {
    hash = foldMessageSignatureDigest(hash, list[index]);
  }
  return hash.toString(16).padStart(8, '0');
}

function createSnapshotCharacterBaseline(name = '') {
  return {
    name: String(name || '').trim(),
    initialized: false,
    profile: {
      cooldown: {
        orgasmOvulationUsed: false,
        laborResistanceUsed: false,
        pregnancyPressureWarning: false,
        pregnancySymptomActive: false,
      },
      base: {
        isHere: true,
        days: 0,
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
        vitality: getVitalityInitByLevel(4),
        psyStress: getPsyStressInitByLevel(4),
        vitalityLevel: 4,
        psyStressLevel: 4,
      },
      pregnant: {
        pregnantDays: 0,
        effectivePregnantDays: 0,
        laborHours: 0,
        effectiveLaborHours: 0,
        fetusesCount: 0,
        fetalEnergyDrain: 0,
        amnionDurability: 0,
        nutrition: 0,
        blockage: null,
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
      diary: [],
      bio: {
        menstrualLengthRatio: 1.0,
        gestationSpeciesSpeed: 1.0,
        gestationEffectiveSpeed: 1.0,
        gestationModifierMultiplier: 1.0,
        gestationModifierName: '',
        gestationModifierDescription: '',
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
        milk: 0,
        odor: 0,
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
}

function compactSnapshotRecord(value) {
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === '') continue;
    result[key] = entry;
  }
  return result;
}

function compactSnapshotArrayEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => compactSnapshotRecord(item));
}

function normalizeCharacterForSnapshot(character, name = '') {
  const next = cloneValue(character || {});
  next.name = String(next.name || name || '').trim();
  next.initialized = Boolean(next.initialized);
  next.profile = next.profile && typeof next.profile === 'object' ? next.profile : {};
  next.profile.psychology = normalizePsychologyState(next.profile.psychology);
  next.profile.base = next.profile.base && typeof next.profile.base === 'object' ? next.profile.base : {};
  next.profile.pregnant = next.profile.pregnant && typeof next.profile.pregnant === 'object' ? next.profile.pregnant : {};
  next.profile.children = compactSnapshotArrayEntries(next.profile.children);
  next.profile.diary = compactSnapshotArrayEntries(next.profile.diary);
  next.profile.pregnant.fetuses = compactSnapshotArrayEntries(next.profile.pregnant.fetuses);
  next.profile.base.sperms = compactSnapshotArrayEntries(next.profile.base.sperms);
  next.profile.descriptions = compactSnapshotRecord(next.profile.descriptions || {});
  next.profile.notify = compactSnapshotRecord(next.profile.notify || {});
  delete next.updatedAt;
  delete next.runtime;
  return next;
}

function packSnapshotCharacters(characters) {
  const source = characters && typeof characters === 'object' ? characters : {};
  const packed = {};
  for (const [name, item] of Object.entries(source)) {
    const normalized = normalizeCharacterForSnapshot(item, name);
    const baseline = createSnapshotCharacterBaseline(normalized.name || name);
    const patch = buildStateDeltaPatch(baseline, normalized);
    packed[name] = patch && typeof patch === 'object' ? patch : {};
  }
  return packed;
}

function unpackSnapshotCharacters(characters, format = '') {
  if (!characters || typeof characters !== 'object') return {};
  const unpacked = {};
  for (const [name, item] of Object.entries(characters)) {
    if (format === 'default_delta_v1') {
      const baseline = createSnapshotCharacterBaseline(name);
      const restored = applyStateDeltaPatch(baseline, item && typeof item === 'object' ? item : {});
      unpacked[name] = normalizeCharacterPsychologyState(restored);
      continue;
    }
    unpacked[name] = normalizeCharacterPsychologyState(cloneValue(item));
  }
  return unpacked;
}

function exportChatStateSnapshotPayload(chatState) {
  return {
    snapshotSchema: 'packed_v2',
    charactersFormat: 'default_delta_v1',
    lastAttemptedSignature: sanitizeStoredSignature(chatState.lastAttemptedSignature),
    lastProcessedSignature: sanitizeStoredSignature(chatState.lastProcessedSignature),
    lastRunAt: chatState.lastRunAt || 0,
    sceneSummary: chatState.sceneSummary || '',
    minutesPassed: chatState.minutesPassed || 0,
    characters: packSnapshotCharacters(chatState.characters),
    lastRawResult: summarizeRawResult(chatState.lastRawResult),
    lastOperationLogs: summarizeOperationLogs(chatState.lastOperationLogs),
  };
}

function sanitizeStoredSignature(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 120) return text;
  return `hash:${hashStringFNV1a(text, MESSAGE_DIGEST_SEED).toString(16).padStart(8, '0')}`;
}

function normalizeSnapshotToolArguments(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? summarizeSnapshotDebugValue(parsed) : value.slice(0, MAX_RAW_RESULT_TEXT_LENGTH);
    } catch {
      return value.slice(0, MAX_RAW_RESULT_TEXT_LENGTH);
    }
  }
  if (value && typeof value === 'object') return summarizeSnapshotDebugValue(value);
  return value;
}

function summarizeSnapshotDebugValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, MAX_RAW_RESULT_TEXT_LENGTH);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 8) return '[Object]';
  if (Array.isArray(value)) return value.slice(0, MAX_SNAPSHOT_DEBUG_ITEMS).map((item) => summarizeSnapshotDebugValue(item, depth + 1));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = summarizeSnapshotDebugValue(child, depth + 1);
  }
  return result;
}

export function summarizeRawResult(value) {
  if (!value || typeof value !== 'object') return null;
  const toolCalls = Array.isArray(value.tool_calls)
    ? value.tool_calls.map((call) => {
        const item = { name: String(call?.name || '') };
        const args = normalizeSnapshotToolArguments(call?.arguments);
        if (args !== undefined) item.arguments = args;
        return item;
      })
    : [];
  const message = typeof value.message === 'string' ? value.message.slice(0, MAX_RAW_RESULT_TEXT_LENGTH) : undefined;
  const error = typeof value.error === 'string' ? value.error.slice(0, MAX_RAW_RESULT_TEXT_LENGTH) : undefined;
  const result = {};
  if (message) result.message = message;
  if (error) result.error = error;
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return Object.keys(result).length > 0 ? result : null;
}

export function summarizeOperationLogs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SNAPSHOT_DEBUG_ITEMS).map((item) => {
    const log = {
      name: String(item?.name || ''),
      applied: Boolean(item?.applied),
      message: String(item?.message || '').slice(0, MAX_RAW_RESULT_TEXT_LENGTH),
    };
    const args = normalizeSnapshotToolArguments(item?.arguments);
    if (args !== undefined) log.arguments = args;
    return log;
  });
}

function sanitizeSnapshotPayload(payload) {
  const next = cloneValue(payload || createEmptyChatState());
  next.lastAttemptedSignature = sanitizeStoredSignature(next.lastAttemptedSignature);
  next.lastProcessedSignature = sanitizeStoredSignature(next.lastProcessedSignature);
  next.lastRawResult = summarizeRawResult(next.lastRawResult);
  next.lastOperationLogs = summarizeOperationLogs(next.lastOperationLogs);
  return next;
}

function buildStateDeltaPatch(previousValue, nextValue) {
  if (previousValue === nextValue) return undefined;
  if (Array.isArray(previousValue) || Array.isArray(nextValue)) {
    if (areSnapshotArraysEqual(previousValue, nextValue)) return undefined;
    const appendPatch = createSnapshotArrayAppendPatch(previousValue, nextValue);
    return appendPatch || cloneValue(nextValue);
  }
  if (!isPlainObject(previousValue) || !isPlainObject(nextValue)) {
    return JSON.stringify(previousValue) === JSON.stringify(nextValue) ? undefined : cloneValue(nextValue);
  }

  const patch = {};
  let changed = false;
  const keys = new Set([...Object.keys(previousValue), ...Object.keys(nextValue)]);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(nextValue, key)) {
      patch[key] = createSnapshotDeleteSentinel();
      changed = true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(previousValue, key)) {
      patch[key] = cloneValue(nextValue[key]);
      changed = true;
      continue;
    }
    const childPatch = buildStateDeltaPatch(previousValue[key], nextValue[key]);
    if (childPatch !== undefined) {
      patch[key] = childPatch;
      changed = true;
    }
  }
  return changed ? patch : undefined;
}

function applyStateDeltaPatch(previousValue, deltaPatch) {
  if (deltaPatch === undefined) return cloneValue(previousValue);
  if (isSnapshotDeleteSentinel(deltaPatch)) return undefined;
  if (isSnapshotArrayAppendPatch(deltaPatch)) return applySnapshotArrayAppendPatch(previousValue, deltaPatch);
  if (Array.isArray(deltaPatch) || !isPlainObject(deltaPatch)) return cloneValue(deltaPatch);

  const base = isPlainObject(previousValue) ? cloneValue(previousValue) : {};
  for (const [key, value] of Object.entries(deltaPatch)) {
    if (isSnapshotDeleteSentinel(value)) {
      delete base[key];
      continue;
    }
    const nextValue = applyStateDeltaPatch(base[key], value);
    if (nextValue === undefined) delete base[key];
    else base[key] = nextValue;
  }
  return base;
}

function getSerializedSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function shouldStoreFullSnapshot(snapshotIndex, fullPayload, deltaPatch) {
  if (snapshotIndex <= 0) return true;
  if (snapshotIndex % SNAPSHOT_FULL_INTERVAL === 0) return true;
  if (deltaPatch === undefined) return false;
  const fullSize = getSerializedSize(fullPayload);
  const patchSize = getSerializedSize(deltaPatch);
  if (!Number.isFinite(fullSize) || fullSize <= 0) return true;
  return patchSize >= Math.floor(fullSize * SNAPSHOT_PATCH_SIZE_RATIO);
}

function trimChatStateSnapshots(chatState) {
  if (!Array.isArray(chatState?.snapshots)) return;
  if (chatState.snapshots.length <= MAX_CHAT_STATE_SNAPSHOTS) return;
  compactChatStateSnapshots(chatState);
  const startIndex = chatState.snapshots.length - MAX_CHAT_STATE_SNAPSHOTS;
  const materializedFirstPayload = materializeSnapshotPayloadAt(chatState.snapshots, startIndex);
  chatState.snapshots = chatState.snapshots.slice(startIndex);
  if (chatState.snapshots[0]) {
    chatState.snapshots[0] = {
      messageCount: Number.isInteger(chatState.snapshots[0].messageCount) ? chatState.snapshots[0].messageCount : 0,
      messageDigest: String(chatState.snapshots[0].messageDigest || ''),
      reason: String(chatState.snapshots[0].reason || 'state'),
      createdAt: Number(chatState.snapshots[0].createdAt || Date.now()),
      snapshotMode: 'full',
      stateSnapshot: materializedFirstPayload,
    };
  }
}

function findSnapshotIndex(chatState, snapshot) {
  const snapshots = Array.isArray(chatState?.snapshots) ? chatState.snapshots : [];
  if (!snapshot || typeof snapshot !== 'object') return -1;
  const directIndex = snapshots.indexOf(snapshot);
  if (directIndex >= 0) return directIndex;
  return snapshots.findIndex((item) =>
    item
    && item.createdAt === snapshot.createdAt
    && item.messageCount === snapshot.messageCount
    && item.reason === snapshot.reason
    && String(item.messageDigest || '') === String(snapshot.messageDigest || ''));
}

function materializeSnapshotPayloadAt(snapshots, index, cache = new Map()) {
  if (!Array.isArray(snapshots) || index < 0 || index >= snapshots.length) return createEmptyChatState();
  if (cache.has(index)) return cloneValue(cache.get(index));

  const snapshot = snapshots[index];
  let payload;
  if (snapshot?.snapshotMode === 'patch') {
    const previousPayload = materializeSnapshotPayloadAt(snapshots, index - 1, cache);
    payload = applyStateDeltaPatch(previousPayload, snapshot.stateDelta || {});
  } else {
    payload = snapshot?.stateSnapshot ? cloneValue(snapshot.stateSnapshot) : createEmptyChatState();
  }

  cache.set(index, cloneValue(payload));
  return payload;
}

function createStoredSnapshotState(snapshots, payload, metadata = {}, cache = new Map()) {
  const snapshotIndex = Array.isArray(snapshots) ? snapshots.length : 0;
  const normalizedPayload = sanitizeSnapshotPayload(payload);
  const previousPayload = snapshotIndex > 0 ? materializeSnapshotPayloadAt(snapshots, snapshotIndex - 1, cache) : null;
  const deltaPatch = previousPayload ? buildStateDeltaPatch(previousPayload, normalizedPayload) : undefined;
  const baseRecord = {
    messageCount: Number.isInteger(metadata.messageCount) ? Math.max(0, metadata.messageCount) : 0,
    messageDigest: String(metadata.messageDigest || ''),
    reason: String(metadata.reason || 'state'),
    createdAt: Number(metadata.createdAt || Date.now()),
  };

  if (shouldStoreFullSnapshot(snapshotIndex, normalizedPayload, deltaPatch)) {
    return {
      ...baseRecord,
      snapshotMode: 'full',
      stateSnapshot: normalizedPayload,
    };
  }

  return {
    ...baseRecord,
    snapshotMode: 'patch',
    stateDelta: deltaPatch || {},
  };
}

function compactChatStateSnapshots(chatState) {
  if (!Array.isArray(chatState?.snapshots)) return false;
  let changed = false;
  for (const snapshot of chatState.snapshots) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    if (!Number.isInteger(snapshot.messageCount)) {
      snapshot.messageCount = Array.isArray(snapshot.messageSignatures) ? snapshot.messageSignatures.length : 0;
      changed = true;
    }
    if (!snapshot.messageDigest && Array.isArray(snapshot.messageSignatures)) {
      snapshot.messageDigest = buildMessageDigestFromSignatures(snapshot.messageSignatures, snapshot.messageCount);
      changed = true;
    }
    if (!snapshot.snapshotMode) {
      snapshot.snapshotMode = snapshot.stateDelta ? 'patch' : 'full';
      changed = true;
    }
    if (Array.isArray(snapshot.messageSignatures)) {
      delete snapshot.messageSignatures;
      changed = true;
    }
  }
  return changed;
}

function needsRepackChatStateSnapshots(chatState) {
  if (!Array.isArray(chatState?.snapshots) || chatState.snapshots.length === 0) return false;
  return chatState.snapshots.some((snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (!snapshot.snapshotMode) return true;
    if (Array.isArray(snapshot.messageSignatures)) return true;
    return false;
  });
}

function repackChatStateSnapshots(chatState) {
  if (!Array.isArray(chatState?.snapshots) || chatState.snapshots.length === 0) return false;
  compactChatStateSnapshots(chatState);

  const originalSnapshots = chatState.snapshots;
  const sourceCache = new Map();
  const repackedSnapshots = [];
  const repackedCache = new Map();
  let changed = false;

  for (let index = 0; index < originalSnapshots.length; index += 1) {
    const snapshot = originalSnapshots[index];
    const payload = materializeSnapshotPayloadAt(originalSnapshots, index, sourceCache);
    const stored = createStoredSnapshotState(repackedSnapshots, payload, {
      messageCount: snapshot?.messageCount,
      messageDigest: snapshot?.messageDigest,
      reason: snapshot?.reason,
      createdAt: snapshot?.createdAt,
    }, repackedCache);
    repackedSnapshots.push(stored);
    repackedCache.set(repackedSnapshots.length - 1, cloneValue(payload));

    if (
      stored.snapshotMode !== snapshot?.snapshotMode
      || JSON.stringify(stored.stateSnapshot ?? stored.stateDelta ?? null) !== JSON.stringify(snapshot?.stateSnapshot ?? snapshot?.stateDelta ?? null)
    ) {
      changed = true;
    }
  }

  if (changed) chatState.snapshots = repackedSnapshots;
  return changed;
}

function getSnapshotRuntimeKey(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  return [
    Number.isInteger(snapshot.messageCount) ? snapshot.messageCount : 0,
    String(snapshot.messageDigest || ''),
    String(snapshot.reason || ''),
    Number(snapshot.createdAt || 0),
  ].join('|');
}

function markRestoredSnapshot(chatState, snapshot) {
  if (!chatState || typeof chatState !== 'object') return;
  Object.defineProperty(chatState, RESTORED_SNAPSHOT_RUNTIME_KEY, {
    value: getSnapshotRuntimeKey(snapshot),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

export function restoreChatStateFromSnapshot(chatState, snapshot) {
  if (!snapshot) return;
  const snapshotIndex = findSnapshotIndex(chatState, snapshot);
  const payload = snapshotIndex >= 0
    ? materializeSnapshotPayloadAt(chatState.snapshots, snapshotIndex)
    : (snapshot?.stateSnapshot ? cloneValue(snapshot.stateSnapshot) : createEmptyChatState());
  chatState.lastAttemptedSignature = payload.lastAttemptedSignature || '';
  chatState.lastProcessedSignature = payload.lastProcessedSignature || '';
  chatState.lastRunAt = payload.lastRunAt || 0;
  chatState.sceneSummary = payload.sceneSummary || '';
  chatState.minutesPassed = payload.minutesPassed || 0;
  chatState.characters = unpackSnapshotCharacters(payload.characters, payload.charactersFormat || '');
  chatState.lastRawResult = payload.lastRawResult || null;
  chatState.lastOperationLogs = Array.isArray(payload.lastOperationLogs) ? payload.lastOperationLogs : [];
}

export function recordChatStateSnapshot(ctx, chatState, options = {}) {
  if (!Array.isArray(chatState.snapshots)) chatState.snapshots = [];
  const messageCount = Number.isInteger(options.messageCount)
    ? Math.max(0, options.messageCount)
    : (Array.isArray(ctx.chat) ? ctx.chat.length : 0);
  const snapshot = createStoredSnapshotState(
    chatState.snapshots,
    exportChatStateSnapshotPayload(chatState),
    {
      messageCount,
      messageDigest: buildMessageDigest(ctx, messageCount),
      reason: String(options.reason || 'state'),
      createdAt: Date.now(),
    },
  );
  chatState.snapshots.push(snapshot);
  trimChatStateSnapshots(chatState);
  markRestoredSnapshot(chatState, snapshot);
  return snapshot;
}

export function getLatestMatchingSnapshot(ctx, chatState, messageCount = null) {
  compactChatStateSnapshots(chatState);
  const chatLength = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
  const requestedCount = Number.isInteger(messageCount)
    ? Math.max(0, Math.min(chatLength, messageCount))
    : null;
  const snapshots = Array.isArray(chatState.snapshots) ? chatState.snapshots : [];
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    const count = Number.isInteger(snapshot?.messageCount) ? snapshot.messageCount : 0;
    if (requestedCount !== null) {
      if (count !== requestedCount) continue;
    } else if (count > chatLength) {
      continue;
    }
    return snapshot;
  }
  return null;
}

export function buildSignature(ctx, endIndexExclusive = null) {
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const end = Number.isInteger(endIndexExclusive) ? Math.max(0, Math.min(chat.length, endIndexExclusive)) : chat.length;
  const last = chat[end - 1];
  if (!last) return '';
  const content = String(last.mes || '');
  return [
    getChatKey(ctx),
    end,
    last.is_user ? 'user' : 'assistant',
    String(last.name || ''),
    content.length,
    hashStringFNV1a(content, MESSAGE_DIGEST_SEED).toString(16).padStart(8, '0'),
  ].join('|');
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
    if (Array.isArray(profile.diary) && profile.diary.length > 0) lines.push(`Diary: ${JSON.stringify(profile.diary)}`);
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
