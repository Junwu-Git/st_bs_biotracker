import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { callOpenAICompatible, fetchModelList } from '../scripts/api.js';

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
