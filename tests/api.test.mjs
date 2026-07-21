import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { callOpenAICompatible, fetchModelList, isApiTimeoutError, resolveApiTimeoutMs } from '../scripts/api.js';

const ORIGINAL_GLOBALS = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  document: globalThis.document,
  location: globalThis.location,
  SillyTavern: globalThis.SillyTavern,
};

afterEach(() => {
  Object.entries(ORIGINAL_GLOBALS).forEach(([key, value]) => {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  });
});

function installBrowserHost(fetchImpl) {
  globalThis.window = {};
  globalThis.document = { cookie: 'csrf_token=test-csrf' };
  globalThis.location = {
    origin: 'http://localhost:8000',
    href: 'http://localhost:8000/',
  };
  globalThis.SillyTavern = {
    getContext: () => null,
    getRequestHeaders: () => ({ 'X-ST-Header': 'host-value' }),
  };
  globalThis.fetch = fetchImpl;
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(data);
    },
  };
}

test('fetchModelList uses the SillyTavern backend proxy for a cross-origin API', async () => {
  const calls = [];
  installBrowserHost(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ response: JSON.stringify({ models: [{ name: 'grok-4' }, 'ollama-local'] }) });
  });

  const models = await fetchModelList({
    apiUrl: 'https://example-model-host.test/v1',
    apiKey: '',
  });

  assert.deepEqual(models, ['grok-4', 'ollama-local']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/backends/chat-completions/status');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-ST-Header'], 'host-value');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'test-csrf');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_completion_source, 'custom');
  assert.equal(body.custom_url, 'https://example-model-host.test/v1');
  assert.equal(body.reverse_proxy, 'https://example-model-host.test/v1');
  assert.equal(body.proxy_password, '');
});

test('callOpenAICompatible sends chat completions through the SillyTavern backend proxy', async () => {
  const calls = [];
  installBrowserHost(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ operations: [] }) } }],
    });
  });

  const result = await callOpenAICompatible({
    apiUrl: 'https://example-model-host.test/v1/chat/completions',
    apiKey: 'secret-key',
    model: 'grok-compatible',
  }, { recent_messages: [] }, 'Return JSON.');

  assert.deepEqual(result, { operations: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/backends/chat-completions/generate');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_completion_source, 'custom');
  assert.equal(body.custom_url, 'https://example-model-host.test/v1');
  assert.equal(body.proxy_password, 'secret-key');
  assert.equal(body.custom_include_headers, 'Authorization: Bearer secret-key');
  assert.equal(body.model, 'grok-compatible');
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(Array.isArray(body.messages), true);
});

test('fetchModelList falls back to direct access when the SillyTavern proxy returns 403', async () => {
  const calls = [];
  installBrowserHost(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/backends/chat-completions/status') {
      return {
        ok: false,
        status: 403,
        async text() {
          return '<!DOCTYPE html><pre>Forbidden</pre>';
        },
      };
    }
    assert.equal(url, 'https://relay.example.test/v1/models');
    return jsonResponse({ data: [{ id: 'relay-model' }] });
  });

  const models = await fetchModelList({
    apiUrl: 'https://relay.example.test/v1',
    apiKey: 'relay-key',
  });

  assert.deepEqual(models, ['relay-model']);
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/backends/chat-completions/status',
    'https://relay.example.test/v1/models',
  ]);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer relay-key');
});

test('callOpenAICompatible falls back to direct access when the SillyTavern proxy returns 403', async () => {
  const calls = [];
  installBrowserHost(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/backends/chat-completions/generate') {
      return {
        ok: false,
        status: 403,
        async text() {
          return '<!DOCTYPE html><pre>Forbidden</pre>';
        },
      };
    }
    assert.equal(url, 'https://relay.example.test/v1/chat/completions');
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ operations: [] }) } }],
    });
  });

  const result = await callOpenAICompatible({
    apiUrl: 'https://relay.example.test/v1',
    apiKey: 'relay-key',
    model: 'relay-model',
  }, { recent_messages: [] }, 'Return JSON.');

  assert.deepEqual(result, { operations: [] });
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/backends/chat-completions/generate',
    'https://relay.example.test/v1/chat/completions',
  ]);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer relay-key');
});

test('callOpenAICompatible aborts a hanging request instead of waiting forever', async () => {
  const calls = [];
  installBrowserHost((url, options) => {
    calls.push({ url, options });
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
  });

  await assert.rejects(
    callOpenAICompatible({
      apiUrl: 'https://relay.example.test/v1',
      apiKey: 'relay-key',
      model: 'relay-model',
      apiTimeoutMs: 1000,
    }, { recent_messages: [] }, 'Return JSON.'),
    (error) => isApiTimeoutError(error) && /自动终止/.test(error.message),
  );

  // 超时不重试，只发一次；也不会退回直连再卡一轮
  assert.deepEqual(calls.map((call) => call.url), ['/api/backends/chat-completions/generate']);
});

test('resolveApiTimeoutMs clamps input and treats 0 as unlimited', () => {
  assert.equal(resolveApiTimeoutMs({}), 180000);
  assert.equal(resolveApiTimeoutMs({ apiTimeoutMs: 0 }), 0);
  assert.equal(resolveApiTimeoutMs({ apiTimeoutMs: 500 }), 1000);
  assert.equal(resolveApiTimeoutMs({ apiTimeoutMs: 99999999 }), 1800000);
});
