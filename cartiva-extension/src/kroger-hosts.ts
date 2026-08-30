const KROGER_FAMILY_HOSTS = new Set([
  "www.kroger.com", "kroger.com",
  "www.ralphs.com", "ralphs.com",
  "www.fredmeyer.com", "fredmeyer.com",
  "www.kingsoopers.com", "kingsoopers.com",
  "www.frysfood.com", "frysfood.com",
  "www.smithsfoodanddrug.com", "smithsfoodanddrug.com",
  "www.qfc.com", "qfc.com",
  "www.dillons.com", "dillons.com",
  "www.harristeeter.com", "harristeeter.com",
  "www.marianos.com", "marianos.com",
  "www.picknsave.com", "picknsave.com",
  "www.food4less.com", "food4less.com",
  "www.citymarket.com", "citymarket.com",
  "www.bakersplus.com", "bakersplus.com",
  "www.foodsco.net", "foodsco.net",
  "www.gerbes.com", "gerbes.com",
  "www.jaycfoods.com", "jaycfoods.com",
  "www.metromarket.net", "metromarket.net",
  "www.pay-less.com", "pay-less.com",
  "www.rulerfoods.com", "rulerfoods.com",
]);

export function isTrustedKrogerFamilyUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && KROGER_FAMILY_HOSTS.has(url.hostname.toLowerCase())
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}

export function isTrustedKrogerCartUrl(value: string) {
  try {
    const url = new URL(value);
    return isTrustedKrogerFamilyUrl(value)
      && (url.pathname === "/cart" || url.pathname === "/cart/");
  } catch {
    return false;
  }
}

export function isTrustedKrogerAuthorizationUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "api.kroger.com"
      && !url.username
      && !url.password
      && !url.port
      && url.pathname === "/v1/connect/oauth2/authorize";
  } catch {
    return false;
  }
}

export function isTrustedKrogerNavigationUrl(value: string) {
  return isTrustedKrogerFamilyUrl(value) || isTrustedKrogerAuthorizationUrl(value);
}
