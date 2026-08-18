// 回归测试：跨插件握手抑制组件注入引发的重复分析。
//
// A 插件 st-end-component-generator 在文尾组件注入完成后写入
// globalThis.__st_message_component_injected__ = { chatLength, at, source }。
// B 插件在 poll 守卫链里检测到信号且 chatLength 与当前 chat.length 相等、
// 且已分析过该楼层计数时，采纳注入后内容为已处理基线并跳过本轮重复分析。
//
// 上一版用 messageId 匹配，但标准 SillyTavern 的 chat 消息对象没有 .id 字段，
// 导致信号 messageId 恒为 ''、守卫 if ('' && ...) 恒 false，整条守卫形同虚设。
// 这里 makeCtx 的 chat 消息一律不带 .id，正是上一版漏掉的回归点。
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import * as state from '../scripts/state.js';
import { runTracker } from '../scripts/tracker.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_FETCH === undefined) delete globalThis.fetch;
  else globalThis.fetch = ORIGINAL_FETCH;
  delete globalThis.SillyTavern;
  delete globalThis.toastr;
  delete globalThis.__st_message_component_injected__;
});

const AFTER_AI_SETTLE_MS = 1400;
const sleepPastSettle = () => new Promise((resolve) => { setTimeout(resolve, AFTER_AI_SETTLE_MS + 200); });

function makeDeps() {
  return { renderStatusPanel() {}, updateMainFlowPrompt() {} };
}

// chat 消息一律不带 .id 字段，模拟标准 SillyTavern（上一版 bug 的触发条件）。
function setup(extraChat = []) {
  const chat = extraChat.length
    ? extraChat
    : [{ is_user: false, name: 'Alice', mes: 'previous reply' }];
  const ctx = {
    chatId: 'injection-guard-chat',
    chat,
    extensionSettings: {},
    saveSettingsDebounced() {},
  };
  globalThis.SillyTavern = { getContext: () => ctx };
  const settings = state.getSettings(ctx);
  settings.enabled = true;
  settings.triggerTiming = 'after_ai';
  settings.apiUrl = 'https://example.invalid/v1';
  settings.apiKey = 'k';
  settings.model = 'test-model';
  state.getChatState(ctx, settings).characters['艾拉'] = {
    name: '艾拉', initialized: true, profile: { base: {} },
  };

  const state_ = { requests: 0 };
  globalThis.fetch = async () => {
    state_.requests += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tool_calls: [] }) } }] });
      },
    };
  };
  return { ctx, counter: state_ };
}

function setInjectionSignal(chatLength) {
  globalThis.__st_message_component_injected__ = {
    chatLength,
    at: Date.now(),
    source: 'st-end-component-generator',
  };
}

// after_ai 模式下首轮 poll 只会建立 pendingAssistantSignature 并返回 message_not_settled，
// 信号守卫在它之后，因此首轮不会消费信号；睡过 settle 时间后再 poll 才会抵达信号守卫。
async function settleAndPoll(ctx, deps) {
  await runTracker(ctx, deps, 'poll');
  await sleepPastSettle();
  return runTracker(ctx, deps, 'poll');
}

test('B 已分析过该楼层计数时，组件注入信号使其跳过且不发请求', async () => {
  const { ctx, counter } = setup();
  // 先用 manual 把现有助手楼层追踪完，留下 messageCount=1 的快照
  await runTracker(ctx, makeDeps(), 'manual');
  counter.requests = 0;

  // A 插件注入完成，写入手写信号
  setInjectionSignal(ctx.chat.length);

  const result = await settleAndPoll(ctx, makeDeps());
  assert.equal(result?.skipped, true);
  assert.equal(result?.reason, 'injected_by_component_generator');
  assert.equal(globalThis.__st_message_component_injected__, null, '信号应被消费清空');
  assert.equal(counter.requests, 0, '跳过时不应发出追踪请求');
});

test('A 注入早于 B 首轮时，清信号后放行让 B 分析一次', async () => {
  const { ctx, counter } = setup();
  // 不做 manual，无任何预存快照（模拟 A 注入早于 B 首轮）
  setInjectionSignal(ctx.chat.length);

  const result = await settleAndPoll(ctx, makeDeps());
  assert.notEqual(result?.reason, 'injected_by_component_generator', '尚未分析过时不应被注入守卫跳过');
  assert.equal(globalThis.__st_message_component_injected__, null, '信号应被清空');
  assert.ok(counter.requests >= 1, '应放行并真正发起一次追踪请求');
});

test('chatLength 与当前楼层计数不匹配时守卫不触发，信号残留', async () => {
  const { ctx, counter } = setup();
  await runTracker(ctx, makeDeps(), 'manual');
  counter.requests = 0;

  // 信号记录的是旧的楼层计数，而当前 chat.length 仍为 1 → 不匹配
  setInjectionSignal(ctx.chat.length + 1);

  const result = await settleAndPoll(ctx, makeDeps());
  assert.notEqual(result?.reason, 'injected_by_component_generator', '不匹配时注入守卫不应触发');
  assert.equal(result?.reason, 'no_pending_history', '应正常走后续守卫链直至无待处理历史');
  assert.notEqual(globalThis.__st_message_component_injected__, null, '不匹配时信号不应被清空');
  assert.equal(counter.requests, 0);
});

test('手动分析不受注入信号影响，信号不被消费', async () => {
  const { ctx, counter } = setup();
  // 不做 manual，确保手动分析会真正发起请求
  setInjectionSignal(ctx.chat.length);

  const result = await runTracker(ctx, makeDeps(), 'manual');
  assert.notEqual(result?.reason, 'injected_by_component_generator', '手动分析不应被注入守卫拦截');
  assert.ok(counter.requests >= 1, '手动分析应真正发起请求');
  assert.notEqual(globalThis.__st_message_component_injected__, null, '手动分析不应消费信号');
});

test('消息对象无 .id 字段（标准 ST）时握手仍生效', async () => {
  // 显式构造不带 .id 的消息，并断言该属性确实不存在——正是上一版漏掉的回归点
  const assistant = { is_user: false, name: 'Alice', mes: 'previous reply' };
  const user = { is_user: true, name: 'User', mes: 'my input' };
  assert.equal(Object.prototype.hasOwnProperty.call(assistant, 'id'), false, '助手消息不应带 .id');
  assert.equal(Object.prototype.hasOwnProperty.call(user, 'id'), false, '用户消息不应带 .id');

  const { ctx, counter } = setup([user, assistant]);
  await runTracker(ctx, makeDeps(), 'manual');
  counter.requests = 0;

  setInjectionSignal(ctx.chat.length);

  const result = await settleAndPoll(ctx, makeDeps());
  assert.equal(result?.skipped, true);
  assert.equal(result?.reason, 'injected_by_component_generator');
  assert.equal(globalThis.__st_message_component_injected__, null);
  assert.equal(counter.requests, 0);
});
