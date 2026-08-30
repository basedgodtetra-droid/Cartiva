import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createPersistedComparisonEnvelope,
  parsePersistedComparisonEnvelope,
  type PersistedComparisonEnvelope,
} from "@cartiva/shared";

const STORAGE_KEY = "cartiva.comparison-state.v1";
export type PersistedCartivaState<TComparison = unknown> = PersistedComparisonEnvelope<TComparison>;
export const parsePersistedCartivaState = parsePersistedComparisonEnvelope;

export async function loadPersistedCartivaState() {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    return value ? parsePersistedCartivaState(value) : null;
  } catch {
    return null;
  }
}

export async function savePersistedCartivaState<TComparison>(
  state: Omit<PersistedCartivaState<TComparison>, "schemaVersion" | "savedAt">,
) {
  const envelope = createPersistedComparisonEnvelope(state);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export async function clearPersistedCartivaState() {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Local persistence is best-effort; comparison remains usable in memory.
  }
}
