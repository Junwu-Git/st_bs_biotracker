// 回归测试：v0.9.2 回报的注册／推演／技能三个问题。
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import * as state from '../scripts/state.js';
import {
  applyRegistrySkillSetup,
  buildRegistrySkillSystemPrompt,
  buildRegistrySystemPrompt,
  normalizeInitialSkillTalentConfig,
  runRegistry,
} from '../scripts/registry.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_FETCH === undefined) delete globalThis.fetch;
  else globalThis.fetch = ORIGINAL_FETCH;
  delete globalThis.SillyTavern;
  delete globalThis.toastr;
});

const CATALOG = [
  { id: 1, name: '剑术', description: '使用长剑进行攻防的实战技巧。' },
  { id: 2, name: '魔力感知', description: '辨识周遭魔力流动的能力。' },
];

test('an unresolvable skill reference is skipped instead of discarding the whole setup', () => {
  // 注册「第一个」角色时图鉴还是空的，模型很容易在 initialTalents 引用
  // 一个没有一并写进 skillDefinitions 的技能名。旧版整份抛错，技能与天赋一起丢失。
  const config = {
    skills: [{ skill: '剑术', level: 3, exp: 0 }, { skill: '不存在的技能', level: 2, exp: 0 }],
    talents: [{ skill: '魔力感知', level: 2, exp: 0 }, { skill: '另一个幽灵技能', level: 1, exp: 0 }],
  };
  const result = normalizeInitialSkillTalentConfig(config, CATALOG);

  assert.deepEqual(result.skills.map((entry) => entry.skillId), [1], '解析得到的技能应保留');
  assert.deepEqual(result.talents.map((entry) => entry.skillId), [2], '解析得到的天赋应保留');
  assert.deepEqual(result.skipped, ['不存在的技能', '另一个幽灵技能'], '跳过的项要回报，不能静默吞掉');
});

test('skipped references are reported to the caller while the rest is written', () => {
  const chatState = state.createEmptyChatState();
  chatState.skillCatalog = CATALOG.map((item) => ({ ...item }));
  chatState.nextSkillId = 3;
  chatState.characters['艾拉'] = { name: '艾拉', initialized: true, profile: { base: {} } };

  const report = {};
  const character = applyRegistrySkillSetup(chatState, '艾拉', {
    skillDefinitions: [],
    initialSkills: [{ skill: '剑术', level: 2, exp: 0 }],
    initialTalents: [{ skill: '幽灵天赋', level: 1, exp: 0 }],
  }, report);

  assert.equal(character.profile.skills.length, 1, '能解析的技能照常写入');
  assert.deepEqual(report.skipped, ['幽灵天赋']);
});

test('the registry prompt pins name to the requested target character', () => {
  const prompt = buildRegistrySystemPrompt({ payload: { target_character: '露比' } });
  assert.match(prompt, /payload\.target_character/);
  assert.match(prompt, /不得改用角色卡名/);
});

test('registration keeps the typed name even when the model returns the card name', async () => {
  const ctx = {
    chatId: 'registry-name-chat',
    name1: 'User',
    name2: '卡片角色',
    characterId: 0,
    characters: [{ name: '卡片角色', description: '角色卡描述', avatar: 'card.png' }],
    chat: [{ is_user: false, name: '卡片角色', mes: '一段剧情。' }],
    extensionSettings: {},
    saveSettingsDebounced() {},
  };
  globalThis.SillyTavern = { getContext: () => ctx };
  const settings = state.getSettings(ctx);
  settings.apiUrl = 'https://example.test/v1';
  settings.model = 'test-model';

  // 模型无视 target_character，回传了角色卡名
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ name: '卡片角色', profile: { base: { age: 20 } } }) } }],
      });
    },
  });

  const character = await runRegistry(ctx, { targetName: '露比' });

  assert.equal(character.name, '露比', '必须使用使用者输入的名字');
  const chatState = state.getChatState(ctx, settings);
  assert.equal(Object.prototype.hasOwnProperty.call(chatState.characters, '露比'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(chatState.characters, '卡片角色'), false, '不该注册成角色卡名');
});

test('the skill prompt spells out that talents also need a defined skill', () => {
  const prompt = buildRegistrySkillSystemPrompt({});
  // 天赋是「对某个技能的擅长／苦手」，模型常把它当成独立的性格标签而漏掉定义
  assert.match(prompt, /天赋同样需要技能作为载体/);
  assert.match(prompt, /initialTalents 引用的技能若不在 payload\.skill_catalog 中，必须先在本次 skillDefinitions 里定义/);
  // 输出前自检，放在 JSON 结构旁边最容易被回顾到
  assert.match(prompt, /输出前请逐条自检/);
});

test('an empty catalog is called out because every reference must be defined in-place', () => {
  const empty = buildRegistrySkillSystemPrompt({ emptyCatalog: true });
  assert.match(empty, /skill_catalog 目前是空的（这是本聊天的第一个角色）/);
  assert.match(empty, /没有任何既有技能可以复用/);
  // 空图鉴时不该再说「只有图鉴无法表达时才能新增」，那会自相矛盾
  assert.doesNotMatch(empty, /只有现有图鉴确实无法表达所需技能时/);

  const normal = buildRegistrySkillSystemPrompt({});
  assert.doesNotMatch(normal, /目前是空的/);
  assert.match(normal, /只有现有图鉴确实无法表达所需技能时/);
});
