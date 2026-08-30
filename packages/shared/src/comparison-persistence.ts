const PERSISTED_COMPARISON_SCHEMA_VERSION = 1 as const;

export interface PersistedComparisonEnvelope<TComparison = unknown> {
  schemaVersion: typeof PERSISTED_COMPARISON_SCHEMA_VERSION;
  savedAt: string;
  rawInput: string;
  zipCode: string;
  comparison: TComparison | null;
}

export function createPersistedComparisonEnvelope<TComparison>(state: {
  rawInput: string;
  zipCode: string;
  comparison: TComparison | null;
}, savedAt = new Date().toISOString()): PersistedComparisonEnvelope<TComparison> {
  return {
    schemaVersion: PERSISTED_COMPARISON_SCHEMA_VERSION,
    savedAt,
    ...state,
  };
}

export function parsePersistedComparisonEnvelope(
  value: string,
): PersistedComparisonEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (
      state.schemaVersion !== PERSISTED_COMPARISON_SCHEMA_VERSION
      || typeof state.savedAt !== "string"
      || typeof state.rawInput !== "string"
      || state.rawInput.length > 10_000
      || typeof state.zipCode !== "string"
      || (state.zipCode !== "" && !/^\d{1,5}$/.test(state.zipCode))
      || (state.comparison !== null && typeof state.comparison !== "object")
    ) return null;
    return state as unknown as PersistedComparisonEnvelope;
  } catch {
    return null;
  }
}
