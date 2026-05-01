import {
  cloneValue,
  derivePregnancyStageState,
  getGestationEffectiveSpeed,
  getGestationSpeciesSpeed,
  getGestationModifierMultiplier,
  getChatState,
  getPsyStressInitByLevel,
  getSettings,
  getVitalityInitByLevel,
  saveSettings,
  syncCharacterStageFromProfile,
} from './state.js';
import {
  buildEmptyPsychologyGroup,
  normalizePsychologyGroup,
  PSY_MENS_FIELDS,
  PSY_MENS_BOOL_FIELDS,
  PSY_PREG_FIELDS,
  PSY_PREG_BOOL_FIELDS,
} from './registry_psy_config.js';
import {
  LABOR_STAGES,
  LABOR_STAGE_BASE_HOURS,
  LABOR_STAGE_INCREMENT,
  MENSTRUAL_STAGE_DAYS,
  MENSTRUAL_STAGES,
  PREGNANCY_STAGES,
} from './stage_config.js';
import {
  getBaseRaceName,
  getDerivedTypeInheritanceProfile,
  getEmbryoTypeByRace,
  getMergedRacePhysiologyProfile,
  parseRaceDescriptor,
  getRaceComponents as getConfiguredRaceComponents,
} from './race_config.js';

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'bsPassedTime',
    description: '推进当前聊天中已注册角色的时间。会处理月经阶段、受精着床、孕期推进、产前阵痛、第一至第三产程、产后恢复，以及最近性行为计时。',
    input_schema: {
      type: 'object',
      properties: {
        minute: { type: 'integer' },
        hour: { type: 'integer' },
        day: { type: 'integer' },
        week: { type: 'integer' },
        month: { type: 'integer' },
        year: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bsUpdateCharacterStatus',
    description: '对单一角色的活力、情压、性欲、宫压做增减更新。会联动代谢累积、高潮排卵、羊膜耐久警告等状态。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            vitality: { type: 'integer' },
            libido: { type: 'integer' },
            uterinePressure: { type: 'integer' },
            psyStress: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
      required: ['female', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsSetDescription',
    description:
      '只更新单一角色的描述字段，可单独更新 normalDescription / closeupDescription / pregnantDescription。描述内容必须使用旧版格式：字段名|描述内容;;字段名|描述内容;;...字段名|描述内容;;，不可改成自然段或换行文本。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            normalDescription: { type: 'string' },
            closeupDescription: { type: 'string' },
            pregnantDescription: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['female', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsSetCharacterPresence',
    description: '设置角色是否在场。设为 false 后，tracker 默认不会再把该角色完整状态发送给 LLM，直到重新设为 true。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        isPresent: { type: 'boolean' },
      },
      required: ['female'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsUpdateExperience',
    description: '直接更新单一角色的经验/关系字段。适合修正贞洁、伴侣、怀孕/分娩/流产经历等记录，不触发额外规则。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            virginity: { type: ['string', 'null'] },
            latestSexPartner: { type: ['string', 'null'] },
            emotionalMate: { type: ['string', 'null'] },
            marriageMate: { type: ['string', 'null'] },
            pregnantExperience: { type: 'integer' },
            naturalBirthExperience: { type: 'integer' },
            surgicalBirthExperience: { type: 'integer' },
            miscarriageExperience: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
      required: ['female', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsNameChild',
    description: '给单一角色已出生的某个孩子命名。只修改 children 指定索引的 name，不触发额外规则。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        childIndex: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['female', 'childIndex', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsUpdatePsychology',
    description: '按当前阶段更新单一角色的心理倾向数值。月经阶段使用 mens，妊娠/假孕/产前阵痛/产程使用 preg。系统会自动重算 *_interpret。注意：数值字段传入的是“变化量(delta)”而不是目标值，例如当前 stance_value=78，传入 {"preg":{"stance":2}} 会变成 80，而不是设为 2。建议一次只调整一个心理项，且尽量小幅变动；单次以 ±1 到 ±3 为宜，±5 已属于偏大变化。布林字段则是直接设为 true/false。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        options: {
          type: 'object',
          properties: {
              mens: {
                type: 'object',
                properties: {
                  mastery: { type: 'number' },
                  desire: { type: 'number' },
                  autonomy: { type: 'number' },
                  isChaste: { type: 'boolean' },
                  hasContraception: { type: 'boolean' },
                },
                additionalProperties: false,
              },
              preg: {
                type: 'object',
                properties: {
                  cognition: { type: 'number' },
                  bonding: { type: 'number' },
                  stance: { type: 'number' },
                  knowsFatherSource: { type: 'boolean' },
                  hasProfessionalPrenatalCare: { type: 'boolean' },
                },
                additionalProperties: false,
              },
          },
          additionalProperties: false,
        },
      },
      required: ['female', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsAddSperm',
    description: '向单一角色体内加入或扣除精液，用于性交后留下受孕机会。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        male: { type: 'string' },
        race: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['female', 'male', 'race', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsDrainSperm',
    description: '让角色主动排出体内部分或全部精液残留，按当前各来源比例一并减少。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['female', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsSetMenstrualPhases',
    description: '直接设置月经相关阶段，用于催情、药物、外力或剧情推进。切到排卵期时会重新允许高潮排卵；假孕期可留精但不会排卵或受孕。不会覆盖正在进行的受精、真妊娠、产前阵痛或产程。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        stage: { type: 'string' },
      },
      required: ['female', 'stage'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsExcreteMetabolism',
    description: '缓解角色的生理需求。普通种族用于处理尿意、便意、饿意、困意；带 derivedType 的角色则用于释放单一极性需求 flux，按释放量抵消当前极性，只有在释放量足够时才会跨过 0 翻转。尿便受宫压阻碍，怀孕、产前阵痛与产程阶段存在不同程度残留感。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            urine: { type: 'number' },
            stool: { type: 'number' },
            hunger: { type: 'number' },
            sleep: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      required: ['female'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsAbortion',
    description: '终止当前受精或妊娠状态。月经阶段且着床前视为避孕成功，其他阶段视为流产；可指定 fetusIndex 做减胎。若 miscarriage 保护开启，则需 force=true 才会生效。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        force: { type: 'boolean' },
        fetusIndex: { type: 'integer' },
      },
      required: ['female'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsChildbirth',
    description: '让角色立即结束分娩并进入产后恢复，并把剩余胎儿转为 children 记录。外部直接调用视为手术产；产程自然结束时则记为自然产。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
      },
      required: ['female'],
      additionalProperties: false,
    },
  },
  {
    name: 'bsMaternalFetalInteraction',
    description: '处理母体与胎儿之间的互动。平时会调整随机一胎的 affinity；若当前处于产前阵痛且 direction=maternal，则自动改为分娩抵抗，成功可延后分娩，失败则进入第一产程。',
    input_schema: {
      type: 'object',
      properties: {
        female: { type: 'string' },
        change: {
          type: 'string',
          enum: ['slight_increase', 'significant_increase', 'slight_decrease', 'significant_decrease'],
        },
        direction: {
          type: 'string',
          enum: ['fetal', 'maternal'],
        },
      },
      required: ['female'],
      additionalProperties: false,
    },
  },
]);

function clampNumber(value, min, max, fallback = 0) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function randomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(randomNumber(min, max + 1));
}

function wrapAngle(angle) {
  let next = Number(angle) || 0;
  while (next < 0) next += 360;
  while (next >= 360) next -= 360;
  return next;
}

function angleDistance(from, to) {
  const direct = Math.abs(from - to);
  return Math.min(direct, 360 - direct);
}

function shuffleInPlace(list) {
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
}

function getBaseRace(race) {
  return getBaseRaceName(race);
}

function getRaceComponents(race) {
  return getConfiguredRaceComponents(race);
}

function isSameRaceGroup(leftRace, rightRace) {
  const left = getRaceComponents(leftRace).sort();
  const right = getRaceComponents(rightRace).sort();
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function deriveFetusRace(motherRace, fatherRace) {
  const motherParts = getRaceComponents(motherRace);
  const fatherParts = getRaceComponents(fatherRace);
  const combined = [...fatherParts, ...motherParts].filter(Boolean);
  if (combined.length === 0) return '人类';
  const unique = [];
  for (const part of combined) {
    if (!unique.includes(part)) unique.push(part);
  }
  return unique.join('x');
}

function deriveFetusEmbryoType(race) {
  return getEmbryoTypeByRace(race);
}

function deriveFetusGender(race) {
  const profile = getMergedRacePhysiologyProfile(race);
  if (profile?.genderRatio === -1) return '无';
  if (profile?.genderRatio === null) return '双';
  const ratio = clampNumber(profile?.genderRatio, 0, 100, 50);
  return Math.random() < (ratio / 100) ? '男' : '女';
}

function getConceptionWeight(stage, gender, weightRatio = 1.0) {
  const stageWeights = {
    黄体期: 1.2,
    排卵期: 1.1,
    卵泡期: 1.0,
    产后恢复: 0.9,
    月经期: 0.8,
  };
  const baseWeight = stageWeights[String(stage || '')] || 1.0;
  const fluctuation = randomNumber(-0.08, 0.08);
  const sexMultiplier = gender === '男' ? 1.05 : gender === '女' ? 0.95 : 1.0;
  return Math.max(0.5, Math.min(2.0, Number((baseWeight + fluctuation) * sexMultiplier * weightRatio)));
}

function getConceptionWeightRatio(profile, sperm) {
  const motherBreedTolerance = clampNumber(profile?.bio?.breedTolerance, 0.1, 100, 1.0);
  const fatherProfile = getMergedRacePhysiologyProfile(sperm?.race);
  const fatherBreedTolerance = clampNumber(fatherProfile?.breedTolerance, 0.1, 100, 1.0);
  const dominance = (fatherBreedTolerance - motherBreedTolerance) / Math.max(motherBreedTolerance + fatherBreedTolerance, 0.1);
  return clampNumber(1 + (dominance * 0.65), 0.625, 1.6, 1.0);
}

function getDerivedTypeSeed(motherDerivedType, fatherDerivedType) {
  const mother = motherDerivedType ? String(motherDerivedType) : null;
  const father = fatherDerivedType ? String(fatherDerivedType) : null;
  if (!mother && !father) return { affinity: 0, progress: 0 };
  if (mother && father && mother === father) return { affinity: 30, progress: 30 };
  if (mother && father && mother !== father) return { affinity: -30, progress: -30 };
  return { affinity: 15, progress: 0 };
}

function updateDerivedTypeProgress(profile, tick) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  const motherDerivedType = base.derivedType ? String(base.derivedType) : null;
  const passedDays = Math.max(0, tick.passedDays);
  if (fetuses.length === 0 || passedDays <= 0) return;

  for (const fetus of fetuses) {
    const fatherDerivedType = fetus?.fatherDerivedType ? String(fetus.fatherDerivedType) : null;
    if (!motherDerivedType && !fatherDerivedType) continue;
    const currentProgress = clampNumber(fetus?.maternalDerivedTypeProgress, -100, 100, 0);
    if (currentProgress === 0) continue;

    const direction = Math.sign(currentProgress);
    const affinity = clampNumber(fetus?.affinity, -50, 50, 0);
    const alignment = direction * affinity;
    const factor = clampNumber(1 + (alignment / 30), 0, 3, 1);
    const activeDerivedType = direction > 0 ? motherDerivedType : fatherDerivedType;
    const inheritanceSpeed = clampNumber(getDerivedTypeInheritanceProfile(activeDerivedType)?.inheritanceSpeed, 0.2, 3.0, 1.0);
    const delta = direction * passedDays * 3 * factor * inheritanceSpeed;
    fetus.maternalDerivedTypeProgress = clampNumber(currentProgress + delta, -100, 100, currentProgress);
  }

  pregnant.fetuses = fetuses;
  profile.pregnant = pregnant;
}

function cloneIdenticalFetus(fetus) {
  return {
    ...fetus,
    tendencyAngle: randomInt(0, 360),
    affinity: 0,
  };
}

function applyIdenticalSplit(profile) {
  const pregnant = profile.pregnant || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  if (fetuses.length === 0) return;

  const splitRate = clampNumber(profile?.bio?.identicalProbability, 0, 100, 5) / 100;
  if (splitRate <= 0) return;

  const baseFetus = fetuses[fetuses.length - 1];
  let targetCount = 1;
  if (Math.random() < splitRate) {
    targetCount = 2;
    if (Math.random() < splitRate * splitRate) {
      targetCount = 3;
      if (Math.random() < splitRate * splitRate * splitRate) {
        targetCount = 4;
      }
    }
  }

  while (fetuses.length < targetCount) {
    fetuses.push(cloneIdenticalFetus(baseFetus));
  }
  pregnant.fetuses = fetuses;
  pregnant.fetusesCount = fetuses.length;
}

function createSimpleFetus(profile, sperm, cycleStage) {
  const motherRace = parseRaceDescriptor(profile?.base?.race || '人类').race || '人类';
  const fatherRace = parseRaceDescriptor(sperm?.race || motherRace || '人类').race || motherRace || '人类';
  const fetusRace = deriveFetusRace(motherRace, fatherRace);
  const gender = deriveFetusGender(fetusRace);
  const weightRatio = getConceptionWeightRatio(profile, sperm);
  const motherDerivedType = profile?.base?.derivedType ? String(profile.base.derivedType) : null;
  const fatherDerivedType = sperm?.derivedType ? String(sperm.derivedType) : null;
  const derivedSeed = getDerivedTypeSeed(motherDerivedType, fatherDerivedType);
  return {
    fathers: String(sperm?.male || '未知'),
    provider: null,
    race: fetusRace,
    fatherRace,
    fatherDerivedType,
    gender,
    embryoType: deriveFetusEmbryoType(fetusRace),
    weight: getConceptionWeight(cycleStage, gender, weightRatio),
    tendencyAngle: randomInt(0, 360),
    affinity: derivedSeed.affinity,
    maternalDerivedTypeProgress: derivedSeed.progress,
  };
}

function updateFetalEnergyDrain(profile) {
  const fetuses = Array.isArray(profile?.pregnant?.fetuses) ? profile.pregnant.fetuses : [];
  const effectivePregnantDays = clampNumber(profile?.pregnant?.effectivePregnantDays, 0, 9999, 0);
  const motherBreedTolerance = clampNumber(profile?.bio?.breedTolerance, 0.1, 100, 1.0);
  profile.pregnant.fetalEnergyDrain = fetuses.reduce((sum, fetus) => {
    const weight = clampNumber(fetus?.weight, 0.5, 2.0, 1.0);
    const ageInDays = effectivePregnantDays * weight;
    const fetalAgeWeeks = ageInDays / 7;
    const fetalLoad = fetalAgeWeeks / 40;
    const fetusEnergyDrain = fetalLoad / motherBreedTolerance;
    return sum + fetusEnergyDrain;
  }, 0);
}

function getEmbryoTypeModifiers(embryoType) {
  switch (String(embryoType || '胎生')) {
    case '卵生':
      return { recoveryCoefficient: 0.6 };
    case '卵胎生':
      return { recoveryCoefficient: 0.4 };
    case '胎转卵生':
      return { recoveryCoefficient: 1.0 };
    case '不定型':
      return { recoveryCoefficient: 0.8 };
    case '胎生':
    default:
      return { recoveryCoefficient: 0.2 };
  }
}

function snapshotOriginalPregnancyBio(character) {
  const runtime = character.runtime || {};
  if (runtime.originalPregnancyBio) return runtime.originalPregnancyBio;
  const bio = character?.profile?.bio || {};
  const snapshot = {
    gestationSpeciesSpeed: clampNumber(getGestationSpeciesSpeed(character?.profile), 0.1, 20, 1.0),
    birthDifficulty: clampNumber(bio.birthDifficulty, 0.1, 100, 1.0),
    breedTolerance: clampNumber(bio.breedTolerance, 0.1, 100, 1.0),
    recoveryDays: Math.max(1, Math.round(clampNumber(bio.recoveryDays, 1, 9999, 56))),
  };
  runtime.originalPregnancyBio = snapshot;
  character.runtime = runtime;
  return snapshot;
}

function applyPregnancyPhysiology(profile, runtime) {
  const pregnant = profile.pregnant || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  if (fetuses.length === 0) return false;

  const originalBio = runtime?.originalPregnancyBio || {
    gestationSpeciesSpeed: clampNumber(getGestationSpeciesSpeed(profile), 0.1, 20, 1.0),
    birthDifficulty: clampNumber(profile?.bio?.birthDifficulty, 0.1, 100, 1.0),
    breedTolerance: clampNumber(profile?.bio?.breedTolerance, 0.1, 100, 1.0),
    recoveryDays: Math.max(1, Math.round(clampNumber(profile?.bio?.recoveryDays, 1, 9999, 56))),
  };

  let totalWeight = 0;
  let gestationAccumulator = 0;
  let birthAccumulator = 0;
  let toleranceAccumulator = 0;
  let recoveryAccumulator = 0;

  for (const fetus of fetuses) {
    const weight = clampNumber(fetus?.weight, 0.5, 2.0, 1.0);
    const embryoModifiers = getEmbryoTypeModifiers(fetus?.embryoType);
    const raceProfile = getMergedRacePhysiologyProfile(fetus?.race) || {};

    totalWeight += weight;
    gestationAccumulator += weight * clampNumber(raceProfile.gestationSpeciesSpeed, 0.1, 20, 1.0);
    birthAccumulator += weight * clampNumber(raceProfile.birthDifficulty, 0.1, 100, 1.0);
    toleranceAccumulator += weight * clampNumber(raceProfile.breedTolerance, 0.1, 100, 1.0);
    recoveryAccumulator += weight * embryoModifiers.recoveryCoefficient;
  }

  const averageGestation = gestationAccumulator / Math.max(totalWeight, 0.5);
  const averageBirth = birthAccumulator / Math.max(totalWeight, 0.5);
  const averageTolerance = toleranceAccumulator / Math.max(totalWeight, 0.5);
  const averageRecoveryCoefficient = recoveryAccumulator / Math.max(totalWeight, 0.5);
  const fetusCountModifier = 1 + ((fetuses.length - 1) * 0.08);
  const toleranceCountModifier = Math.max(0.6, 1 - ((fetuses.length - 1) * 0.04));
  const gestationModifierMultiplier = getGestationModifierMultiplier(profile);

  const gestationEffectiveSpeed = clampNumber(originalBio.gestationSpeciesSpeed * gestationModifierMultiplier * averageGestation, 0, 20, originalBio.gestationSpeciesSpeed);
  const recoveryGestationSpeed = Math.max(0.1, gestationEffectiveSpeed > 0 ? gestationEffectiveSpeed : (originalBio.gestationSpeciesSpeed * averageGestation));
  const birthDifficulty = clampNumber(originalBio.birthDifficulty * averageBirth * fetusCountModifier, 0.1, 100, originalBio.birthDifficulty);
  const breedTolerance = clampNumber(originalBio.breedTolerance * averageTolerance * toleranceCountModifier, 0.1, 100, originalBio.breedTolerance);
  const recoveryDays = Math.max(
    1,
    Math.round(clampNumber(averageRecoveryCoefficient, 0.1, 2.0, 0.2) * (280 / recoveryGestationSpeed) * (birthDifficulty / Math.max(breedTolerance, 0.1))),
  );

  profile.bio = {
    ...(profile.bio || {}),
    gestationSpeciesSpeed: clampNumber(originalBio.gestationSpeciesSpeed, 0.1, 20, 1.0),
    gestationEffectiveSpeed,
    birthDifficulty,
    breedTolerance,
    recoveryDays,
  };
  return true;
}

function restorePregnancyPhysiology(profile, runtime) {
  const originalBio = runtime?.originalPregnancyBio;
  if (!originalBio) return false;
  const gestationModifierMultiplier = getGestationModifierMultiplier(profile);
  profile.bio = {
    ...(profile.bio || {}),
    gestationSpeciesSpeed: clampNumber(originalBio.gestationSpeciesSpeed, 0.1, 20, 1.0),
    gestationEffectiveSpeed: clampNumber(originalBio.gestationSpeciesSpeed * gestationModifierMultiplier, 0, 20, 1.0),
    birthDifficulty: clampNumber(originalBio.birthDifficulty, 0.1, 100, 1.0),
    breedTolerance: clampNumber(originalBio.breedTolerance, 0.1, 100, 1.0),
    recoveryDays: Math.max(1, Math.round(clampNumber(originalBio.recoveryDays, 1, 9999, 56))),
  };
  delete runtime.originalPregnancyBio;
  return true;
}

function isObliquePosition(angle, fetus) {
  if (fetus && (fetus.embryoType === '胎转卵生' || fetus.embryoType === '不定型')) return false;
  const normalized = wrapAngle(angle);
  if ((normalized >= 0 && normalized <= 15) || (normalized >= 345 && normalized <= 360)) return false;
  if (normalized >= 165 && normalized <= 195) return false;
  if ((normalized >= 75 && normalized <= 105) || (normalized >= 265 && normalized <= 285)) return false;
  return true;
}

function calculateNearestMainPosition(angle) {
  const normalized = wrapAngle(angle);
  const positions = [0, 90, 180, 270];
  let nearest = positions[0];
  let minDiff = angleDistance(normalized, positions[0]);
  for (const position of positions) {
    const diff = angleDistance(normalized, position);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = position;
    }
  }
  return nearest;
}

function calculatePositionDifficulty(angle, fetus) {
  const normalized = wrapAngle(angle);
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

function updateFetalPositions(profile, tick, female) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const stage = String(base.stage || '');
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  if (fetuses.length === 0) return;

  const gestationSpeed = clampNumber(getGestationEffectiveSpeed(profile), 0, 20, 1);
  const iterations = Math.max(0, tick.passedDays);
  if (iterations <= 0 || !PREGNANCY_STAGES.includes(stage)) return;

  for (let step = 0; step < iterations; step += 1) {
    const totalWeight = fetuses.reduce((sum, fetus) => sum + clampNumber(fetus?.weight, 0.5, 2.0, 1.0), 0);
    if (stage === '孕晚期' && fetuses.length > 1) {
      const positionedIndexes = [];
      for (let index = 0; index < fetuses.length; index += 1) {
        const fetus = fetuses[index];
        if (!Number.isFinite(Number(fetus?.tendencyAngle))) fetus.tendencyAngle = randomInt(0, 360);
        const angle = wrapAngle(fetus.tendencyAngle);
        if ((angle >= 0 && angle <= 15) || (angle >= 345 && angle <= 360)) positionedIndexes.push(index);
      }
      if (positionedIndexes.length > 0) {
        const targetIndex = positionedIndexes[randomInt(0, positionedIndexes.length - 1)];
        const targetFetus = fetuses[targetIndex];
        const adjustmentSuccessRate = clampNumber(targetFetus?.weight, 0.5, 2.0, 1.0) / Math.max(totalWeight, 0.5);
        if (Math.random() > adjustmentSuccessRate) {
          targetFetus.tendencyAngle = wrapAngle(Number(targetFetus.tendencyAngle || 0) + (randomInt(-15, 15) * gestationSpeed));
        }
      }
    }

    for (const fetus of fetuses) {
      if (!Number.isFinite(Number(fetus?.tendencyAngle))) fetus.tendencyAngle = randomInt(0, 360);
      if (stage === '逾期') continue;

      let adjustmentSuccessRate = 1;
      if (fetuses.length > 1) {
        adjustmentSuccessRate = clampNumber(fetus?.weight, 0.5, 2.0, 1.0) / Math.max(totalWeight, 0.5);
      }
      if (Math.random() > adjustmentSuccessRate) continue;

      const currentAngle = wrapAngle(fetus.tendencyAngle);
      if (stage === '孕早期') {
        fetus.tendencyAngle = wrapAngle(currentAngle + (randomInt(-45, 45) * gestationSpeed));
      } else if (stage === '孕中期') {
        fetus.tendencyAngle = wrapAngle(currentAngle + (randomInt(-30, 30) * gestationSpeed));
      } else if (stage === '孕晚期') {
        if (currentAngle >= 0 && currentAngle <= 180) {
          fetus.tendencyAngle = Math.max(0, currentAngle - (randomInt(1, 5) * gestationSpeed));
        } else {
          const shifted = currentAngle + (randomInt(1, 5) * gestationSpeed);
          fetus.tendencyAngle = shifted >= 360 ? 0 : shifted;
        }
        if (fetus.tendencyAngle === 0 || fetus.tendencyAngle === 360) {
          fetus.tendencyAngle = wrapAngle(Number(fetus.tendencyAngle || 0) + (randomInt(-2, 2) * gestationSpeed));
        }
      } else if (stage === '临产期') {
        const targetAngle = calculateNearestMainPosition(currentAngle);
        const diffRaw = targetAngle - currentAngle;
        let diff = diffRaw;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        if (angleDistance(currentAngle, targetAngle) > 15) {
          fetus.tendencyAngle = wrapAngle(currentAngle + (Math.sign(diff) * randomInt(1, 3) * gestationSpeed));
        }
      }
    }

    if (fetuses.length > 1) {
      const originalOrder = fetuses.slice();
      if (stage === '孕早期' || stage === '孕中期') {
        shuffleInPlace(fetuses);
      } else if (stage === '孕晚期') {
        const oblique = [];
        const total = fetuses.reduce((sum, fetus) => sum + clampNumber(fetus?.weight, 0.5, 2.0, 1.0), 0);
        for (let index = fetuses.length - 1; index >= 0; index -= 1) {
          const fetus = fetuses[index];
          if (isObliquePosition(fetus?.tendencyAngle || 0, fetus)) {
            oblique.push({
              index,
              fetus,
              rate: clampNumber(fetus?.weight, 0.5, 2.0, 1.0) / Math.max(total, 0.5),
            });
          }
        }
        for (const entry of oblique) {
          if (Math.random() < entry.rate) {
            fetuses.splice(entry.index, 1);
            const newIndex = randomInt(0, fetuses.length);
            fetuses.splice(newIndex, 0, entry.fetus);
          }
        }
      } else if (stage === '临产期') {
        const total = fetuses.reduce((sum, fetus) => sum + clampNumber(fetus?.weight, 0.5, 2.0, 1.0), 0);
        if (fetuses.length > 1) {
          const firstRate = clampNumber(fetuses[0]?.weight, 0.5, 2.0, 1.0) / Math.max(total, 0.5);
          if (Math.random() < firstRate) {
            [fetuses[0], fetuses[1]] = [fetuses[1], fetuses[0]];
          }
        }
        if (fetuses.length > 2) {
          const lastIndex = fetuses.length - 1;
          const lastRate = clampNumber(fetuses[lastIndex]?.weight, 0.5, 2.0, 1.0) / Math.max(total, 0.5);
          if (Math.random() < lastRate) {
            [fetuses[lastIndex], fetuses[lastIndex - 1]] = [fetuses[lastIndex - 1], fetuses[lastIndex]];
          }
        }
      }
      const orderChanged = fetuses.some((fetus, index) => fetus !== originalOrder[index]);
      if (orderChanged) {
        profile.notify = {
          ...(profile.notify || {}),
          secondly: `${female}的胚胎分布发生了变化`,
        };
      }
    }
  }

  pregnant.fetuses = fetuses;
  pregnant.fetusesCount = fetuses.length;
  profile.pregnant = pregnant;
}

function updateLaborFetalPositions(profile, tick) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const stage = String(base.stage || '');
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  if (fetuses.length === 0 || !LABOR_STAGES.includes(stage)) return;
  const passedHours = Math.max(0, tick.passedHours);
  if (passedHours <= 0) return;

  if (stage === '第一产程') {
    const birthDifficulty = clampNumber(profile?.bio?.birthDifficulty, 0.1, 100, 1);
    for (const fetus of fetuses) {
      const currentAngle = Number.isFinite(Number(fetus?.tendencyAngle)) ? wrapAngle(fetus.tendencyAngle) : randomInt(0, 360);
      fetus.tendencyAngle = currentAngle;
      if (!isObliquePosition(currentAngle, fetus)) continue;
      const targetAngle = calculateNearestMainPosition(currentAngle);
      let diff = targetAngle - currentAngle;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      const adjustment = Math.min(angleDistance(currentAngle, targetAngle), (passedHours * 5) / birthDifficulty);
      fetus.tendencyAngle = wrapAngle(currentAngle + (Math.sign(diff) * adjustment));
    }
  }

  pregnant.fetuses = fetuses;
  profile.pregnant = pregnant;
}

function hasObliqueFetus(fetuses) {
  return fetuses.some((fetus) => isObliquePosition(fetus?.tendencyAngle || 0, fetus));
}

function countObliqueFetuses(fetuses) {
  return fetuses.reduce((count, fetus) => count + (isObliquePosition(fetus?.tendencyAngle || 0, fetus) ? 1 : 0), 0);
}

function stageAllowsSpermRetention(stage) {
  return MENSTRUAL_STAGES.includes(stage) || PREGNANCY_STAGES.includes(stage) || stage === '产后恢复' || stage === '假孕期';
}

function processSpermLifecycle(profile, stage, tick) {
  const base = profile.base || {};
  const sperms = Array.isArray(base.sperms) ? base.sperms.map((item) => ({ ...item })) : [];
  if (sperms.length === 0) {
    base.sperms = [];
    return;
  }

  if (stage === '月经期' && tick.passedHours > 0) {
    base.sperms = [];
    return;
  }

  if (!stageAllowsSpermRetention(stage)) {
    base.sperms = [];
    return;
  }

  base.sperms = sperms
    .map((item) => ({
      ...item,
      value: Math.max(0, clampNumber(item?.value, 0, 999999, 0) - (tick.deltaDays * 10)),
    }))
    .filter((item) => item.value > 0);
}

function processSimpleConception(profile, tick, notify, name) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const stage = String(base.stage || '');
  const deltaDays = tick.deltaDays;
  const fullDays = tick.passedDays;
  const passedHours = tick.passedHours;

  if (![...MENSTRUAL_STAGES, '产后恢复'].includes(stage)) return;

  if (stage === '排卵期' && fullDays > 0) {
    base.eggs = clampNumber(base.eggs, 0, 99, 0) + fullDays;
  }

  if (stage === '月经期' && passedHours > 0) {
    base.eggs = 0;
  } else if (base.eggs > 0 && fullDays > 0 && stage !== '排卵期') {
    base.eggs = Math.max(0, clampNumber(base.eggs, 0, 99, 0) - fullDays);
  }

  const sperms = Array.isArray(base.sperms) ? base.sperms.map((item) => ({ ...item })) : [];
  const availableSperms = sperms.filter((item) => clampNumber(item?.value, 0, 999999, 0) > 0);
  let eggs = clampNumber(base.eggs, 0, 99, 0);
  const femaleDifficulty = clampNumber(profile?.bio?.impregnationDifficulty, 0.1, 100, 1.0);

  while (eggs > 0 && availableSperms.length > 0) {
    const totalSperm = availableSperms.reduce((sum, item) => sum + clampNumber(item?.value, 0, 999999, 0), 0);
    let winner = null;
    for (const sperm of availableSperms) {
      const share = totalSperm > 0 ? clampNumber(sperm?.value, 0, 999999, 0) / totalSperm : 0;
      const maleDifficulty = clampNumber(getMergedRacePhysiologyProfile(sperm?.race)?.impregnationDifficulty, 0.1, 100, 1.0);
      const isSameRace = isSameRaceGroup(profile?.base?.race, sperm?.race);
      let effectiveDifficulty = isSameRace ? femaleDifficulty : (femaleDifficulty + maleDifficulty);
      const femaleEmbryoType = deriveFetusEmbryoType(profile?.base?.race);
      const maleEmbryoType = deriveFetusEmbryoType(sperm?.race);
      if (femaleEmbryoType !== maleEmbryoType) effectiveDifficulty *= 1.5;
      const spermBaseChance = Math.max(0.001, Math.min(0.8, (deltaDays * 12 * 0.5) / effectiveDifficulty));
      const spermChance = Math.max(0.001, Math.min(0.8, spermBaseChance * share));
      if (Math.random() <= spermChance) {
        winner = sperm;
        break;
      }
    }
    if (winner) {
      pregnant.fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
      pregnant.fetuses.push(createSimpleFetus(profile, winner, stage));
      notify.secondly = `${name}受精成功`;
      eggs -= 1;
      break;
    }
    break;
  }

  base.eggs = eggs;

  if (Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0) {
    base.fertilizationDays = clampNumber(base.fertilizationDays, 0, 9999, 0) + deltaDays;
    if (base.fertilizationDays >= 2) {
      const vitality = clampNumber(base.vitality, 0, 200, 100);
      const implantationFailChance = vitality < 100 ? (100 - vitality) / 100 : 0;
      if (Math.random() < implantationFailChance) {
        pregnant.fetuses = [];
        pregnant.fetusesCount = 0;
        pregnant.fetalEnergyDrain = 0;
        base.fertilizationDays = 0;
        notify.secondly = `${name}因身体虚弱，胚胎著床失败`;
      } else {
        applyIdenticalSplit(profile);
        base.stage = '孕早期';
        base.days = 1;
        base.fertilizationDays = 0;
        pregnant.pregnantDays = 0;
        pregnant.effectivePregnantDays = 0;
        pregnant.amnionDurability = 100;
        profile.experience = {
          ...(profile.experience || {}),
          pregnantExperience: clampNumber(profile?.experience?.pregnantExperience, 0, 999, 0) + 1,
        };
        notify.firstly = `${name}进入了孕早期`;
      }
    }
  } else {
    base.fertilizationDays = 0;
  }

  pregnant.fetusesCount = Array.isArray(pregnant.fetuses) ? pregnant.fetuses.length : 0;
  updateFetalEnergyDrain(profile);
}

function normalizeToolCallArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPregnancyStage(stage) {
  return PREGNANCY_STAGES.includes(stage) || stage === '假孕期' || stage === '产前阵痛' || LABOR_STAGES.includes(stage);
}

function clearPsychologyTransitionState(profile, stage, days) {
  const psychology = profile?.psychology;
  if (!psychology || typeof psychology !== 'object') return;
  const pregnant = profile?.pregnant || {};

  if (isTruePregnancyStage(stage) && clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0) > 7) {
    psychology.mens = buildEmptyPsychologyGroup(PSY_MENS_FIELDS, PSY_MENS_BOOL_FIELDS);
  }

  if (stage === '产后恢复' && clampNumber(days, 1, 9999, 1) > 7) {
    psychology.preg = buildEmptyPsychologyGroup(PSY_PREG_FIELDS, PSY_PREG_BOOL_FIELDS);
  }
}

function isTruePregnancyStage(stage) {
  return PREGNANCY_STAGES.includes(stage) || stage === '产前阵痛' || LABOR_STAGES.includes(stage);
}

function hasDerivedMetabolism(profile) {
  return Boolean(String(profile?.base?.derivedType || '').trim());
}

function getDerivedFluxDirection(currentFlux, fallbackDirection = 1) {
  const current = Number(currentFlux) || 0;
  if (current > 0) return 1;
  if (current < 0) return -1;
  return fallbackDirection >= 0 ? 1 : -1;
}

function shouldResetOrgasmOvulation(stage) {
  return stage === '月经期' || stage === '产后恢复';
}

function getLibidoCap(profile) {
  const stage = profile?.base?.stage;
  if (!isTruePregnancyStage(stage)) return 100;
  const effectivePregnantDays = clampNumber(profile?.pregnant?.effectivePregnantDays, 0, 9999, 0);
  const months = Math.floor(effectivePregnantDays / 28);
  const progress = Math.max(0, Math.min(10, months)) / 10;
  return Math.round(100 + (150 - 100) * progress);
}

function getUterinePressureCap(profile) {
  const stage = profile?.base?.stage;
  if (!isTruePregnancyStage(stage)) return 50;
  const effectivePregnantDays = clampNumber(profile?.pregnant?.effectivePregnantDays, 0, 9999, 0);
  const months = Math.floor(effectivePregnantDays / 28);
  const progress = Math.max(0, Math.min(10, months)) / 10;
  return Math.round(50 + (150 - 50) * progress);
}

function applyHourlyPregnancyMetabolism(profile, tick) {
  const immune = profile?.immune || {};
  if (immune.metabolism) return;
  const stage = String(profile?.base?.stage || '');
  if (!isTruePregnancyStage(stage)) return;
  if (tick.passedHours <= 0) return;

  const metabolism = profile?.metabolism || {};
  const fetalEnergyDrain = clampNumber(profile?.pregnant?.fetalEnergyDrain, 0, 9999, 0);
  const delta = (1 + fetalEnergyDrain) * 2 * tick.passedHours;

  if (hasDerivedMetabolism(profile)) {
    const stressMultiplier = clampNumber(1 + ((clampNumber(profile?.base?.psyStress, 0, 200, 100) - 100) / 200), 0.5, 1.5, 1.0);
    const direction = getDerivedFluxDirection(metabolism.flux, 1);
    metabolism.flux = clampNumber((Number(metabolism.flux) || 0) + (delta * stressMultiplier * direction), -150, 150, metabolism.flux || 0);
    profile.metabolism = metabolism;
    return;
  }

  metabolism.urine = clampNumber((metabolism.urine || 0) + delta, 0, 150, metabolism.urine || 0);
  metabolism.stool = clampNumber((metabolism.stool || 0) + delta, 0, 150, metabolism.stool || 0);
  metabolism.hunger = clampNumber((metabolism.hunger || 0) + delta, 0, 150, metabolism.hunger || 0);
  metabolism.sleep = clampNumber((metabolism.sleep || 0) + delta, 0, 150, metabolism.sleep || 0);
  profile.metabolism = metabolism;
}

function applyOverduePressure(profile, tick, female) {
  const base = profile?.base || {};
  const stage = String(base.stage || '');
  if (stage !== '逾期' || tick.passedDays <= 0) return;

  const pregnant = profile?.pregnant || {};
  const fetalEnergyDrain = clampNumber(pregnant.fetalEnergyDrain, 0, 9999, 0);
  const effectivePregnantDays = clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0);
  const overdueDays = Math.max(0, effectivePregnantDays - 280);
  const overdueMultiplier = 1 + Math.max(0, overdueDays / 28);
  const pressureCap = getUterinePressureCap(profile);
  const nextPressure = clampNumber(base.uterinePressure + (fetalEnergyDrain * overdueMultiplier * tick.passedDays), 0, pressureCap, base.uterinePressure || 0);
  base.uterinePressure = nextPressure;
  profile.base = base;
  profile.notify = {
    ...(profile.notify || {}),
    secondly: `${female}已逾期，宫缩压力持续增强`,
  };
}

function applyNaturalMetabolismRecovery(profile, tick) {
  const immune = profile?.immune || {};
  const metabolism = profile?.metabolism || {};
  if (immune.metabolism) {
    metabolism.urine = 0;
    metabolism.stool = 0;
    metabolism.hunger = 0;
    metabolism.sleep = 0;
    metabolism.flux = 0;
    profile.metabolism = metabolism;
    return;
  }

  const passedDays = Math.max(0, tick.passedDays);
  const passedWeeks = Math.floor(passedDays / 7);
  const passedMonths = Math.floor(passedDays / 30);
  const shouldFlush = passedWeeks > 0 || passedMonths > 0;

  if (hasDerivedMetabolism(profile)) {
    if (shouldFlush) {
      metabolism.flux = 0;
      profile.metabolism = metabolism;
      return;
    }

    if (passedDays <= 0) return;

    const currentFlux = clampNumber(metabolism.flux, -150, 150, 0);
    const recovery = 14 * passedDays;
    if (currentFlux > 0) metabolism.flux = Math.max(0, currentFlux - recovery);
    else if (currentFlux < 0) metabolism.flux = Math.min(0, currentFlux + recovery);
    else metabolism.flux = 0;
    profile.metabolism = metabolism;
    return;
  }

  if (shouldFlush) {
    metabolism.urine = 0;
    metabolism.stool = 0;
    metabolism.hunger = 0;
    metabolism.sleep = 0;
    profile.metabolism = metabolism;
    return;
  }

  if (passedDays <= 0) return;

  const dayUrineRecovery = 12 * passedDays;
  const dayStoolRecovery = 8 * passedDays;
  const dayHungerRecovery = 16 * passedDays;
  const daySleepRecovery = 18 * passedDays;

  metabolism.urine = Math.max(0, clampNumber(metabolism.urine, 0, 150, 0) - dayUrineRecovery);
  metabolism.stool = Math.max(0, clampNumber(metabolism.stool, 0, 150, 0) - dayStoolRecovery);
  metabolism.hunger = Math.max(0, clampNumber(metabolism.hunger, 0, 150, 0) - dayHungerRecovery);
  metabolism.sleep = Math.max(0, clampNumber(metabolism.sleep, 0, 150, 0) - daySleepRecovery);
  profile.metabolism = metabolism;
}

function applyMetabolismFromVitality(profile, changeValue) {
  const immune = profile?.immune || {};
  const metabolism = profile?.metabolism || {};
  const base = profile?.base || {};
  if (immune.metabolism || !changeValue) return;

  const stressMultiplier = clampNumber(1 + ((clampNumber(base.psyStress, 0, 200, 100) - 100) / 200), 0.5, 1.5, 1.0);
  const delta = Math.abs(Number(changeValue) || 0) * stressMultiplier;
  if (delta <= 0) return;

  if (hasDerivedMetabolism(profile)) {
    const direction = getDerivedFluxDirection(metabolism.flux, Math.sign(Number(changeValue) || 1));
    metabolism.flux = clampNumber((Number(metabolism.flux) || 0) + (delta * direction), -150, 150, metabolism.flux || 0);
    profile.metabolism = metabolism;
    return;
  }

  if (changeValue > 0) {
    metabolism.urine = clampNumber((metabolism.urine || 0) + delta, 0, 150, metabolism.urine || 0);
    metabolism.stool = clampNumber((metabolism.stool || 0) + delta, 0, 150, metabolism.stool || 0);
  } else {
    metabolism.hunger = clampNumber((metabolism.hunger || 0) + delta, 0, 150, metabolism.hunger || 0);
    metabolism.sleep = clampNumber((metabolism.sleep || 0) + delta, 0, 150, metabolism.sleep || 0);
  }
  profile.metabolism = metabolism;
}

function getMetabolismLevel(value) {
  if (value >= 125) return '爆';
  if (value >= 100) return '满';
  if (value >= 75) return '高';
  if (value >= 50) return '中';
  if (value >= 25) return '低';
  return '无';
}

function getDerivedFluxLevel(value) {
  return getMetabolismLevel(Math.abs(Number(value) || 0));
}

function getDerivedFluxNeedLabel(value) {
  return (Number(value) || 0) >= 0 ? '正极释放需求' : '负极释放需求';
}

function updateAdvisoryNotify(profile, female) {
  const notify = profile?.notify || {};
  const metabolism = profile?.metabolism || {};
  const base = profile?.base || {};
  const pregnant = profile?.pregnant || {};
  const needs = [];

  const urineLevel = getMetabolismLevel(metabolism.urine);
  const stoolLevel = getMetabolismLevel(metabolism.stool);
  const hungerLevel = getMetabolismLevel(metabolism.hunger);
  const sleepLevel = getMetabolismLevel(metabolism.sleep);

  if (['高', '满', '爆'].includes(urineLevel)) needs.push(`尿意:${urineLevel}`);
  if (['高', '满', '爆'].includes(stoolLevel)) needs.push(`便意:${stoolLevel}`);
  if (['高', '满', '爆'].includes(hungerLevel)) needs.push(`饿意:${hungerLevel}`);
  if (['高', '满', '爆'].includes(sleepLevel)) needs.push(`困意:${sleepLevel}`);

  const reminders = [];
  if (hasDerivedMetabolism(profile)) {
    const flux = clampNumber(metabolism.flux, -150, 150, 0);
    if (Math.abs(flux) >= 75) {
      reminders.push(`${female}的${getDerivedFluxNeedLabel(flux)}已达到${getDerivedFluxLevel(flux)}，应优先使用 bsExcreteMetabolism 进行解放；若释放量足够大，需求极性才会跨过 0 翻转`);
    }
  } else if (needs.length > 0) {
    reminders.push(`${female}有强烈的生理需求（${needs.join('、')}），应优先使用 bsExcreteMetabolism 缓解生理不适`);
  }

  const stage = String(base.stage || '');
  if (['临产期', '逾期', '产前阵痛', '第一产程', '第二产程'].includes(stage)) {
    const amnion = clampNumber(pregnant.amnionDurability, -100, 100, 0);
    if (amnion > 0) {
      reminders.push(`${female}的膜耐性尚有${Math.round(amnion)}%，还未到破水时机`);
    } else if (stage !== '第三产程') {
      reminders.push(`${female}已破水`);
    }
  }

  if (stage === '产前阵痛') {
    reminders.push(`${female}正处于产前阵痛阶段，可优先使用 bsMaternalFetalInteraction（direction=maternal）来尝试让其抵抗分娩`);
  }

  profile.notify = {
    ...notify,
    thirdly: reminders.join('；'),
  };
}

function getResidualRate(stage) {
  if (stage === '假孕期') return 0.10;
  if (stage === '产前阵痛' || LABOR_STAGES.includes(stage)) return 0.50;
  if (stage === '孕早期') return 0.10;
  if (stage === '孕中期') return 0.20;
  if (stage === '孕晚期') return 0.30;
  if (stage === '临产期' || stage === '逾期') return 0.40;
  return 0;
}

function applyAmnionDurabilityFromPressure(profile, finalPressure, female) {
  const base = profile?.base || {};
  const pregnant = profile?.pregnant || {};
  const stage = String(base.stage || '');
  if (!PREGNANCY_STAGES.includes(stage)) return;

  const pressureCap = getUterinePressureCap(profile);
  const warningThreshold = pressureCap * 0.33;
  if (finalPressure <= warningThreshold) return;

  const currentDurability = clampNumber(pregnant.amnionDurability, 0, 100, 100);
  const drain = Math.max(1, clampNumber(pregnant.fetalEnergyDrain, 0, 9999, 1));
  const minDurability = LABOR_STAGES.includes(stage) ? 0 : 1;
  const nextDurability = Math.max(minDurability, currentDurability - drain);

  pregnant.amnionDurability = nextDurability;
  profile.pregnant = pregnant;

  const notify = profile.notify || {};
  if (stage === '孕早期' || stage === '孕中期') {
    notify.secondly = `${female}子宫压力过高，有流产风险`;
  } else {
    notify.secondly = `${female}子宫收缩强烈，即将生产`;
  }
  profile.notify = notify;
}

function applyExcreteMetabolism(chatState, args) {
  const female = String(args?.female || '').trim();
  const options = args?.options && typeof args.options === 'object' ? args.options : {};
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsExcreteMetabolism skipped: unknown character ${female || '(empty)'}.` };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const base = profile.base || {};
  const metabolism = profile.metabolism || {};
  const notify = profile.notify || {};
  const immune = profile.immune || {};
  if (immune.metabolism) return { applied: false, message: `bsExcreteMetabolism skipped for ${female}: metabolism immune.` };

  const stage = String(base.stage || '');
  const uterinePressure = clampNumber(base.uterinePressure, 0, 150, 0);
  if (hasDerivedMetabolism(profile)) {
    const pressureHindrance = Math.min(0.5, (uterinePressure / 150) * 0.5);
    const excretionEfficiency = 1 - pressureHindrance;
    const currentFlux = clampNumber(metabolism.flux, -150, 150, 0);
    const direction = getDerivedFluxDirection(currentFlux, 1);
    const optionValues = Object.values(options).map((value) => Math.abs(Number(value) || 0)).filter((value) => value > 0);
    const releasePower = (optionValues.length > 0 ? Math.max(...optionValues) : 40) * excretionEfficiency;
    metabolism.flux = clampNumber(currentFlux - (direction * releasePower), -150, 150, currentFlux);
    profile.metabolism = metabolism;
    const nextFlux = clampNumber(metabolism.flux, -150, 150, 0);
    const didFlip = currentFlux !== 0 && Math.sign(currentFlux) !== Math.sign(nextFlux) && nextFlux !== 0;
    profile.notify = {
      ...notify,
      secondly: didFlip
        ? `${female}完成了一次${direction > 0 ? '正极' : '负极'}解放，需求强度被压过头，极性翻转为${nextFlux > 0 ? '正极' : '负极'}`
        : `${female}完成了一次${direction > 0 ? '正极' : '负极'}解放，当前需求降为 ${Math.round(nextFlux)}`,
    };
    updateAdvisoryNotify(profile, female);
    next.profile = profile;
    chatState.characters[female] = next;
    return { applied: true, message: `bsExcreteMetabolism applied to ${female}.` };
  }

  const currentUrine = clampNumber(metabolism.urine, 0, 150, 0);
  const currentStool = clampNumber(metabolism.stool, 0, 150, 0);
  const currentHunger = clampNumber(metabolism.hunger, 0, 150, 0);
  const currentSleep = clampNumber(metabolism.sleep, 0, 150, 0);

  const residualRate = getResidualRate(stage);
  const pressureHindrance = Math.min(0.5, (uterinePressure / 150) * 0.5);
  const excretionEfficiency = 1 - pressureHindrance;

  const hasOptions = Object.keys(options).length > 0;
  const urineReduction = options.urine !== undefined ? Number(options.urine || 0) : (hasOptions ? 0 : 30);
  const stoolReduction = options.stool !== undefined ? Number(options.stool || 0) : (hasOptions ? 0 : 20);
  const hungerReduction = options.hunger !== undefined ? Number(options.hunger || 0) : (hasOptions ? 0 : 40);
  const sleepReduction = options.sleep !== undefined ? Number(options.sleep || 0) : (hasOptions ? 0 : 40);

  const actualUrineReduction = Math.max(0, urineReduction) * excretionEfficiency;
  const actualStoolReduction = Math.max(0, stoolReduction) * excretionEfficiency;
  const actualHungerReduction = Math.max(0, hungerReduction);
  const actualSleepReduction = Math.max(0, sleepReduction);

  const urineResidual = currentUrine >= 100 ? currentUrine * residualRate : 0;
  const stoolResidual = currentStool >= 100 ? currentStool * residualRate : 0;
  const hungerResidual = currentHunger >= 100 ? currentHunger * residualRate : 0;
  const sleepResidual = currentSleep >= 100 ? currentSleep * residualRate : 0;

  metabolism.urine = Math.max(urineResidual, currentUrine - actualUrineReduction);
  metabolism.stool = Math.max(stoolResidual, currentStool - actualStoolReduction);
  metabolism.hunger = Math.max(hungerResidual, currentHunger - actualHungerReduction);
  metabolism.sleep = Math.max(sleepResidual, currentSleep - actualSleepReduction);

  profile.metabolism = metabolism;
  profile.notify = notify;
  updateAdvisoryNotify(profile, female);
  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsExcreteMetabolism applied to ${female}.` };
}

function clearPregnancyState(profile) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  base.fertilizationDays = 0;
  base.uterinePressure = 0;
  pregnant.pregnantDays = 0;
  pregnant.effectivePregnantDays = 0;
  pregnant.laborHours = 0;
  pregnant.effectiveLaborHours = 0;
  pregnant.fetuses = [];
  pregnant.fetusesCount = 0;
  pregnant.fetalEnergyDrain = 0;
  pregnant.amnionDurability = 0;
  profile.base = base;
  profile.pregnant = pregnant;
}

function appendChildrenFromFetuses(profile, fetuses) {
  const children = Array.isArray(profile.children) ? profile.children.map((item) => ({ ...item })) : [];
  const base = profile.base || {};
  const motherDerivedType = base.derivedType ? String(base.derivedType) : null;
  for (const fetus of fetuses) {
    const progress = clampNumber(fetus?.maternalDerivedTypeProgress, -100, 100, 0);
    const fatherDerivedType = fetus?.fatherDerivedType ? String(fetus.fatherDerivedType) : null;
    let childDerivedType = null;

    if (progress > 75 && motherDerivedType) {
      childDerivedType = motherDerivedType;
    }
    if (progress < -75 && fatherDerivedType) {
      childDerivedType = fatherDerivedType;
    }

    if (fetus?.provider !== null && fetus?.provider !== undefined) continue;
    children.push({
      name: null,
      fathers: String(fetus?.fathers || '未知'),
      gender: String(fetus?.gender || '未知'),
      race: String(fetus?.race || '未知'),
      derivedType: childDerivedType,
      age: 0,
    });
  }
  profile.children = children;
}

function resolveLaborStageHours(stage, fetusesCount, birthDifficulty) {
  const safeCount = Math.max(1, fetusesCount);
  const baseHours = LABOR_STAGE_BASE_HOURS[stage] || 0;
  const increment = LABOR_STAGE_INCREMENT[stage] || 0;
  return (baseHours + ((safeCount - 1) * increment)) * birthDifficulty;
}

function applyChildbirthInternal(profile, female, isNatural) {
  const pregnant = profile.pregnant || {};
  const base = profile.base || {};
  const notify = profile.notify || {};
  const experience = profile.experience || {};
  const runtime = profile.__runtimeRef || null;
  const remainingFetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses.map((item) => ({ ...item })) : [];
  if (remainingFetuses.length > 0) appendChildrenFromFetuses(profile, remainingFetuses);
  clearPregnancyState(profile);
  if (runtime) restorePregnancyPhysiology(profile, runtime);
  base.stage = '产后恢复';
  base.days = 1;
  experience.naturalBirthExperience = clampNumber(experience.naturalBirthExperience, 0, 999, 0) + (isNatural ? 1 : 0);
  experience.surgicalBirthExperience = clampNumber(experience.surgicalBirthExperience, 0, 999, 0) + (isNatural ? 0 : 1);
  profile.experience = experience;
  profile.notify = {
    ...notify,
    firstly: `${female}进入了产后恢复`,
    secondly: remainingFetuses.length > 0
      ? (isNatural
        ? `${female}自然分娩，生下了${remainingFetuses.length}个孩子`
        : `${female}通过手术分娩，生下了${remainingFetuses.length}个孩子`)
      : (isNatural
        ? `${female}完成了自然分娩，进入产后恢复`
        : `${female}完成了手术分娩，进入产后恢复`),
  };
  profile.base = base;
  return true;
}

function applyLaborAmnionWear(profile, female, options = {}) {
  const pregnant = profile.pregnant || {};
  const notify = profile.notify || {};
  const forceRupture = Boolean(options.forceRupture);
  const silent = Boolean(options.silent);
  const currentDurability = clampNumber(pregnant.amnionDurability, -100, 100, 0);

  if (forceRupture) {
    if (currentDurability > 0) pregnant.amnionDurability = 0;
    profile.pregnant = pregnant;
    return false;
  }

  const drainBase = Math.max(1, clampNumber(pregnant.fetalEnergyDrain, 0, 9999, 1));
  const multiplier = clampNumber(options.multiplier, 0.1, 10, 1);
  const nextDurability = currentDurability - (drainBase * multiplier);
  const ruptured = currentDurability > 0 && nextDurability <= 0;
  pregnant.amnionDurability = nextDurability;
  profile.pregnant = pregnant;

  if (ruptured && !silent) {
    profile.notify = {
      ...notify,
      secondly: `${female}破水了`,
    };
  }
  return ruptured;
}

function maybeStartLabor(profile, tick, female) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const cooldown = profile.cooldown || {};
  const stage = String(base.stage || '');
  if (!['临产期', '逾期'].includes(stage) || tick.passedHours <= 0) return false;
  if (cooldown.laborResistanceUsed) return false;

  const pressureCap = getUterinePressureCap(profile);
  const currentPressure = clampNumber(base.uterinePressure, 0, pressureCap, 0);
  if (currentPressure < pressureCap * 0.66) return false;

  base.stage = '产前阵痛';
  base.days = 1;
  pregnant.laborHours = 0;
  pregnant.effectiveLaborHours = 0;
  profile.notify = {
    ...(profile.notify || {}),
    firstly: `${female}进入了产前阵痛`,
    secondly: `${female}开始出现规律宫缩，分娩即将开始`,
  };
  return true;
}

function shouldKeepPregnancyPressureWarning(profile) {
  const base = profile?.base || {};
  const stage = String(base.stage || '');
  if (!isPregnancyStage(stage)) return false;
  const pressureCap = getUterinePressureCap(profile);
  const currentPressure = clampNumber(base.uterinePressure, 0, pressureCap, 0);
  return currentPressure >= (pressureCap * 0.5);
}

function applyPressureCrisis(profile, runtime, female) {
  const base = profile?.base || {};
  const pregnant = profile?.pregnant || {};
  const immune = profile?.immune || {};
  const experience = profile?.experience || {};
  const cooldown = profile?.cooldown || {};
  const stage = String(base.stage || '');
  if (!isPregnancyStage(stage)) return { changed: false, warned: false };

  const pressureCap = getUterinePressureCap(profile);
  const currentPressure = clampNumber(base.uterinePressure, 0, pressureCap, 0);
  const triggerThreshold = pressureCap * 0.5;
  if (currentPressure < triggerThreshold) return { changed: false, warned: false };

  const notify = profile.notify || {};
  if (!cooldown.pregnancyPressureWarning) {
    const warningText = (stage === '孕早期' || stage === '孕中期')
      ? `${female}子宫压力过高，有流产风险；若下次时间推进时仍未缓解，可能会真的流产`
      : `${female}子宫压力过高，有提前发动产程的风险；若下次时间推进时仍未缓解，可能会进入产前阵痛`;
    profile.cooldown = {
      ...cooldown,
      pregnancyPressureWarning: true,
    };
    profile.notify = {
      ...notify,
      secondly: warningText,
    };
    return { changed: false, warned: true };
  }

  if (stage === '孕早期' || stage === '孕中期') {
    if (immune.miscarriage) {
      profile.notify = {
        ...notify,
        secondly: `${female}的胚胎受到保护，流产无效，胚胎依旧留着`,
      };
      return { changed: false, warned: false };
    }

    clearPregnancyState(profile);
    restorePregnancyPhysiology(profile, runtime || {});
    base.stage = '产后恢复';
    base.days = 1;
    experience.miscarriageExperience = clampNumber(experience.miscarriageExperience, 0, 999, 0) + 1;
    profile.experience = experience;
    profile.notify = {
      ...notify,
      firstly: `${female}进入了产后恢复`,
      secondly: `${female}因子宫压力过高而流产了`,
    };
    return { changed: true, warned: false };
  }

  if ((stage === '孕晚期' || stage === '临产期') && immune.miscarriage) {
    profile.notify = {
      ...notify,
      secondly: `${female}的胎儿受到保护，早产被阻止了`,
    };
    return { changed: false, warned: false };
  }

  if ((stage === '孕晚期' || stage === '临产期' || stage === '逾期') && !cooldown.laborResistanceUsed) {
    base.stage = '产前阵痛';
    base.days = 1;
    pregnant.laborHours = 0;
    pregnant.effectiveLaborHours = 0;
    profile.pregnant = pregnant;
    profile.notify = {
      ...notify,
      firstly: `${female}进入了产前阵痛`,
      secondly: `${female}子宫压力达到临界值，开始出现规律宫缩`,
    };
    return { changed: true, warned: false };
  }

  return { changed: false, warned: false };
}

function processLabor(profile, tick, female) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const notify = profile.notify || {};
  const stage = String(base.stage || '');
  const rawHours = tick.deltaDays * 24;
  if (rawHours <= 0) return false;

  const pressureCap = getUterinePressureCap(profile);
  const currentPressure = clampNumber(base.uterinePressure, 0, pressureCap, 0);
  const libido = clampNumber(base.libido, 0, getLibidoCap(profile), 0);
  const libidoMultiplier = 1 + (libido / Math.max(getLibidoCap(profile), 1)) * 0.25;
  const baseEffectiveHours = rawHours * libidoMultiplier;
  let currentStageHours = clampNumber(pregnant.laborHours, 0, 9999, 0);
  let currentEffectiveHours = clampNumber(pregnant.effectiveLaborHours, 0, 9999, 0);

  if (stage === '产前阵痛') {
    currentStageHours += rawHours;
    currentEffectiveHours += baseEffectiveHours;
    pregnant.laborHours = currentStageHours;
    pregnant.effectiveLaborHours = currentEffectiveHours;
    applyLaborAmnionWear(profile, female, { multiplier: rawHours * 0.15, silent: true });
    const threshold = 6 * clampNumber(profile?.bio?.birthDifficulty, 0.1, 100, 1);
    if (pregnant.effectiveLaborHours >= threshold) {
      base.stage = '第一产程';
      base.days = 1;
      pregnant.laborHours = 0;
      pregnant.effectiveLaborHours = 0;
      profile.notify = {
        ...notify,
        firstly: `${female}进入了第一产程`,
        secondly: `${female}的宫缩进一步加剧，正式进入分娩`,
      };
      return true;
    }
    notify.secondly = `${female}的宫缩正在增强，产程尚未正式开始`;
    profile.notify = notify;
    return false;
  }

  if (!LABOR_STAGES.includes(stage)) return false;

  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  updateLaborFetalPositions(profile, tick);
  const birthDifficulty = clampNumber(profile?.bio?.birthDifficulty, 0.1, 100, 1);
  let threshold = resolveLaborStageHours(stage, Math.max(fetuses.length, 1), birthDifficulty);
  if (stage === '第二产程' && fetuses.length > 0) {
    const firstFetus = fetuses[0];
    const fetalAngle = Number.isFinite(Number(firstFetus?.tendencyAngle)) ? wrapAngle(firstFetus.tendencyAngle) : 0;
    const positionDifficulty = calculatePositionDifficulty(fetalAngle, firstFetus);
    const fetalWeight = clampNumber(firstFetus?.weight, 0.5, 2.0, 1.0);
    threshold = resolveLaborStageHours('第二产程', 1, birthDifficulty) * positionDifficulty * fetalWeight;
  }
  const stallThreshold = pressureCap * 0.66;
  const isThirdStageWithNoFetuses = stage === '第三产程' && fetuses.length === 0;

  currentStageHours += rawHours;
  pregnant.laborHours = currentStageHours;

  if (currentPressure < stallThreshold && !isThirdStageWithNoFetuses) {
    const currentRatio = pressureCap > 0 ? (currentPressure / pressureCap) : 0;
    const chanceToStall = Math.max(0, Math.min(1, 1 - currentRatio));
    if (Math.random() < chanceToStall) {
      profile.notify = {
        ...notify,
        secondly: `${female}的子宫收缩微弱，产程进展停滞`,
      };
      pregnant.effectiveLaborHours = currentEffectiveHours;
      return false;
    }
  } else if (currentPressure >= pressureCap) {
    if (stage === '第一产程') {
      currentEffectiveHours += threshold;
      pregnant.effectiveLaborHours = currentEffectiveHours;
      applyLaborAmnionWear(profile, female, { forceRupture: true, silent: true });
      let corrected = false;
      const firstOblique = fetuses.find((fetus) => isObliquePosition(fetus?.tendencyAngle || 0, fetus));
      if (firstOblique) {
        const currentAngle = Number.isFinite(Number(firstOblique?.tendencyAngle)) ? wrapAngle(firstOblique.tendencyAngle) : randomInt(0, 360);
        firstOblique.tendencyAngle = calculateNearestMainPosition(currentAngle);
        corrected = true;
      }
      base.uterinePressure = pressureCap * 0.5;
      if (hasObliqueFetus(fetuses)) {
        profile.notify = {
          ...notify,
          secondly: corrected
            ? `${female}宫缩暴增，胎位被强行扳正，但仍有斜位胎儿滞留在第一产程`
            : `${female}宫缩暴增，但仍有斜位胎儿滞留在第一产程`,
        };
        return false;
      }
      base.stage = '第二产程';
      base.days = 1;
      pregnant.laborHours = 0;
      pregnant.effectiveLaborHours = 0;
      profile.notify = {
        ...notify,
        firstly: `${female}进入了第二产程`,
        secondly: corrected ? `${female}宫口开全，胎位被迅速调整后进入第二产程` : `${female}宫口开全，产程突然加速`,
      };
      return true;
    }

    if (stage === '第二产程') {
      currentEffectiveHours += threshold;
      pregnant.effectiveLaborHours = currentEffectiveHours;
      applyLaborAmnionWear(profile, female, { forceRupture: true, silent: true });
      let father = '未知';
      let gender = '未知';
      if (fetuses.length > 0) {
        const baby = fetuses.shift();
        father = String(baby?.fathers || '未知');
        gender = String(baby?.gender || '未知');
        appendChildrenFromFetuses(profile, [baby]);
        pregnant.fetuses = fetuses;
        pregnant.fetusesCount = fetuses.length;
        updateFetalEnergyDrain(profile);
      }
      base.uterinePressure = pressureCap * 0.5;
      pregnant.laborHours = 0;
      pregnant.effectiveLaborHours = 0;
      if (fetuses.length === 0) {
        base.stage = '第三产程';
        base.days = 1;
        profile.notify = {
          ...notify,
          firstly: `${female}进入了第三产程`,
          secondly: `${female}产程突然加速，生下了${father}的孩子，性别为${gender}，正在娩出胎盘`,
        };
      } else {
        profile.notify = {
          ...notify,
          secondly: `${female}产程突然加速，生下了${father}的孩子，性别为${gender}，仍有${fetuses.length}胎待产`,
        };
      }
      return true;
    }

    if (stage === '第三产程') {
      currentEffectiveHours += threshold;
      pregnant.effectiveLaborHours = currentEffectiveHours;
      applyLaborAmnionWear(profile, female, { forceRupture: true, silent: true });
      return applyChildbirthInternal(profile, female, true);
    }
  }

  const pressureMultiplier = stage === '第三产程'
    ? 1
    : Math.max(0.5, Math.min(1.5, 0.5 + (currentPressure / 150)));
  const effectiveHoursGain = baseEffectiveHours * pressureMultiplier;
  currentEffectiveHours += effectiveHoursGain;
  pregnant.effectiveLaborHours = currentEffectiveHours;

  if (stage === '第一产程') {
    applyLaborAmnionWear(profile, female, { multiplier: rawHours * 0.35 });
  } else if (stage === '第二产程') {
    applyLaborAmnionWear(profile, female, { multiplier: rawHours * 0.75 });
  } else if (stage === '第三产程') {
    applyLaborAmnionWear(profile, female, { forceRupture: true, silent: true });
  }
  if (pregnant.effectiveLaborHours < threshold) {
    if (stage === '第二产程' && fetuses.length > 0) {
      const firstFetus = fetuses[0];
      const fetalAngle = Number.isFinite(Number(firstFetus?.tendencyAngle)) ? wrapAngle(firstFetus.tendencyAngle) : 0;
      const positionDifficulty = calculatePositionDifficulty(fetalAngle, firstFetus);
      const fetalWeight = clampNumber(firstFetus?.weight, 0.5, 2.0, 1.0);
      notify.secondly = `${female}正在娩出第1顺位胎儿，胚位${fetalAngle.toFixed(1)}°，难度${positionDifficulty.toFixed(2)}，胎重${fetalWeight.toFixed(2)}，进度${pregnant.effectiveLaborHours.toFixed(2)}/${threshold.toFixed(2)}小时`;
    } else {
      if (stage === '第一产程') {
        const obliqueCount = countObliqueFetuses(fetuses);
        notify.secondly = obliqueCount > 0
          ? `${female}的宫口正在逐渐扩张，仍有${obliqueCount}个斜位胎儿需要调整`
          : `${female}的宫口正在逐渐扩张`;
      } else {
        notify.secondly = `${female}正在娩出胎盘，进度${pregnant.effectiveLaborHours.toFixed(2)}/${threshold.toFixed(2)}小时`;
      }
    }
    profile.notify = notify;
    return false;
  }

  if (stage === '第一产程') {
    if (hasObliqueFetus(fetuses)) {
      pregnant.effectiveLaborHours = threshold;
      const obliqueCount = countObliqueFetuses(fetuses);
      profile.notify = {
        ...notify,
        secondly: `${female}仍有${obliqueCount}个斜位胎儿，尚未进入第二产程`,
      };
      return false;
    }
    base.stage = '第二产程';
    base.days = 1;
    pregnant.laborHours = 0;
    pregnant.effectiveLaborHours = 0;
    profile.notify = {
      ...notify,
      firstly: `${female}进入了第二产程`,
      secondly: `${female}宫口开全，开始娩出胎儿`,
    };
    return true;
  }

  if (stage === '第二产程') {
    if (fetuses.length > 0) {
      const baby = fetuses.shift();
      const father = String(baby?.fathers || '未知');
      const gender = String(baby?.gender || '未知');
      appendChildrenFromFetuses(profile, [baby]);
      pregnant.fetuses = fetuses;
      pregnant.fetusesCount = fetuses.length;
      updateFetalEnergyDrain(profile);
      pregnant.laborHours = 0;
      pregnant.effectiveLaborHours = 0;
      if (fetuses.length === 0) {
        base.stage = '第三产程';
        base.days = 1;
        profile.notify = {
          ...notify,
          firstly: `${female}进入了第三产程`,
          secondly: `${female}生下了${father}的孩子，性别为${gender}，正在娩出胎盘`,
        };
      } else {
        profile.notify = {
          ...notify,
          secondly: `${female}生下了${father}的孩子，性别为${gender}，仍有${fetuses.length}胎待产`,
        };
      }
      return true;
    }
    base.stage = '第三产程';
    base.days = 1;
    pregnant.laborHours = 0;
    pregnant.effectiveLaborHours = 0;
    return true;
  }

  if (stage === '第三产程') {
    return applyChildbirthInternal(profile, female, true);
  }

  return false;
}

function applyAbortion(chatState, args) {
  const female = String(args?.female || '').trim();
  const force = Boolean(args?.force);
  const fetusIndex = args?.fetusIndex;
  const character = chatState.characters?.[female];
  if (!female || !character) {
    return { applied: false, message: `bsAbortion skipped: unknown character ${female || '(empty)'}.` };
  }

  const next = cloneValue(character);
  const profile = next.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const notify = profile.notify || {};
  const experience = profile.experience || {};
  const immune = profile.immune || {};
  const stage = String(base.stage || '');
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses.map((item) => ({ ...item })) : [];
  const hasConceptionState = fetuses.length > 0 || clampNumber(base.fertilizationDays, 0, 9999, 0) > 0 || isPregnancyStage(stage);

  if (!hasConceptionState) {
    return { applied: false, message: `bsAbortion skipped for ${female}: no conception state.` };
  }

  if (immune.miscarriage && !force) {
    profile.notify = {
      ...notify,
      secondly: `${female}的胚胎受到保护，流产无效，胚胎依旧留着`,
    };
    next.profile = profile;
    chatState.characters[female] = next;
    return { applied: false, message: `bsAbortion skipped for ${female}: miscarriage immune.` };
  }

  if (fetusIndex !== undefined && (!Number.isInteger(fetusIndex) || fetusIndex < 0 || fetusIndex >= fetuses.length)) {
    return { applied: false, message: `bsAbortion skipped for ${female}: invalid fetusIndex.` };
  }

  if (Number.isInteger(fetusIndex) && fetusIndex >= 0 && fetusIndex < fetuses.length) {
    const removedFetus = fetuses.splice(fetusIndex, 1)[0];
    pregnant.fetuses = fetuses;
    pregnant.fetusesCount = fetuses.length;
    profile.pregnant = pregnant;
    updateFetalEnergyDrain(profile);
    if (fetuses.length > 0) applyPregnancyPhysiology(profile, next.runtime || {});
    if (fetuses.length > 0) {
      const gender = String(removedFetus?.gender || '未知');
      const race = String(removedFetus?.race || '未知');
      profile.notify = {
        ...notify,
        secondly: `${female}的第${fetusIndex + 1}胎（${gender}，${race}）消失了`,
      };
      next.profile = profile;
      chatState.characters[female] = next;
      return { applied: true, message: `bsAbortion reduced fetus count for ${female}.` };
    }
  }

  clearPregnancyState(profile);
  restorePregnancyPhysiology(profile, next.runtime || {});

  if (MENSTRUAL_STAGES.includes(stage)) {
    base.stage = '卵泡期';
    base.days = 1;
    profile.notify = {
      ...notify,
      firstly: `${female}进入了卵泡期`,
      secondly: `${female}避孕成功`,
    };
  } else {
    base.stage = '产后恢复';
    base.days = 1;
    experience.miscarriageExperience = clampNumber(experience.miscarriageExperience, 0, 999, 0) + 1;
    profile.experience = experience;
    profile.notify = {
      ...notify,
      firstly: `${female}进入了产后恢复`,
      secondly: `${female}流产了`,
    };
  }

  next.profile = profile;
  chatState.characters[female] = syncCharacterStageFromProfile(next);
  return { applied: true, message: `bsAbortion applied to ${female}.` };
}

function applyChildbirth(chatState, args) {
  const female = String(args?.female || '').trim();
  const character = chatState.characters?.[female];
  if (!female || !character) {
    return { applied: false, message: `bsChildbirth skipped: unknown character ${female || '(empty)'}.` };
  }

  const next = cloneValue(character);
  const profile = next.profile || {};
  const fetuses = Array.isArray(profile?.pregnant?.fetuses) ? profile.pregnant.fetuses : [];
  if (fetuses.length === 0) {
    return { applied: false, message: `bsChildbirth skipped for ${female}: no fetuses.` };
  }

  profile.__runtimeRef = next.runtime || {};
  applyChildbirthInternal(profile, female, false);
  delete profile.__runtimeRef;
  next.profile = profile;
  chatState.characters[female] = syncCharacterStageFromProfile(next);
  return { applied: true, message: `bsChildbirth applied to ${female}.` };
}

function applyLaborResistance(profile, female) {
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const notify = profile.notify || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  if (String(base.stage || '') !== '产前阵痛') {
    profile.notify = {
      ...notify,
      secondly: `${female}不在产前阵痛阶段，无法执行抵抗判定`,
    };
    return { applied: false, message: `bsMaternalFetalInteraction skipped for ${female}: not in labor warning stage.` };
  }

  const vitality = clampNumber(base.vitality, 0, 9999, 100);
  const uterinePressure = clampNumber(base.uterinePressure, 0, 9999, 0);
  const fetalEnergyDrain = clampNumber(pregnant.fetalEnergyDrain, 0, 9999, 0);
  const birthDifficulty = clampNumber(profile?.bio?.birthDifficulty, 0.1, 100, 1);
  const breedTolerance = clampNumber(profile?.bio?.breedTolerance, 0.1, 100, 1);
  const judgeCount = Math.max(1, Math.round(fetalEnergyDrain + birthDifficulty - breedTolerance));
  let failedRound = -1;

  for (let round = 0; round < judgeCount; round += 1) {
    const threshold = randomInt(0, Math.max(0, Math.floor(uterinePressure)));
    const passed = vitality > threshold;

    if (fetuses.length > 0) {
      const randomFetusIndex = randomInt(0, fetuses.length - 1);
      const fetus = fetuses[randomFetusIndex];
      const currentAngle = Number.isFinite(Number(fetus?.tendencyAngle))
        ? Number(fetus.tendencyAngle)
        : randomInt(0, 360);
      fetus.tendencyAngle = wrapAngle(currentAngle + randomInt(-90, 90));
    }

    if (clampNumber(pregnant.amnionDurability, 0, 100, 100) > 0) {
      const drain = Math.max(1, fetalEnergyDrain || 1);
      pregnant.amnionDurability = Math.max(1, clampNumber(pregnant.amnionDurability, 0, 100, 100) - drain);
    }

    if (!passed) {
      failedRound = round + 1;
      break;
    }
  }

  pregnant.fetuses = fetuses;
  profile.pregnant = pregnant;

  if (failedRound === -1) {
    const adjustedDays = clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0);
    let targetStage = '孕晚期';
    if (adjustedDays >= 280) {
      targetStage = '逾期';
    } else if (adjustedDays >= 252) {
      targetStage = '临产期';
    }

    const reducedPressure = Math.floor(uterinePressure * 0.25);
    base.stage = targetStage;
    base.days = 1;
    base.uterinePressure = reducedPressure;
    pregnant.laborHours = 0;
    pregnant.effectiveLaborHours = 0;
    profile.cooldown = {
      ...(profile.cooldown || {}),
      laborResistanceUsed: true,
    };
    profile.notify = {
      ...notify,
      firstly: `${female}进入了${targetStage}`,
      secondly: `${female}通过了${judgeCount}次抵抗判定，成功延缓分娩，回到${targetStage}`,
    };
    return { applied: true, message: `bsMaternalFetalInteraction applied to ${female}: labor resisted.` };
  }

  base.stage = '第一产程';
  base.days = 1;
  pregnant.laborHours = 0;
  pregnant.effectiveLaborHours = 0;
  profile.notify = {
    ...notify,
    firstly: `${female}进入了第一产程`,
    secondly: `${female}在第${failedRound}/${judgeCount}次判定中失败，无法抵抗，进入分娩`,
  };
  return { applied: true, message: `bsMaternalFetalInteraction applied to ${female}: labor resistance failed.` };
}

function applyMaternalFetalInteraction(chatState, args) {
  const female = String(args?.female || '').trim();
  const change = String(args?.change || 'slight_increase').trim();
  const direction = String(args?.direction || 'fetal').trim();
  const character = chatState.characters?.[female];
  if (!female || !character) {
    return { applied: false, message: `bsMaternalFetalInteraction skipped: unknown character ${female || '(empty)'}.` };
  }

  const changeMap = Object.freeze({
    slight_increase: 0.5,
    significant_increase: 1,
    slight_decrease: -0.5,
    significant_decrease: -1,
  });
  const changeDisplayMap = Object.freeze({
    slight_increase: '轻微增加',
    significant_increase: '显著增加',
    slight_decrease: '轻微减少',
    significant_decrease: '显著减少',
  });
  const actualDirection = direction === 'maternal' ? 'maternal' : 'fetal';
  const changeValue = changeMap[change];
  if (changeValue === undefined) {
    return { applied: false, message: `bsMaternalFetalInteraction skipped: invalid change ${change}.` };
  }

  const next = cloneValue(character);
  const profile = next.profile || {};
  const stage = String(profile?.base?.stage || '');
  if (direction === 'maternal' && stage === '产前阵痛') {
    const result = applyLaborResistance(profile, female);
    next.profile = profile;
    chatState.characters[female] = syncCharacterStageFromProfile(next);
    return result;
  }

  const pregnant = profile.pregnant || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  if (fetuses.length === 0) {
    return { applied: false, message: `bsMaternalFetalInteraction skipped for ${female}: no fetuses.` };
  }

  const selectedIndex = randomInt(0, fetuses.length - 1);
  const selectedFetus = fetuses[selectedIndex];

  let success = true;
  let appliedChange = changeValue;
  let rotated = false;
  if (actualDirection === 'maternal') {
    const psyStress = clampNumber(profile?.base?.psyStress, 0, 9999, 0);
    const failureChance = Math.min(1, psyStress / 200);
    success = Math.random() >= failureChance;
    if (!success) {
      appliedChange = 0;
      const currentAngle = Number.isFinite(Number(selectedFetus?.tendencyAngle))
        ? Number(selectedFetus.tendencyAngle)
        : randomInt(0, 360);
      selectedFetus.tendencyAngle = wrapAngle(currentAngle + randomInt(-10, 10));
      rotated = true;
    }
  }

  const currentAffinity = clampNumber(selectedFetus?.affinity, -50, 50, 0);
  selectedFetus.affinity = clampNumber(currentAffinity + appliedChange, -50, 50, 0);

  pregnant.fetuses = fetuses;
  pregnant.fetusesCount = fetuses.length;
  profile.pregnant = pregnant;

  const notify = profile.notify || {};
  const changeDisplay = changeDisplayMap[change];
  const targetName = `第${selectedIndex + 1}胎`;
  if (actualDirection === 'fetal') {
    notify.secondly = `${targetName}对${female}的亲密度${changeDisplay}了`;
  } else if (success) {
    notify.secondly = `${female}对${targetName}的亲密度${changeDisplay}了`;
  } else if (rotated) {
    notify.secondly = `${female}尝试与${targetName}建立联系，但因心理压力过大而失败，${targetName}的胚位角度发生了微小转动`;
  } else {
    notify.secondly = `${female}尝试与${targetName}建立联系，但因心理压力过大而失败`;
  }
  profile.notify = notify;

  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsMaternalFetalInteraction applied to ${female}.` };
}

function applyEggGain(profile, amount) {
  const nextAmount = Math.max(0, Number(amount) || 0);
  if (nextAmount <= 0) return { applied: false, usedCooldown: false };

  const base = profile.base || {};
  const cooldown = profile.cooldown || {};
  const stage = String(base.stage || '');

  if (stage === '假孕期') {
    return { applied: false, usedCooldown: false };
  }

  if (stage === '排卵期') {
    base.eggs = clampNumber(base.eggs, 0, 999, 0) + nextAmount;
    base.uterinePressure = clampNumber(base.uterinePressure, 0, 999, 0) + 2;
    return { applied: true, usedCooldown: false };
  }

  if (cooldown.orgasmOvulationUsed) {
    return { applied: false, usedCooldown: true };
  }

  base.eggs = clampNumber(base.eggs, 0, 999, 0) + nextAmount;
  base.uterinePressure = clampNumber(base.uterinePressure, 0, 999, 0) + 2;
  return { applied: true, usedCooldown: true };
}

function maybeTriggerOrgasmOvulation(character) {
  const next = character;
  const profile = next.profile || {};
  const cooldown = profile.cooldown || {};
  const bio = profile.bio || {};
  const base = profile.base || {};
  const notify = profile.notify || {};

  const currentLibido = clampNumber(base.libido, 0, 9999, 0);
  const libidoCap = getLibidoCap(profile);
  if (currentLibido < libidoCap || cooldown.orgasmOvulationUsed) return false;

  const amount = Math.max(0, clampNumber(bio.orgasmOvulationAmount, 0, 100, 1));
  const eggResult = applyEggGain(profile, amount);
  if (!eggResult.applied) return false;
  base.libido = 0;
  profile.cooldown = {
    ...cooldown,
    orgasmOvulationUsed: eggResult.usedCooldown ? true : Boolean(cooldown.orgasmOvulationUsed),
  };
  profile.notify = {
    ...notify,
    secondly: `${next.name}因高潮而额外排卵，性欲归零`,
  };
  return true;
}

function getMenstrualCycleLength(profile) {
  const ratio = clampNumber(profile?.bio?.menstrualLengthRatio, 0.1, 20, 1);
  return Math.max(1, Math.round(28 * ratio));
}

function buildTimeTick(character, addedMinutes) {
  const runtime = character?.runtime || {};
  const dayCarryMinutes = clampNumber(runtime.dayCarryMinutes, 0, 24 * 60, 0);
  const hourCarryMinutes = clampNumber(runtime.hourCarryMinutes, 0, 60, 0);
  const totalDayMinutes = dayCarryMinutes + addedMinutes;
  const totalHourMinutes = hourCarryMinutes + addedMinutes;
  return {
    deltaMinutes: addedMinutes,
    deltaDays: addedMinutes / (24 * 60),
    passedDays: Math.floor(totalDayMinutes / (24 * 60)),
    passedHours: Math.floor(totalHourMinutes / 60),
    nextRuntime: {
      dayCarryMinutes: totalDayMinutes % (24 * 60),
      hourCarryMinutes: totalHourMinutes % 60,
    },
  };
}

function getMenstrualStageFluctuation(profile, stage) {
  if (!MENSTRUAL_STAGE_DAYS[stage]) return 0;

  const base = profile?.base || {};
  const vitalityLevel = clampNumber(base.vitalityLevel, 1, 7, 4);
  const psyStressLevel = clampNumber(base.psyStressLevel, 1, 7, 4);

  let maxFluctuationRatio = 0;
  if (vitalityLevel === 2) maxFluctuationRatio += 0.08;
  if (vitalityLevel === 1) maxFluctuationRatio += 0.15;
  if (psyStressLevel === 6) maxFluctuationRatio += 0.08;
  if (psyStressLevel === 7) maxFluctuationRatio += 0.15;
  if (maxFluctuationRatio <= 0) return 0;

  const seedText = `${stage}:${vitalityLevel}:${psyStressLevel}`;
  let seed = 0;
  for (const char of seedText) seed += char.charCodeAt(0);
  const normalized = ((seed % 1001) / 1000) * 2 - 1;
  return normalized * maxFluctuationRatio;
}

function getStageLimit(profile, stage) {
  if (MENSTRUAL_STAGE_DAYS[stage]) {
    const ratio = clampNumber(profile?.bio?.menstrualLengthRatio, 0.1, 20, 1);
    const fluctuation = getMenstrualStageFluctuation(profile, stage);
    return Math.max(1, MENSTRUAL_STAGE_DAYS[stage] * ratio * (1 + fluctuation));
  }
  if (stage === '产后恢复') return Math.max(1, clampNumber(profile?.bio?.recoveryDays, 1, 9999, 56));
  return null;
}

function advanceMenstrualStage(profile, stage, daysValue) {
  let nextStage = stage;
  let nextDays = daysValue;
  let changed = false;
  while (MENSTRUAL_STAGES.includes(nextStage)) {
    const limit = getStageLimit(profile, nextStage);
    if (limit === null || nextDays < limit) break;
    nextDays -= limit;
    const stageIndex = MENSTRUAL_STAGES.indexOf(nextStage);
    nextStage = MENSTRUAL_STAGES[(stageIndex + 1) % MENSTRUAL_STAGES.length];
    changed = true;
  }
  return {
    stage: nextStage,
    days: Math.max(1, nextDays + (changed ? 1 : 0)),
    changed,
  };
}

function shouldEnterPseudoPregnancy(profile, previousStage, nextStage) {
  if (previousStage === '月经期' || nextStage !== '月经期') return false;
  const base = profile?.base || {};
  const experience = profile?.experience || {};
  const psyStress = clampNumber(base.psyStress, 0, 9999, 0);
  const libido = clampNumber(base.libido, 0, 9999, 0);
  const latestSexPartner = String(experience.latestSexPartner || '').trim();
  return psyStress >= 100 && libido >= 50 && latestSexPartner.length > 0;
}

function applyTimeToCharacter(character, tick) {
  const next = cloneValue(character);
  snapshotOriginalPregnancyBio(next);
  const profile = next.profile || {};
  profile.__runtimeRef = next.runtime || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const bio = profile.bio || {};
  const notify = {
    firstly: '',
    secondly: '',
    thirdly: '',
  };
  profile.notify = notify;
  const cooldown = profile.cooldown || {};
  const deltaDays = tick.deltaDays;
  const isHere = base.isHere !== false;

  let stage = String(base.stage || '');
  let days = clampNumber(base.days, 1, 9999, 1);
  let stageChanged = false;
  const oldStage = stage;

  if (deltaDays <= 0) return { character: next, stageChanged: false, oldStage, newStage: stage };

  processSimpleConception(profile, tick, notify, next.name);
  stage = String(base.stage || stage);
  if (Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0 && isPregnancyStage(stage)) {
    applyPregnancyPhysiology(profile, next.runtime || {});
  }

  if (MENSTRUAL_STAGES.includes(stage)) {
    const advanced = advanceMenstrualStage(profile, stage, days + deltaDays);
    stage = advanced.stage;
    days = advanced.days;
    stageChanged = advanced.changed;
    if (stageChanged && shouldEnterPseudoPregnancy(profile, oldStage, stage)) {
      stage = '假孕期';
      days = 1;
      pregnant.pregnantDays = 0;
      pregnant.effectivePregnantDays = 0;
      notify.secondly = `${next.name}因进入月经期时心理压力偏高、性欲偏高且近期有性接触记录，出现了假孕症状`;
    }
  } else if (PREGNANCY_STAGES.includes(stage)) {
    pregnant.pregnantDays = clampNumber(pregnant.pregnantDays, 0, 9999, 0) + deltaDays;
    pregnant.effectivePregnantDays = clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0) + (deltaDays * clampNumber(getGestationEffectiveSpeed({ ...profile, bio }), 0, 20, 1));
    updateDerivedTypeProgress(profile, tick);
    const derived = derivePregnancyStageState(pregnant.effectivePregnantDays, 1);
    stage = derived.stage;
    days = derived.days;
    stageChanged = stage !== oldStage;
    base.stage = stage;
    base.days = days;
    updateFetalPositions(profile, tick, next.name);
    if (isHere) {
      applyOverduePressure(profile, tick, next.name);
      applyHourlyPregnancyMetabolism(profile, tick);
    }
    const pressureCrisis = isHere ? applyPressureCrisis(profile, next.runtime || {}, next.name) : { changed: false, warned: false };
    if (pressureCrisis.changed) {
      stage = String(base.stage || stage);
      days = clampNumber(base.days, 1, 9999, 1);
      stageChanged = true;
    }
    if (isHere && !pressureCrisis.warned && maybeStartLabor(profile, tick, next.name)) {
      stage = String(base.stage || stage);
      days = clampNumber(base.days, 1, 9999, 1);
      stageChanged = true;
    }
  } else if (stage === '产后恢复') {
    days += deltaDays;
    const recoveryDays = getStageLimit(profile, '产后恢复');
    if (days >= recoveryDays) {
      stage = '卵泡期';
      days = 1;
      stageChanged = true;
      pregnant.pregnantDays = 0;
      pregnant.effectivePregnantDays = 0;
      pregnant.laborHours = 0;
      pregnant.effectiveLaborHours = 0;
      pregnant.fetuses = [];
      pregnant.fetusesCount = 0;
      pregnant.fetalEnergyDrain = 0;
      base.fertilizationDays = 0;
    }
  } else if (stage === '假孕期') {
    pregnant.pregnantDays = clampNumber(pregnant.pregnantDays, 0, 9999, 0) + deltaDays;
    const pseudoLimit = Math.max(1, 84 * clampNumber(getGestationEffectiveSpeed({ ...profile, bio }), 0.1, 20, 1));
    if (pregnant.pregnantDays >= pseudoLimit) {
      stage = '月经期';
      days = 1;
      stageChanged = true;
      pregnant.pregnantDays = 0;
      pregnant.effectivePregnantDays = 0;
    }
  } else if (stage === '产前阵痛' || LABOR_STAGES.includes(stage)) {
    if (isHere) applyHourlyPregnancyMetabolism(profile, tick);
    updateDerivedTypeProgress(profile, tick);
    const laborChanged = processLabor(profile, tick, next.name);
    stage = String(base.stage || stage);
    days = clampNumber(base.days, 1, 9999, 1);
    stageChanged = stageChanged || laborChanged || stage !== oldStage;
  } else if (stage === '无经期' || stage === '未激活') {
    days += deltaDays;
    } else {
      days += deltaDays;
    }

  processSpermLifecycle(profile, stage, tick);

  if (base.latestSexDays !== null && base.latestSexDays !== undefined && Number(base.latestSexDays) >= 0) {
    base.latestSexDays = clampNumber(base.latestSexDays, -1, 9999, 0) + tick.passedDays;
    if (base.latestSexDays >= getMenstrualCycleLength(profile)) {
      base.latestSexDays = -1;
      profile.experience = {
        ...(profile.experience || {}),
        latestSexPartner: null,
      };
    }
  }

  applyNaturalMetabolismRecovery(profile, tick);

  base.age = clampNumber(base.age, 0, 99999, 15) + (deltaDays / 365);
  if (Array.isArray(profile.children) && profile.children.length > 0) {
    profile.children = profile.children.map((child) => ({
      ...child,
      age: child?.age === null || child?.age === undefined ? child?.age : clampNumber(child.age, 0, 99999, 0) + (deltaDays / 365),
    }));
  }

  if (Array.isArray(pregnant.fetuses) && pregnant.fetuses.length > 0 && clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0) > 0 && !isPregnancyStage(stage)) {
    const derived = derivePregnancyStageState(pregnant.effectivePregnantDays, 1);
    stage = derived.stage;
    days = derived.days;
    stageChanged = stage !== oldStage;
  }

  if ((!Array.isArray(pregnant.fetuses) || pregnant.fetuses.length === 0) && !isPregnancyStage(stage)) {
    restorePregnancyPhysiology(profile, next.runtime || {});
  }

  clearPsychologyTransitionState(profile, stage, days);

  profile.base = {
    ...base,
    stage,
    days,
  };
  profile.pregnant = {
    ...pregnant,
    fetusesCount: Array.isArray(pregnant.fetuses) ? pregnant.fetuses.length : clampNumber(pregnant.fetusesCount, 0, 99, 0),
  };
  const currentNotify = profile.notify || notify;
  profile.notify = {
    ...currentNotify,
    firstly: stageChanged ? `${next.name}进入了${stage}` : currentNotify.firstly || '',
  };
  profile.cooldown = {
    ...cooldown,
    orgasmOvulationUsed: shouldResetOrgasmOvulation(stage) ? false : Boolean(cooldown.orgasmOvulationUsed),
    laborResistanceUsed: tick.passedDays > 0 ? false : Boolean(cooldown.laborResistanceUsed),
    pregnancyPressureWarning: shouldKeepPregnancyPressureWarning(profile) ? Boolean((profile.cooldown || cooldown).pregnancyPressureWarning) : false,
  };
  updateAdvisoryNotify(profile, next.name);
  delete profile.__runtimeRef;
  next.profile = profile;
  next.runtime = {
    ...(next.runtime || {}),
    ...tick.nextRuntime,
  };
  return {
    character: syncCharacterStageFromProfile(next),
    stageChanged,
    oldStage,
    newStage: stage,
  };
}

function applyPassedTime(chatState, args) {
  const minute = clampNumber(args?.minute, 0, 60 * 24 * 365, 0);
  const hour = clampNumber(args?.hour, 0, 24 * 365, 0);
  const day = clampNumber(args?.day, 0, 36500, 0);
  const week = clampNumber(args?.week, 0, 5200, 0);
  const month = clampNumber(args?.month, 0, 1200, 0);
  const year = clampNumber(args?.year, 0, 200, 0);
  const totalMinutes = minute + (hour * 60) + (day * 24 * 60) + (week * 7 * 24 * 60) + (month * 30 * 24 * 60) + (year * 365 * 24 * 60);
  if (totalMinutes <= 0) return { applied: false, message: 'bsPassedTime skipped: no positive duration.' };

  for (const name of Object.keys(chatState.characters || {})) {
    const current = chatState.characters[name];
    if (!current || typeof current !== 'object') continue;
    const tick = buildTimeTick(current, totalMinutes);
    const result = applyTimeToCharacter(current, tick);
    chatState.characters[name] = result.character;
  }
  chatState.minutesPassed = Math.round(totalMinutes);
  return { applied: true, message: `bsPassedTime applied ${chatState.minutesPassed} minutes.` };
}

function applyCharacterStatus(chatState, args) {
  const female = String(args?.female || '').trim();
  const options = args?.options && typeof args.options === 'object' ? args.options : {};
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsUpdateCharacterStatus skipped: unknown character ${female || '(empty)'}.` };

  const next = cloneValue(character);
  const base = next.profile?.base || {};
  const profile = next.profile || {};
  const vitalityCap = getVitalityInitByLevel(base.vitalityLevel);
  const stressCap = getPsyStressInitByLevel(base.psyStressLevel) * 2;
  const libidoCap = getLibidoCap(profile);
  const uterinePressureCap = getUterinePressureCap(profile);

  if (options.vitality !== undefined) {
    base.vitality = clampNumber((base.vitality || 0) + Number(options.vitality || 0), 0, vitalityCap, base.vitality || 0);
    applyMetabolismFromVitality(profile, Number(options.vitality || 0));
  }
  if (options.psyStress !== undefined) base.psyStress = clampNumber((base.psyStress || 0) + Number(options.psyStress || 0), 0, stressCap, base.psyStress || 0);
  if (options.libido !== undefined) base.libido = clampNumber((base.libido || 0) + Number(options.libido || 0), 0, libidoCap, base.libido || 0);
  if (options.uterinePressure !== undefined) {
    base.uterinePressure = clampNumber((base.uterinePressure || 0) + Number(options.uterinePressure || 0), 0, uterinePressureCap, base.uterinePressure || 0);
    applyAmnionDurabilityFromPressure(profile, base.uterinePressure, female);
  }

  next.profile.base = base;
  maybeTriggerOrgasmOvulation(next);
  chatState.characters[female] = next;
  return { applied: true, message: `bsUpdateCharacterStatus applied to ${female}.` };
}

function applyDescription(chatState, args) {
  const female = String(args?.female || '').trim();
  const options = args?.options && typeof args.options === 'object' ? args.options : {};
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsSetDescription skipped: unknown character ${female || '(empty)'}.` };

  const next = cloneValue(character);
  next.profile.descriptions = {
    ...(next.profile?.descriptions || {}),
  };
  for (const key of ['normalDescription', 'closeupDescription', 'pregnantDescription']) {
    if (options[key] !== undefined) next.profile.descriptions[key] = String(options[key] || '');
  }
  chatState.characters[female] = next;
  return { applied: true, message: `bsSetDescription applied to ${female}.` };
}

function applySetCharacterPresence(chatState, args) {
  const female = String(args?.female || '').trim();
  const character = chatState.characters?.[female];
  const isPresent = args?.isPresent === undefined ? true : Boolean(args.isPresent);
  if (!female || !character) return { applied: false, message: `bsSetCharacterPresence skipped: unknown character ${female || '(empty)'}.` };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const base = profile.base || {};
  base.isHere = isPresent;
  profile.base = base;
  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsSetCharacterPresence applied to ${female}: isHere=${isPresent}.` };
}

function applyUpdateExperience(chatState, args) {
  const female = String(args?.female || '').trim();
  const character = chatState.characters?.[female];
  const options = args?.options && typeof args.options === 'object' ? args.options : null;
  if (!female || !character) return { applied: false, message: `bsUpdateExperience skipped: unknown character ${female || '(empty)'}.` };
  if (!options) return { applied: false, message: 'bsUpdateExperience skipped: empty options.' };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const experience = profile.experience || {};
  const allowedStringFields = ['virginity', 'latestSexPartner', 'emotionalMate', 'marriageMate'];
  const allowedNumberFields = ['pregnantExperience', 'naturalBirthExperience', 'surgicalBirthExperience', 'miscarriageExperience'];

  let changed = false;
  for (const field of allowedStringFields) {
    if (options[field] === undefined) continue;
    experience[field] = options[field] === null ? null : String(options[field]);
    changed = true;
  }
  for (const field of allowedNumberFields) {
    if (options[field] === undefined) continue;
    experience[field] = clampNumber(options[field], 0, 9999, experience[field] || 0);
    changed = true;
  }

  if (!changed) return { applied: false, message: `bsUpdateExperience skipped for ${female}: no allowed fields.` };

  profile.experience = experience;
  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsUpdateExperience applied to ${female}.` };
}

function applyNameChild(chatState, args) {
  const female = String(args?.female || '').trim();
  const childIndex = Number(args?.childIndex);
  const childName = String(args?.name || '').trim();
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsNameChild skipped: unknown character ${female || '(empty)'}.` };
  if (!Number.isInteger(childIndex)) return { applied: false, message: 'bsNameChild skipped: invalid childIndex.' };
  if (!childName) return { applied: false, message: 'bsNameChild skipped: empty name.' };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const children = Array.isArray(profile.children) ? profile.children.map((item) => ({ ...item })) : [];
  if (childIndex < 0 || childIndex >= children.length) {
    return { applied: false, message: `bsNameChild skipped for ${female}: childIndex ${childIndex} out of range.` };
  }

  children[childIndex].name = childName;
  profile.children = children;
  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsNameChild applied to ${female}: child ${childIndex} named ${childName}.` };
}

function applyUpdatePsychology(chatState, args) {
  const female = String(args?.female || '').trim();
  const character = chatState.characters?.[female];
  const options = args?.options && typeof args.options === 'object' ? args.options : null;
  if (!female || !character) return { applied: false, message: `bsUpdatePsychology skipped: unknown character ${female || '(empty)'}.` };
  if (!options) return { applied: false, message: 'bsUpdatePsychology skipped: empty options.' };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const psychology = profile.psychology || {};
  const base = profile.base || {};
  const stage = String(base.stage || '');
  const isPregnancySide = PREGNANCY_STAGES.includes(stage) || stage === '假孕期' || stage === '产前阵痛' || LABOR_STAGES.includes(stage);

  const targetGroup = isPregnancySide ? 'preg' : 'mens';
  const sourcePatch = options[targetGroup];
  if (!sourcePatch || typeof sourcePatch !== 'object') {
    return { applied: false, message: `bsUpdatePsychology skipped for ${female}: current stage expects ${targetGroup} updates.` };
  }

  const fieldConfig = targetGroup === 'preg' ? PSY_PREG_FIELDS : PSY_MENS_FIELDS;
  const boolFieldConfig = targetGroup === 'preg' ? PSY_PREG_BOOL_FIELDS : PSY_MENS_BOOL_FIELDS;
  const target = normalizePsychologyGroup(psychology[targetGroup], fieldConfig, { booleanFields: boolFieldConfig });
  const allowedFields = Object.keys(fieldConfig);
  const allowedBoolFields = Object.keys(boolFieldConfig);

  let changed = false;
  for (const field of allowedFields) {
    if (sourcePatch[field] === undefined) continue;
    const valueKey = `${field}_value`;
    const currentValue = target[valueKey] === null || target[valueKey] === undefined ? 0 : clampNumber(target[valueKey], 0, 100, 0);
    target[valueKey] = clampNumber(currentValue + Number(sourcePatch[field] || 0), 0, 100, currentValue);
    changed = true;
  }
  for (const field of allowedBoolFields) {
    if (sourcePatch[field] === undefined) continue;
    target[field] = Boolean(sourcePatch[field]);
    changed = true;
  }

  if (!changed) {
    return { applied: false, message: `bsUpdatePsychology skipped for ${female}: no allowed ${targetGroup} fields.` };
  }

  const normalizedTarget = normalizePsychologyGroup(target, fieldConfig, { booleanFields: boolFieldConfig });
  profile.psychology = {
    ...(profile.psychology || {}),
    mens: targetGroup === 'mens'
      ? normalizedTarget
      : normalizePsychologyGroup(profile.psychology?.mens, PSY_MENS_FIELDS, { booleanFields: PSY_MENS_BOOL_FIELDS }),
    preg: targetGroup === 'preg'
      ? normalizedTarget
      : normalizePsychologyGroup(profile.psychology?.preg, PSY_PREG_FIELDS, { booleanFields: PSY_PREG_BOOL_FIELDS }),
  };
  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsUpdatePsychology applied to ${female}.` };
}

function applyAddSperm(chatState, args) {
  const female = String(args?.female || '').trim();
  const male = String(args?.male || '').trim();
  const parsedRace = parseRaceDescriptor(args?.race || '人类');
  const race = parsedRace.race || '人类';
  const amount = Number(args?.amount || 0);
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsAddSperm skipped: unknown character ${female || '(empty)'}.` };
  if (!male) return { applied: false, message: 'bsAddSperm skipped: empty male.' };
  if (!Number.isFinite(amount) || amount === 0) return { applied: false, message: 'bsAddSperm skipped: invalid amount.' };

  const next = cloneValue(character);
  const base = next.profile?.base || {};
  const sperms = Array.isArray(base.sperms) ? base.sperms.map((item) => ({ ...item })) : [];
  const maleDerivedType = chatState.characters?.[male]?.profile?.base?.derivedType ?? null;
  const existing = sperms.find((item) => String(item?.male || '') === male);
  if (existing) {
    existing.value = Math.max(0, clampNumber(existing.value, 0, 999999, 0) + amount);
    existing.race = race;
    existing.derivedType = maleDerivedType;
  } else if (amount > 0) {
    sperms.push({ male, race, derivedType: maleDerivedType, value: amount });
  }
  base.sperms = sperms.filter((item) => clampNumber(item?.value, 0, 999999, 0) > 0);
  base.latestSexDays = 0;
  next.profile.base = base;
  const experience = {
    ...(next.profile?.experience || {}),
    latestSexPartner: male,
  };
  if (experience.virginity === null || experience.virginity === undefined) {
    experience.virginity = male;
  }
  next.profile.experience = experience;
  chatState.characters[female] = next;
  return { applied: true, message: `bsAddSperm applied to ${female}.` };
}

function applyDrainSperm(chatState, args) {
  const female = String(args?.female || '').trim();
  const amount = Number(args?.amount || 0);
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsDrainSperm skipped: unknown character ${female || '(empty)'}.` };
  if (!Number.isFinite(amount) || amount <= 0) return { applied: false, message: 'bsDrainSperm skipped: invalid amount.' };

  const next = cloneValue(character);
  const base = next.profile?.base || {};
  let sperms = Array.isArray(base.sperms) ? base.sperms.map((item) => ({ ...item })) : [];
  const total = sperms.reduce((sum, item) => sum + clampNumber(item?.value, 0, 999999, 0), 0);

  if (total <= amount) {
    base.sperms = [];
    next.profile.base = base;
    chatState.characters[female] = next;
    return { applied: true, message: `bsDrainSperm cleared all sperm for ${female}.` };
  }

  const factor = amount / total;
  sperms = sperms
    .map((item) => ({
      ...item,
      value: Math.max(Math.floor(clampNumber(item?.value, 0, 999999, 0) - (clampNumber(item?.value, 0, 999999, 0) * factor)), 0),
    }))
    .filter((item) => item.value > 0);

  base.sperms = sperms;
  next.profile.base = base;
  chatState.characters[female] = next;
  return { applied: true, message: `bsDrainSperm applied to ${female}.` };
}

function applySetMenstrualPhases(chatState, args) {
  const female = String(args?.female || '').trim();
  const stage = String(args?.stage || '').trim();
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsSetMenstrualPhases skipped: unknown character ${female || '(empty)'}.` };
  if (!stage) return { applied: false, message: 'bsSetMenstrualPhases skipped: empty stage.' };

  const allowedStages = new Set([...MENSTRUAL_STAGES, '产后恢复', '假孕期']);
  if (!allowedStages.has(stage)) {
    return { applied: false, message: `bsSetMenstrualPhases skipped: invalid stage ${stage}.` };
  }

  const next = cloneValue(character);
  const profile = next.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const cooldown = profile.cooldown || {};
  const notify = profile.notify || {};
  const currentStage = String(base.stage || '');
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  const hasConceptionState = fetuses.length > 0
    || clampNumber(base.fertilizationDays, 0, 9999, 0) > 0
    || clampNumber(pregnant.pregnantDays, 0, 9999, 0) > 0
    || clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0) > 0;
  const hasProtectedPregnancyState = PREGNANCY_STAGES.includes(currentStage)
    || currentStage === '产前阵痛'
    || LABOR_STAGES.includes(currentStage);

  if (hasConceptionState || hasProtectedPregnancyState) {
    return {
      applied: false,
      message: `bsSetMenstrualPhases skipped for ${female}: active conception or pregnancy state must not be overridden.`,
    };
  }

  base.stage = stage;
  base.days = 1;
  if (stage === '排卵期') {
    profile.cooldown = {
      ...cooldown,
      orgasmOvulationUsed: false,
    };
  } else {
    profile.cooldown = {
      ...cooldown,
      orgasmOvulationUsed: shouldResetOrgasmOvulation(stage) ? false : Boolean(cooldown.orgasmOvulationUsed),
    };
  }

  if (stage === '假孕期') {
    pregnant.pregnantDays = 0;
    pregnant.effectivePregnantDays = 0;
  }

  profile.base = base;
  profile.pregnant = pregnant;
  profile.notify = {
    ...notify,
    firstly: `${female}进入了${stage}`,
  };
  next.profile = profile;
  chatState.characters[female] = syncCharacterStageFromProfile(next);
  return { applied: true, message: `bsSetMenstrualPhases applied to ${female}.` };
}

function applyDebugInjectPregnancy(chatState, args) {
  const female = String(args?.female || '').trim();
  const fatherInput = String(args?.father || '').trim();
  const raceInput = String(args?.race || '人类').trim();
  const fetusCount = clampNumber(args?.fetusCount, 1, 9, 1);
  const equivalentDays = clampNumber(args?.equivalentDays, 0, 300, 0);
  const genderInput = String(args?.genders || '').trim();
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsDebugInjectPregnancy skipped: unknown character ${female || '(empty)'}.` };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const experience = profile.experience || {};
  const notify = profile.notify || {};
  const bio = profile.bio || {};
  const currentStage = String(base.stage || '');
  const existingFetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  const hasConceptionState = existingFetuses.length > 0
    || clampNumber(base.fertilizationDays, 0, 9999, 0) > 0
    || isPregnancyStage(currentStage);
  if (hasConceptionState) {
    return { applied: false, message: `bsDebugInjectPregnancy skipped for ${female}: pregnancy/conception state already exists.` };
  }

  const rawGenderList = genderInput
    ? genderInput.split(',').map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (rawGenderList.length > 1 && rawGenderList.length !== fetusCount) {
    return { applied: false, message: `bsDebugInjectPregnancy skipped for ${female}: genders count must be 1 or match fetusCount.` };
  }

  const rawFatherList = fatherInput
    ? fatherInput.split(',').map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (rawFatherList.length > 1 && rawFatherList.length !== fetusCount) {
    return { applied: false, message: `bsDebugInjectPregnancy skipped for ${female}: fathers count must be 1 or match fetusCount.` };
  }

  const rawRaceList = raceInput
    ? raceInput.split(',').map((item) => String(item || '').trim()).filter(Boolean)
    : ['人类'];
  if (rawRaceList.length > 1 && rawRaceList.length !== fetusCount) {
    return { applied: false, message: `bsDebugInjectPregnancy skipped for ${female}: races count must be 1 or match fetusCount.` };
  }

  const allowedGenderMap = {
    男: '男',
    女: '女',
    双: '双',
    雙: '双',
    無: '无',
    无: '无',
  };
  const normalizedGenderList = rawGenderList.map((item) => allowedGenderMap[item]);
  if (normalizedGenderList.some((item) => !item)) {
    return { applied: false, message: `bsDebugInjectPregnancy skipped for ${female}: unsupported gender value.` };
  }

  const fetuses = [];
  for (let index = 0; index < fetusCount; index += 1) {
    const spermSeed = {
      male: rawFatherList.length === 0 ? '未知' : (rawFatherList.length === 1 ? rawFatherList[0] : rawFatherList[index]),
      race: parseRaceDescriptor(rawRaceList.length === 1 ? rawRaceList[0] : rawRaceList[index]).race || '人类',
      derivedType: null,
    };
    const fetus = createSimpleFetus(profile, spermSeed, equivalentDays === 0 ? currentStage : '孕早期');
    if (normalizedGenderList.length === 1) {
      fetus.gender = normalizedGenderList[0];
    } else if (normalizedGenderList.length === fetusCount) {
      fetus.gender = normalizedGenderList[index];
    }
    fetuses.push(fetus);
  }

  pregnant.fetuses = fetuses;
  pregnant.fetusesCount = fetuses.length;
  pregnant.laborHours = 0;
  pregnant.effectiveLaborHours = 0;
  pregnant.amnionDurability = equivalentDays === 0 ? 0 : 100;
  pregnant.pregnantDays = equivalentDays === 0 ? 0 : 1;
  pregnant.effectivePregnantDays = equivalentDays === 0 ? 0 : equivalentDays;

  profile.base = base;
  if (equivalentDays === 0) {
    base.fertilizationDays = 0;
  } else {
    applyPregnancyPhysiology(profile, next.runtime || {});
    const actualGestationSpeed = clampNumber(getGestationEffectiveSpeed(profile), 0, 20, 1);
    pregnant.pregnantDays = actualGestationSpeed > 0 ? Math.max(1, Math.round(equivalentDays / actualGestationSpeed)) : 1;
    pregnant.effectivePregnantDays = Math.max(1, equivalentDays);
    const derived = derivePregnancyStageState(pregnant.effectivePregnantDays, 1);
    base.stage = derived.stage;
    base.days = derived.days;
    base.fertilizationDays = 0;
    experience.pregnantExperience = clampNumber(experience.pregnantExperience, 0, 999, 0) + 1;
  }

  profile.pregnant = pregnant;
  profile.experience = experience;
  updateFetalEnergyDrain(profile);
  profile.notify = {
    ...notify,
    secondly: equivalentDays === 0
      ? `${female}已注入${fetusCount}个刚受精胚胎，尚未着床`
      : `${female}已注入${fetusCount}胎，当前为等效妊娠${equivalentDays}天`,
  };

  next.profile = profile;
  chatState.characters[female] = equivalentDays > 0 ? syncCharacterStageFromProfile(next) : next;
  return { applied: true, message: `bsDebugInjectPregnancy applied to ${female}.` };
}

function applyDebugClearContainers(chatState, args) {
  const female = String(args?.female || '').trim();
  const container = String(args?.container || '').trim();
  const character = chatState.characters?.[female];
  if (!female || !character) return { applied: false, message: `bsDebugClearContainers skipped: unknown character ${female || '(empty)'}.` };
  if (!['sperms', 'fetuses', 'children'].includes(container)) {
    return { applied: false, message: `bsDebugClearContainers skipped for ${female}: unsupported container ${container || '(empty)'}.` };
  }

  const next = cloneValue(character);
  const profile = next.profile || {};
  const base = profile.base || {};
  const pregnant = profile.pregnant || {};
  const experience = profile.experience || {};
  const notify = profile.notify || {};
  const stage = String(base.stage || '');

  if (container === 'sperms') {
    const sperms = Array.isArray(base.sperms) ? base.sperms : [];
    if (sperms.length === 0) {
      return { applied: false, message: `bsDebugClearContainers skipped for ${female}: no sperms.` };
    }
    base.sperms = [];
    profile.base = base;
    profile.notify = {
      ...notify,
      secondly: `${female}体内残留精液已被调试淨空`,
    };
    next.profile = profile;
    chatState.characters[female] = next;
    return { applied: true, message: `bsDebugClearContainers cleared sperms for ${female}.` };
  }

  if (container === 'children') {
    const children = Array.isArray(profile.children) ? profile.children : [];
    if (children.length === 0) {
      return { applied: false, message: `bsDebugClearContainers skipped for ${female}: no children.` };
    }
    profile.children = [];
    profile.notify = {
      ...notify,
      secondly: `${female}的孩子记录已被调试淨空`,
    };
    next.profile = profile;
    chatState.characters[female] = next;
    return { applied: true, message: `bsDebugClearContainers cleared children for ${female}.` };
  }

  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [];
  const fertilizationDays = clampNumber(base.fertilizationDays, 0, 9999, 0);
  const hasConceptionState = fetuses.length > 0 || fertilizationDays > 0 || isPregnancyStage(stage);
  if (!hasConceptionState) {
    return { applied: false, message: `bsDebugClearContainers skipped for ${female}: no fetuses or conception state.` };
  }

  const implantedPregnancy = isPregnancyStage(stage) || clampNumber(pregnant.effectivePregnantDays, 0, 9999, 0) > 0;
  clearPregnancyState(profile);
  restorePregnancyPhysiology(profile, next.runtime || {});
  if (implantedPregnancy) {
    base.stage = '产后恢复';
    base.days = 1;
    experience.miscarriageExperience = clampNumber(experience.miscarriageExperience, 0, 999, 0) + 1;
    profile.experience = experience;
    profile.notify = {
      ...notify,
      firstly: `${female}进入了产后恢复`,
      secondly: `${female}的胎儿已被调试淨空，并记录一次流产/堕胎经验`,
    };
    next.profile = profile;
    chatState.characters[female] = syncCharacterStageFromProfile(next);
    return { applied: true, message: `bsDebugClearContainers cleared implanted pregnancy for ${female}.` };
  }

  profile.notify = {
    ...notify,
    secondly: `${female}尚未着床的受精卵已被调试淨空`,
  };
  next.profile = profile;
  chatState.characters[female] = next;
  return { applied: true, message: `bsDebugClearContainers cleared pre-implantation conception for ${female}.` };
}

function applyDebugSetGestationModifier(chatState, args) {
  const female = String(args?.female || '').trim();
  const character = chatState.characters?.[female];
  const clear = Boolean(args?.clear);
  if (!female || !character) return { applied: false, message: `bsDebugSetGestationModifier skipped: unknown character ${female || '(empty)'}.` };

  const next = cloneValue(character);
  const profile = next.profile || {};
  const bio = profile.bio || {};
  const notify = profile.notify || {};
  const stage = String(profile?.base?.stage || '');
  const fetuses = Array.isArray(profile?.pregnant?.fetuses) ? profile.pregnant.fetuses : [];
  const runtimeBaseSpeed = Number(next.runtime?.originalPregnancyBio?.gestationSpeciesSpeed);
  const baseSpeed = clampNumber(
    Number.isFinite(runtimeBaseSpeed) && runtimeBaseSpeed > 0 ? runtimeBaseSpeed : getGestationSpeciesSpeed(profile),
    0.1,
    20,
    1.0,
  );

  bio.gestationSpeciesSpeed = baseSpeed;
  if (clear) {
    bio.gestationModifierMultiplier = 1.0;
    bio.gestationModifierName = '';
    bio.gestationModifierDescription = '';
  } else {
    const name = String(args?.name || '').trim();
    const description = String(args?.description || '').trim();
    const multiplier = clampNumber(args?.multiplier, 0, 20, 1.0);
    if (!name) return { applied: false, message: `bsDebugSetGestationModifier skipped for ${female}: empty name.` };
    bio.gestationModifierMultiplier = multiplier;
    bio.gestationModifierName = name;
    bio.gestationModifierDescription = description;
  }

  bio.gestationEffectiveSpeed = clampNumber(getGestationEffectiveSpeed({ ...profile, bio }), 0, 20, baseSpeed);
  profile.bio = bio;

  if (fetuses.length > 0 && isPregnancyStage(stage)) {
    applyPregnancyPhysiology(profile, next.runtime || {});
  }

  profile.notify = {
    ...notify,
    firstly: clear
      ? `${female}失去了妊娠变速效果`
      : `${female}获得了妊娠变速效果「${bio.gestationModifierName}」x${Number(bio.gestationModifierMultiplier || 0).toFixed(2)}`,
    secondly: clear
      ? `${female}的妊娠变速效果已被清除`
      : Number(bio.gestationModifierMultiplier || 0) === 0
        ? `${female}的胎儿发育已被冻结`
        : `${female}当前妊娠变速倍率为 x${Number(bio.gestationModifierMultiplier || 0).toFixed(2)}`,
  };

  next.profile = profile;
  chatState.characters[female] = syncCharacterStageFromProfile(next);
  return { applied: true, message: `bsDebugSetGestationModifier applied to ${female}.` };
}

export function applyToolCall(chatState, call) {
  const name = String(call?.name || '').trim();
  const args = normalizeToolCallArguments(call?.arguments);
  if (!name) return { applied: false, message: 'Empty tool call name.' };
  if (name === 'bsPassedTime') return applyPassedTime(chatState, args);
  if (name === 'bsUpdateCharacterStatus') return applyCharacterStatus(chatState, args);
  if (name === 'bsSetDescription') return applyDescription(chatState, args);
  if (name === 'bsSetCharacterPresence') return applySetCharacterPresence(chatState, args);
  if (name === 'bsUpdateExperience') return applyUpdateExperience(chatState, args);
  if (name === 'bsNameChild') return applyNameChild(chatState, args);
  if (name === 'bsUpdatePsychology') return applyUpdatePsychology(chatState, args);
  if (name === 'bsAddSperm') return applyAddSperm(chatState, args);
  if (name === 'bsDrainSperm') return applyDrainSperm(chatState, args);
  if (name === 'bsSetMenstrualPhases') return applySetMenstrualPhases(chatState, args);
  if (name === 'bsExcreteMetabolism') return applyExcreteMetabolism(chatState, args);
  if (name === 'bsAbortion') return applyAbortion(chatState, args);
  if (name === 'bsChildbirth') return applyChildbirth(chatState, args);
  if (name === 'bsMaternalFetalInteraction') return applyMaternalFetalInteraction(chatState, args);
  if (name === 'bsDebugInjectPregnancy') return applyDebugInjectPregnancy(chatState, args);
  if (name === 'bsDebugClearContainers') return applyDebugClearContainers(chatState, args);
  if (name === 'bsDebugSetGestationModifier') return applyDebugSetGestationModifier(chatState, args);
  return { applied: false, message: `Unsupported tool: ${name}` };
}

export function applyToolCallsResult(ctx, result) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const toolCalls = Array.isArray(result?.tool_calls) ? result.tool_calls : [];
  const logs = [];
  for (const call of toolCalls) {
    const normalizedCall = {
      name: String(call?.name || '').trim(),
      arguments: normalizeToolCallArguments(call?.arguments),
    };
    const appliedResult = applyToolCall(chatState, normalizedCall);
    logs.push({
      ...appliedResult,
      name: normalizedCall.name,
      arguments: cloneValue(normalizedCall.arguments),
    });
  }
  if (result?.scene_summary !== undefined) chatState.sceneSummary = String(result.scene_summary || '');
  chatState.lastRawResult = result;
  chatState.lastOperationLogs = logs;
  saveSettings(ctx);
  return { chatState, logs };
}
