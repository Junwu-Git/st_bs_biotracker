// 种族名录回归：词汇表是否真的进入两条提示词，以及开关能否关掉。
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRaceCatalogBlock } from '../scripts/race_prompt_context.js';
import { getDerivedTypeIntroductionLine, getRaceIntroductionLine } from '../scripts/race_config.js';
import { buildTrackerSystemPrompt } from '../scripts/tracker_prompt_context.js';
import { buildRegistrySystemPrompt } from '../scripts/registry.js';

test('名录涵盖全部内建种族与衍生类型', () => {
  const block = buildRaceCatalogBlock();
  for (const race of ['人类', '鱼人', '人鱼', '空鲸', '史萊姆', '深潜者']) {
    assert.ok(block.includes(race), `名录应含 ${race}`);
  }
  for (const derived of ['血族', '序列', '器灵']) {
    assert.ok(block.includes(derived), `名录应含衍生类型 ${derived}`);
  }
  assert.ok(block.includes('不要自创种族名'), '应指示不要自创种族名');
});

test('紧凑模式不带辨识提示，注册模式带', () => {
  const compact = buildRaceCatalogBlock();
  const hinted = buildRaceCatalogBlock({ withHints: true });
  assert.equal(compact.includes('Fishfolk'), false, '紧凑模式不应带提示');
  assert.ok(hinted.includes('鱼人(Fishfolk，人形而带鱼类特徵与粗尾鳍)'), '注册模式应带提示');
  // 短敘述以英文原名开头时，提示不能只剩英文
  assert.ok(hinted.includes('精灵(Elf，长寿的尖耳亚人)'), '提示应至少含一句中文');
  assert.ok(hinted.length > compact.length);
});

test('追踪系统提示词默认带名录，payload 旗标可关闭', () => {
  const on = buildTrackerSystemPrompt('base', null, { race_catalog_enabled: true });
  assert.ok(on.includes('[可用种族名录]'), '默认应带名录');
  const off = buildTrackerSystemPrompt('base', null, { race_catalog_enabled: false });
  assert.equal(off.includes('[可用种族名录]'), false, '关闭后不应带名录');
});

test('注册系统提示词默认带名录，设定可关闭', () => {
  const on = buildRegistrySystemPrompt({}, {});
  assert.ok(on.includes('[可用种族名录]'), '默认应带名录');
  assert.ok(on.includes('鱼人(Fishfolk，人形而带鱼类特徵与粗尾鳍)'), '注册应带辨识提示');
  const off = buildRegistrySystemPrompt({ raceCatalogInPrompt: false }, {});
  assert.equal(off.includes('[可用种族名录]'), false, '关闭后不应带名录');
});

test('衍生类型有内建短敘述并进入名录', () => {
  for (const type of ['器灵', '序列', '星际']) {
    assert.ok(getDerivedTypeIntroductionLine(type), `衍生类型 ${type} 应有内建短敘述`);
  }
  const hinted = buildRaceCatalogBlock({ withHints: true });
  assert.ok(hinted.includes('序列(ABO'), '名录应带衍生类型提示');
});

test('短敘述与名录提示都走使用者覆写', async () => {
  const { setRacePhysiologyOverrides } = await import('../scripts/race_config.js');
  try {
    setRacePhysiologyOverrides({ 精灵: { introductionLine: '本世界的精灵全为扶她。' } });
    assert.equal(getRaceIntroductionLine('精灵'), '本世界的精灵全为扶她。');
    assert.ok(buildRaceCatalogBlock({ withHints: true }).includes('精灵(本世界的精灵全为扶她)'), '名录提示应跟随覆写');
  } finally {
    setRacePhysiologyOverrides({});
  }
});
