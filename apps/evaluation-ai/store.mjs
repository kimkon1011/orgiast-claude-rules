export const STORAGE_KEY = 'evaluation-ai-data';

export function createStore(storage = globalThis.localStorage, key = STORAGE_KEY) {
  return {
    load(fallback = null) {
      try {
        const value = storage?.getItem(key);
        return value === null || value === undefined ? fallback : JSON.parse(value);
      } catch { return fallback; }
    },
    save(value) {
      storage?.setItem(key, JSON.stringify(value));
      return value;
    },
    clear() { storage?.removeItem(key); },
  };
}
