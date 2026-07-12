import assert from 'node:assert/strict';
import test from 'node:test';

import * as host from '../scripts/host.js';
import * as state from '../scripts/state.js';
import * as raceConfig from '../scripts/race_config.js';
import { getTrackerToolDefinitions, isFailedAutoRetryBlocked } from '../scripts/tracker.js';
import { buildTrackerSystemPrompt } from '../scripts/tracker_prompt_context.js';
import { applyToolCall } from '../scripts/tools.js';
import { buildRegistrySystemPrompt, buildWardrobePrepSystemPrompt, normalizeBreedingInferenceResult } from '../scripts/registry.js';

function resetGlobals() {
  delete globalThis.__TAURITAVERN__;
  delete globalThis.__TAURITAVERN_MAIN_READY__;
  delete globalThis.SillyTavern;
  delete globalThis.ST_API;
  delete globalThis.openai_settings;
}

test('standard SillyTavern keeps chatStates in extensionSettings', () => {
  resetGlobals();
  const ctx = {
    chatId: 'standard-chat',
    extensionSettings: {},
    saveSettingsDebounced() {},
  };
  globalThis.SillyTavern = { getContext: () => ctx };
  const settings = state.getSettings(ctx);
  assert.equal(Object.prototype.propertyIsEnumerable.call(settings, 'chatStates'), true);
  assert.equal(state.getChatKey(ctx), 'standard-chat');
  assert.match(JSON.stringify(settings), /"chatStates"/);
});

test('TauriTavern uses stableId and per-chat store without persisting chatStates globally', async () => {
  resetGlobals();
  let saved = null;
  const handle = {
    stableId: async () => 'stable-chat-42',
    store: {
      getJson: async () => ({
        version: 1,
        chatState: { characters: { Alice: { initialized: true } }, snapshots: [] },
      }),
      setJson: async ({ value }) => { saved = value; },
    },
  };
  const ctx = {
    chatId: 'fallback-chat',
    extensionSettings: {},
    saveSettingsDebounced() {},
  };
  globalThis.SillyTavern = { getContext: () => ctx };
  globalThis.__TAURITAVERN__ = {
    ready: Promise.resolve(),
    api: { chat: { current: { handle: () => handle } } },
  };

  const settings = state.getSettings(ctx);
  assert.equal(Object.prototype.propertyIsEnumerable.call(settings, 'chatStates'), false);
  assert.doesNotMatch(JSON.stringify(settings), /"chatStates"/);
  assert.equal(await state.hydrateChatStateFromHost(ctx, settings), true);
  assert.equal(state.getChatKey(ctx), 'stable-chat-42');
  state.saveSettings(ctx);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(saved?.chatState?.characters?.Alice?.initialized, true);
});

test('TauriTavern history view preserves absolute message indexes', async () => {
  resetGlobals();
  const messages = Array.from({ length: 450 }, (_, index) => ({ mes: `m${index}` }));
  const makePage = (start, end) => ({
    startIndex: start,
    totalCount: messages.length,
    messages: messages.slice(start, end),
    cursor: start,
    hasMoreBefore: start > 0,
  });
  const handle = {
    history: {
      tail: async ({ limit }) => makePage(Math.max(0, messages.length - limit), messages.length),
      before: async (page, { limit }) => makePage(Math.max(0, page.startIndex - limit), page.startIndex),
    },
  };
  const ctx = { chatId: 'history-chat', chat: messages.slice(-20) };
  globalThis.SillyTavern = { getContext: () => ctx };
  globalThis.__TAURITAVERN__ = {
    ready: Promise.resolve(),
    api: {
      chat: {
        current: {
          windowInfo: async () => ({ totalCount: messages.length }),
          handle: () => handle,
        },
      },
    },
  };

  const view = await host.refreshHostChatView(ctx, { resumeIndexes: [300], contextSize: 12 });
  assert.equal(view.length, 450);
  assert.equal(view[288]?.mes, 'm288');
  assert.equal(view[449]?.mes, 'm449');
  assert.equal(view[287], undefined);
});

test('host facades preserve API receivers and replace event subscriptions', async () => {
  resetGlobals();
  const listeners = new Map();
  globalThis.ST_API = {
    worldBook: {
      marker: 'worldbook',
      async get({ name }) {
        assert.equal(this.marker, 'worldbook');
        return { worldBook: { name } };
      },
    },
    preset: {
      marker: 'preset',
      async list() {
        assert.equal(this.marker, 'preset');
        return { presets: [] };
      },
      async get({ name }) {
        assert.equal(this.marker, 'preset');
        return { preset: { name } };
      },
    },
  };
  const ctx = {
    event_types: { CHAT_CHANGED: 'chat-changed' },
    eventSource: {
      on(type, handler) { listeners.set(type, handler); },
      off(type, handler) {
        if (listeners.get(type) === handler) listeners.delete(type);
      },
    },
  };

  assert.equal((await host.getHostWorldBook('book'))?.name, 'book');
  assert.equal((await host.getHostPreset('preset'))?.name, 'preset');
  await host.listHostPresets();
  let count = 0;
  let unsubscribe = host.replaceHostEventSubscription(ctx, 'chatChanged', null, () => { count += 1; });
  listeners.get('chat-changed')();
  unsubscribe = host.replaceHostEventSubscription(ctx, 'chatChanged', unsubscribe, () => { count += 10; });
  listeners.get('chat-changed')();
  unsubscribe();
  assert.equal(count, 11);
  assert.equal(listeners.has('chat-changed'), false);
});

test('failed automatic request is blocked only for the same last message', () => {
  resetGlobals();
  const ctx = {
    chatId: 'retry-chat',
    chat: [{ is_user: false, name: 'Alice', mes: 'first reply' }],
  };
  globalThis.SillyTavern = { getContext: () => ctx };
  const chatState = state.createEmptyChatState();
  chatState.lastFailedSignature = state.buildSignature(ctx, ctx.chat.length);
  assert.equal(isFailedAutoRetryBlocked(ctx, chatState), true);
  ctx.chat.push({ is_user: false, name: 'Alice', mes: 'new reply' });
  assert.equal(isFailedAutoRetryBlocked(ctx, chatState), false);
});

test('chat state counting ignores empty stored keys', () => {
  assert.equal(state.isChatStateEffectivelyEmpty(state.createEmptyChatState()), true);
  const populated = state.createEmptyChatState();
  populated.characters.Alice = { initialized: true };
  assert.equal(state.isChatStateEffectivelyEmpty(populated), false);
});

test('tracker token budget defaults to 4096 and is clamped', () => {
  resetGlobals();
  const ctx = { chatId: 'token-budget', extensionSettings: {}, saveSettingsDebounced() {} };
  globalThis.SillyTavern = { getContext: () => ctx };
  const settings = state.getSettings(ctx);
  assert.equal(settings.trackerTokenBudget, 4096);
  settings.trackerTokenBudget = 999999;
  assert.equal(state.getSettings(ctx).trackerTokenBudget, 100000);
  assert.equal(settings.requireFullDescriptionUpdates, false);
});

test('full description update mode adds the strict tracker instruction', () => {
  const prompt = buildTrackerSystemPrompt('', null, { require_full_description_updates: true });
  assert.equal(prompt.includes('[descriptions 完整更新模式：强制提示约束]'), true);
  assert.equal(prompt.includes('所有既有子字段'), true);
});

test('wardrobe preparation treats upper and lower garments as one main outfit', () => {
  const prompt = buildWardrobePrepSystemPrompt({}, { wardrobePrepMainCount: 3, wardrobePrepAccessoryCount: 2 });
  assert.equal(prompt.includes('完整套装，不是单件'), true);
  assert.equal(prompt.includes('把上衣与下着合并为同一个 main'), true);
});

test('psychology tool is hidden until a character has breeding stage profiles', () => {
  const settings = { diaryRecentLimit: 0 };
  const hidden = getTrackerToolDefinitions(settings, {
    Alice: { profile: { psychology: { stageProfiles: {} } } },
  });
  assert.equal(hidden.some((tool) => tool.name === 'bsUpdatePsychology'), false);
  const visible = getTrackerToolDefinitions(settings, {
    Alice: { profile: { psychology: { stageProfiles: { mens: { mastery: { 0: '自定义表现' } } } } } },
  });
  assert.equal(visible.some((tool) => tool.name === 'bsUpdatePsychology'), true);
});

test('tracker prompt omits psychology guidance when no breeding inference exists', () => {
  const prompt = buildTrackerSystemPrompt('', null, {
    diary_enabled: true,
    wardrobe_enabled: false,
    breeding_psychology_enabled: false,
  });
  assert.equal(prompt.includes('[psychology]'), false);
  assert.equal(prompt.includes('bsUpdatePsychology'), false);
});

test('wardrobe and psychology tools reject targets without their opt-in state', () => {
  const chatState = state.createEmptyChatState();
  chatState.characters.Alice = state.createDefaultFemaleState('Alice');
  assert.equal(applyToolCall(chatState, {
    name: 'bsAddWardrobeItem',
    arguments: { female: 'Alice', item: { id: 1, name: '外套', note: '黑色外套', slot: 'main', masking: 1, support: 0, capacity: 1, convenience: 1 } },
  }).applied, false);
  assert.equal(applyToolCall(chatState, {
    name: 'bsUpdatePsychology',
    arguments: { female: 'Alice', options: { mens: { mastery: 1 } } },
  }).applied, false);
});

test('breeding inference accepts psychology-wrapped stage profiles', () => {
  const stageProfiles = { mens: { mastery: { 0: '自定义表现' } } };
  const normalized = normalizeBreedingInferenceResult({
    profile: { psychology: { mens: { mastery_value: 42 }, stageProfiles } },
  });
  assert.equal(normalized.mens.mastery_value, 42);
  assert.equal(normalized.stageProfiles, stageProfiles);
});

test('registry prompt delegates diary writing to the dedicated diary flow', () => {
  const prompt = buildRegistrySystemPrompt({}, { includeBreedingPsychology: false });
  assert.equal(prompt.includes('首篇日记'), false);
  assert.equal(prompt.includes('"diary"'), false);
});

test('derived type overrides affect base types and custom subtypes', () => {
  raceConfig.setDerivedTypeOverrides({
    不死: {
      introductionLine: '亡者衍生类型的简短说明。',
      fluxDefinition: '自定义描述',
      inheritanceSpeed: 3.5,
      metabolismExemptions: ['hunger', 'sleep'],
    },
  });
  assert.equal(raceConfig.getDerivedTypeFluxProfile('不死-僵尸').fluxName, '死气');
  assert.equal(raceConfig.getDerivedTypeIntroductionLine('不死-僵尸'), '亡者衍生类型的简短说明。');
  assert.equal(raceConfig.getDerivedTypeFluxProfile('不死').fluxDefinition, '自定义描述');
  assert.equal(raceConfig.getDerivedTypeInheritanceProfile('不死-僵尸').inheritanceSpeed, 3.5);
  assert.deepEqual(raceConfig.getDerivedTypeMetabolismExemptions('不死'), ['odor', 'sleep', 'milk']);
  assert.equal(raceConfig.getDerivedTypeOverride('不死-僵尸').metabolismExemptions, undefined);
  raceConfig.setDerivedTypeOverrides({});
  assert.equal(raceConfig.getDerivedTypeFluxProfile('不死').fluxName, '死气');
  assert.equal(raceConfig.getDerivedTypeIntroductionLine('不死'), '');
});
