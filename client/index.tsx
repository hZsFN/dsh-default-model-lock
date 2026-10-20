/**
 * DEPRECATED DRAFT — kept only as a record of what the first attempt assumed.
 *
 * The shipped client is `lib/client.js`, a hand-written module wrapped in
 * `window.__ModuleLoader__.load({ id, inject, apply, factory })` because the
 * browser loads plugin clients through that envelope; an ESM bundle (what this
 * file would compile to) cannot register itself. See `docs/INSTALL.md`.
 *
 * Keeping a second, compiled-able copy here would drift from the real code, so
 * this file is documentation. Every assumption the draft made, and what the
 * real DSH 0.2.1-rc.2 contract turned out to be:
 *
 * 1. `inject = ['slots', 'configForms', 'modelCatalog']`
 *    → there is no `ctx.modelCatalog`. The catalog is a Host remote call:
 *      `await ctx.remote.session.modelCatalog()`, so the client face is
 *      `['slots', 'remote', 'remote.session', 'configForms']`.
 *
 * 2. `ctx.modelCatalog.getSnapshot()` handed over `{ providers: [...] }`
 *    → the response is a Typert envelope. Check `response.ok === true` first,
 *      then read `response.value`, which is
 *      `{ default, routableProviders, groups[{ id, name, models[{ id, name,
 *      description?, reasoning?: { efforts: [{ id, name, description? }],
 *      defaultEffort? } }] }], failures }`. Effort options are objects, not a
 *      `reasoningEfforts: string[]` array, and providers live in `groups`.
 *
 * 3. `form.set(wholeConfigObject)`
 *    → `ConfigForm<T>.set(field: string, value: unknown)` writes ONE scalar
 *      field, and `unset(field)` clears one. A whole-section write is
 *      `form.mutate(ops, expectedRevision)` with `SettingsPathOpView` ops
 *      (`{ op: 'set', path: ['model'], value }` / `{ op: 'unset', path: [...] }`),
 *      fenced by the revision read from `form.getSnapshot().revision`.
 *      `lib/client.js` issues exactly one `mutate()` per save.
 *
 * 4. `ctx.slots.register({ ... }, Component)` called directly
 *    → a section registration is
 *      `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:
 *      'settings.section', id, order, label, inject }, Component))`, so the
 *      registration is re-run when the slot owner is replaced.
 *
 * 5. A saved-but-missing model was silently swapped for the catalog default
 *    → the real page keeps the stored value, labels it 不可用, and refuses to
 *      save while the lock is enabled and the value no longer resolves. A
 *      failed catalog read shows an error and offers no invented options.
 *      Disabling the lock stays possible with empty provider/model, which is
 *      how the lock is turned off.
 *
 * Runtime state for the real page lives in `lib/client.js` (`createStore()`);
 * `client/types.ts` carries the verified type contracts.
 */
export {};
