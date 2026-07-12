import assert from 'node:assert/strict';
import test from 'node:test';

import * as host from '../scripts/host.js';
import * as state from '../scripts/state.js';
import { isFailedAutoRetryBlocked } from '../scripts/tracker.js';

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
