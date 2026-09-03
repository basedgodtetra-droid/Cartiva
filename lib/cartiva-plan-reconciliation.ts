import type { GroceryNotepadItem } from "@/lib/grocery-notepad";
import type { ConsolidatedIngredient } from "@/lib/cartiva-planning";

export interface StoredPlanIngredient {
  id: string;
  name: string;
  shoppingText: string;
  currentRaw?: string;
  position?: number;
}

function normalizedLine(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Plan lines carry their latest exact raw text. Name-only or position-only
 * matching can overwrite unrelated shopper groceries after insertions,
 * removals, or clarifications, so ownership is never guessed here.
 */
export function matchedCommittedPlanItemIndexes(
  currentItems: GroceryNotepadItem[],
  previousIngredients: StoredPlanIngredient[],
) {
  const matchedIndexes = new Set<number>();
  const currentRawByIngredientId = new Map<string, string>();
  const ingredientIdByItemIndex = new Map<number, string>();

  for (const ingredient of previousIngredients) {
    const expectedLine = normalizedLine(ingredient.currentRaw ?? ingredient.shoppingText);
    const preferredPosition = Number.isSafeInteger(ingredient.position)
      ? ingredient.position as number
      : -1;
    const preferredMatches = preferredPosition >= 0
      && !matchedIndexes.has(preferredPosition)
      && normalizedLine(currentItems[preferredPosition]?.raw ?? "") === expectedLine;
    const candidates = currentItems.flatMap((item, index) => (
      !matchedIndexes.has(index) && normalizedLine(item.raw) === expectedLine ? [index] : []
    ));
    // A stored exact position disambiguates identical manual and planned rows.
    // Without it, only a unique global exact match is safe to claim.
    const matchIndex = preferredMatches
      ? preferredPosition
      : candidates.length === 1
        ? candidates[0]
        : -1;
    if (matchIndex < 0) continue;
    matchedIndexes.add(matchIndex);
    currentRawByIngredientId.set(ingredient.id, currentItems[matchIndex].raw);
    ingredientIdByItemIndex.set(matchIndex, ingredient.id);
  }

  return { matchedIndexes, currentRawByIngredientId, ingredientIdByItemIndex };
}

export function reconcileCommittedPlanState(
  currentItems: GroceryNotepadItem[],
  previousIngredients: StoredPlanIngredient[],
  nextIngredients: ConsolidatedIngredient[],
) {
  const { matchedIndexes, currentRawByIngredientId } = matchedCommittedPlanItemIndexes(
    currentItems,
    previousIngredients,
  );
  const insertionIndex = matchedIndexes.size ? Math.min(...matchedIndexes) : currentItems.length;
  const previousById = new Map(previousIngredients.map((ingredient) => [ingredient.id, ingredient]));
  const planLines = nextIngredients.map((ingredient) => {
    const previous = previousById.get(ingredient.id);
    const reviewedRaw = currentRawByIngredientId.get(ingredient.id);
    return previous?.shoppingText === ingredient.shoppingText && reviewedRaw
      ? reviewedRaw
      : ingredient.shoppingText;
  });
  const before = currentItems.slice(0, insertionIndex)
    .filter((_, index) => !matchedIndexes.has(index))
    .map((item) => item.raw);
  const after = currentItems.slice(insertionIndex)
    .filter((_, index) => !matchedIndexes.has(index + insertionIndex))
    .map((item) => item.raw);
  return {
    rawInput: [...before, ...planLines, ...after].join("\n"),
    matchedIndexes,
    storedIngredients: nextIngredients.map((ingredient, index) => ({
      id: ingredient.id,
      name: ingredient.name,
      shoppingText: ingredient.shoppingText,
      currentRaw: planLines[index],
      position: before.length + index,
    } satisfies StoredPlanIngredient)),
  };
}

export function reconcileCommittedPlanIngredients(
  currentItems: GroceryNotepadItem[],
  previousIngredients: StoredPlanIngredient[],
  nextIngredients: ConsolidatedIngredient[],
) {
  return reconcileCommittedPlanState(currentItems, previousIngredients, nextIngredients).rawInput;
}

export function trackStoredPlanIngredientEdit(
  currentItems: GroceryNotepadItem[],
  previousIngredients: StoredPlanIngredient[],
  itemIndex: number,
  nextRaw: string | null,
) {
  const ingredientId = matchedCommittedPlanItemIndexes(
    currentItems,
    previousIngredients,
  ).ingredientIdByItemIndex.get(itemIndex);
  if (!ingredientId) return { ingredients: previousIngredients, tracked: false };
  if (nextRaw === null) {
    return {
      ingredients: previousIngredients.filter((ingredient) => ingredient.id !== ingredientId),
      tracked: true,
    };
  }
  return {
    ingredients: previousIngredients.map((ingredient) => ingredient.id === ingredientId
      ? { ...ingredient, currentRaw: nextRaw, position: itemIndex }
      : ingredient),
    tracked: true,
  };
}
