[![](https://img.shields.io/badge/powered_by-dafeiyu-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/Dafeiyu111)

# Default Model Lock

A shared-default-model lock for DeepSeek Harness. Pick a provider, a model and an optional reasoning effort in Settings, enable the lock, and the shared default stays pinned.

Why it exists: switching the model once in the UI also rewrites the default in `cordis.yml` (and drops the `reasoningEffort` line), so heartbeats, scheduled board runs and new sessions silently change model too. This plugin makes that an explicit switch instead.

## Behavior

- **Chat model switching keeps working**: `session.selectModel()` still applies to the current session.
- **The shared default cannot be moved**: `saveSelection()` is intercepted *before* it reaches the original save queue, and the call resolves without writing.
- `currentSelection()` returns the exact configured selection, so new sessions, headless runs, heartbeats and scheduled tasks all read the locked value.
- Disabling the lock restores official behavior and `unset`s provider/model, so the original default applies again. The plugin never rewrites the official default-model configuration.
- An empty reasoning effort delegates to the adapter's per-model default.
- An invalid provider/model **fails closed**: no guessing, no fallback, no write.
- Effective only in profiles that load this plugin.

## Where it intercepts

It wraps `currentSelection()` and `saveSelection()` on the `@deepseek-ai/dsh-agent-default-model` service *instance*:

- The original service object is recovered through Cordis `symbols.original`, and own methods are replaced on the instance, which covers plain `ctx` properties, `ctx.get()`, `root`, headless-shaped reads and already-cached service references.
- No prototype edits, no disk writes, no model API calls.
- Original descriptors are restored on disposal; the lock reinstalls itself when the service is rebuilt.

## Settings page

Registered on the `settings.section` slot through `ctx.slots.inject`, reading the real catalog: `ctx.remote.session.modelCatalog()` → Typert `{ ok, value }` → `{ groups[{ id, name, models[{ id, name, reasoning: { efforts[{ id, name }], defaultEffort } }] }] }`.

- Linked provider → model → effort selects, listing only what the catalog actually contains.
- One atomic `mutate(ops, revision)` per save, using `SettingsPathOpView` operations fenced by the namespace revision.
- A failed catalog read shows the error and offers no options; with no catalog you can still disable the lock.
- A stored model that is no longer available is labeled unavailable and **never auto-replaced**.
- Disabling the lock allows an empty provider/model.

When the settings service is present, the plugin calls `settings.configure({ auto: false })` to hide the official auto-generated generic form, so there is exactly one entry; the settings service itself is an **optional injection** (absent it does not fail, the lock keeps working).

The full chain has been exercised on a real Electron carrier with an isolated `DSH_HOME` and port 3199 (real Loader load, Config projection, `settings/update` persistence, `currentSelection()` interception taking effect, zero writes to the official config, restore on unlock). See section 6 of [docs/INSTALL.md](docs/INSTALL.md).

## Layout

```
index.js               entry point + Config schema (volatile fields)
core.mjs               the lock (service-instance method wrapping)
lib/client.js          client artifact: hand-written __ModuleLoader__ module
client/types.ts        verified DSH contract types (reference only)
client/index.tsx       migration notes for the abandoned draft
test/core.test.mjs     6 backend tests: real Cordis + real AgentDefaultModel
test/client.test.mjs   9 frontend tests: load lib/client.js directly
scripts/install-profile.ps1    install into a profile (dry-run by default, auto-backup)
scripts/restore-backup.ps1     rollback from backup (removes the junction only)
scripts/isolation-probe.mjs    isolation probe (own DSH_HOME + port 3199)
docs/INSTALL.md        install, limits, and isolation results
```

## Checks

```bash
npm run check   # node --check over the runtime and the client artifact
npm test        # 15 tests, all green
```

## Compatibility and limits

Built against DSH 0.2.1-rc.2 / Cordis 4.0.5; the wrapping contract must be re-verified after a DSH upgrade. **Writes already queued in the original save queue cannot be withdrawn** — a save submitted just before the lock engages still lands. A plugin that cached an independent method reference before wrapping may also bypass it. No core source edits, and no watch-then-rewrite scheme.

Installation and on-device verification: [docs/INSTALL.md](docs/INSTALL.md).
