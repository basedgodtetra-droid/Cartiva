export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class JsonStateStore<T> {
  constructor(
    private readonly area: StorageAreaLike,
    private readonly key: string,
    private readonly defaultValue: () => T,
  ) {}

  async load(): Promise<T> {
    const result = await this.area.get(this.key);
    return (result[this.key] as T | undefined) ?? this.defaultValue();
  }

  async save(value: T) {
    await this.area.set({ [this.key]: value });
    return value;
  }

  async update(updater: (current: T) => T | Promise<T>) {
    const next = await updater(await this.load());
    return this.save(next);
  }

  async clear() {
    await this.area.remove(this.key);
  }
}

export function createMemoryStorageArea(initial: Record<string, unknown> = {}): StorageAreaLike {
  const state = { ...initial };
  return {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: state[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback]),
        );
      }
      return { ...state };
    },
    async set(items) {
      Object.assign(state, items);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete state[key];
    },
  };
}

export function chromeStorageArea(area: {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}): StorageAreaLike {
  return area;
}
