// Node ships an experimental global `localStorage` getter that shadows the
// jsdom storage vitest installs, leaving `window.localStorage` undefined in
// jsdom test environments. Restore a working storage before components mount.
// This is a no-op where jsdom's own storage is reachable.

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
  }
}

if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const jsdomStorage = (window as typeof window & { _localStorage?: Storage })._localStorage
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: jsdomStorage ?? memoryStorage(),
  })
}
