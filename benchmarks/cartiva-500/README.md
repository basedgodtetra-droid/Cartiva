# CARTIVA 500

CARTIVA 500 is the permanent normal-human grocery reliability benchmark. It complements—rather than replaces—CARTIVA 100 and embeds every CARTIVA 100 case as a regression.

Run the deterministic suite with:

```text
pnpm test:cartiva500
```

The fixture is regenerated deterministically with `node scripts/generate-cartiva-500.mjs`. Never remove a difficult case to improve the score. Add verified shopper failures to this fixture or a future successor.

## Groups

- A — 100 generic grocery requests
- B — 100 generic requests with quantity
- C — 100 vague attribute or shopping-purpose requests
- D — 100 typo, shorthand, and messy-input requests
- E — 100 planner and recipe-style requirements

Every case is evaluated against shuffled, reversed, and adversarial-price candidate orders. Discovery is capped at three attempts. The full local suite makes zero retailer requests.

## Targets

- At least 95% score 2 or 3
- At least 99% score at least 1
- Zero unexplained shopper dead-ends
- Zero unsafe automatic selections

Run records are append-only under `history/`.
