import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  KrogerCartAddOutcome,
  KrogerCartComparisonIdentity,
} from "./kroger-handoff-api";
import {
  parseKrogerCartSubmissionMarker,
  type KrogerCartSubmissionMarker,
  type KrogerCartSubmissionPhase,
} from "./cart-submission-marker";

export type {
  KrogerCartSubmissionMarker,
  KrogerCartSubmissionPhase,
} from "./cart-submission-marker";

const STORAGE_KEY = "cartiva.kroger-cart-submission.v1";

function markerFor(
  identity: KrogerCartComparisonIdentity,
  phase: KrogerCartSubmissionPhase,
  details: Pick<KrogerCartSubmissionMarker, "message" | "handoffUrl" | "reviewUrl"> = {},
): KrogerCartSubmissionMarker {
  return {
    schemaVersion: 1,
    retailer: "kroger",
    ...identity,
    phase,
    updatedAt: new Date().toISOString(),
    ...details,
  };
}

async function writeMarker(marker: KrogerCartSubmissionMarker) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(marker));
}

export async function markKrogerCartSubmitting(
  identity: KrogerCartComparisonIdentity,
) {
  try {
    await writeMarker(markerFor(identity, "SUBMITTING"));
  } catch {
    throw new Error(
      "Cartiva could not safely record this cart attempt. Nothing was sent to Kroger; free device storage and try again.",
    );
  }
}

export async function clearKrogerCartSubmissionMarker(
  comparisonId: string,
) {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (!stored) return true;
    const marker = parseKrogerCartSubmissionMarker(stored);
    if (!marker || marker.comparisonId === comparisonId) {
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/** Server owner recovery returned NONE, so any device-only marker is stale. */
export async function clearKrogerCartSubmissionMarkerAfterOwnerNone() {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function recordKrogerCartSubmissionOutcome(
  identity: KrogerCartComparisonIdentity,
  outcome: KrogerCartAddOutcome,
) {
  if (outcome.status === "CONFIRMED") {
    try {
      await writeMarker(markerFor(identity, "CONFIRMED", {
        message: outcome.message,
        handoffUrl: outcome.handoff.url,
      }));
      return true;
    } catch {
      return false;
    }
  }
  if (outcome.status === "OUTCOME_UNKNOWN" || !outcome.retrySafe) {
    try {
      await writeMarker(markerFor(identity, "OUTCOME_UNKNOWN", {
        message: outcome.error,
        reviewUrl: outcome.reviewHandoff?.url,
      }));
      return true;
    } catch {
      return false;
    }
  }
  return clearKrogerCartSubmissionMarker(identity.comparisonId);
}

export async function loadKrogerCartSubmissionMarker(
  comparisonId: string,
) {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const marker = parseKrogerCartSubmissionMarker(stored);
    if (!marker) {
      throw new Error("The previous cart submission record could not be verified.");
    }
    return marker?.comparisonId === comparisonId ? marker : null;
  } catch (error) {
    throw new Error(
      "Cartiva could not verify whether this basket was submitted before. Automatic cart add is disabled until local storage is available.",
      { cause: error },
    );
  }
}

export async function markInterruptedKrogerCartSubmissionUnknown(
  marker: KrogerCartSubmissionMarker,
) {
  if (marker.phase !== "SUBMITTING") return marker;
  const recovered = markerFor({
    comparisonId: marker.comparisonId,
    locationId: marker.locationId,
    retailerBanner: marker.retailerBanner,
  }, "OUTCOME_UNKNOWN", {
    message: "Cartiva closed before Kroger's response was recorded. Check your retailer cart before trying again.",
  });
  try {
    await writeMarker(recovered);
  } catch {
    // The in-memory recovery state still prevents an unsafe retry this run.
  }
  return recovered;
}
