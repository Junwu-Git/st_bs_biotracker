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
