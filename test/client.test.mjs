import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * Loads the shipped browser artifact the way the page does: a `window` with
 * `__ModuleLoader__`, a module table whose `react` entry is a stub, and the
 * factory invoked with the table's `require`. Nothing here re-implements the
 * client logic — every assertion runs against lib/client.js itself.
 */
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClient() {
  const loaded = [];
  const previous = globalThis.window;
  // Same realm as the test file, so asserted objects keep their prototypes.
  globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
  try {
    vm.runInThisContext(source, { filename: 'lib/client.js' });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
  assert.equal(loaded.length, 1, 'lib/client.js must register exactly one module');
  const definition = loaded[0];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
  };
  const require = (id) => {
    if (id === 'react') return react;
    throw new Error(`unexpected require: ${id}`);
  };
  return { definition, module: definition.factory(require), react };
}

const CATALOG = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  routableProviders: ['deepseek'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High', description: 'slower, deeper' },
            ],
            defaultEffort: 'low',
          },
        },
        { id: 'deepseek-plain', name: 'DeepSeek Plain' },
      ],
    },
    { id: 'mirror', name: 'Mirror', models: [{ id: 'mirror-small', name: 'Mirror Small' }] },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'no key' }],
};

function snapshotOf(value, { writable = true, revision = 7, status = 'ready' } = {}) {
  return { status, value, base: undefined, user: undefined, revision, writable };
}

function makeForm(options = {}) {
  const state = {
    snapshot: snapshotOf(options.value ?? { enabled: false, provider: '', model: '', reasoningEffort: '' }, options),
    writes: [],
    subscribers: new Set(),
    accept: options.accept ?? true,
  };
  return {
    state,
    getSnapshot: () => state.snapshot,
    subscribe(listener) {
      state.subscribers.add(listener);
      return () => state.subscribers.delete(listener);
    },
    async mutate(ops, expectedRevision) {
      state.writes.push({ ops, expectedRevision });
      if (expectedRevision !== state.snapshot.revision) return false;
      if (!state.accept) return false;
      // A real Host applies the mutation and bumps the revision, so the next
      // snapshot read reflects the write. Mirror that or syncForm() would
      // resurrect the stale draft.
      const value = { ...state.snapshot.value };
      for (const op of ops) {
        if (op.op === 'set') value[op.path[0]] = op.value;
        else delete value[op.path[0]];
      }
      state.snapshot = snapshotOf(value, {
        writable: state.snapshot.writable,
        revision: state.snapshot.revision + 1,
        status: state.snapshot.status,
      });
      return true;
    },
    async set() {
      throw new Error('set(field, value) must not be used for multi-field saves');
    },
    async unset() {
      throw new Error('unset(field) must not be used for multi-field saves');
    },
  };
}

function makeCtx({ form, catalog = async () => ({ ok: true, value: CATALOG }), describe } = {}) {
  const registers = [];
  const injected = [];
  const effects = [];
  const calls = { modelCatalog: 0 };
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name);
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      register(options, component) {
        registers.push({ options, component });
        return () => {};
      },
    },
    configForms: {
      get(namespace) {
        assert.equal(namespace, 'default-model-lock');
        return form;
      },
      describe: describe ?? (() => ({ ensure: async () => {}, getSnapshot: () => ({ status: 'ready', view: { namespaces: [] } }) })),
    },
    remote: {
      session: {
        async modelCatalog() {
          calls.modelCatalog += 1;
          return catalog();
        },
      },
    },
    effect(callback) {
      const disposer = callback();
      effects.push(disposer);
      return () => {};
    },
  };
  return { ctx, registers, injected, effects, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('client registers the settings section through slots.inject with the real option shape', () => {
  const { module } = loadClient();
  const form = makeForm();
  const { ctx, registers, injected } = makeCtx({ form });
  assert.deepEqual(module.inject, ['slots', 'remote', 'remote.session', 'configForms']);
  module.apply(ctx);
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registers.length, 1);
  const { options, component } = registers[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'default-model-lock');
  assert.equal(typeof options.order, 'number');
  assert.equal(typeof options.label, 'string');
  assert.equal(typeof options.inject, 'function');
  assert.equal(typeof component, 'function');
  const props = options.inject();
  assert.ok(props.store, 'inject() must hand the section its store');
  assert.equal(typeof props.store.getState, 'function');
});

test('catalog comes from remote.session.modelCatalog() wrapped in a Typert response', async () => {
  const { module } = loadClient();
  const form = makeForm();
  const { ctx, registers, calls } = makeCtx({ form });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  assert.equal(store.getState().catalog.status, 'idle', 'the catalog read stays lazy until the section renders');
  store.ensureCatalog();
  await flush();
  assert.equal(calls.modelCatalog, 1);
  const catalog = store.getState().catalog;
  assert.equal(catalog.status, 'ready');
  assert.deepEqual(catalog.value, CATALOG);
  assert.deepEqual(module.__internals.providerOptions(catalog), [
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'mirror', label: 'Mirror' },
  ]);
  assert.deepEqual(module.__internals.modelOptions(catalog, 'deepseek'), [
    { value: 'deepseek-chat', label: 'DeepSeek Chat' },
    { value: 'deepseek-plain', label: 'DeepSeek Plain' },
  ]);
  assert.deepEqual(module.__internals.effortOptions(catalog, 'deepseek', 'deepseek-chat'), [
    { value: 'low', label: 'Low', description: '' },
    { value: 'high', label: 'High', description: 'slower, deeper' },
  ]);
  assert.deepEqual(module.__internals.effortOptions(catalog, 'deepseek', 'deepseek-plain'), []);
});

test('a failed catalog read surfaces the error and never invents options', async () => {
  const { module } = loadClient();
  const form = makeForm();
  const { ctx, registers } = makeCtx({
    form,
    catalog: async () => ({ ok: false, error: { message: 'catalog exploded', code: 'gateway/internal' } }),
  });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  store.ensureCatalog();
  await flush();
  const state = store.getState();
  assert.equal(state.catalog.status, 'error');
  assert.equal(state.catalog.value, null);
  assert.match(state.catalog.error, /catalog exploded/);
  assert.deepEqual(module.__internals.providerOptions(state.catalog), []);
  // Enablement cannot be written from a catalog we could not read.
  store.setDraft({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' });
  const plan = module.__internals.planSave(store.getState().draft, store.getState().catalog, store.getState().config);
  assert.equal(plan.ok, false);
  assert.match(plan.message, /模型目录未就绪/);
  assert.equal(await store.save(), false);
  assert.equal(form.state.writes.length, 0, 'a refused plan must not reach the Host');
});

test('a saved model that is no longer in the catalog is reported, never replaced', async () => {
  const { module } = loadClient();
  const form = makeForm({ value: { enabled: true, provider: 'gone', model: 'vanished', reasoningEffort: 'high' } });
  const { ctx, registers } = makeCtx({ form });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  store.ensureCatalog();
  await flush();
  const state = store.getState();
  assert.deepEqual(state.config, { enabled: true, provider: 'gone', model: 'vanished', reasoningEffort: 'high' });
  assert.deepEqual(state.draft, state.config, 'the draft mirrors the saved value until the user edits it');
  const availability = module.__internals.describeAvailability(state.catalog, state.config);
  assert.equal(availability.state, 'provider');
  assert.match(availability.text, /gone/);
  const effortOnly = module.__internals.describeAvailability(state.catalog, {
    enabled: true,
    provider: 'deepseek',
    model: 'deepseek-plain',
    reasoningEffort: 'high',
  });
  assert.equal(effortOnly.state, 'effort');
});

test('disabled saves stay possible with empty provider/model and need no catalog', async () => {
  const { module } = loadClient();
  const form = makeForm({ value: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } });
  const { ctx, registers } = makeCtx({ form, catalog: async () => ({ ok: false, error: { message: 'offline' } }) });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  await flush();
  store.setDraft({ enabled: false, provider: '', model: '', reasoningEffort: '' });
  assert.equal(await store.save(), true);
  assert.equal(form.state.writes.length, 1);
  assert.equal(form.state.writes[0].expectedRevision, 7, 'the mutation carries the snapshot revision fence');
  assert.deepEqual(form.state.writes[0].ops, [
    { op: 'set', path: ['enabled'], value: false },
    { op: 'unset', path: ['provider'] },
    { op: 'unset', path: ['model'] },
    { op: 'unset', path: ['reasoningEffort'] },
  ]);
});

test('enabled saves write every field in one atomic mutation with sanitized ids', async () => {
  const { module } = loadClient();
  const form = makeForm();
  const { ctx, registers } = makeCtx({ form });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  store.ensureCatalog();
  await flush();
  store.setDraft({ enabled: true });
  assert.equal(await store.save(), false, 'an enabled lock without a selection is refused');
  store.setDraft({ provider: ' deepseek ' });
  store.setDraft({ model: 'deepseek-chat' });
  store.setDraft({ reasoningEffort: 'high' });
  assert.equal(await store.save(), true);
  assert.equal(form.state.writes.length, 1, 'exactly one Host mutation per save');
  assert.deepEqual(form.state.writes[0].ops, [
    { op: 'set', path: ['enabled'], value: true },
    { op: 'set', path: ['provider'], value: 'deepseek' },
    { op: 'set', path: ['model'], value: 'deepseek-chat' },
    { op: 'set', path: ['reasoningEffort'], value: 'high' },
  ]);
  store.setDraft({ reasoningEffort: '' });
  assert.equal(await store.save(), true);
  assert.deepEqual(form.state.writes[1].ops[3], { op: 'unset', path: ['reasoningEffort'] });
});

test('provider, model and effort stay linked, and a stale effort is not silently kept', async () => {
  const { module } = loadClient();
  const form = makeForm();
  const { ctx, registers } = makeCtx({ form });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  store.ensureCatalog();
  await flush();
  store.setDraft({ provider: 'deepseek' });
  store.setDraft({ model: 'deepseek-chat' });
  store.setDraft({ reasoningEffort: 'high' });
  store.setDraft({ provider: 'mirror' });
  assert.deepEqual(store.getState().draft, { enabled: false, provider: 'mirror', model: '', reasoningEffort: '' });
  store.setDraft({ model: 'mirror-small' });
  assert.equal(store.getState().draft.model, 'mirror-small');
  store.setDraft({ model: 'deepseek-chat' });
  store.setDraft({ reasoningEffort: 'low' });
  store.setDraft({ model: 'deepseek-plain' });
  assert.equal(store.getState().draft.reasoningEffort, '', 'an effort the new model does not declare is cleared while editing');
});

test('a Host refusal becomes a visible error instead of a silent success', async () => {
  const { module } = loadClient();
  const form = makeForm({ accept: false });
  const { ctx, registers } = makeCtx({ form });
  module.apply(ctx);
  const store = registers[0].options.inject().store;
  await flush();
  store.setDraft({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' });
  store.ensureCatalog();
  await flush();
  assert.equal(await store.save(), false);
  assert.equal(store.getState().notice.kind, 'error');
  assert.match(store.getState().notice.text, /Host 拒绝/);
});

test('the entry id fallback finds the namespace from a describe scan', async () => {
  const { module } = loadClient();
  const unavailable = makeForm({ status: 'unavailable' });
  const found = makeForm({ value: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' } });
  const seen = [];
  const ctx = makeCtx({
    form: unavailable,
    describe: () => ({
      async ensure() {},
      getSnapshot: () => ({
        status: 'ready',
        view: {
          namespaces: [
            { ns: 'ui-settings-general', schema: { type: 'object', dict: { welcomeNoticeVersion: { type: 'string' } } } },
            { ns: 'renamed-entry', schema: { type: 'object', dict: { enabled: {}, provider: {}, model: {}, reasoningEffort: {} } } },
          ],
        },
      }),
    }),
  });
  const originalGet = ctx.ctx.configForms.get;
  ctx.ctx.configForms.get = (namespace) => {
    seen.push(namespace);
    return namespace === 'renamed-entry' ? found : originalGet(namespace);
  };
  module.apply(ctx.ctx);
  await flush();
  assert.deepEqual(seen, ['default-model-lock', 'renamed-entry']);
  assert.equal(module.__internals.looksLikeThisPlugin({ dict: { provider: {}, model: {}, enabled: {}, reasoningEffort: {} } }), true);
  assert.equal(module.__internals.looksLikeThisPlugin({ dict: { provider: {}, model: {} } }), false);
});
