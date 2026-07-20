const EMPTY_LIST = Object.freeze([]);
const HOST_CHAT_VIEW_CACHE = new WeakMap();
const HOST_STABLE_CHAT_ID_CACHE = new WeakMap();
const TAURI_HISTORY_PAGE_SIZE = 200;
const TAURI_STATE_NAMESPACE = 'bs-biotracker';
const TAURI_STATE_KEY = 'chat-state-v1';
const TAURI_STATE_SAVE_DELAY_MS = 250;
const TAURI_STATE_SAVE_QUEUE = new Map();
const TAURI_STATE_KNOWN_MISSING_IDS = new Set();
const TAURI_STATE_LOAD_INFLIGHT = new Map();
const HOST_EVENT_TYPE_KEYS = Object.freeze({
  appReady: 'APP_READY',
  chatChanged: 'CHAT_CHANGED',
  chatCreated: 'CHAT_CREATED',
  chatDeleted: 'CHAT_DELETED',
  groupChatCreated: 'GROUP_CHAT_CREATED',
  groupChatDeleted: 'GROUP_CHAT_DELETED',
});

export function getHostKind() {
  if (globalThis.__TAURITAVERN__) return 'tauritavern';
  if (globalThis.Luker?.getContext) return 'luker';
  return 'sillytavern';
}

export function getHostContext() {
  try {
    return globalThis.Luker?.getContext?.() || globalThis.SillyTavern?.getContext?.() || null;
  } catch (error) {
    console.warn('[BS BioTracker] unable to read host context', error);
    return null;
  }
}

export async function getHostAgentRunBarrier(ctx, message) {
  if (getHostKind() !== 'tauritavern') return { state: 'not_applicable', runId: '' };
  const runId = String(message?.extra?.tauritavern?.agent?.runId || '').trim();
  if (!runId) return { state: 'not_applicable', runId: '' };
  const ready = globalThis.__TAURITAVERN__?.ready || globalThis.__TAURITAVERN_MAIN_READY__;
  if (ready && typeof ready.then === 'function') await ready;
  const agentApi = getTauriTavernApi()?.agent;
  if (typeof agentApi?.readEvents !== 'function') return { state: 'pending', runId };
  try {
    const result = await agentApi.readEvents({ runId, limit: 500 });
    const events = Array.isArray(result?.events) ? result.events : [];
    const types = new Set(events.map((event) => String(event?.type || '')));
    if (types.has('run_completed')) return { state: 'completed', runId };
    if (types.has('run_cancelled') || types.has('run_failed')) return { state: 'aborted', runId };
    return { state: 'pending', runId };
  } catch (error) {
    console.warn('[BS BioTracker] unable to read TauriTavern agent run events', error);
    return { state: 'pending', runId };
  }
}

export function subscribeHostEvent(ctx, eventName, handler) {
  const eventSource = ctx?.eventSource;
  const eventTypeKey = HOST_EVENT_TYPE_KEYS[eventName];
  const eventType = eventTypeKey ? ctx?.event_types?.[eventTypeKey] : null;
  if (!eventSource || !eventType || typeof eventSource.on !== 'function' || typeof handler !== 'function') return null;
  const safeHandler = (...args) => {
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error(`[BS BioTracker] host event ${eventName} failed`, error));
      }
    } catch (error) {
      console.error(`[BS BioTracker] host event ${eventName} failed`, error);
    }
  };
  eventSource.on(eventType, safeHandler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (typeof eventSource.off === 'function') eventSource.off(eventType, safeHandler);
  };
}

export function replaceHostEventSubscription(ctx, eventName, previousUnsubscribe, handler) {
  if (typeof previousUnsubscribe === 'function') previousUnsubscribe();
  return subscribeHostEvent(ctx, eventName, handler);
}

export function getHostChat(ctx) {
  const cached = ctx && typeof ctx === 'object' ? HOST_CHAT_VIEW_CACHE.get(ctx) : null;
  if (cached?.chatId === getHostChatId(ctx) && Array.isArray(cached.messages)) return cached.messages;
  return Array.isArray(ctx?.chat) ? ctx.chat : EMPTY_LIST;
}

export function hasAbsoluteHostChatView(ctx) {
  const cached = ctx && typeof ctx === 'object' ? HOST_CHAT_VIEW_CACHE.get(ctx) : null;
  return Boolean(cached?.chatId === getHostChatId(ctx) && cached.absolute === true);
}

function assignHistoryPage(target, page) {
  const startIndex = Math.max(0, Number(page?.startIndex) || 0);
  const messages = Array.isArray(page?.messages) ? page.messages : EMPTY_LIST;
  for (let index = 0; index < messages.length; index += 1) {
    target[startIndex + index] = messages[index];
  }
}

export async function refreshHostChatView(ctx, options = {}) {
  if (getHostKind() !== 'tauritavern') return getHostChat(ctx);
  const ready = globalThis.__TAURITAVERN__?.ready || globalThis.__TAURITAVERN_MAIN_READY__;
  if (ready && typeof ready.then === 'function') await ready;
  const api = getTauriTavernApi()?.chat;
  if (!api?.current?.windowInfo || !api?.current?.handle) return getHostChat(ctx);

  const info = await api.current.windowInfo();
  const totalCount = Math.max(0, Number(info?.totalCount) || 0);
  const contextSize = Math.max(2, Number(options.contextSize) || 12);
  const resumeIndexes = Array.isArray(options.resumeIndexes) ? options.resumeIndexes : [options.afterIndex];
  const afterIndex = resumeIndexes.reduce((latest, value) => {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index <= totalCount && index > latest ? index : latest;
  }, 0);
  const requiredStartIndex = Math.max(0, afterIndex - contextSize);
  const minimumTailSize = Math.max(contextSize, totalCount - requiredStartIndex);
  const handle = api.current.handle();
  let page = await handle.history.tail({ limit: Math.min(TAURI_HISTORY_PAGE_SIZE, Math.max(1, minimumTailSize)) });
  const messages = new Array(totalCount);
  assignHistoryPage(messages, page);

  while (page?.hasMoreBefore && Number(page.startIndex) > requiredStartIndex) {
    page = await handle.history.before(page, { limit: TAURI_HISTORY_PAGE_SIZE });
    assignHistoryPage(messages, page);
  }

  HOST_CHAT_VIEW_CACHE.set(ctx, {
    absolute: true,
    chatId: getHostChatId(ctx),
    messages,
    loadedStartIndex: Math.max(0, Number(page?.startIndex) || 0),
    totalCount,
  });
  return messages;
}

export function getHostCharacters(ctx) {
  return Array.isArray(ctx?.characters) ? ctx.characters : EMPTY_LIST;
}

export function getHostChatId(ctx) {
  const fallbackId = getFallbackHostChatId(ctx);
  if (getHostKind() === 'tauritavern') {
    const cached = ctx && typeof ctx === 'object' ? HOST_STABLE_CHAT_ID_CACHE.get(ctx) : null;
    if (cached?.fallbackId === fallbackId && cached.stableId) return cached.stableId;
  }
  return fallbackId;
}

function getFallbackHostChatId(ctx) {
  try {
    const currentChatId = ctx?.getCurrentChatId?.();
    if (currentChatId !== undefined && currentChatId !== null && String(currentChatId)) {
      return String(currentChatId);
    }
  } catch (error) {
    console.warn('[BS BioTracker] unable to read current chat id', error);
  }
  if (ctx?.chatId !== undefined && ctx?.chatId !== null && String(ctx.chatId)) return String(ctx.chatId);
  return `${ctx?.characterId ?? 'char'}:${ctx?.groupId ?? 'solo'}`;
}

export async function resolveHostChatId(ctx) {
  const fallbackId = getFallbackHostChatId(ctx);
  if (getHostKind() !== 'tauritavern') return fallbackId;
  const cached = ctx && typeof ctx === 'object' ? HOST_STABLE_CHAT_ID_CACHE.get(ctx) : null;
  if (cached?.fallbackId === fallbackId && cached.stableId) return cached.stableId;
  const ready = globalThis.__TAURITAVERN__?.ready || globalThis.__TAURITAVERN_MAIN_READY__;
  if (ready && typeof ready.then === 'function') await ready;
  const handle = getCurrentTauriChatHandle();
  if (typeof handle?.stableId !== 'function') return fallbackId;
  try {
    const stableId = String(await handle.stableId() || '').trim();
    if (!stableId) return fallbackId;
    if (ctx && typeof ctx === 'object') HOST_STABLE_CHAT_ID_CACHE.set(ctx, { fallbackId, stableId });
    return stableId;
  } catch (error) {
    console.warn('[BS BioTracker] unable to resolve TauriTavern stable chat id', error);
    return fallbackId;
  }
}

export function getHostExtensionSettings(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') ctx.extensionSettings = {};
  return ctx.extensionSettings;
}

export function saveHostSettings(ctx) {
  try {
    ctx?.saveSettingsDebounced?.();
  } catch (error) {
    console.warn('[BS BioTracker] unable to save host settings', error);
  }
}

export function getHostChatCompletionSettings(ctx = null) {
  const runtime = ctx || getHostContext();
  const settings = runtime?.chatCompletionSettings;
  return settings && typeof settings === 'object' ? settings : null;
}

export function canLoadHostWorldInfo(ctx) {
  return typeof ctx?.loadWorldInfo === 'function';
}

export async function loadHostWorldInfo(ctx, name) {
  if (!canLoadHostWorldInfo(ctx)) return null;
  return ctx.loadWorldInfo(String(name || ''));
}

export async function getHostWorldBook(name, scope = 'global') {
  const worldBookApi = globalThis.ST_API?.worldBook;
  if (typeof worldBookApi?.get !== 'function') return null;
  const result = await worldBookApi.get({ name: String(name || ''), scope: String(scope || 'global') });
  return result?.worldBook || null;
}

export async function getHostWorldInfoPrompt(ctx, chat, maxContext, includeNames = true) {
  if (typeof ctx?.getWorldInfoPrompt !== 'function') return null;
  return ctx.getWorldInfoPrompt(chat, maxContext, includeNames);
}

export function getHostPresetManager(ctx = null, apiId = 'openai') {
  const runtime = ctx || getHostContext();
  if (typeof runtime?.getPresetManager !== 'function') return null;
  return runtime.getPresetManager(apiId);
}

export async function listHostPresets() {
  const presetApi = globalThis.ST_API?.preset;
  return typeof presetApi?.list === 'function' ? presetApi.list() : null;
}

export async function getHostPreset(name, ctx = null) {
  const presetName = String(name || '').trim();
  if (!presetName) return null;
  const presetApi = globalThis.ST_API?.preset;
  if (typeof presetApi?.get === 'function') {
    const result = await presetApi.get({ name: presetName });
    if (result?.preset && typeof result.preset === 'object') return result.preset;
  }
  if (globalThis.openai_settings && typeof globalThis.openai_settings === 'object') {
    const preset = globalThis.openai_settings[presetName];
    if (preset && typeof preset === 'object') return preset;
  }
  const settings = getHostChatCompletionSettings(ctx);
  if (settings?.[presetName] && typeof settings[presetName] === 'object') return settings[presetName];
  if (settings?.presets?.[presetName] && typeof settings.presets[presetName] === 'object') return settings.presets[presetName];
  return null;
}

export async function registerHostExtensionMenuItem(options) {
  const uiApi = globalThis.ST_API?.ui;
  if (typeof uiApi?.registerExtensionsMenuItem !== 'function') return false;
  await uiApi.registerExtensionsMenuItem(options);
  return true;
}

export function getTauriTavernApi() {
  const api = globalThis.__TAURITAVERN__?.api;
  return api && typeof api === 'object' ? api : null;
}

function cloneHostValue(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function getCurrentTauriChatHandle() {
  const api = getTauriTavernApi()?.chat;
  return typeof api?.current?.handle === 'function' ? api.current.handle() : null;
}

export async function loadHostChatState(ctx = null) {
  const hostKind = getHostKind();
  if (hostKind === 'luker') {
    const runtime = ctx || getHostContext();
    if (typeof runtime?.getChatState !== 'function') return null;
    try {
      const stored = await runtime.getChatState(TAURI_STATE_NAMESPACE);
      if (stored?.version === 1 && stored.chatState && typeof stored.chatState === 'object') return cloneHostValue(stored.chatState);
    } catch (error) {
      console.warn('[BS BioTracker] unable to load Luker chat state', error);
    }
    return null;
  }
  if (hostKind !== 'tauritavern') return null;
  const ready = globalThis.__TAURITAVERN__?.ready || globalThis.__TAURITAVERN_MAIN_READY__;
  if (ready && typeof ready.then === 'function') await ready;
  const handle = getCurrentTauriChatHandle();
  if (typeof handle?.store?.getJson !== 'function') return null;
  // TT surfaces every backend store miss as an error toast, so remember chats
  // without stored state and skip repeat probes until our own save creates one.
  const chatId = await resolveHostChatId(ctx);
  if (TAURI_STATE_KNOWN_MISSING_IDS.has(chatId)) return null;
  const inflight = TAURI_STATE_LOAD_INFLIGHT.get(chatId);
  if (inflight) return inflight;
  const loadPromise = (async () => {
    try {
      const stored = await handle.store.getJson({ namespace: TAURI_STATE_NAMESPACE, key: TAURI_STATE_KEY });
      if (stored?.version === 1 && stored.chatState && typeof stored.chatState === 'object') {
        return cloneHostValue(stored.chatState);
      }
    } catch (error) {
      if (/not found/i.test(String(error?.message || error))) {
        TAURI_STATE_KNOWN_MISSING_IDS.add(chatId);
      } else {
        console.warn('[BS BioTracker] unable to load TauriTavern chat state', error);
      }
    }
    return null;
  })();
  TAURI_STATE_LOAD_INFLIGHT.set(chatId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    TAURI_STATE_LOAD_INFLIGHT.delete(chatId);
  }
}

export function scheduleHostChatStateSave(ctx, chatState) {
  const hostKind = getHostKind();
  if (!chatState || typeof chatState !== 'object') return;
  if (hostKind === 'luker') {
    if (typeof ctx?.updateChatState !== 'function') return;
    const chatId = getHostChatId(ctx);
    const previous = TAURI_STATE_SAVE_QUEUE.get(chatId);
    if (previous?.timer) clearTimeout(previous.timer);
    const payload = { version: 1, chatState: cloneHostValue(chatState) };
    const timer = setTimeout(async () => {
      const queued = TAURI_STATE_SAVE_QUEUE.get(chatId);
      if (!queued || queued.timer !== timer) return;
      TAURI_STATE_SAVE_QUEUE.delete(chatId);
      try {
        await queued.ctx.updateChatState(TAURI_STATE_NAMESPACE, () => queued.payload);
      } catch (error) {
        console.warn('[BS BioTracker] unable to save Luker chat state', error);
      }
    }, TAURI_STATE_SAVE_DELAY_MS);
    TAURI_STATE_SAVE_QUEUE.set(chatId, { ctx, payload, timer });
    return;
  }
  if (hostKind !== 'tauritavern') return;
  const handle = getCurrentTauriChatHandle();
  if (typeof handle?.store?.setJson !== 'function') return;
  const chatId = getHostChatId(ctx);
  TAURI_STATE_KNOWN_MISSING_IDS.delete(chatId);
  const previous = TAURI_STATE_SAVE_QUEUE.get(chatId);
  if (previous?.timer) clearTimeout(previous.timer);
  const payload = { version: 1, chatState: cloneHostValue(chatState) };
  const timer = setTimeout(async () => {
    const queued = TAURI_STATE_SAVE_QUEUE.get(chatId);
    if (!queued || queued.timer !== timer) return;
    TAURI_STATE_SAVE_QUEUE.delete(chatId);
    try {
      await queued.handle.store.setJson({
        namespace: TAURI_STATE_NAMESPACE,
        key: TAURI_STATE_KEY,
        value: queued.payload,
      });
    } catch (error) {
      console.warn('[BS BioTracker] unable to save TauriTavern chat state', error);
    }
  }, TAURI_STATE_SAVE_DELAY_MS);
  TAURI_STATE_SAVE_QUEUE.set(chatId, { handle, payload, timer });
}
