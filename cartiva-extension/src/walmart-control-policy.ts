(() => {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const stateZipPattern = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|VI|GU|AS|MP)\s+(\d{5})(?:-\d{4})?(?=\s*(?:,?\s*(?:USA|United States))?\s*$)/i;

  const postalCodeFromUsAddress: CartivaWalmartControlPolicyApi["postalCodeFromUsAddress"] = (address) =>
    address.match(stateZipPattern)?.[1];

  const labelMatchesControl = (label: string, kind: CartivaWalmartControlKind) => {
    const value = normalize(label);
    if (kind === "increment") return /^(increase|increment|add one)\b/.test(value);
    if (/^add to (?:list|registry)\b/.test(value)) return false;
    return /^add(?:\b| to cart\b| item to cart\b)/.test(value);
  };

  const chooseCandidate: CartivaWalmartControlPolicyApi["chooseCandidate"] = ({
    kind,
    itemId,
    exactTitle,
    pageTitleMatches,
    candidates,
  }) => {
    if (!pageTitleMatches || !/^\d{6,20}$/.test(itemId)) return undefined;
    const exact = normalize(exactTitle);
    const eligible = candidates.flatMap((candidate, index) => {
      if (candidate.disabled || candidate.ariaDisabled || candidate.inRecommendation) return [];
      if (!labelMatchesControl(candidate.label, kind)) return [];
      if (candidate.associatedItemIds.length && !candidate.associatedItemIds.includes(itemId)) return [];
      const label = normalize(candidate.label);
      const exactLabel = exact.length >= 4 && (label.includes(exact) || exact.includes(label));
      const exactItem = candidate.associatedItemIds.includes(itemId);
      const grounded = exactItem || exactLabel || candidate.inPrimaryRoot || candidate.explicitControlSelector;
      const score = (exactItem ? 500 : 0)
        + (exactLabel ? 300 : 0)
        + (candidate.inPrimaryRoot ? 200 : 0)
        + (candidate.explicitControlSelector ? 100 : 0);
      return [{ index, grounded, score }];
    });
    const grounded = eligible.filter((candidate) => candidate.grounded);
    const choices = grounded.length ? grounded : eligible.length === 1 ? eligible : [];
    return choices.sort((left, right) => right.score - left.score || left.index - right.index)[0]?.index;
  };

  const api: CartivaWalmartControlPolicyApi = { postalCodeFromUsAddress, chooseCandidate };
  Object.assign(globalThis, { CartivaWalmartControlPolicy: api });
})();
