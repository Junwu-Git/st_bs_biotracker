// 代孕／寄生：胎儿带 provider 时，孩子必须归到提供者名下而不是凭空消失。
import assert from 'node:assert/strict';
import test from 'node:test';

import * as state from '../scripts/state.js';
import { applyToolCall } from '../scripts/tools.js';

function makeCharacter(name, fetuses = []) {
  return {
    name,
    initialized: true,
    profile: {
      base: { stage: fetuses.length > 0 ? '孕晚期' : '卵泡期', days: 0, race: '人类', vitality: 100 },
      pregnant: {
        pregnantDays: 240,
        effectivePregnantDays: 240,
        fetusesCount: fetuses.length,
        fetuses,
        fetalEnergyDrain: 1,
        amnionDurability: 100,
      },
      bio: { birthDifficulty: 1, breedTolerance: 1 },
      immune: {},
      metabolism: {},
      children: [],
      notify: {},
    },
  };
}

function makeFetus(overrides = {}) {
  return {
    fathers: '莱昂',
    provider: null,
    race: '人类',
    gender: '女',
    embryoType: '胎生',
    weight: 1,
    tendencyAngle: 0,
    affinity: 0,
    ...overrides,
  };
}

const childrenOf = (chatState, name) => chatState.characters[name].profile.children || [];

test('a surrogate birth hands the child to the registered provider', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['代孕者'] = makeCharacter('代孕者', [makeFetus({ provider: '委托母亲' })]);
  chatState.characters['委托母亲'] = makeCharacter('委托母亲');

  const result = applyToolCall(chatState, { name: 'bsChildbirth', arguments: { female: '代孕者' } });

  assert.equal(result.applied, true);
  // 先前这里是 continue：孩子既不给承载者、也不给提供者，直接消失
  assert.equal(childrenOf(chatState, '代孕者').length, 0, '承载者不该获得孩子');
  const received = childrenOf(chatState, '委托母亲');
  assert.equal(received.length, 1, '孩子必须转交给提供者');
  assert.equal(received[0].fathers, '莱昂');
  assert.equal(received[0].provider ?? null, null, '已在正确的人名下就不必再留标记');
});

test('an unregistered provider keeps the child on the host with its marker', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['宿主'] = makeCharacter('宿主', [makeFetus({ provider: '虫母', race: '虫族' })]);

  const result = applyToolCall(chatState, { name: 'bsChildbirth', arguments: { female: '宿主' } });

  assert.equal(result.applied, true);
  const kept = childrenOf(chatState, '宿主');
  // 提供者没注册就无处可转，但绝不能像先前那样丢掉
  assert.equal(kept.length, 1, '无处可转时也必须保留记录');
  assert.equal(kept[0].provider, '虫母', '保留标记，日后仍可辨认归属');
  assert.equal(kept[0].race, '虫族');
});

test('an ordinary birth still lands on the mother herself', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['艾拉'] = makeCharacter('艾拉', [makeFetus()]);

  applyToolCall(chatState, { name: 'bsChildbirth', arguments: { female: '艾拉' } });

  const own = childrenOf(chatState, '艾拉');
  assert.equal(own.length, 1, '没有 provider 的孩子照常记在自己名下');
  assert.equal(own[0].provider ?? null, null);
});

test('the provider marker survives chat-state persistence', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['宿主'] = makeCharacter('宿主');
  chatState.characters['宿主'].profile.children = [{
    name: null, fathers: '未知', provider: '虫母', gender: '女',
    race: '虫族', derivedType: null, age: 0,
    birthWeightRatio: 1, birthAffinity: 0, talents: [],
  }];

  // 走一次工具调用触发正规化，确认 provider 不会在存档流程中被剥掉
  applyToolCall(chatState, { name: 'bsPassedTime', arguments: { minute: 1 } });

  assert.equal(childrenOf(chatState, '宿主')[0].provider, '虫母');
});

function makeHost(name, race = '人类') {
  const character = makeCharacter(name);
  character.profile.base.race = race;
  character.profile.base.stage = '卵泡期';
  character.profile.pregnant.fetuses = [];
  character.profile.pregnant.fetusesCount = 0;
  return character;
}

test('implanting marks every embryo with its provider and starts the pregnancy', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['代孕者'] = makeHost('代孕者');
  chatState.characters['委托母亲'] = makeHost('委托母亲');

  const result = applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '代孕者', provider: '委托母亲', fathers: '委托父亲', count: 2 },
  });

  assert.equal(result.applied, true);
  const carrier = chatState.characters['代孕者'].profile;
  assert.equal(carrier.base.stage, '孕早期');
  assert.equal(carrier.pregnant.fetuses.length, 2);
  for (const fetus of carrier.pregnant.fetuses) {
    assert.equal(fetus.provider, '委托母亲', '每个胚胎都要记住归属');
    assert.equal(fetus.fathers, '委托父亲');
  }
});

test('embryo race follows the provider, not the carrier', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['宿主'] = makeHost('宿主', '人类');
  chatState.characters['虫母'] = makeHost('虫母', '虫族');

  applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '宿主', provider: '虫母', count: 1 },
  });

  // 必须精确比对：按承载者算会得到「人类x虫族」，光用 /虫族/ 匹配是抓不出来的
  const fetus = chatState.characters['宿主'].profile.pregnant.fetuses[0];
  assert.equal(fetus.race, '虫族', `胚胎应是纯虫族血统，实际为 ${fetus.race}`);
});

test('same-race parents do not produce a self-hybrid race', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['代孕者'] = makeHost('代孕者', '人类');
  chatState.characters['委托母亲'] = makeHost('委托母亲', '人类');

  applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '代孕者', provider: '委托母亲', fathers: '委托父亲' },
  });

  // deriveFetusRace 少了去重时，同族生育会得到「人类x人类」
  assert.equal(chatState.characters['代孕者'].profile.pregnant.fetuses[0].race, '人类');
});

test('a cross-species father still hybridises with the genetic mother', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['宿主'] = makeHost('宿主', '人类');
  chatState.characters['虫母'] = makeHost('虫母', '虫族');

  applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '宿主', provider: '虫母', fathers: '精灵战士', fatherRace: '精灵' },
  });

  const race = String(chatState.characters['宿主'].profile.pregnant.fetuses[0].race);
  assert.match(race, /虫族/);
  assert.match(race, /精灵/);
  assert.doesNotMatch(race, /人类/, '承载者的种族不该混进血统');
});

test('an unregistered provider can still supply the race explicitly', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['宿主'] = makeHost('宿主', '人类');

  applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '宿主', provider: '深渊母巢', race: '虫族', count: 3 },
  });

  const fetuses = chatState.characters['宿主'].profile.pregnant.fetuses;
  assert.equal(fetuses.length, 3);
  assert.match(String(fetuses[0].race), /虫族/);
  assert.equal(fetuses[0].provider, '深渊母巢');
});

test('implanting is refused when the carrier is already pregnant', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['艾拉'] = makeCharacter('艾拉', [makeFetus()]);
  chatState.characters['委托母亲'] = makeHost('委托母亲');

  const result = applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '艾拉', provider: '委托母亲' },
  });

  assert.equal(result.applied, false);
  assert.match(result.message, /already exists/);
});

test('implanting is refused when the provider is the carrier herself', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['艾拉'] = makeHost('艾拉');

  const result = applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '艾拉', provider: '艾拉' },
  });

  assert.equal(result.applied, false);
  assert.match(result.message, /must differ/);
});

test('an implanted pregnancy carried to term hands the children back', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters['代孕者'] = makeHost('代孕者');
  chatState.characters['委托母亲'] = makeHost('委托母亲');

  applyToolCall(chatState, {
    name: 'bsImplantEmbryo',
    arguments: { female: '代孕者', provider: '委托母亲', fathers: '委托父亲', count: 2 },
  });
  applyToolCall(chatState, { name: 'bsChildbirth', arguments: { female: '代孕者' } });

  // 端到端：植入 → 分娩 → 孩子回到委托方
  assert.equal(childrenOf(chatState, '代孕者').length, 0);
  assert.equal(childrenOf(chatState, '委托母亲').length, 2);
});

test('the rupture tool is hidden until someone can actually rupture', async () => {
  const { getTrackerToolDefinitions } = await import('../scripts/tracker.js');
  const settings = { diaryRecentLimit: 0 };
  const names = (existing) => getTrackerToolDefinitions(settings, existing).map((tool) => tool.name);

  // 平时挂着只是占用模型注意力，且执行层本来就会拒绝
  assert.equal(names({ 艾拉: { profile: { base: { stage: '卵泡期' } } } }).includes('bsRuptureMembranes'), false);
  assert.equal(names({ 艾拉: { profile: { base: { stage: '孕晚期' } } } }).includes('bsRuptureMembranes'), false);

  for (const stage of ['产兆前驱', '第一产程', '第二产程']) {
    assert.equal(
      names({ 艾拉: { profile: { base: { stage } } } }).includes('bsRuptureMembranes'),
      true,
      `${stage} 应提供破水工具`,
    );
  }
});
