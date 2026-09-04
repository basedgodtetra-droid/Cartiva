import { writeFileSync } from "node:fs";
import path from "node:path";

const cases = [];

function add(group, input, expectedItems) {
  cases.push({
    id: `CFR-${group}-${String(cases.filter((testCase) => testCase.group === group).length + 1).padStart(3, "0")}`,
    group,
    input,
    tags: ["ITEM_FRAGMENT_ATTACHMENT", "ORPHAN_MODIFIER"],
    expectedItems,
  });
}

const ratioSeeds = [
  ["ground beef", "Ground Beef", "93/7", "1 lb", "1 lb"],
  ["ground beef", "Ground Beef", "90/10", "2 lb", "2 lb"],
  ["ground beef", "Ground Beef", "80/20", "3 pounds", "3 lb"],
  ["ground turkey", "Ground Turkey", "93/7", "3 lb", "3 lb"],
  ["ground turkey", "Ground Turkey", "85/15", "2 pounds", "2 lb"],
];

for (const [product, name, ratio, weight, normalizedWeight] of ratioSeeds) {
  const expected = [{
    name,
    detail: `${ratio} · ${normalizedWeight}`,
    canonicalText: `${name}, ${ratio}, ${normalizedWeight}`,
    leanRatio: ratio,
    requestedWeight: normalizedWeight,
  }];
  add("RATIO", `${product}, ${ratio}, ${weight}`, expected);
  add("RATIO", `${product},${ratio},${weight.replace(" ", "")}`, expected);
  add("RATIO", `${ratio} ${product} ${weight}`, expected);
  add("RATIO", `${product} ${ratio.replace("/", " ")} ${weight}`, expected);
}

const produceSeeds = [
  ["bananas", "Bananas", 6],
  ["apples", "Apples", 4],
  ["avocados", "Avocados", 3],
  ["limes", "Limes", 6],
  ["tomatoes", "Tomatoes", 5],
];

for (const [product, name, quantity] of produceSeeds) {
  const expected = [{
    name,
    detail: `${quantity} each`,
    canonicalText: `${name}, ${quantity} each`,
  }];
  add("EACH", `${product}, ${quantity}`, expected);
  add("EACH", `${product},${quantity}`, expected);
  add("EACH", `${product} ${quantity}`, expected);
  add("EACH", `${quantity} ${product}`, expected);
}

const packageSeeds = [
  {
    inputs: ["large eggs, 18 count", "large eggs,18ct", "large eggs 18 count", "large eggs, 18-count"],
    expected: { name: "Large Eggs", detail: "18 ct", canonicalText: "Large Eggs, 18 ct" },
  },
  {
    inputs: ["2% milk, 1 gallon", "2%milk,1gallon", "2% milk 1 gallon", "2% milk, 1 gal"],
    expected: { name: "2% Milk", detail: "1 gallon", canonicalText: "2% Milk, 1 gallon" },
  },
  {
    inputs: ["Coke Zero, 12 pack", "Coke Zero,12pk", "Coke Zero 12 pack", "Coke Zero, 12-pack"],
    expected: { name: "Coke Zero", detail: "12 pack", canonicalText: "Coke Zero, 12 pack" },
  },
  {
    inputs: ["paper towels, 6 rolls", "paper towels,6rolls", "paper towels 6 rolls", "paper towels, 6-rolls"],
    expected: { name: "Paper Towels", detail: "6 rolls", canonicalText: "Paper Towels, 6 rolls" },
  },
  {
    inputs: ["black beans, 3 cans", "black beans,3cans", "black beans 3 cans", "black beans, 3 cans total"],
    expected: { name: "Black Beans", detail: "3 cans", canonicalText: "Black Beans, 3 cans" },
  },
];

for (const seed of packageSeeds) {
  for (const input of seed.inputs) {
    const expected = /\stotal$/i.test(input)
      ? { ...seed.expected, canonicalText: `${seed.expected.canonicalText} total` }
      : seed.expected;
    add("PACKAGE", input, [expected]);
  }
}

const attributeSeeds = [
  {
    chunks: ["chicken breast", "boneless", "skinless", "2 lb"],
    expected: { preparation: "boneless skinless", requestedWeight: "2 lb" },
  },
  {
    chunks: ["chicken thighs", "bone-in", "skin-on", "2 lb"],
    expected: { preparation: "bone-in skin-on", requestedWeight: "2 lb" },
  },
  {
    chunks: ["shrimp", "large", "1 lb"],
    expected: { size: "large", requestedWeight: "1 lb" },
  },
  {
    chunks: ["pork bacon", "thick-cut", "12 oz"],
    expected: { style: "thick cut", requestedWeight: "12 oz" },
  },
  {
    chunks: ["turkey breast", "boneless", "3 lb"],
    expected: { preparation: "boneless", requestedWeight: "3 lb" },
  },
];

for (const seed of attributeSeeds) {
  const [product, ...modifiers] = seed.chunks;
  const expected = [{ itemCountOnly: true, ...seed.expected }];
  add("ATTRIBUTE", [product, ...modifiers].join(", "), expected);
  add("ATTRIBUTE", [product, ...modifiers].join(","), expected);
  add("ATTRIBUTE", [product, ...modifiers].join(" "), expected);
  add("ATTRIBUTE", `${product}; ${modifiers.join(" ")}`, [
    { itemCountOnly: true },
  ]);
}

const mixedSeeds = [
  {
    groups: ["milk", "eggs", "bread"],
    expected: ["Milk", "Eggs", "Bread"],
  },
  {
    groups: ["bananas, 6", "2% milk, 1 gallon", "white bread"],
    expected: ["Bananas, 6 each", "2% Milk, 1 gallon", "White Bread"],
  },
  {
    groups: ["ground beef, 93/7, 1 lb", "bananas, 6", "white bread"],
    expected: ["Ground Beef, 93/7, 1 lb", "Bananas, 6 each", "White Bread"],
  },
  {
    groups: ["large eggs, 18 count", "2% milk, 1 gallon", "Coke Zero, 12 pack"],
    expected: ["Large Eggs, 18 ct", "2% Milk, 1 gallon", "Coke Zero, 12 pack"],
  },
  {
    groups: ["black beans, 3 cans", "Coke Zero, 12 pack", "paper towels, 6 rolls"],
    expected: ["Black Beans, 3 cans", "Coke Zero, 12 pack", "Paper Towels, 6 rolls"],
  },
];

for (const seed of mixedSeeds) {
  const expectedItems = seed.expected.map((canonicalText) => ({ canonicalText }));
  add("MIXED", seed.groups.join(", "), expectedItems);
  add("MIXED", seed.groups.map((group) => group.replaceAll(", ", ",")).join(","), expectedItems);
  add("MIXED", seed.groups.join("\n"), expectedItems);
  add("MIXED", seed.groups.join("; "), expectedItems);
}

const groupCounts = Object.fromEntries(
  ["RATIO", "EACH", "PACKAGE", "ATTRIBUTE", "MIXED"].map((group) => [
    group,
    cases.filter((testCase) => testCase.group === group).length,
  ]),
);

if (cases.length !== 100 || Object.values(groupCounts).some((count) => count !== 20)) {
  throw new Error(`Fragment regression distribution is invalid: ${JSON.stringify(groupCounts)}`);
}

const fixture = {
  schemaVersion: 1,
  suite: {
    id: "cartiva-item-fragment-attachment-100",
    title: "Cartiva item fragment attachment regressions",
    failureCategories: ["ITEM_FRAGMENT_ATTACHMENT", "ORPHAN_MODIFIER"],
    requiredCases: 100,
    requiredPerGroup: 20,
  },
  cases,
};

const output = path.join(process.cwd(), "tests/fixtures/cartiva-item-fragment-attachment.json");
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Generated ${cases.length} item-fragment regressions (${JSON.stringify(groupCounts)}).`);
