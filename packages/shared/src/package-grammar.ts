/** Shared grammar for count-based retailer package contents. */
export const COUNTED_CONTENT_UNIT_PATTERN_SOURCE =
  "bars?|blades?|pacs?|pieces?|pods?|rolls?|sheets?|wipes?";

export const COUNTED_CONTENT_MODIFIER_PATTERN_SOURCE =
  "(?:(?:big|double|family|giant|jumbo|large|mega|regular|standard|super|triple|xl|select[ -]?a[ -]?size)[\\s-]+){0,3}";

export const COUNTED_CONTENT_SEPARATOR_PATTERN_SOURCE = "[\\s-]+";

export const MULTIPACK_CONTAINER_UNIT_PATTERN_SOURCE =
  "bags?|bottles?|boxes?|bunch(?:es)?|canisters?|cans?|cartons?|containers?|jars?|loaf|loaves|pouch(?:es)?|rolls?|trays?|tubs?";

export const OUTER_CONTAINER_UNIT_PATTERN_SOURCE =
  `${MULTIPACK_CONTAINER_UNIT_PATTERN_SOURCE}|each`;
