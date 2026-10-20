import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { installLock, readPolicy } from '../core.mjs';
const base = process.env.DSH_TEST_MODULES ?? join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');
const load = (pkg, entry = 'lib/index.js') => import(pathToFileURL(`${base}/@deepseek-ai/${pkg}/${entry}`).href);
const { Context, symbols } = await load('cordis');
const { default: AgentDefaultModel } = await load('dsh-agent-default-model');
// Evaluate the shipped entry with only package specifiers redirected; no install/symlink needed.
const entrySource = (await readFile(new URL('../index.js', import.meta.url), 'utf8'))
  .replace("'@deepseek-ai/schemastery'", JSON.stringify(pathToFileURL(`${base}/@deepseek-ai/schemastery/lib/index.mjs`).href))
  .replace("'@deepseek-ai/cordis'", JSON.stringify(pathToFileURL(`${base}/@deepseek-ai/cordis/lib/index.js`).href))
  .replace("'./core.mjs'", JSON.stringify(new URL('../core.mjs', import.meta.url).href));
const entryPlugin = await import(`data:text/javascript;base64,${Buffer.from(entrySource).toString('base64')}`);

async function fixture() {
  const ctx = new Context();
  const edits = [];
  const originalConfig = { provider: { get: () => 'original-provider' }, model: { get: () => 'original-model' }, reasoningEffort: { get: () => undefined } };
  const entry = { options: { id: 'test-default' } };
  let release;
  let blocked = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const editor = await ctx.plugin((child) => { child.provide('configEditor', { async edit(row, change) {
    assert.equal(row, entry);
    if (blocked) await gate;
    edits.push(change());
  } }); });
  const providerPlugin = (child) => { child.fiber.entry = entry; new AgentDefaultModel(child, originalConfig); };
  let provider = await ctx.plugin(providerPlugin);
  let consumer;
  const consumerFiber = await ctx.plugin({ inject: ['agentDefaultModel'], apply(child) { consumer = child; } });
  const config = { enabled: true, provider: 'locked-provider', model: 'locked-model', reasoningEffort: '' };
  let lock;
  const lockPlugin = { inject: ['agentDefaultModel'], apply(child) { installLock(child, config, symbols.original); } };
  return { ctx, edits, config, entry, get consumer() { return consumer; },
    async install() { lock = await ctx.plugin(lockPlugin); assert.equal(lock.state, 2); return lock; },
    async uninstall() { await lock.dispose(); },
    async reload() { await provider.dispose(); provider = await ctx.plugin(providerPlugin); await new Promise((r) => setTimeout(r, 20)); },
    block() { blocked = true; }, release,
    async cleanup() { release(); await ctx.fiber.dispose(); },
  };
}

test('real Cordis + real AgentDefaultModel: plugin/root/get/old object, concurrent saves, live fields, disable and unload', async () => {
  const f = await fixture();
  try {
    const oldObject = f.consumer.agentDefaultModel;
    const raw = oldObject[symbols.original];
    const originalMethod = raw.currentSelection;
    await f.install();
    const expected = { provider: 'locked-provider', model: 'locked-model' };
    for (const svc of [f.consumer.agentDefaultModel, f.consumer.get('agentDefaultModel'), f.ctx.agentDefaultModel, oldObject]) {
      assert.deepEqual(svc.currentSelection(), expected);
      const detached = svc.currentSelection(); detached.model = 'tampered';
      assert.deepEqual(svc.currentSelection(), expected);
      await Promise.all(Array.from({ length: 50 }, () => svc.saveSelection({ provider: 'x', model: 'y' })));
    }
    assert.equal(f.edits.length, 0);
    f.config.reasoningEffort = 'high';
    assert.equal(oldObject.currentSelection().reasoningEffort, 'high');
    f.config.model = 'next';
    assert.equal(oldObject.currentSelection().model, 'next');
    f.config.enabled = false;
    assert.equal(oldObject.currentSelection().model, 'original-model');
    await oldObject.saveSelection({ provider: 'normal', model: 'normal-model' });
    assert.deepEqual(f.edits, [{ provider: 'normal', model: 'normal-model' }]);
    f.config.enabled = true;
    const cachedLockedMethod = oldObject.currentSelection.bind(oldObject);
    await f.uninstall();
    assert.equal(raw.currentSelection, originalMethod);
    assert.equal(Object.hasOwn(raw, 'currentSelection'), false);
    assert.equal(cachedLockedMethod().model, 'original-model');
    await oldObject.saveSelection({ provider: 'after', model: 'unload' });
    assert.equal(f.edits.length, 2);
  } finally { await f.cleanup(); }
});

test('invalid enabled config fails closed; no fallback or writes; volatile getters', async () => {
  const f = await fixture();
  try {
    await f.install();
    f.config.provider = '';
    assert.throws(() => f.consumer.get('agentDefaultModel').currentSelection(), /non-empty/);
    await assert.rejects(f.consumer.agentDefaultModel.saveSelection({ provider: 'x', model: 'y' }), /non-empty/);
    assert.equal(f.edits.length, 0);
    f.config.enabled = false;
    assert.equal(f.consumer.agentDefaultModel.currentSelection().model, 'original-model');
    const wrapped = Object.fromEntries(Object.entries({ enabled: true, provider: 'p', model: 'm', reasoningEffort: '' }).map(([k, v]) => [k, { get: () => v }]));
    assert.deepEqual(readPolicy(wrapped), { enabled: true, selection: { provider: 'p', model: 'm' } });
  } finally { await f.cleanup(); }
});

test('provider reload reinstalls lock on new instance', async () => {
  const f = await fixture();
  try {
    await f.install();
    const before = f.consumer.get('agentDefaultModel')[symbols.original];
    await f.reload();
    const after = f.consumer.get('agentDefaultModel')[symbols.original];
    assert.notEqual(after, before);
    assert.equal(f.consumer.get('agentDefaultModel').currentSelection().model, 'locked-model');
    await f.consumer.get('agentDefaultModel').saveSelection({ provider: 'x', model: 'y' });
    assert.equal(f.edits.length, 0);
    assert.equal(before.currentSelection().model, 'original-model');
  } finally { await f.cleanup(); }
});

test('entry schema defaults disabled; real volatile updates use exact supplied IDs', async () => {
  const f = await fixture();
  const { createVolatile, updateVolatile } = await load('cosmokit');
  try {
    const plugin = await f.ctx.plugin(entryPlugin, {});
    assert.equal(plugin.state, 2);
    assert.equal(plugin.config.enabled.get(), false);
    assert.equal(f.consumer.agentDefaultModel.currentSelection().model, 'original-model');
    // Same synchronous batch as Loader._commitVolatile; no awaiting between fields.
    updateVolatile(plugin.config.provider, createVolatile('not-a-catalog-provider'));
    updateVolatile(plugin.config.model, createVolatile('exact-unknown-model'));
    updateVolatile(plugin.config.reasoningEffort, createVolatile(''));
    updateVolatile(plugin.config.enabled, createVolatile(true));
    assert.deepEqual(f.consumer.get('agentDefaultModel').currentSelection(), {
      provider: 'not-a-catalog-provider', model: 'exact-unknown-model',
    });
    await f.consumer.get('agentDefaultModel').saveSelection({ provider: 'x', model: 'y' });
    assert.equal(f.edits.length, 0);
    await plugin.dispose();
  } finally { await f.cleanup(); }
});

test('isolated services are untouched; own descriptors restored; duplicate refused', async () => {
  const f = await fixture();
  try {
    const isolated = f.ctx.isolate('agentDefaultModel');
    const isolatedFiber = await isolated.plugin((child) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ model: 'isolated' }), saveSelection: async () => {} });
    });
    const raw = f.ctx.get('agentDefaultModel')[symbols.original];
    const ownMethod = raw.currentSelection;
    Object.defineProperty(raw, 'currentSelection', { value: ownMethod, configurable: true, writable: false, enumerable: true });
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'currentSelection');
    await f.install();
    assert.equal(isolated.get('agentDefaultModel').currentSelection().model, 'isolated');
    assert.throws(() => installLock(f.consumer, f.config, symbols.original), /another lock/);
    await f.uninstall();
    assert.deepEqual(Object.getOwnPropertyDescriptor(raw, 'currentSelection'), descriptor);
    await isolatedFiber.dispose();
  } finally { await f.cleanup(); }
});

test('pre-existing queued saves are not cancelled, but later saves never enqueue', async () => {
  const f = await fixture();
  try {
    f.block();
    const pending = f.consumer.agentDefaultModel.saveSelection({ provider: 'queued', model: 'before-lock' });
    await f.install();
    await f.consumer.agentDefaultModel.saveSelection({ provider: 'blocked', model: 'after-lock' });
    assert.equal(f.edits.length, 0);
    f.release(); await pending;
    assert.deepEqual(f.edits, [{ provider: 'queued', model: 'before-lock' }]);
    assert.equal(f.consumer.agentDefaultModel.currentSelection().model, 'locked-model');
  } finally { await f.cleanup(); }
});
