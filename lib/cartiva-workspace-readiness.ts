export interface CompareReadinessInput {
  itemCount: number;
  unresolvedCount: number;
  limitReached: boolean;
  zipInput: string;
  resolvedZip: string;
  selectedLocationId: string;
}

export interface CompareReadiness {
  canCompare: boolean;
  itemsReady: boolean;
  zipValid: boolean;
  storeSelected: boolean;
  clarificationsRemaining: number;
  reason: string;
}

export function getCompareReadiness({
  itemCount,
  unresolvedCount,
  limitReached,
  zipInput,
  resolvedZip,
  selectedLocationId,
}: CompareReadinessInput): CompareReadiness {
  const itemsReady = itemCount > 0 && !limitReached;
  const zipValid = /^\d{5}$/.test(zipInput);
  const storeSelected = Boolean(selectedLocationId) && resolvedZip === zipInput;
  const clarificationsRemaining = Math.max(0, unresolvedCount);
  const canCompare = itemsReady
    && zipValid
    && storeSelected
    && clarificationsRemaining === 0;

  let reason = "Ready to compare the complete basket.";
  if (itemCount < 1) reason = "Add at least one grocery item to continue.";
  else if (limitReached) reason = "Reduce the grocery list before comparing.";
  else if (!zipInput) reason = "Enter a ZIP code to continue.";
  else if (!zipValid) reason = "Enter a valid 5-digit ZIP code.";
  else if (!storeSelected) reason = "Find and choose a nearby store to continue.";
  else if (clarificationsRemaining > 0) {
    reason = `${clarificationsRemaining} ${clarificationsRemaining === 1 ? "item needs" : "items need"} a quick choice.`;
  }

  return {
    canCompare,
    itemsReady,
    zipValid,
    storeSelected,
    clarificationsRemaining,
    reason,
  };
}
