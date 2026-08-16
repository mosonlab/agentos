const memory = new Map<string, string>();
const degraded = new Set<string>();
const tombstones = new Set<string>();

export const storage = {
  get(key: string): string | null {
    if (degraded.has(key)) return tombstones.has(key) ? null : memory.get(key) ?? null;
    try { return window.localStorage.getItem(key); }
    catch { degraded.add(key); return memory.get(key) ?? null; }
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    tombstones.delete(key);
    try { window.localStorage.setItem(key, value); degraded.delete(key); }
    catch { degraded.add(key); }
  },
  remove(key: string): void {
    memory.delete(key);
    tombstones.add(key);
    try { window.localStorage.removeItem(key); degraded.delete(key); tombstones.delete(key); }
    catch { degraded.add(key); }
  },
};
