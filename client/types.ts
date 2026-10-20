/**
 * Real DSH 0.2.1-rc.2 contracts this plugin's settings section depends on.
 *
 * Every shape below is copied from the shipped declarations inside
 * `@deepseek-ai/*`; this file is documentation and type reference only. It is not
 * bundled and it is not the runtime artifact — the shipped client is the
 * hand-written module at `lib/client.js` (the browser needs the
 * `window.__ModuleLoader__.load({...})` envelope, which an ESM bundler output
 * cannot provide).
 *
 * Sources:
 * - `@deepseek-ai/dsh-client-ui-settings/lib/types/client/config-form-types.d.ts`
 * - `@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts`
 * - `@deepseek-ai/dsh-settings/lib/types/types.d.ts`
 * - `@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`
 */

/** This plugin's `Config` as stored in settings namespace `default-model-lock`. */
export interface DefaultModelLockConfig {
  enabled: boolean
  provider: string
  model: string
  reasoningEffort: string
}

/** `SettingsPathOpView` — one field operation inside an atomic namespace mutation. */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

export interface ConfigFormSnapshot<T> {
  /** `loading` until the first accepted section, `unavailable` when the namespace is not exposed. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  value: T | undefined
  base: unknown
  user: unknown
  /** Namespace revision fencing the next write; undefined before the first Host view. */
  revision: number | undefined
  writable: boolean
}

/** `@deepseek-ai/dsh-client-ui-settings` `ConfigForm<T>`. */
export interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  /** One atomic namespace mutation; all ops share one revision fence. */
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
  /** One scalar field write. Note: `set(field, value)`, never `set(fieldObject)`. */
  set(field: string, value: unknown): Promise<boolean>
  /** One scalar field clear, so the field re-inherits the composition layer. */
  unset(field: string): Promise<boolean>
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelReasoning {
  efforts: readonly ModelReasoningEffort[]
  defaultEffort?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: readonly ModelCatalogModel[]
}

export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** Value of `ctx.remote.session.modelCatalog()`. */
export interface ModelCatalog {
  default: ModelSelection
  /** Provider routes with at least one currently available catalog model. */
  routableProviders: readonly string[]
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
}

/** Typert response envelope: check `ok === true` and read `value`. */
export type TypertResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message?: string } | string }

/**
 * The client face this plugin uses. `ctx.modelCatalog` does not exist; the
 * catalog is a Host remote call, and the settings entry is a `settings.section`
 * slot registration reached through `slots.inject`.
 */
export interface DefaultModelLockClientContext {
  configForms: {
    get<T>(entryId: string): ConfigForm<T>
    describe(): {
      ensure(): Promise<unknown>
      getSnapshot(): {
        status: string
        view?: { namespaces?: readonly { ns: string; schema?: unknown }[] }
      }
    }
  }
  remote: {
    session: {
      modelCatalog(): Promise<TypertResult<ModelCatalog>>
    }
  }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register<T>(
      options: { name: string; id: string; order: number; label: string; inject: () => T },
      component: unknown,
    ): () => void
  }
}
