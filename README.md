# Cartiva

Cartiva is an independent grocery comparison and cart-building assistant. A shopper enters one grocery list and a ZIP code; Cartiva matches equivalent products across available local retailers, compares only complete and trustworthy baskets, and hands the shopper to the retailer to finish checkout. Cartiva never places an order or handles payment information.

The visible brand name and tagline live in `config/site.ts` as `siteConfig.name` and `siteConfig.tagline`.

## iPhone MVP

The existing website remains at the repository root. The new React Native + Expo + TypeScript application lives in [`mobile`](./mobile), while retailer-neutral parsing, product-intent types, attribute origins, availability states, and complete-basket rules live in [`packages/shared`](./packages/shared). Both clients use the existing Next.js backend; Kroger credentials never enter the mobile bundle.

The first mobile vertical is intentionally Kroger-only: list → clarification → exact Kroger-family location → flexible discovery → strict verification → complete/incomplete basket → capability-driven retailer handoff. Anonymous development uses the official banner shopping page and never claims a transfer. A deployed HTTPS backend can additionally enable owner-scoped Kroger customer authorization and confirmed Cart API adds only after explicit cart-write and durable-state deployment gates pass; success appears only after Kroger returns its documented confirmation response. Setup, physical-iPhone development, EAS Build, and TestFlight preparation are documented in [`mobile/README.md`](./mobile/README.md).

## Public web experience

The main Next.js routes now provide a complete marketing and product experience:

- `/` — neutral landing page, one-list value proposition, source labeling, and complete-basket policy.
- `/compare` — a live, owner-only Kroger-family basket check using official Locations and Products data. A regular-price product subtotal appears only when every requested line passes exact-store, package, stock, pickup, and confidence checks.
- `/how-it-works` — matching, completeness, provenance, location, and no-checkout rules in plain language.
- `/faq` and `/about` — shopper questions, independence, and product boundaries.
- `/prototype` — the preserved live Walmart-focused web prototype.

The separate `site/` deployment copy keeps its homepage animation as explicitly fixed sample data. The mobile application does not depend on that deployment copy: it uses the root Next.js mobile API routes. Anonymous comparison exposes no customer token or cart mutation. Optional mobile Kroger authorization and cart routes require an opaque temporary bearer, an owner-scoped immutable comparison receipt, a registered HTTPS callback, and encrypted server-side retailer tokens. Cartiva accounts, ordering, and payment handling are not part of this MVP.

The current security controls and the non-negotiable gates for any hosted backend are documented in [`SECURITY.md`](./SECURITY.md). Native Cartiva builds intentionally target iOS 17.4 or newer because Kroger production authorization returns through an app-claimed HTTPS universal link; no custom-scheme fallback is accepted in production.

The first owner-only Sites deployment is available at [cartiva-complete-cart.basedgodtetra.chatgpt.site](https://cartiva-complete-cart.basedgodtetra.chatgpt.site).

## Retailer integration status

As of August 24, 2026:

- Kroger-family product and location data are live on the owner-only hosted comparison page through Kroger's official APIs. Customer OAuth and cart operations remain available only in the local app and extension.
- The iPhone MVP uses official Kroger location and product data through an anonymous comparison API. Its capability endpoint reports `SHOPPING_PAGE_ONLY` until a registered mobile HTTPS callback, server session secret, explicit write opt-in, and reviewed secure-state deployment are configured. With those gates present, it can report `CART_TRANSFER_SUPPORTED`, authorize the shopper in the system browser, and submit only a fresh, server-preserved, complete basket whose inventory was verified in stock through Kroger's Cart API.
- Walmart official I/O OPD access is still pending. Current Walmart comparisons use clearly labeled third-party data.
- Target Partners approval is still pending. Current Target comparisons use clearly labeled third-party data and remain estimates unless the evidence proves the requested store.

## What the prototype does

- Accepts commas, new lines, natural-language connectors, and common adjacent grocery words.
- Presents an editable pre-search list with add, delete, and quantity controls.
- Supports browser speech recognition when the browser provides it.
- Preserves brands, quantities, package sizes, flavors, and restrictions.
- Parses the list locally while the user types. After a short pause, the extension can show exact Walmart products for the active item; product details are not requested until the list is submitted.
- Keeps a selected exact product ID separate from the shopper's text, so commas inside a Walmart title cannot create fake extra list items.
- Searches one selected Walmart store through server-side SerpApi without exposing credentials to the browser or extension. Decodo remains an optional fallback.
- Requires named brands to match; a store brand cannot silently replace Coca-Cola, Gatorade, FAGE, Pepsi, or another recognized brand.
- Stops genuinely ambiguous requests such as `cranberry` for clarification while making a visible, changeable assumption for common requests such as `bread`.
- Verifies the selected candidate through the Product Details endpoint using its Walmart product or item ID.
- Keeps the store-localized Walmart Search price as the basket estimate. Product details verify identity, brand, package, availability, and the canonical Walmart URL without silently replacing that price.
- Rejects third-party marketplace and shipping-only offers from the pickup basket. Exact shelf and checkout prices remain Walmart's final authority.
- Tracks current, sale, regular, unit, shipping, marketplace, Search API, and Product API price provenance separately.
- Checks pack arithmetic and reported unit prices with a 15% consistency tolerance.
- Includes only reliable, identity-verified Walmart matches in the subtotal. No-match and API-error items are excluded, and totals use integer cents internally.
- Pipelines concurrent list searches and product verification within conservative app limits. Search results are cached for 30 minutes and product details for 45 minutes in server memory.
- Offers a separate Target flow backed by Parse.bot ZIP-localized product search and selected-store availability checks. The extension adds verified matches through Target's visible controls and pauses when Target requires sign-in or a shopper choice.
- Uses Kroger's official Locations and Products APIs for exact selected-location catalog, price, promotion, stock, and fulfillment data across Kroger-family banners.
- Connects a shopper through Kroger OAuth and batches verified UPCs through Kroger's official write-only Cart API. A persisted operation ID prevents a completed request from being submitted twice.
- Starts with one ZIP code, automatically selects a current Walmart and Kroger-family location returned for that ZIP, and includes Target through a clearly labeled ZIP-localized estimate. After the grocery list stops changing briefly, Cartiva compares every available retailer automatically with no retailer chooser, store dropdown, or separate Compare button.
- Compares the same delivery list across any two or three available Walmart, Target, and Kroger-family contexts in parallel. A retailer can be labeled lowest only when its complete basket has fresh, reliable prices and equivalent package sizes for every requested item. Partial baskets never receive a false $0 advantage.
- Keeps comparison and cart building separate. After reviewing the totals, the shopper chooses one retailer, and Cartiva activates only that retailer's cached basket and existing cart flow.
- Runs automatically with realistic Walmart demo data when no live Walmart provider is configured.

## What it intentionally does not do

This prototype does not support Albertsons, coupons, payments, recipes, pantry management, advertisements, or checkout automation. It never submits an order. It does not use an OpenAI API. Cartiva is independent and is not affiliated with or endorsed by Walmart, Target, or Kroger.

## Install and run locally

Requirements: Node.js 22.13 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Quality checks:

```bash
npm run lint
npm test
npm run build
```

## Retailer data setup

1. Create or sign in to SerpApi for Walmart and Parse.bot for Target. Register a free Kroger Developer application with Locations, Products, Profile, and Cart access.
2. Copy `.env.example` to `.env.local`.
3. Add the server-only SerpApi, Parse.bot, and Kroger client credentials. Never use a `NEXT_PUBLIC_` variable for a retailer credential, and never commit `.env.local`.
4. Set `WALMART_DATA_PROVIDER=serpapi`.
5. Set the numeric Walmart store ID, display name, and location.
6. Restart the development server after changing environment values.

Exact `.env.local` format:

```dotenv
SERPAPI_API_KEY=your_private_serpapi_key_here
WALMART_DATA_PROVIDER=serpapi
PARSEBOT_API_KEY=your_private_parsebot_key_here
TARGET_DATA_PROVIDER=parsebot
REDCIRCLE_API_KEY=
DECODO_AUTH_TOKEN=
WALMART_STORE_ID=512
WALMART_STORE_NAME=El Paso Walmart
WALMART_STORE_LOCATION=El Paso, TX
CARTIVA_EXTENSION_ID=
CARTIVA_EXTENSION_DEV_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
KROGER_CLIENT_ID=your_kroger_client_id
KROGER_CLIENT_SECRET=your_kroger_client_secret
KROGER_REDIRECT_URI=http://localhost:3000/api/kroger/oauth/callback
CARTIVA_MOBILE_ALLOWED_ORIGINS=http://localhost:8081,http://127.0.0.1:8081
```

The automatic comparison uses one ZIP to resolve Walmart and Kroger-family locations and to localize Target. Walmart and Kroger product requests retain the automatically selected provider-returned store ID; Target participates as a ZIP-localized delivery estimate because its current provider does not expose a trustworthy general store locator. Kroger credentials and customer OAuth tokens stay on the local server and are never returned to Chrome.

The previous ScrapingBee implementation remains available in `lib/scrapingbee.ts`, but no active route imports it.

## Data modes

If no configured Walmart provider credential is available, the Walmart flow uses `lib/mock-data.ts` and displays **Demo data**. Target live search requires `TARGET_DATA_PROVIDER=parsebot` and `PARSEBOT_API_KEY`. Kroger live search requires the registered Kroger client credentials and never falls back to demo data.

With the relevant provider configured, the interface displays live Walmart, Target, or Kroger data. A complete live-data failure changes the badge to the appropriate unavailable state.

## Chrome extension backend access

The website keeps its existing same-origin `POST /api/search` behavior. The extension uses `POST /api/extension/search` for Walmart, `POST /api/extension/target/search` for Target, and the `/api/extension/kroger/*` routes for official Kroger locations, search, OAuth state, and cart adding. Retailer credentials never enter Chrome.

Shoppers do not need to choose a retailer or enter store numbers. At five ZIP digits, the extension resolves Walmart and Kroger-family locations in parallel, uses the first valid provider-returned location unless a still-current saved location is returned again, and marks Target as a ZIP estimate. It never calls the automatic choice the nearest store because the normalized directory responses do not prove distance. Once the list remains unchanged briefly, the extension starts the comparison automatically. Cart mutation remains separate and occurs only after the shopper explicitly chooses one retailer's basket.

During the first local load, the extension route accepts well-formed unpacked Chrome-extension origins and the loopback origins listed in `CARTIVA_EXTENSION_DEV_ORIGINS`. Set `CARTIVA_EXTENSION_ID` to the exact 32-character ID Chrome assigns to the unpacked Cartiva folder; once configured, that ID is enforced in development and production and all other extension origins are rejected. The endpoint supports browser CORS preflight through `OPTIONS` and permits only JSON `POST` requests.

The standalone Manifest V3 project lives in [`cartiva-extension`](./cartiva-extension). With the backend running, build and load it locally:

```bash
cd cartiva-extension
npm test
npm run typecheck
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `cartiva-extension/dist` or the versioned unpacked Cartiva 4 release folder. The complete test flow, architecture, safety rules, and current limitations are documented in [`cartiva-extension/README.md`](./cartiva-extension/README.md). Version 0.6.0 is delivered as a regular folder with `manifest.json` at its root.

This single-computer release uses only a loopback Cartiva backend. The local bridge binds to `127.0.0.1` so another device on the Wi-Fi cannot invoke the shopper's persisted Kroger cart connection. Kroger customer OAuth tokens are stored in an authenticated encrypted envelope and legacy plaintext sessions migrate on first use. A multi-user or remote release requires managed user authentication, authenticated extension pairing, encrypted per-user token storage, owner-scoped records, durable abuse limits, a real HTTPS backend, and the published extension ID configured in `CARTIVA_EXTENSION_ID`.

## Price and checkout limitations

Matched items show price provenance and last-checked time. Walmart Search receives the selected store and ZIP; Product Details verifies identity separately and never silently replaces the localized Search price. Target prices remain labeled estimates unless the upstream response proves the requested store. Kroger prices and fulfillment come from official Products requests scoped to the selected location. Unknown stock, missing UPCs, unsupported fulfillment, and stale results are excluded. Comparison totals are product subtotals only and exclude taxes, fees, tips, deposits, memberships, and checkout changes. Conditional Kroger promotions are not used as the comparison baseline unless the response proves they are unconditional.

In development, the results screen includes sanitized performance diagnostics. Coke Zero searches also expose a collapsed candidate audit with product identifiers, seller, current/regular/sale/unit price, fulfillment, store ID, price source, and the reason each candidate was accepted or rejected. It never includes the API key.

SerpApi and Parse.bot provide product data, not approved retailer cart or checkout APIs. The extension therefore uses visible, sequential interaction with Walmart and Target Add controls and waits for page confirmation. Kroger is different: its official public Cart API accepts verified UPCs after customer OAuth, but it is write-only and does not bind the selected search location. Cartiva opens the banner cart so the shopper can confirm the active store, quantities, availability, and final prices. No flow places an order, bypasses security, or enters payment information.

## Recommended next steps after validation

1. Test live matching across several Walmart, Target, and Kroger-family stores and a larger set of grocery lists.
2. Review clarification and verification failures using anonymized examples.
3. Add structured observability for search latency, product-detail failures, and verification reasons without storing personal lists.
4. Confirm the selected SerpApi and Parse.bot plans' limits and monitor Kroger's published daily API quotas before wider testing.
5. Rotate any credential shown in a screenshot before public distribution, and add authenticated multi-user token storage before moving the backend off localhost.
