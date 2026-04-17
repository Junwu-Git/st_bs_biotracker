import { PSY_MENS_FIELDS, PSY_PREG_FIELDS } from './registry_psy_config.js';
import { buildEmbryoTypeLorePrompt } from './embryo_prompt_context.js';
import { buildRacePhysiologyPrompt } from './race_prompt_context.js';
import { getDerivedTypeFluxProfile } from './race_config.js';

function collectRelevantFluxNames(payload = {}) {
  const found = [];
  const pushFluxName = (derivedType) => {
    const fluxName = String(getDerivedTypeFluxProfile(derivedType)?.fluxName || '').trim();
    if (fluxName && !found.includes(fluxName)) found.push(fluxName);
  };
  if (payload?.existing_state && typeof payload.existing_state === 'object') {
    for (const item of Object.values(payload.existing_state)) {
      const profile = item?.profile || {};
      const base = profile.base || {};
      const pregnant = profile.pregnant || {};
      pushFluxName(base.derivedType);
      for (const sperm of (Array.isArray(base.sperms) ? base.sperms : [])) pushFluxName(sperm?.derivedType);
      for (const fetus of (Array.isArray(pregnant.fetuses) ? pregnant.fetuses : [])) pushFluxName(fetus?.fatherDerivedType);
      for (const child of (Array.isArray(profile.children) ? profile.children : [])) pushFluxName(child?.derivedType);
    }
  }
  return found;
}

export const TRACKER_VARIABLE_GUIDE_PROMPT = [
  '以下是角色状态变量的语义说明，供你理解 existing_state 中的字段，不是要求你原样输出这些字段。',
  '',
  '[总结构]',
  '- 每个角色结构为 name / initialized / profile。',
  '- profile 主要包含 base、pregnant、experience、psychology、children、metabolism、descriptions、notify。',
  '- bio 与 immune 属于内部运行参数，tracker 默认不会发给你。',
  '- 若角色具有 immune.metabolism=true，则 metabolism 也不会发给你，因为该角色不受代谢累积影响。',
  '- 若角色带有 offscreen=true，表示该角色当前不在场，existing_state 只提供精简状态，不代表角色不存在。',
  '',
  '[base]',
  '- isHere: 是否在场。false 时角色仍会随时间推进，但幕外角色只发送少量状态给你。',
  '- stage: 当前阶段。可能是月经阶段、妊娠阶段、假孕期、产前阵痛、第一/第二/第三产程、产后恢复、无经期、未激活。',
  '- days: 当前阶段已经过了多少天。',
  '- fertilizationDays: 受精后、着床前已经过的天数。',
  '- latestSexDays: 距最近一次性行为经过的天数；超过一个周期后通常会失效。',
  '- age: 角色年龄，单位为年。',
  '- race: 当前保存的种族字符串，可能带子类或混血，不再带 [derived] 前缀。',
  '- derivedType: 衍生类型字符串，如 不死-僵尸；没有则为 null。',
  '- sperms: 体内残留精液来源列表。',
  '- sperms[*].male: 精液来源对象名称。',
  '- sperms[*].race: 该来源的父方种族字符串，已去除 [derived] 前缀，用于受精与混血计算。',
  '- sperms[*].derivedType: 该来源的父方衍生类型；没有则为 null。',
  '- sperms[*].value: 当前残留量，用于多父竞争与受精判定。',
  '- eggs: 当前可受精卵子数。',
  '- libido: 性欲。',
  '- uterinePressure: 宫压，越高越接近妊娠风险或分娩。',
  '- vitality: 活力。',
  '- psyStress: 情压/精神压力。',
  '- vitalityLevel / psyStressLevel: 个体等级，决定对应数值上限与体质倾向。',
  '- vitalityLevelText / psyStressLevelText: 系统额外附带的等级文字说明，方便直接理解体质与精神倾向。',
  '',
  '[pregnant]',
  '- pregnantDays: 这次妊娠已持续的天数。',
  '- laborHours: 产程已消耗的实际时长。',
  '- effectiveLaborHours: 真正推动产程前进的有效时长。',
  '- amnionDurability: 母体层的膜耐性；过低代表接近或已经破水。',
  '- fetuses: 胎儿列表。',
  '- fetuses[*].fathers: 父方对象名称。',
  '- fetuses[*].provider: 提供子宫或代孕来源；正常情况下为 null。',
  '- fetuses[*].fatherRace: 父方种族字符串，已去除 [derived] 前缀，用于理解父源与 fatherDerivedType。',
  '- fetuses[*].fatherDerivedType: 父方衍生类型；若没有则为 null。',
  '- fetuses[*].gender: 胎儿性别。',
  '- fetuses[*].embryoType: 胚胎型态，如 胎生、卵生、卵胎生、胎转卵生、不定型。',
  '- fetuses[*].weight: 胎重系数，標準1.0，会影响妊娠负担、分娩难度与恢复期。',
  '- fetuses[*].tendencyAngle: 胎位倾向角度，影响孕期调位与产程顺序。',
  '- fetuses[*].tendencyAngleText: 系统额外附带的胎位文字说明，如 正位/倒位/横位/斜位。',
  '- fetuses[*].affinity: 母胎之間的親密度，也会参与 derivedType 进展。',
  '- fetuses[*].maternalDerivedTypeProgress: 与母体(正)/父源(負)衍生同化的进度，范围 -100 到 100。',
  '',
  '[experience]',
  '- 记录第一次对象、最近对象、情感/婚姻对象，以及怀孕、分娩、流产等经历次数。',
  '- 这类字段偏长期记录，通常只在剧情明确成立时才需要更新。',
  '',
  '[psychology]',
  '- psychology 分为 mens (常规/生理) 与 preg (妊娠相关) 两大组心理指数。',
  ...Object.entries(PSY_MENS_FIELDS).map(([k, v]) => `- [mens] ${k} (0-100+): ${v.definition}`),
  ...Object.entries(PSY_PREG_FIELDS).map(([k, v]) => `- [preg] ${k} (0-100+): ${v.definition}`),
  '- 非怀孕时主要看 psychology.mens；怀孕、假孕、产前阵痛、产程时主要看 psychology.preg。',
  '- 心理阶段从 0 到 100+。若要调用 bsUpdatePsychology，数值参数表示变化量(delta)而不是目标值；例如当前 78 传 2 会变成 80，不是设为 2。建议尽量做小幅变化；单次以 ±1 到 ±3 为宜，±5 已属于大改。',
  '- 每个心理项由 *_value 和 *_interpret 组成。*_value 是 0-100 数值本体，*_interpret 是系统对应生成的心理解释。',
  '- psychology.mens 另外包含 isChaste (是否当前保持贞洁)、hasContraception (是否有避孕措施) 两个事件旗标。',
  '- psychology.preg 另外包含 knowsFatherSource (是否知晓父源)、hasProfessionalPrenatalCare (是否接受专业产检) 两个事件旗标。',
  '',
  '[children]',
  '- 已出生孩子列表。provider!=null 的胎儿通常不会计入 children。',
  '- children[*].name: 孩子姓名。',
  '- children[*].fathers: 父方对象名称。',
  '- children[*].gender: 孩子性别。',
  '- children[*].race: 孩子种族。',
  '- children[*].derivedType: 孩子继承到的衍生类型；没有则为 null。',
  '- children[*].age: 孩子年龄，单位为年，会随时间推进。',
  '',
  '[metabolism]',
  '- 普通种族使用 urine / stool / hunger / sleep，分别对应尿意、便意、饿意、困意。',
  '- 若角色具有 derivedType，则 metabolism 只看 flux。它是 -150 到 150 的单一极性需求值：正值持续走向更正，负值持续走向更负，绝对值越高代表越需要使用 bsExcreteMetabolism 进行一次“解放”。解放会按释放量抵消当前需求，只有在抵消过头时才会跨过 0 翻转极性。',
  '- 对 derivedType 角色来说，四项常规代谢需求不再作为主要判读依据。',
  '',
  '[descriptions]',
  '- normalDescription / closeupDescription / pregnantDescription 为文字描述栏位。',
  '- 三者格式固定为：字段名|描述内容;;字段名|描述内容;;...字段名|描述内容;;',
  '- 不要改写成自然段，不要省略字段名，不要把 ;; 或 | 换成别的分隔方式。',
  '',
  '[notify]',
  '- firstly: 主要阶段变化提示。',
  '- secondly: 次级事件提示，如风险、破水、分娩推进等。',
  '- thirdly: 辅助建议提示，提醒是否该缓解生理需求、关注膜耐性、抵抗分娩等。',
  '',
].join('\n');

function buildTrackerMetabolismGuide(payload = null) {
  const fluxNames = collectRelevantFluxNames(payload || {});
  return fluxNames.length > 0
    ? TRACKER_VARIABLE_GUIDE_PROMPT.replace(
      '- 若角色具有 derivedType，则 metabolism 只看 flux。它是 -150 到 150 的单一极性需求值：正值持续走向更正，负值持续走向更负，绝对值越高代表越需要使用 bsExcreteMetabolism 进行一次“解放”。解放会按释放量抵消当前需求，只有在抵消过头时才会跨过 0 翻转极性。',
      `- 若角色具有 derivedType，则 metabolism 只看 flux。它是 -150 到 150 的单一极性需求值；在本轮相关衍生种族中，flux 分别表示：${fluxNames.join(' / ')}。正值持续走向更正，负值持续走向更负，绝对值越高代表越需要使用 bsExcreteMetabolism 进行一次“解放”。解放会按释放量抵消当前需求，只有在抵消过头时才会跨过 0 翻转极性。`,
    )
    : TRACKER_VARIABLE_GUIDE_PROMPT;
}

export function buildTrackerSystemPrompt(basePrompt = '', descriptionGuides = null, payload = null) {
  const metabolismGuide = buildTrackerMetabolismGuide(payload);
  const parts = [
    [
      '[bsPassedTime 强制规则]',
      '- bsPassedTime 是每一轮 tracker 分析都必须优先考虑的第一工具。',
      '- 你应先根据 recent_messages 判断本轮累计了多少分钟/小时/天，再调用 bsPassedTime 推进时间。',
      '- 只有在确认本轮完全没有任何可推进的时间量时，才允许不调用 bsPassedTime。',
      '- 其他状态工具默认建立在时间推进之后，不要跳过 bsPassedTime 直接更新长程状态。',
    ].join('\n'),
    String(basePrompt || '').trim(),
    metabolismGuide,
  ];
  const embryoTypeLorePrompt = buildEmbryoTypeLorePrompt(payload || {});
  if (embryoTypeLorePrompt) parts.push(embryoTypeLorePrompt);

  if (descriptionGuides) {
    parts.push([
      '[descriptions 填写规范]',
      '- normalDescription 与 closeupDescription 默认必须填写。',
      '- pregnantDescription 只有当角色处于妊娠相关阶段或假孕时才需要填写，否则必须留空或不返回。',
      '- 请务必按照预设的字段名与 |、;; 分隔符进行填写（参考下方规范），不可擅自使用自然段或缺少字段名。',
      '',
      '【normalDescription 规范】',
      String(descriptionGuides.normalDescription || '').trim(),
      '',
      '【closeupDescription 规范】',
      String(descriptionGuides.closeupDescription || '').trim(),
      '',
      '【pregnantDescription 规范 (仅妊娠/假孕时填写)】',
      String(descriptionGuides.pregnantDescription || '').trim(),
    ].join('\n'));
  }

  return parts.filter(Boolean).join('\n\n');
}

export function buildMainFlowStatePrompt(payload = {}) {
  const existingState = payload?.existing_state && typeof payload.existing_state === 'object' ? payload.existing_state : {};
  const hasState = Object.keys(existingState).length > 0;
  if (!hasState) return '';
  const racePhysiologyPrompt = buildRacePhysiologyPrompt(payload || {});
  const metabolismGuide = buildTrackerMetabolismGuide(payload);
  return [
    racePhysiologyPrompt,
    '<bs_biotracker>',
    '[并行生理追踪上下文]',
    '以下内容来自并行运行的女性生理状态追踪支流。',
    '在輸出COT时，需檢查已註冊角色变量来理解角色当下的生理与心理状态。',
    '这些变量是只读上下文，不用于要求你直接修改它们；若剧情没有明确触发变化，不要擅自忽略、覆盖或编造与之冲突的状态。',
    '',
    metabolismGuide,
    '',
    '[当前已注册角色状态]',
    JSON.stringify(existingState),
    '</bs_biotracker>',
  ].join('\n');
}
