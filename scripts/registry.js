import { callOpenAICompatible } from './api.js';
import { buildEmbryoTypeLorePrompt } from './embryo_prompt_context.js';
import { buildRegistryRacePhysiologyPrompt } from './race_prompt_context.js';
import { DEFAULT_REGISTRY_DESCRIPTION_GUIDES } from './registry_config.js';
import {
  buildEmptyPsychologyGroup,
  normalizePsychologyGroup,
  PSY_MENS_FIELDS,
  PSY_MENS_BOOL_FIELDS,
  PSY_PREG_FIELDS,
  PSY_PREG_BOOL_FIELDS,
} from './registry_psy_config.js';
import {
  getEmbryoTypeByRace,
  getMergedRacePhysiologyProfile,
  getRaceComponents,
  parseRaceDescriptor,
} from './race_config.js';
import {
  buildRecentMessages,
  createDefaultFemaleState,
  getCharacterCard,
  getGestationEffectiveSpeed,
  getGestationSpeciesSpeed,
  getCharacterWorldBookName,
  getCharacterWorldBookNameViaSTscript,
  getChatKey,
  getChatState,
  getPsyStressInitByLevel,
  getSettings,
  normalizeCharacterPsychologyState,
  recordChatStateSnapshot,
  syncCharacterStageFromProfile,
  getVitalityInitByLevel,
  saveSettings,
} from './state.js';

const MAINFLOW_CONTEXT_SNAPSHOT_KEY = '__bs_biotracker_mainflow_context_snapshot__';
const DEBUG_LAST_REGISTRY_REQUEST_KEY = '__bs_biotracker_debug_last_registry_request__';
const DEBUG_LAST_REGISTRY_RESULT_KEY = '__bs_biotracker_debug_last_registry_result__';

function normalizeWorldbookMode(value) {
  const mode = String(value || 'exclude').trim();
  if (mode === 'mainflow' || mode === 'allowlist_all' || mode === 'exclude') return mode;
  return 'exclude';
}

async function getCharacterWorldBook(ctx) {
  const card = getCharacterCard(ctx);
  if (card?.worldBook) return card.worldBook;
  const boundWorldBookName = getCharacterWorldBookName(ctx) || await getCharacterWorldBookNameViaSTscript();
  if (boundWorldBookName && typeof ctx?.loadWorldInfo === 'function') {
    try {
      return await ctx.loadWorldInfo(boundWorldBookName);
    } catch (error) {
      console.warn('[BS BioTracker] loadWorldInfo failed', error);
    }
  }
  if (globalThis.ST_API?.worldBook?.get) {
    try {
      const result = await globalThis.ST_API.worldBook.get({ name: boundWorldBookName || 'Current Chat', scope: 'character' });
      return result?.worldBook || null;
    } catch (error) {
      console.warn('[BS BioTracker] getCharacterWorldBook failed', error);
    }
  }
  return null;
}

function parseRegistryWorldbookExcludeNames(settings) {
  return new Set(
    String(settings?.trackerWorldbookExcludeNames || '')
      .split(/[\r\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseRegistryWorldbookIncludeNames(settings) {
  return new Set(
    String(settings?.trackerWorldbookIncludeNames || '')
      .split(/[\r\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
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

function filterRegistryWorldbookEntries(value, excludedNames, settings = null, recentMessages = []) {
  if (!value || typeof value !== 'object') return value;
  const mode = normalizeWorldbookMode(settings?.trackerWorldbookMode);
  const includedNames = parseRegistryWorldbookIncludeNames(settings);
  const activationText = mode === 'mainflow' ? buildWorldbookActivationText(recentMessages) : '';

  const normalizeEntryName = (entry) => String(entry?.name || entry?.comment || entry?.title || entry?.displayName || entry?.uid || '').trim();

  const keepEntry = (entry) => {
    const name = normalizeEntryName(entry);
    if (mode === 'allowlist_all') return Boolean(name) && includedNames.has(name);
    if (entry?.enabled === false || entry?.disable === true) return false;
    if (name && excludedNames.has(name)) return false;
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
    return {
      ...value,
      entries: Object.fromEntries(
        Object.entries(value.entries).filter(([, entry]) => keepEntry(entry)),
      ),
    };
  }

  return value;
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

function recordRegistryRequestDebug(systemPrompt, payload) {
  globalThis[DEBUG_LAST_REGISTRY_REQUEST_KEY] = {
    capturedAt: Date.now(),
    systemPrompt,
    payload,
    messages: [
      { role: 'system', content: String(systemPrompt || '') },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ],
  };
}

function recordRegistryResultDebug(result, error = null) {
  globalThis[DEBUG_LAST_REGISTRY_RESULT_KEY] = {
    capturedAt: Date.now(),
    ok: !error,
    result: result ?? null,
    error: error ? String(error?.message || error) : null,
  };
}


export function buildRegistrySystemPrompt(settings, options = {}) {
  const guides = {
    ...DEFAULT_REGISTRY_DESCRIPTION_GUIDES,
    ...(settings?.registryDescriptionGuides || {}),
    ...(options.descriptionGuides || {}),
  };
  const customNotes = String(options.customNotes || settings?.registryCustomNotes || '').trim();
  const declaredRace = String(options.declaredRace || '').trim();
  const embryoTypeLorePrompt = buildEmbryoTypeLorePrompt(options.payload || {}, { includeAllIfEmpty: true });
  const racePhysiologyPrompt = buildRegistryRacePhysiologyPrompt(options.payload || {});
  const psyMensLines = Object.entries(PSY_MENS_FIELDS).flatMap(([key, value]) => [
    `- psychology.mens.${key}_value: ${value.definition}`,
    `  阶段预览: ${value.preview}`,
  ]);
  const psyMensBoolLines = Object.entries(PSY_MENS_BOOL_FIELDS).map(([key, value]) => `- psychology.mens.${key}: ${value.definition}`);
  const psyPregLines = Object.entries(PSY_PREG_FIELDS).flatMap(([key, value]) => [
    `- psychology.preg.${key}_value: ${value.definition}`,
    `  阶段预览: ${value.preview}`,
  ]);
  const psyPregBoolLines = Object.entries(PSY_PREG_BOOL_FIELDS).map(([key, value]) => `- psychology.preg.${key}: ${value.definition}`);
  return [
    racePhysiologyPrompt,
    '你是 AIRP 女性角色注册初始化器。',
    '只在用户明确要求注册指定角色时工作，不得擅自新增其他角色。',
    '根据角色卡、用户要求、已有资料，输出角色初始化 JSON。',
    '你只需要填写角色注册时真正需要声明的内容，不需要补充其他无关信息。',
    '不要扩写额外分类，不要发散到注册步骤之外的内容。',
    '你只需要填写以下声明内容：',
    '1. 角色基础注册：base.age、base.race、base.vitalityLevel、base.psyStressLevel、base.libido、base.uterinePressure、base.latestSexDays、base.sperms、metabolism',
    '2. 情感与妊娠经验：experience',
    '3. 繁育心理：psychology.mens 或 psychology.preg（二选一，互斥）',
    '4. 既有孩子记录：children',
    '5. 初登场即怀孕：pregnant.pregnantDays、pregnant.effectivePregnantDays、pregnant.fetusesCount、pregnant.fetuses',
    '6. 文字描述栏位：descriptions',
    '如果资料不足，可以省略字段或给 null；不要为了凑完整而编造。',
    embryoTypeLorePrompt,
    '以下字段定义、参数说明、注意事项与示例，均视为必要规则：',
    '【1. 角色基础注册】',
    '参数说明：',
    `- base.race: 纯种/混血/衍生种族/子类物种，保留原始写法，若故事为现代写实，种族统一填人类即可${declaredRace ? `。【重要】用户已明确指定，必须强制填写為：${declaredRace}` : ''}`,
    '- base.vitalityLevel: 1-7，默认语义为 一推就倒(1)-身怀病弱(2)-难产体态(3)-均衡活力(4)-安产体态(5)-经过锻炼(6)-无坚不摧(7)',
    '- base.psyStressLevel: 1-7，默认语义为 情感丧失麻木不仁(1)-内向压抑冷感(2)-情绪平缓理性(3)-情绪均衡稳定(4)-情绪丰富敏感(5)-强烈波动焦躁(6)-极端情绪精神异常(7)',
    '- base.age: 角色年龄',
    '- base.libido: 初始性欲。非妊娠上限100；妊娠後会随孕期提升，临产最后一天上限可达150。若角色开场就在发情、催情、强欲状态，可给较高值。',
    '- base.uterinePressure: 初始宫压。非妊娠上限50；妊娠後会随进度平滑提升，臨產期上限达150。【危险警告】孕早期与孕中期前期上限极低，超过15便极易触发流产警告！除非开局正在临盆或剧烈腹痛，否则强烈建议填 0。',
    '- base.latestSexDays: 距最近一次性行为经过的天数。若 experience.latestSexPartner 有意义，建议一并填写；若已超过最近一月经周期或无从判断，可为 null。',
    '- base.sperms: 体内残留精液来源列表。适用于刚性交结束、仍有精液残留的开局；每项包含 male、race、value。race 可直接写 [衍生]种族，系统会自动拆出 derivedType。',
    '- metabolism: 初始代谢状态。普通种族上限皆為150，包含 urine、stool、hunger、sleep；可用于表达一开始很饿、很困、憋尿等状态。',
    '- 若 base.derivedType 不为 null，则 metabolism 可改填 flux（范围 -150 到 150）。这是衍生种族专用的单一极性需求值：正值与负值分别代表两种相反的释放需求，绝对值越高需求越强；此时四项常规代谢可省略。',
    '注意：vitalityLevel 与 psyStressLevel 是角色内在特质等级，不根据当前疲劳、刚哭过、当下崩溃等暂时状态调整。',
    '注意：base.vitality 与 base.psyStress 不由你直接填写，系统会根据 vitalityLevel 与 psyStressLevel 自动计算初始值。',
    '示例：',
    '- 人类少女: {"base":{"race":"人类","vitalityLevel":4,"psyStressLevel":4,"age":18,"libido":12,"uterinePressure":0}}',
    '- 混血: {"base":{"race":"天使x恶魔","vitalityLevel":5,"psyStressLevel":3,"age":25,"libido":35,"uterinePressure":3}}',
    '- 衍生种族: {"base":{"race":"[血族]人类","vitalityLevel":2,"psyStressLevel":5,"age":150,"libido":28,"uterinePressure":0}}',
    '- 子类物种: {"base":{"race":"鱼人-鲸族","vitalityLevel":6,"psyStressLevel":2,"age":30,"libido":20,"uterinePressure":0}}',
    '- 复杂种族: {"base":{"race":"[不死-僵尸]兽耳族-九尾狐","vitalityLevel":7,"psyStressLevel":1,"age":1000,"libido":60,"uterinePressure":20}}',
    '【2. 情感与妊娠经验】',
    '参数说明：',
    '- virginity: 初次性对象名称，处女时为 null',
    '- latestSexPartner: 最新性对象，仅在最近一月经周期(ex: 人类28天)内仍有意义，否则可为 null',
    '- 若填写 latestSexPartner，最好同时填写 base.latestSexDays，表示距离最近一次性行为过去了几天',
    '- emotionalMate: 情感对象，无则 null',
    '- marriageMate: 婚姻对象，无则 null',
    '- pregnantExperience: 怀孕经验次数',
    '- naturalBirthExperience: 自然产经验次数',
    '- surgicalBirthExperience: 手术产经验次数',
    '- miscarriageExperience: 流产/堕胎次数',
    '示例：',
    '- 高中女生: {"experience":{"virginity":"前男友","emotionalMate":"{{user_name}}","pregnantExperience":0}}',
    '- 魅魔女仆: {"experience":{"virginity":"前任主人","emotionalMate":null,"pregnantExperience":5,"naturalBirthExperience":3,"surgicalBirthExperience":0,"miscarriageExperience":2}}',
    '- 守贞人妻: {"experience":{"virginity":"丈夫","latestSexPartner":"丈夫","emotionalMate":"丈夫","marriageMate":"丈夫","pregnantExperience":3,"naturalBirthExperience":0,"surgicalBirthExperience":2,"miscarriageExperience":0}}',
    '- 刚做爱开局: {"base":{"latestSexDays":0,"sperms":[{"male":"丈夫","race":"[不死-僵尸]人类","value":30}]},"experience":{"latestSexPartner":"丈夫"}}',
    '【3. 繁育心理】',
    '参数说明：',
    '- 非怀孕角色只填写 psychology.mens，包含 mastery_value、mastery_interpret、desire_value、desire_interpret、autonomy_value、autonomy_interpret，以及 isChaste、hasContraception。',
    '- 怀孕角色只填写 psychology.preg，包含 cognition_value、cognition_interpret、bonding_value、bonding_interpret、stance_value、stance_interpret，以及 knowsFatherSource、hasProfessionalPrenatalCare。',
    '- psychology.mens 与 psychology.preg 互斥，不要同时填写。',
    '- 你主要填写 *_value，数值范围为 0-100；*_interpret 可省略，系统会按阶段自动补全。布林旗标只填 true/false。',
    '非怀孕使用以下定义与阶段预览：',
    ...psyMensLines,
    ...psyMensBoolLines,
    '怀孕使用以下定义与阶段预览：',
    ...psyPregLines,
    ...psyPregBoolLines,
    '示例：',
    '- 非怀孕: {"psychology":{"mens":{"mastery_value":62,"desire_value":38,"autonomy_value":71,"isChaste":true,"hasContraception":true}}}',
    '- 怀孕: {"psychology":{"preg":{"cognition_value":58,"bonding_value":84,"stance_value":47,"knowsFatherSource":true,"hasProfessionalPrenatalCare":false}}}',
    '【4. 既有孩子记录】',
    '参数说明：每个孩子对象包含 name、fathers、gender、race、age。',
    '示例：',
    '- [{"name":"冬月 露花","fathers":"前夫","gender":"女","race":"人类","age":5}]',
    '【5. 初登场即怀孕】',
    '参数说明：',
    '- pregnant.pregnantDays: 这次妊娠在现实中已持续的天数，必须按天数填写。',
    '- pregnant.effectivePregnantDays: 真正计入胎儿发育与阶段推进的有效妊娠天数。若存在时间冻结、祝福加速、缓慢孕育、闭关多年但胎儿仅成长数月等情况，必须单独填写，不可默认等同于 pregnantDays。',
    '- pregnant.fetusesCount: 这次怀孕的怀胎数',
    '- pregnant.fetuses: 每个胎儿包含 fathers、provider、race、gender、embryoType',
    '- provider: 代孕母方、寄生等提供者名称，正常情况下为 null',
    '示例：',
    '- 人类怀单胎8周: {"pregnant":{"pregnantDays":56,"effectivePregnantDays":56,"fetusesCount":1,"fetuses":[{"fathers":"丈夫","provider":null,"race":"人类","gender":"男","embryoType":"胎生"}]}}',
    '- 妖怪猫又怀双胎20周: {"pregnant":{"pregnantDays":140,"effectivePregnantDays":140,"fetusesCount":2,"fetuses":[{"fathers":"监狱囚犯","provider":null,"race":"[妖怪]兽耳族-猫又x蜥蜴人","gender":"女","embryoType":"胎生"},{"fathers":"监狱囚犯","provider":null,"race":"[妖怪]兽耳族-猫又x蜥蜴人","gender":"女","embryoType":"胎生"}]}}',
    '- 代孕情节: {"pregnant":{"pregnantDays":84,"effectivePregnantDays":84,"fetusesCount":1,"fetuses":[{"fathers":"委托人","provider":"代孕者A","race":"人类","gender":"女","embryoType":"胎生"}]}}',
    '- 女散修闭关三年、胎儿仅成长三个月: {"pregnant":{"pregnantDays":1095,"effectivePregnantDays":90,"fetusesCount":1,"fetuses":[{"fathers":"道侣","provider":null,"race":"人类","gender":"女","embryoType":"胎生"}]}}',
    '【5.1 妊娠變速类补充设定（注册自订补充设定可直接体现到 bio）】',
    '参数说明：',
    '- bio.gestationModifierMultiplier: 妊娠速度倍率。1 为正常，大于 1 为加速，小于 1 为减速，可与 pregnant.effectivePregnantDays 同时出现。',
    '- bio.gestationModifierName: 该倍率效果的名称，例如祝福、诅咒、体质、术式。',
    '- bio.gestationModifierDescription: 对该倍率来源与表现的简短说明。',
    '- 注意：未怀孕角色也可以填写这组 bio 字段；是否怀孕只影响 pregnant，不影响该 buff 是否存在。',
    '示例：',
    '- 被祝福的冒险者妊娠加快: {"bio":{"gestationModifierMultiplier":1.5,"gestationModifierName":"丰饶祝福","gestationModifierDescription":"受女神祝福后，妊娠期间胎儿发育明显加快，孕期反应也会更早显现。"}}',
    '- 红尘之力导致孕期极端延长，即使当前未怀孕也应保留: {"bio":{"gestationModifierMultiplier":0.001,"gestationModifierName":"红尘织命","gestationModifierDescription":"受红尘之力影响，若进入妊娠，孕期推进速度仅为常规人类的千分之一，整体妊娠期会被极度拉长。"}}',
    '【6. 文字描述栏位】',
    '参数说明：descriptions 包含 normalDescription、closeupDescription、pregnantDescription。',
    '三个 descriptions 字段都必须使用旧版格式：字段名|描述内容;;字段名|描述内容;;...字段名|描述内容;;',
    '只能用 | 分隔字段名与描述内容，只能用 ;; 分隔字段；每个字段都要保留字段名，结尾也要补 ;;。',
    '不要改成自然段、不要换行、不要写成纯长文。',
    '示例：状态|处于饥饿与寒冷的边缘，精神高度焦虑且带有防御性;;表情|戴着苍白口罩，眼神涣散且带病态妆容;;行动|蜷缩在自动贩卖机旁躲雨，机械地刷手机;;',
    '以下三段规则文本由用户自定义，注册时应严格遵守：',
    '[normalDescription]',
    String(guides.normalDescription || DEFAULT_REGISTRY_DESCRIPTION_GUIDES.normalDescription),
    '[closeupDescription]',
    String(guides.closeupDescription || DEFAULT_REGISTRY_DESCRIPTION_GUIDES.closeupDescription),
    '[pregnantDescription]',
    String(guides.pregnantDescription || DEFAULT_REGISTRY_DESCRIPTION_GUIDES.pregnantDescription),
    '【7. 用户自订补充设定】',
    customNotes ? customNotes : '无',
    '若提供了自订补充设定，必须优先视为该角色已明确声明的特征，并在相关字段中如实体现；不要忽略，也不要擅自扩写超出原意的内容。',
    '若用户自订补充设定描述的是一种未来也会持续生效的妊娠体质、祝福、诅咒、冻结或延长效果，即使角色当前未怀孕，也必须写入 bio.gestationModifierMultiplier、bio.gestationModifierName、bio.gestationModifierDescription。',
    '注意：未怀孕角色不要硬填 pregnantDescription；描述内容应遵守旧系统文字栏位语义，不要换行。',
    '只输出 JSON，不要输出额外解释。',
    'JSON 结构必须是：',
    '{',
    '  "name": "string",',
    '  "profile": {',
    '    "base": {',
    '      "age": 0,',
    '      "race": "string",',
    '      "libido": 0,',
    '      "uterinePressure": 0,',
    '      "latestSexDays": 0,',
    '      "sperms": [],',
    '      "vitalityLevel": 4,',
    '      "psyStressLevel": 4',
    '    },',
    '    "pregnant": {',
    '      "pregnantDays": 0,',
    '      "effectivePregnantDays": 0,',
    '      "fetusesCount": 0,',
    '      "fetuses": []',
    '    },',
    '    "experience": {',
    '      "virginity": "string|null",',
    '      "latestSexPartner": "string|null",',
    '      "emotionalMate": "string|null",',
    '      "marriageMate": "string|null",',
    '      "pregnantExperience": 0,',
    '      "naturalBirthExperience": 0,',
    '      "surgicalBirthExperience": 0,',
    '      "miscarriageExperience": 0',
    '    },',
    '    "psychology": {',
    '      "mens": {',
    '        "mastery_value": 0,',
    '        "mastery_interpret": "string",',
    '        "desire_value": 0,',
    '        "desire_interpret": "string",',
    '        "autonomy_value": 0,',
    '        "autonomy_interpret": "string",',
    '        "isChaste": false,',
    '        "hasContraception": false',
    '      },',
    '      "preg": {',
    '        "cognition_value": 0,',
    '        "cognition_interpret": "string",',
    '        "bonding_value": 0,',
    '        "bonding_interpret": "string",',
    '        "stance_value": 0,',
    '        "stance_interpret": "string",',
    '        "knowsFatherSource": false,',
    '        "hasProfessionalPrenatalCare": false',
    '      }',
    '    },',
    '    "metabolism": {',
    '      "urine": 0,',
    '      "stool": 0,',
    '      "hunger": 0,',
    '      "sleep": 0',
    '    },',
    '    "bio": {',
    '      "gestationModifierMultiplier": 1,',
    '      "gestationModifierName": "string",',
    '      "gestationModifierDescription": "string"',
    '    },',
    '    "children": [],',
    '    "descriptions": {',
    '      "normalDescription": "string",',
    '      "closeupDescription": "string",',
    '      "pregnantDescription": "string"',
    '    }',
    '  }',
    '}',
    '允许省略不确定或不适用的声明字段，但不要编造系统字段。',
    '如果角色不是孕妇，pregnant 使用默认空结构或省略。',
    '如果角色没有孩子，children 返回 [] 或省略。',
    '如果角色没有明确经验背景，experience 只填能确定的部分。',
  ].join('\n');
}

const EXPERIENCE_FIELDS = [
  'virginity',
  'latestSexPartner',
  'emotionalMate',
  'marriageMate',
  'pregnantExperience',
  'naturalBirthExperience',
  'surgicalBirthExperience',
  'miscarriageExperience',
];

const DESCRIPTION_FIELDS = ['normalDescription', 'closeupDescription', 'pregnantDescription'];
const METABOLISM_FIELDS = ['urine', 'stool', 'hunger', 'sleep'];

function clampNumber(value, min, max, fallback = 0) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function randomInt(min, max) {
  const nextMin = Math.ceil(min);
  const nextMax = Math.floor(max);
  return Math.floor(Math.random() * (nextMax - nextMin + 1)) + nextMin;
}

function getRegistryMenstrualCycleLength(profile) {
  const ratio = clampNumber(profile?.bio?.menstrualLengthRatio, 0.1, 20, 1);
  return Math.max(1, Math.round(28 * ratio));
}

function pickObjectFields(value, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const key of allowedFields) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function sanitizeChildren(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const parsed = parseRaceDescriptor(item.race);
      return {
        name: item.name ?? item.babyName ?? null,
        fathers: item.fathers ?? null,
        gender: item.gender ?? null,
        race: parsed.race || null,
        derivedType: item.derivedType ?? parsed.derivedType ?? null,
        age: item.age ?? null,
      };
    });
}

function sanitizeRegistrySperms(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const parsed = parseRaceDescriptor(item.race);
      const derivedTypeRaw = item.derivedType === undefined ? parsed.derivedType : item.derivedType;
      return {
        male: item.male === null ? null : String(item.male || '').trim() || null,
        race: parsed.race || null,
        derivedType: derivedTypeRaw === null ? null : String(derivedTypeRaw || '').trim() || null,
        value: clampNumber(item.value, 0, 9999, 0),
      };
    })
    .filter((item) => item.male && item.race && item.value > 0);
}

function sanitizePregnant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fetuses = Array.isArray(value.fetuses)
    ? value.fetuses
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const parsed = parseRaceDescriptor(item.race);
        return {
          fathers: item.fathers ?? null,
          provider: item.provider ?? null,
          race: parsed.race || null,
          fatherRace: parsed.race || null,
          fatherDerivedType: item.fatherDerivedType ?? parsed.derivedType ?? null,
          gender: item.gender ?? null,
          embryoType: item.embryoType ?? null,
          maternalDerivedTypeProgress: Number.isFinite(Number(item.maternalDerivedTypeProgress)) ? clampNumber(item.maternalDerivedTypeProgress, -100, 100, 0) : undefined,
          weight: Number.isFinite(Number(item.weight)) ? clampNumber(item.weight, 0.5, 2.0, 1.0) : undefined,
          tendencyAngle: Number.isFinite(Number(item.tendencyAngle)) ? clampNumber(item.tendencyAngle, 0, 360, 0) : undefined,
          affinity: Number.isFinite(Number(item.affinity)) ? clampNumber(item.affinity, -50, 50, 0) : undefined,
        };
      })
    : [];
  return {
    pregnantDays: Number.isFinite(Number(value.pregnantDays)) ? Number(value.pregnantDays) : 0,
    effectivePregnantDays: Number.isFinite(Number(value.effectivePregnantDays)) ? Number(value.effectivePregnantDays) : null,
    fetusesCount: Number.isFinite(Number(value.fetusesCount)) ? Number(value.fetusesCount) : fetuses.length,
    fetuses,
  };
}

function sanitizeRegistryBio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nextBio = {};
  if (value.gestationModifierMultiplier !== undefined) {
    const multiplier = Number(value.gestationModifierMultiplier);
    if (Number.isFinite(multiplier)) nextBio.gestationModifierMultiplier = clampNumber(multiplier, 0, 20, 1);
  }
  if (value.gestationModifierName !== undefined) {
    nextBio.gestationModifierName = value.gestationModifierName === null ? '' : String(value.gestationModifierName || '').trim();
  }
  if (value.gestationModifierDescription !== undefined) {
    nextBio.gestationModifierDescription = value.gestationModifierDescription === null ? '' : String(value.gestationModifierDescription || '').trim();
  }
  return Object.keys(nextBio).length > 0 ? nextBio : null;
}

function getRegistryEmbryoTypeRecoveryCoefficient(embryoType) {
  switch (String(embryoType || '胎生')) {
    case '卵生':
      return 0.6;
    case '卵胎生':
      return 0.4;
    case '胎转卵生':
      return 1.0;
    case '不定型':
      return 0.8;
    case '胎生':
    default:
      return 0.2;
  }
}

function deriveRegisteredFetusRace(motherRace, fatherRace) {
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

function normalizeRegisteredPregnancy(profile) {
  const pregnant = profile.pregnant || {};
  const fetuses = Array.isArray(pregnant.fetuses) ? pregnant.fetuses.map((item) => ({ ...item })) : [];
  if (fetuses.length === 0) return;
  const motherRace = parseRaceDescriptor(profile?.base?.race || '人类').race || '人类';

  pregnant.fetuses = fetuses.map((fetus) => {
    const fatherRace = parseRaceDescriptor(fetus?.fatherRace || fetus?.race || motherRace).race || motherRace;
    const fetusRace = deriveRegisteredFetusRace(motherRace, fatherRace);
    return {
      ...fetus,
      race: fetusRace,
      fatherRace,
      embryoType: fetus?.embryoType || getEmbryoTypeByRace(fetusRace),
      weight: Number.isFinite(Number(fetus?.weight)) ? clampNumber(fetus.weight, 0.5, 2.0, 1.0) : 1.0,
      tendencyAngle: Number.isFinite(Number(fetus?.tendencyAngle)) ? clampNumber(fetus.tendencyAngle, 0, 360, 0) : randomInt(0, 360),
      affinity: Number.isFinite(Number(fetus?.affinity)) ? clampNumber(fetus.affinity, -50, 50, 0) : 0,
    };
  });
  pregnant.fetusesCount = pregnant.fetuses.length;
  pregnant.pregnantDays = Math.max(1, Math.floor(Number(pregnant.pregnantDays) || 1));
  const gestationSpeed = clampNumber(getGestationEffectiveSpeed(profile), 0.1, 20, 1.0);
  pregnant.effectivePregnantDays = Number.isFinite(Number(pregnant.effectivePregnantDays))
    ? Math.max(1, Number(pregnant.effectivePregnantDays))
    : Math.max(1, pregnant.pregnantDays * gestationSpeed);
  pregnant.amnionDurability = 100;

  const bio = profile.bio || {};
  const motherBreedTolerance = clampNumber(bio.breedTolerance, 0.1, 100, 1.0);
  pregnant.fetalEnergyDrain = pregnant.fetuses.reduce((sum, fetus) => {
    const weight = clampNumber(fetus?.weight, 0.5, 2.0, 1.0);
    const ageInDays = pregnant.effectivePregnantDays * weight;
    const fetalAgeWeeks = ageInDays / 7;
    const fetalLoad = fetalAgeWeeks / 40;
    return sum + (fetalLoad / motherBreedTolerance);
  }, 0);

  const experience = profile.experience || {};
  experience.pregnantExperience = Math.max(1, clampNumber(experience.pregnantExperience, 0, 999, 0));
  profile.experience = experience;

  const recoveryBase = Math.max(1, Math.round(clampNumber(bio.recoveryDays, 1, 9999, 56)));
  const totalWeight = pregnant.fetuses.reduce((sum, fetus) => sum + clampNumber(fetus?.weight, 0.5, 2.0, 1.0), 0);
  const recoveryAccumulator = pregnant.fetuses.reduce((sum, fetus) => {
    const weight = clampNumber(fetus?.weight, 0.5, 2.0, 1.0);
    return sum + (weight * getRegistryEmbryoTypeRecoveryCoefficient(fetus?.embryoType));
  }, 0);
  const averageRecovery = recoveryAccumulator / Math.max(totalWeight, 0.5);
  const fetusCountModifier = 1 + (Math.max(0, pregnant.fetuses.length - 1) * 0.12);
  profile.bio = {
    ...bio,
    recoveryDays: Math.max(1, Math.round(recoveryBase * (1 + averageRecovery) * fetusCountModifier)),
  };
  profile.pregnant = pregnant;
}

function sanitizePsy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mens = normalizePsychologyGroup(value.mens, PSY_MENS_FIELDS, { includeDefaults: false, booleanFields: PSY_MENS_BOOL_FIELDS });
  const preg = normalizePsychologyGroup(value.preg, PSY_PREG_FIELDS, { includeDefaults: false, booleanFields: PSY_PREG_BOOL_FIELDS });
  if (preg) return { preg };
  if (mens) return { mens };
  return null;
}

function sanitizeMeter(value, { min = 0, max = 999 } = {}) {
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function sanitizeRegistryProfile(profile, baseProfile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
  const sanitized = {};
  if (profile.base && typeof profile.base === 'object' && !Array.isArray(profile.base)) {
    const nextBase = {};
    if (profile.base.race !== undefined) {
      const parsed = parseRaceDescriptor(profile.base.race);
      nextBase.race = parsed.race || baseProfile.base.race;
      if (profile.base.derivedType === undefined && parsed.derivedType !== null) nextBase.derivedType = parsed.derivedType;
    }
    if (profile.base.derivedType !== undefined) nextBase.derivedType = profile.base.derivedType === null ? null : String(profile.base.derivedType || '').trim() || null;
    if (profile.base.age !== undefined) {
      const age = Number(profile.base.age);
      if (Number.isFinite(age)) nextBase.age = age;
    }
    if (profile.base.libido !== undefined) {
      const libido = sanitizeMeter(profile.base.libido, { min: 0, max: 150 });
      if (libido !== null) nextBase.libido = libido;
    }
    if (profile.base.uterinePressure !== undefined) {
      const uterinePressure = sanitizeMeter(profile.base.uterinePressure, { min: 0, max: 150 });
      if (uterinePressure !== null) nextBase.uterinePressure = uterinePressure;
    }
    if (profile.base.latestSexDays !== undefined) {
      const latestSexDays = Number(profile.base.latestSexDays);
      if (Number.isFinite(latestSexDays)) nextBase.latestSexDays = Math.max(-1, Math.round(latestSexDays));
      else if (profile.base.latestSexDays === null) nextBase.latestSexDays = null;
    }
    if (profile.base.sperms !== undefined) {
      nextBase.sperms = sanitizeRegistrySperms(profile.base.sperms);
    }
    if (profile.base.vitalityLevel !== undefined) {
      const vitalityLevel = Number(profile.base.vitalityLevel);
      if (Number.isFinite(vitalityLevel)) nextBase.vitalityLevel = Math.max(1, Math.min(7, Math.round(vitalityLevel)));
    }
    if (profile.base.psyStressLevel !== undefined) {
      const psyStressLevel = Number(profile.base.psyStressLevel);
      if (Number.isFinite(psyStressLevel)) nextBase.psyStressLevel = Math.max(1, Math.min(7, Math.round(psyStressLevel)));
    }
    if (Object.keys(nextBase).length > 0) sanitized.base = nextBase;
  }

  const experience = pickObjectFields(profile.experience, EXPERIENCE_FIELDS);
  if (Object.keys(experience).length > 0) sanitized.experience = experience;

  const metabolism = pickObjectFields(profile.metabolism, METABOLISM_FIELDS);
  if (Object.keys(metabolism).length > 0) {
    const nextMetabolism = {};
    for (const [key, value] of Object.entries(metabolism)) {
      const meter = sanitizeMeter(value, { min: 0, max: 100 });
      if (meter !== null) nextMetabolism[key] = meter;
    }
    if (Object.keys(nextMetabolism).length > 0) sanitized.metabolism = nextMetabolism;
  }

  if (profile.psychology !== undefined) {
    const psychology = sanitizePsy(profile.psychology);
    if (psychology) sanitized.psychology = psychology;
  }

  if (profile.children !== undefined) sanitized.children = sanitizeChildren(profile.children);

  if (profile.pregnant !== undefined) sanitized.pregnant = sanitizePregnant(profile.pregnant);

  if (profile.bio !== undefined) {
    const bio = sanitizeRegistryBio(profile.bio);
    if (bio) sanitized.bio = bio;
  }

  const descriptions = pickObjectFields(profile.descriptions, DESCRIPTION_FIELDS);
  if (Object.keys(descriptions).length > 0) sanitized.descriptions = descriptions;

  return sanitized;
}

export function applyRegistryResult(chatState, result) {
  const name = String(result?.name || '').trim();
  if (!name) throw new Error('注册结果缺少角色名称');
  const current = chatState.characters[name];
  const base = current && typeof current === 'object' ? current : createDefaultFemaleState(name);
  const sanitizedProfile = sanitizeRegistryProfile(result.profile, base.profile);
  const effectiveRace = sanitizedProfile.base?.race ?? base.profile.base.race;
  const mergedRaceProfile = getMergedRacePhysiologyProfile(effectiveRace);
  const nextCharacter = {
    ...base,
    name,
    initialized: true,
    profile: {
      ...base.profile,
      ...sanitizedProfile,
      base: {
        ...base.profile.base,
        ...(sanitizedProfile.base || {}),
        vitality: getVitalityInitByLevel(sanitizedProfile.base?.vitalityLevel ?? base.profile.base.vitalityLevel),
        psyStress: getPsyStressInitByLevel(sanitizedProfile.base?.psyStressLevel ?? base.profile.base.psyStressLevel),
      },
      pregnant: {
        ...base.profile.pregnant,
        ...(sanitizedProfile.pregnant || {}),
      },
      experience: {
        ...base.profile.experience,
        ...(sanitizedProfile.experience || {}),
      },
      psychology: sanitizedProfile.psychology?.preg
        ? {
          mens: buildEmptyPsychologyGroup(PSY_MENS_FIELDS, PSY_MENS_BOOL_FIELDS),
          preg: {
            ...buildEmptyPsychologyGroup(PSY_PREG_FIELDS, PSY_PREG_BOOL_FIELDS),
            ...sanitizedProfile.psychology.preg,
          },
        }
        : sanitizedProfile.psychology?.mens
          ? {
            mens: {
              ...buildEmptyPsychologyGroup(PSY_MENS_FIELDS, PSY_MENS_BOOL_FIELDS),
              ...sanitizedProfile.psychology.mens,
            },
            preg: buildEmptyPsychologyGroup(PSY_PREG_FIELDS, PSY_PREG_BOOL_FIELDS),
          }
          : normalizeCharacterPsychologyState(base).profile.psychology,
      descriptions: {
        ...base.profile.descriptions,
        ...(sanitizedProfile.descriptions || {}),
      },
      bio: {
        ...base.profile.bio,
        ...(mergedRaceProfile || {}),
        ...(sanitizedProfile.bio || {}),
      },
      metabolism: {
        ...base.profile.metabolism,
        ...(sanitizedProfile.metabolism || {}),
      },
    },
    updatedAt: Date.now(),
  };
  if (Array.isArray(nextCharacter.profile?.pregnant?.fetuses) && nextCharacter.profile.pregnant.fetuses.length > 0) {
    normalizeRegisteredPregnancy(nextCharacter.profile);
  }
  nextCharacter.profile.bio = {
    ...nextCharacter.profile.bio,
    gestationEffectiveSpeed: clampNumber(
      getGestationEffectiveSpeed(nextCharacter.profile),
      0,
      20,
      getGestationSpeciesSpeed(nextCharacter.profile),
    ),
  };
  const latestSexDays = Number(nextCharacter.profile?.base?.latestSexDays);
  if (Number.isFinite(latestSexDays) && latestSexDays >= 0) {
    const cycleLength = getRegistryMenstrualCycleLength(nextCharacter.profile);
    if (latestSexDays >= cycleLength) {
      nextCharacter.profile.base.latestSexDays = -1;
    }
  }
  chatState.characters[name] = syncCharacterStageFromProfile(normalizeCharacterPsychologyState(nextCharacter));
  return chatState.characters[name];
}

export async function runRegistry(ctx, options = {}) {
  const settings = getSettings(ctx);
  const chatState = getChatState(ctx, settings);
  const targetName = String(options.targetName || '').trim();
  const customNotes = String(options.customNotes || settings.registryCustomNotes || '').trim();
  const declaredRace = String(options.declaredRace || '').trim();
  if (!targetName) throw new Error('runRegistry 需要 targetName');
  const currentCharacter = getCharacterCard(ctx);
  const recentMessages = buildRecentMessages(ctx, settings);
  const useMainflowMode = normalizeWorldbookMode(settings?.trackerWorldbookMode) === 'mainflow';
  let mainflowContextSnapshot = useMainflowMode ? getMainflowContextSnapshot() : null;
  if (mainflowContextSnapshot && settings?.useStPresetForAsync) {
    mainflowContextSnapshot = {
      ...mainflowContextSnapshot,
      messages: mainflowContextSnapshot.messages.filter((message) => message.role !== 'system'),
    };
    if (mainflowContextSnapshot.messages.length === 0) mainflowContextSnapshot = null;
  }
  const rawCharacterWorldBook = await getCharacterWorldBook(ctx);
  const characterWorldBook = filterRegistryWorldbookEntries(
    rawCharacterWorldBook,
    parseRegistryWorldbookExcludeNames(settings),
    settings,
    recentMessages,
  );
  const payloadWorldBook = mainflowContextSnapshot ? null : characterWorldBook;
  const payload = {
    reason: options.reason || 'manual_registry',
    chat_id: getChatKey(ctx),
    current_character: {
      ...currentCharacter,
      worldBook: payloadWorldBook,
    },
    character_description: currentCharacter.description || '',
    character_worldbook_name: payloadWorldBook ? (getCharacterWorldBookName(ctx) || null) : null,
    character_worldbook: payloadWorldBook,
    mainflow_context_snapshot: mainflowContextSnapshot,
    target_character: targetName,
    existing_state: chatState.characters[targetName] || null,
    recent_messages: recentMessages,
    custom_notes: customNotes,
    declared_race: declaredRace || null,
    user_instruction: String(options.userInstruction || '').trim(),
  };
  try {
    const currentCharacterText = JSON.stringify(currentCharacter) || '';
    const characterWorldBookText = JSON.stringify(characterWorldBook) || '';
    const recentMessagesText = JSON.stringify(payload.recent_messages) || '';
    const payloadText = JSON.stringify(payload) || '';
    const worldbookEntries = Array.isArray(characterWorldBook?.entries)
      ? characterWorldBook.entries.length
      : (Array.isArray(characterWorldBook?.worldBook?.entries) ? characterWorldBook.worldBook.entries.length : 0);
    console.log('[BS BioTracker][registry] payload size', {
      target_character: targetName,
      current_character_chars: currentCharacterText.length,
      character_worldbook_chars: characterWorldBookText.length,
      character_worldbook_entries: worldbookEntries,
      recent_messages_chars: recentMessagesText.length,
      payload_chars: payloadText.length,
    });
  } catch (error) {
    console.warn('[BS BioTracker][registry] payload size debug failed', error);
  }
  const systemPrompt = options.systemPrompt || buildRegistrySystemPrompt(settings, { ...options, customNotes, declaredRace, payload });
  recordRegistryRequestDebug(systemPrompt, payload);
  try {
    const result = await callOpenAICompatible(
      settings,
      payload,
      systemPrompt,
    );
    recordRegistryResultDebug(result);
    const character = applyRegistryResult(chatState, result);
    recordChatStateSnapshot(ctx, chatState, { reason: 'registry' });
    saveSettings(ctx);
    return character;
  } catch (error) {
    recordRegistryResultDebug(null, error);
    throw error;
  }
}
