const KROGER_FAMILY_DOMAINS: Record<string, string> = {
  KROGER: "www.kroger.com",
  RALPHS: "www.ralphs.com",
  "FRED MEYER": "www.fredmeyer.com",
  "KING SOOPERS": "www.kingsoopers.com",
  "FRY'S": "www.frysfood.com",
  "SMITH'S": "www.smithsfoodanddrug.com",
  QFC: "www.qfc.com",
  DILLONS: "www.dillons.com",
  "HARRIS TEETER": "www.harristeeter.com",
  "MARIANO'S": "www.marianos.com",
  "PICK 'N SAVE": "www.picknsave.com",
  "FOOD 4 LESS": "www.food4less.com",
  "CITY MARKET": "www.citymarket.com",
  "BAKER'S": "www.bakersplus.com",
  BAKERS: "www.bakersplus.com",
  "FOODS CO": "www.foodsco.net",
  GERBES: "www.gerbes.com",
  "JAY C": "www.jaycfoods.com",
  "METRO MARKET": "www.metromarket.net",
  "PAY-LESS": "www.pay-less.com",
  "PAY LESS": "www.pay-less.com",
  RULER: "www.rulerfoods.com",
};

function familyKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

const FAMILY_DOMAIN_BY_KEY = new Map(
  Object.entries(KROGER_FAMILY_DOMAINS).map(([name, domain]) => [familyKey(name), domain]),
);

const FAMILY_DISPLAY_NAMES: Record<string, string> = {
  KROGER: "Kroger",
  RALPHS: "Ralphs",
  FREDMEYER: "Fred Meyer",
  KINGSOOPERS: "King Soopers",
  FRYS: "Fry's",
  SMITHS: "Smith's",
  QFC: "QFC",
  DILLONS: "Dillons",
  HARRISTEETER: "Harris Teeter",
  MARIANOS: "Mariano's",
  PICKNSAVE: "Pick 'n Save",
  FOOD4LESS: "Food 4 Less",
  CITYMARKET: "City Market",
  BAKERS: "Baker's",
  FOODSCO: "Foods Co",
  GERBES: "Gerbes",
  JAYC: "Jay C",
  METROMARKET: "Metro Market",
  PAYLESS: "Pay-Less",
  RULER: "Ruler",
};

export const KROGER_FAMILY_HOSTS = new Set(Object.values(KROGER_FAMILY_DOMAINS));

export function krogerFamilyDomain(chain?: string) {
  return chain ? FAMILY_DOMAIN_BY_KEY.get(familyKey(chain)) : undefined;
}

export function krogerFamilyDisplayName(chain: string) {
  return FAMILY_DISPLAY_NAMES[familyKey(chain)] ?? chain;
}

export function krogerCartUrl(chain?: string) {
  return `https://${krogerFamilyDomain(chain) ?? "www.kroger.com"}/cart`;
}

export function isKrogerFamilyCartUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && KROGER_FAMILY_HOSTS.has(parsed.hostname.toLowerCase())
      && /^\/cart\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** A public shopping destination that never implies Cartiva transferred a cart. */
export function krogerShoppingUrl(chain?: string) {
  return `https://${krogerFamilyDomain(chain) ?? "www.kroger.com"}/`;
}
