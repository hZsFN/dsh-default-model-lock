// Runtime-only lock: no profile writes and no model selection requests.
export function readPolicy(config) {
  const read = (key) => {
    const value = config[key];
    return value && typeof value.get === 'function' ? value.get() : value;
  };
  const enabled = read('enabled');
  if (typeof enabled !== 'boolean') throw new TypeError('default-model-lock: enabled must be boolean');
  if (!enabled) return { enabled: false };
  const provider = read('provider');
  const model = read('model');
  const effort = read('reasoningEffort');
  for (const [key, value] of [['provider', provider], ['model', model]]) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
      throw new TypeError(`default-model-lock: ${key} must be a non-empty, trimmed string`);
    }
  }
  if (typeof effort !== 'string' || effort !== effort.trim()) {
    throw new TypeError('default-model-lock: reasoningEffort must be a trimmed string (empty means omitted)');
  }
  return { enabled: true, selection: { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) } };
}

const installations = new WeakMap();

export function installLock(ctx, config, originalSymbol) {
  const service = ctx.get('agentDefaultModel');
  if (!service) throw new Error('default-model-lock: agentDefaultModel is unavailable');
  const target = service[originalSymbol] ?? service;
  if (installations.has(target)) throw new Error('default-model-lock: another lock owns this service');
  const keys = ['currentSelection', 'saveSelection'];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]));
  const original = Object.fromEntries(keys.map((key) => [key, target[key]]));
  for (const key of keys) {
    if (typeof original[key] !== 'function') throw new TypeError(`default-model-lock: missing ${key}`);
    const descriptor = descriptors.get(key);
    if (descriptor && !descriptor.configurable) throw new TypeError(`default-model-lock: ${key} is not configurable`);
  }
  if (!Object.isExtensible(target)) throw new TypeError('default-model-lock: service is not extensible');
  let active = true;
  const wrappers = {
    currentSelection: function (...args) {
      if (!active) return Reflect.apply(original.currentSelection, this, args);
      const policy = readPolicy(config);
      return policy.enabled ? { ...policy.selection } : Reflect.apply(original.currentSelection, this, args);
    },
    saveSelection: async function (...args) {
      if (!active) return Reflect.apply(original.saveSelection, this, args);
      const policy = readPolicy(config);
      if (!policy.enabled) return Reflect.apply(original.saveSelection, this, args);
      // Intentionally never enter the original serialized save queue while locked.
    },
  };
  const token = {};
  installations.set(target, token);
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const key of keys) {
      // Do not clobber a later third-party patch.
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrappers[key]) continue;
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
    if (installations.get(target) === token) installations.delete(target);
  };
  try {
    for (const key of keys) Object.defineProperty(target, key, {
      configurable: true, writable: true, enumerable: descriptors.get(key)?.enumerable ?? false,
      value: wrappers[key],
    });
    ctx.effect(() => dispose);
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
