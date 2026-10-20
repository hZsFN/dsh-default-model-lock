/**
 * Browser half of dsh-default-model-lock.
 *
 * Written directly in the loader format every shipped client bundle uses
 * (`window.__ModuleLoader__.load`), so the artifact needs no bundler: the id is
 * the package name, React comes from the browser module table, and the returned
 * object carries `inject` and `apply` like any other Client plugin.
 *
 * Contracts this file obeys (dsh 0.2.1-rc.2 / cordis 4.0.5):
 * - settings registration goes through `ctx.slots.inject('settings.section', …)`
 *   wrapping `ctx.slots.register({ name, id, order, label, inject }, Component)`;
 * - the model list is `ctx.remote.session.modelCatalog()`, which answers a
 *   Typert wrapper (`{ ok: true, value: ModelCatalog }`), not a catalog itself;
 * - writes go through `ConfigForm.mutate(ops, expectedRevision)` once per save,
 *   with `SettingsPathOpView` operations, never `set(wholeObject)`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-default-model-lock',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;

    /** Settings section identity; the order puts it right after Models. */
    const SECTION_ID = 'default-model-lock';
    // Shipped settings sections use 0/10/20/30/100/…; 25 keeps this page unique
    // so its nav position never depends on registration order.
    const SECTION_ORDER = 25;
    const SECTION_LABEL = '默认模型锁';
    /** Settings namespace === Host plugin entry id declared by cordis.patch.yml. */
    const NAMESPACE = 'default-model-lock';
    /** Fields this plugin's Config schema declares. */
    const FIELD_KEYS = ['enabled', 'provider', 'model', 'reasoningEffort'];

    const EMPTY_CONFIG = Object.freeze({ enabled: false, provider: '', model: '', reasoningEffort: '' });

    // ---------------------------------------------------------------------
    // Pure view-model helpers (exported through `__internals` for the tests).
    // ---------------------------------------------------------------------

    /** Coerce an unknown wire field to a string. */
    function text(value) {
      return typeof value === 'string' ? value : '';
    }

    /** Narrow a settings section (or nothing) to this plugin's four fields. */
    function normalizeConfig(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      return {
        enabled: source.enabled === true,
        provider: text(source.provider),
        model: text(source.model),
        reasoningEffort: text(source.reasoningEffort),
      };
    }

    /** @returns provider groups from a ModelCatalog, tolerating a missing catalog. */
    function groupsOf(catalog) {
      const value = catalog !== null && typeof catalog === 'object' ? catalog.value : undefined;
      const groups = value !== null && typeof value === 'object' ? value.groups : undefined;
      return Array.isArray(groups) ? groups.filter((group) => group !== null && typeof group === 'object') : [];
    }

    /** @returns one provider group by id, or undefined. */
    function findGroup(catalog, providerId) {
      if (!providerId) return undefined;
      return groupsOf(catalog).find((group) => group.id === providerId);
    }

    /** @returns the models of one provider, in catalog order. */
    function modelsOf(catalog, providerId) {
      const group = findGroup(catalog, providerId);
      return group !== undefined && Array.isArray(group.models) ? group.models.filter((model) => model !== null && typeof model === 'object') : [];
    }

    /** @returns one model entry by provider id and model id, or undefined. */
    function findModel(catalog, providerId, modelId) {
      if (!modelId) return undefined;
      return modelsOf(catalog, providerId).find((model) => model.id === modelId);
    }

    /** @returns the adapter-owned reasoning efforts of one model (`reasoning.efforts`). */
    function effortOptionsOf(model) {
      const reasoning = model !== null && typeof model === 'object' ? model.reasoning : undefined;
      const efforts = reasoning !== null && typeof reasoning === 'object' ? reasoning.efforts : undefined;
      if (!Array.isArray(efforts)) return [];
      return efforts
        .filter((effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string')
        .map((effort) => ({ id: effort.id, name: text(effort.name) || effort.id, description: text(effort.description) }));
    }

    /** @returns provider select options built from the live catalog. */
    function providerOptions(catalog) {
      return groupsOf(catalog).map((group) => ({ value: group.id, label: text(group.name) || group.id }));
    }

    /** @returns model select options for one provider. */
    function modelOptions(catalog, providerId) {
      return modelsOf(catalog, providerId).map((model) => ({ value: model.id, label: text(model.name) || model.id }));
    }

    /** @returns effort select options for one exact model route. */
    function effortOptions(catalog, providerId, modelId) {
      return effortOptionsOf(findModel(catalog, providerId, modelId)).map((effort) => ({ value: effort.id, label: effort.name, description: effort.description }));
    }

    /**
     * Describe whether a selection still exists in the live catalog. Never
     * substitutes another model: a stale saved value stays visible as stale.
     * @returns `{ state, text }` where state is available|provider|model|effort|unknown.
     */
    function describeAvailability(catalog, selection) {
      if (catalog === null || typeof catalog !== 'object' || catalog.status !== 'ready' || !catalog.value) {
        return { state: 'unknown', text: '模型目录尚未就绪，暂时无法确认它是否可用。' };
      }
      const group = findGroup(catalog, selection.provider);
      if (group === undefined) {
        return { state: 'provider', text: `provider「${selection.provider || '（空）'}」当前不在模型目录中。` };
      }
      const model = findModel(catalog, selection.provider, selection.model);
      if (model === undefined) {
        return { state: 'model', text: `模型「${selection.model || '（空）'}」当前不可用。` };
      }
      if (selection.reasoningEffort) {
        const efforts = effortOptionsOf(model);
        if (!efforts.some((effort) => effort.id === selection.reasoningEffort)) {
          return { state: 'effort', text: `模型「${text(model.name) || model.id}」没有推理档位「${selection.reasoningEffort}」。` };
        }
      }
      return { state: 'available', text: '' };
    }

    /**
     * Build the single atomic write for a draft, or refuse it.
     * Refusing is the fail-closed branch: an enabled lock never falls back to
     * another model, and it is never written from a catalog we could not read.
     * @returns `{ ok: true, ops }` or `{ ok: false, message }`.
     */
    function planSave(draft, catalog, saved) {
      const current = normalizeConfig(saved);
      const next = normalizeConfig(draft);
      if (!next.enabled) {
        // Disabling the lock is always allowed, with empty provider/model.
        const ops = [];
        if (current.enabled !== false) ops.push({ op: 'set', path: ['enabled'], value: false });
        if (current.provider !== '') ops.push({ op: 'unset', path: ['provider'] });
        if (current.model !== '') ops.push({ op: 'unset', path: ['model'] });
        if (current.reasoningEffort !== '') ops.push({ op: 'unset', path: ['reasoningEffort'] });
        return { ok: true, ops };
      }
      if (catalog === null || typeof catalog !== 'object' || catalog.status !== 'ready' || !catalog.value) {
        return { ok: false, message: '模型目录未就绪，启用锁定必须先读到真实目录（不会猜测模型）。可以先关闭锁定后保存。' };
      }
      const provider = next.provider.trim();
      const model = next.model.trim();
      const effort = next.reasoningEffort.trim();
      if (provider === '') return { ok: false, message: '启用锁定必须先选择一个 provider。' };
      if (model === '') return { ok: false, message: '启用锁定必须先选择一个 model。' };
      if (findGroup(catalog, provider) === undefined) return { ok: false, message: `provider「${provider}」不在当前模型目录中。` };
      const entry = findModel(catalog, provider, model);
      if (entry === undefined) return { ok: false, message: `模型「${model}」不属于 provider「${provider}」。` };
      if (effort !== '' && !effortOptionsOf(entry).some((option) => option.id === effort)) {
        return { ok: false, message: `模型「${model}」没有推理档位「${effort}」。` };
      }
      const ops = [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['provider'], value: provider },
        { op: 'set', path: ['model'], value: model },
        effort === '' ? { op: 'unset', path: ['reasoningEffort'] } : { op: 'set', path: ['reasoningEffort'], value: effort },
      ];
      return { ok: true, ops };
    }

    /** @returns a readable message for a rejected Typert response or thrown value. */
    function errorText(error) {
      if (error === null || error === undefined) return '未知错误';
      if (typeof error === 'string') return error;
      const message = typeof error.message === 'string' ? error.message : '';
      return message || String(error);
    }

    /** @returns the failure message of a `{ ok: false, error }` response. */
    function failureMessage(response) {
      const failure = response !== null && typeof response === 'object' ? response.error : undefined;
      return errorText(failure !== undefined ? failure : response);
    }

    /** @returns whether a namespace schema declares this plugin's fields. */
    function looksLikeThisPlugin(schema) {
      let serialized;
      try {
        serialized = JSON.stringify(schema);
      } catch {
        return false;
      }
      if (typeof serialized !== 'string') return false;
      return FIELD_KEYS.every((key) => serialized.includes(key));
    }

    // ---------------------------------------------------------------------
    // Store shared by the section component.
    // ---------------------------------------------------------------------

    /**
     * Owns the ConfigForm subscription, the live catalog read, and the draft.
     * @param ctx - client root context carrying `configForms` and `remote`.
     */
    function createStore(ctx) {
      let state = {
        phase: 'loading',
        writable: false,
        revision: undefined,
        config: EMPTY_CONFIG,
        draft: EMPTY_CONFIG,
        dirty: false,
        saving: false,
        notice: null,
        catalog: { status: 'idle', value: null, error: null },
      };
      const listeners = new Set();
      let form;
      let detachForm = null;
      let catalogLoading = false;
      let disposed = false;

      const getState = () => state;

      const put = (patch) => {
        if (disposed) return;
        state = Object.assign({}, state, patch);
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            console.error('default-model-lock: listener failed', error);
          }
        }
      };

      const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };

      /** Re-read the Host form snapshot into state, keeping an edited draft. */
      const syncForm = () => {
        if (!form) return;
        const snapshot = form.getSnapshot();
        const status = snapshot !== null && typeof snapshot === 'object' ? snapshot.status : undefined;
        const config = normalizeConfig(snapshot !== null && typeof snapshot === 'object' ? snapshot.value : undefined);
        const patch = {
          phase: status === 'ready' ? 'ready' : status === 'unavailable' ? 'unavailable' : 'loading',
          writable: snapshot !== null && typeof snapshot === 'object' && snapshot.writable === true,
          revision: snapshot !== null && typeof snapshot === 'object' ? snapshot.revision : undefined,
          config,
        };
        if (!state.dirty) patch.draft = config;
        put(patch);
      };

      const attach = (namespace) => {
        if (detachForm) {
          detachForm();
          detachForm = null;
        }
        form = ctx.configForms.get(namespace);
        syncForm();
        detachForm = form !== null && typeof form === 'object' && typeof form.subscribe === 'function' ? form.subscribe(syncForm) : null;
      };

      /** Fall back to a describe scan when the entry id is not the expected one. */
      const watchDescribe = () => {
        const face = typeof ctx.configForms.describe === 'function' ? ctx.configForms.describe() : undefined;
        if (!face || typeof face.ensure !== 'function') return;
        Promise.resolve()
          .then(() => face.ensure())
          .then(() => {
            if (disposed || state.phase === 'ready') return;
            const snapshot = face.getSnapshot();
            const view = snapshot !== null && typeof snapshot === 'object' ? snapshot.view : undefined;
            const namespaces = view !== null && typeof view === 'object' && Array.isArray(view.namespaces) ? view.namespaces : [];
            if (namespaces.some((entry) => entry !== null && typeof entry === 'object' && entry.ns === NAMESPACE)) {
              if (state.phase !== 'ready') attach(NAMESPACE);
              return;
            }
            const match = namespaces.find((entry) => entry !== null && typeof entry === 'object' && looksLikeThisPlugin(entry.schema));
            if (match !== undefined) attach(match.ns);
          })
          .catch((error) => {
            console.warn('default-model-lock: settings describe scan failed', error);
          });
      };

      /** Read the live model catalog through the session remote face. */
      const loadCatalog = async () => {
        if (disposed || catalogLoading) return;
        catalogLoading = true;
        put({ catalog: { status: 'loading', value: state.catalog.value, error: null } });
        try {
          const response = await ctx.remote.session.modelCatalog();
          if (!response || response.ok !== true) throw new Error(failureMessage(response));
          put({ catalog: { status: 'ready', value: response.value, error: null } });
        } catch (error) {
          put({ catalog: { status: 'error', value: null, error: errorText(error) } });
        } finally {
          catalogLoading = false;
        }
      };

      /** Load the catalog once, on first render. */
      const ensureCatalog = () => {
        if (state.catalog.status !== 'idle') return;
        void loadCatalog();
      };

      /** Re-read the catalog on demand. */
      const refreshCatalog = async () => {
        if (catalogLoading) return;
        await loadCatalog();
      };

      /** Edit the draft, keeping provider → model → effort consistent. */
      const setDraft = (patch) => {
        const next = Object.assign({}, state.draft);
        if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) next.enabled = patch.enabled === true;
        if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
          const value = text(patch.provider);
          if (value !== next.provider) {
            next.provider = value;
            next.model = '';
            next.reasoningEffort = '';
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
          const value = text(patch.model);
          if (value !== next.model) {
            next.model = value;
            const efforts = effortOptionsOf(findModel(state.catalog, next.provider, value));
            if (!efforts.some((effort) => effort.id === next.reasoningEffort)) next.reasoningEffort = '';
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')) next.reasoningEffort = text(patch.reasoningEffort);
        put({ draft: next, dirty: true, notice: null });
      };

      /** Discard the draft. */
      const resetDraft = () => {
        put({ draft: state.config, dirty: false, notice: null });
      };

      /** Write the draft as one atomic namespace mutation. */
      const save = async () => {
        if (!form || state.saving) return false;
        const plan = planSave(state.draft, state.catalog, state.config);
        if (!plan.ok) {
          put({ notice: { kind: 'error', text: plan.message } });
          return false;
        }
        if (plan.ops.length === 0) {
          put({ dirty: false, notice: { kind: 'info', text: '没有需要保存的改动。' } });
          return true;
        }
        put({ saving: true, notice: null });
        try {
          const accepted = await form.mutate(plan.ops, state.revision);
          put({ saving: false });
          if (accepted === true) {
            put({ dirty: false });
            syncForm();
            put({ notice: { kind: 'success', text: '已保存：共享默认模型立即生效，无需重启。' } });
            return true;
          }
          put({ notice: { kind: 'error', text: 'Host 拒绝或跳过了这次写入（配置可能已被别处修改），请刷新后重试。' } });
          return false;
        } catch (error) {
          put({ saving: false, notice: { kind: 'error', text: errorText(error) } });
          return false;
        }
      };

      attach(NAMESPACE);
      if (state.phase !== 'ready') watchDescribe();

      return {
        getState,
        subscribe,
        ensureCatalog,
        refreshCatalog,
        setDraft,
        resetDraft,
        save,
        dispose() {
          disposed = true;
          if (detachForm) detachForm();
          detachForm = null;
          listeners.clear();
        },
      };
    }

    // ---------------------------------------------------------------------
    // Rendering.
    // ---------------------------------------------------------------------

    const styles = {
      root: { display: 'grid', gap: 16, maxWidth: 680, padding: '4px 0 24px', color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 14, lineHeight: 1.55 },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      description: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)' },
      card: {
        display: 'grid',
        gap: 12,
        padding: 16,
        border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, #d8d8d8))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
      },
      row: { display: 'grid', gap: 6 },
      label: { fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      help: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 },
      select: {
        minHeight: 34,
        padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l3, #d8d8d8)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      actions: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      button: {
        minHeight: 34,
        padding: '6px 18px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l3, #d8d8d8)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: 13 },
      warn: { color: 'var(--dsw-alias-state-warn-label, #a06000)', fontSize: 13 },
      success: { color: 'var(--dsw-alias-state-success-primary, #1f7a3d)', fontSize: 13 },
      info: { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 13 },
      mono: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12 },
    };

    const NOTICE_STYLE = { error: styles.error, success: styles.success, info: styles.info };

    /** Subscribe a component to the store without pulling in an extra hook library. */
    function useStoreState(store) {
      const [snapshot, setSnapshot] = useState(() => store.getState());
      useEffect(() => {
        setSnapshot(store.getState());
        return store.subscribe(() => setSnapshot(store.getState()));
      }, [store]);
      return snapshot;
    }

    function Field(props) {
      return h('div', { style: styles.row }, h('span', { style: styles.label }, props.label), props.children, props.help ? h('span', { style: styles.help }, props.help) : null);
    }

    function Select(props) {
      return h(
        'select',
        {
          style: styles.select,
          value: props.value,
          disabled: props.disabled === true,
          'aria-label': props.ariaLabel,
          onChange: (event) => props.onChange(event.target.value),
        },
        props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      );
    }

    function Notice(props) {
      if (!props.notice) return null;
      return h('span', { style: NOTICE_STYLE[props.notice.kind] || styles.info, role: props.notice.kind === 'error' ? 'alert' : undefined }, props.notice.text);
    }

    function DefaultModelLockSection(props) {
      const store = props.store;
      const state = useStoreState(store);
      useEffect(() => {
        store.ensureCatalog();
      }, [store]);

      const draft = state.draft;
      const plan = useMemo(() => planSave(draft, state.catalog, state.config), [draft, state.catalog, state.config]);
      const providers = providerOptions(state.catalog);
      const models = modelOptions(state.catalog, draft.provider);
      const efforts = effortOptions(state.catalog, draft.provider, draft.model);
      const catalogStatus = state.catalog.status;
      const savedAvailability = describeAvailability(state.catalog, state.config);
      const showSavedWarning = state.config.enabled && savedAvailability.state !== 'available' && savedAvailability.state !== 'unknown';
      const busy = state.saving;
      const canEdit = state.writable && state.phase === 'ready';
      const canSave = canEdit && !busy && plan.ok && (state.dirty || plan.ops.length > 0);

      const catalogBlock = [];
      if (catalogStatus === 'idle' || catalogStatus === 'loading') {
        catalogBlock.push(h('span', { key: 'loading', style: styles.info }, '正在读取模型目录…'));
      } else if (catalogStatus === 'error') {
        catalogBlock.push(h('div', { key: 'error', style: styles.error, role: 'alert' }, `模型目录加载失败：${state.catalog.error}`));
        catalogBlock.push(h('span', { key: 'error-hint', style: styles.help }, '这里不会伪造选项。可以重试读取，或先关闭锁定再保存。'));
      } else if (providers.length === 0) {
        catalogBlock.push(h('span', { key: 'empty', style: styles.warn }, '模型目录里没有任何可用 provider。'));
      } else {
        catalogBlock.push(
          h(
            Field,
            { key: 'provider', label: 'Provider' },
            h(Select, {
              ariaLabel: 'Provider',
              value: draft.provider,
              disabled: !canEdit || busy,
              options: [{ value: '', label: '请选择 provider' }].concat(providers),
              onChange: (value) => store.setDraft({ provider: value }),
            }),
          ),
          h(
            Field,
            { key: 'model', label: 'Model', help: draft.provider === '' ? '先选择 provider。' : undefined },
            h(Select, {
              ariaLabel: 'Model',
              value: draft.model,
              disabled: !canEdit || busy || draft.provider === '' || models.length === 0,
              options: [{ value: '', label: models.length === 0 ? '该 provider 没有可选模型' : '请选择 model' }].concat(models),
              onChange: (value) => store.setDraft({ model: value }),
            }),
          ),
          h(
            Field,
            {
              key: 'effort',
              label: 'Reasoning effort',
              help: draft.model === '' ? '先选择 model。' : efforts.length === 0 ? '该模型没有声明 reasoning.efforts，将使用模型默认档位。' : '留空表示使用模型默认档位。',
            },
            h(Select, {
              ariaLabel: 'Reasoning effort',
              value: draft.reasoningEffort,
              disabled: !canEdit || busy || efforts.length === 0,
              options: [{ value: '', label: '模型默认' }].concat(efforts),
              onChange: (value) => store.setDraft({ reasoningEffort: value }),
            }),
          ),
        );
      }

      return h(
        'section',
        { style: styles.root, 'data-dsh-plugin': 'dsh-default-model-lock', 'aria-label': SECTION_LABEL },
        h('h2', { style: styles.title }, SECTION_LABEL),
        h('p', { style: styles.description }, '锁定共享默认模型：新会话、headless、心跳与定时任务都从这里取值；在聊天里手动切换模型仍只影响当前会话，不会改写这个默认值。'),
        state.phase === 'unavailable'
          ? h('div', { style: styles.error, role: 'alert' }, `没有找到 settings 命名空间「${NAMESPACE}」，请确认插件已随 profile 加载。`)
          : null,
        state.phase !== 'unavailable' && state.writable !== true
          ? h('div', { style: styles.warn }, '当前 profile 是只读的，无法保存。')
          : null,
        h(
          'div',
          { style: styles.card },
          h(
            Field,
            {
              label: '启用锁定',
              help: '启用时必须从真实目录里选好 provider 与 model；关闭后默认模型回到 composition 里的值。',
            },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled,
              disabled: !canEdit || busy,
              onChange: (event) => store.setDraft({ enabled: event.target.checked }),
            }),
          ),
          h('div', { style: styles.row }, catalogBlock),
          showSavedWarning ? h('div', { style: styles.warn }, `已保存的默认模型当前不可用（不会自动替换）：${savedAvailability.text}`) : null,
          showSavedWarning || draft.reasoningEffort === '' ? null : h('span', { style: styles.help }, `将写入：${draft.provider} / ${draft.model} / ${draft.reasoningEffort}`),
        ),
        h(
          'div',
          { style: styles.actions },
          h(
            'button',
            {
              type: 'button',
              style: canSave ? styles.button : Object.assign({}, styles.button, { cursor: 'not-allowed', opacity: 0.6 }),
              disabled: !canSave,
              onClick: () => void store.save(),
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            { type: 'button', style: styles.button, disabled: !canEdit || busy || !state.dirty, onClick: () => store.resetDraft() },
            '重置',
          ),
          h('button', { type: 'button', style: styles.button, disabled: busy || catalogStatus === 'loading', onClick: () => void store.refreshCatalog() }, '刷新目录'),
          plan.ok === false ? h('span', { style: styles.warn }, plan.message) : null,
          plan.ok === true && plan.ops.length > 0 ? h('span', { style: styles.mono }, `${plan.ops.length} 项变更待提交`) : null,
          h(Notice, { notice: state.notice }),
        ),
      );
    }

    return {
      inject: ['slots', 'remote', 'remote.session', 'configForms'],
      apply(ctx) {
        const store = createStore(ctx);
        ctx.effect(() => () => store.dispose(), 'default-model-lock: settings store');
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: SECTION_LABEL,
              inject: () => ({ store }),
            },
            DefaultModelLockSection,
          ),
        );
      },
      __internals: {
        SECTION_ID,
        SECTION_ORDER,
        NAMESPACE,
        normalizeConfig,
        groupsOf,
        findGroup,
        findModel,
        effortOptionsOf,
        providerOptions,
        modelOptions,
        effortOptions,
        describeAvailability,
        planSave,
        createStore,
        looksLikeThisPlugin,
      },
    };
  },
});
