(() => {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const labelMatchesControl = (label: string, kind: CartivaTargetControlKind) => {
    const value = normalize(label);
    if (kind === "increment") return /^(increase|increment|add one)\b/.test(value);
    if (/^add to (?:list|registry|favorites|wishlist)\b/.test(value)) return false;
    return /^(?:add(?: to cart)?|ship it|pick it up|get it today)\b/.test(value);
  };

  const fulfillmentCellIsSelected: CartivaTargetControlPolicyApi["fulfillmentCellIsSelected"] = ({
    ariaLabel,
    ariaSelected,
    ariaPressed,
    dataSelected,
  }) => {
    const label = (ariaLabel ?? "").toLowerCase();
    const labelSelected = !label.includes("unselected")
      && /(?:^|\s|-)selected(?:\s|-|$)/.test(label);
    return ariaSelected === "true" || ariaPressed === "true" || dataSelected === "true" || labelSelected;
  };

  const visiblePickupStoreMatches: CartivaTargetControlPolicyApi["visiblePickupStoreMatches"] = (
    expectedStoreId,
    elementId,
  ) => /^\d{3,4}$/.test(expectedStoreId ?? "")
    && elementId?.match(/^store-name-(\d{3,4})$/)?.[1] === expectedStoreId;

  const chooseCandidate: CartivaTargetControlPolicyApi["chooseCandidate"] = ({
    kind,
    tcin,
    exactTitle,
    pageTitleMatches,
    fulfillmentMode,
    candidates,
  }) => {
    if (!pageTitleMatches || !/^\d{6,12}$/.test(tcin)) return undefined;
    const exact = normalize(exactTitle);
    const eligible = candidates.flatMap((candidate, index) => {
      if (candidate.disabled || candidate.ariaDisabled || candidate.inRecommendation) return [];
      if (!labelMatchesControl(candidate.label, kind)) return [];
      if (candidate.fulfillmentModes.length && !candidate.fulfillmentModes.includes(fulfillmentMode)) return [];
      const label = normalize(candidate.label);
      const exactLabel = exact.length >= 4 && (label.includes(exact) || exact.includes(label));
      const exactMode = candidate.fulfillmentModes.includes(fulfillmentMode);
      const grounded = exactLabel || exactMode || candidate.inPrimaryRoot || candidate.explicitControlSelector;
      const score = (exactMode ? 500 : 0)
        + (exactLabel ? 300 : 0)
        + (candidate.inPrimaryRoot ? 200 : 0)
        + (candidate.explicitControlSelector ? 100 : 0);
      return [{ index, grounded, score }];
    });
    const grounded = eligible.filter((candidate) => candidate.grounded);
    const choices = grounded.length ? grounded : eligible.length === 1 ? eligible : [];
    return choices.sort((left, right) => right.score - left.score || left.index - right.index)[0]?.index;
  };

  Object.assign(globalThis, {
    CartivaTargetControlPolicy: {
      chooseCandidate,
      fulfillmentCellIsSelected,
      visiblePickupStoreMatches,
    } satisfies CartivaTargetControlPolicyApi,
  });
})();
