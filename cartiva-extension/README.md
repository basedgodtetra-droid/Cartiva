# Cartiva Chrome extension

Cartiva's Manifest V3 extension turns a grocery list into reliable Walmart, Target, or Kroger-family matches inside Chrome's side panel. Walmart and Target use guarded visible page controls; Kroger-family search and cart adding use Kroger's official APIs through Cartiva's local backend. The extension never places an order and never contains private retailer credentials.

## What v0.6.0 includes

- Cartiva opens in comparison mode. One five-digit ZIP automatically selects Walmart and Kroger store contexts returned for that ZIP, while Target participates as a clearly labeled ZIP estimate. No retailer picker, store dropdown, Target ID, or setup button is required.
- After the grocery list remains unchanged for 1.4 seconds, Cartiva checks ready Walmart, Target, and Kroger-family delivery baskets in parallel. ZIP lookup is debounced, stale lookups are aborted, and the same list-and-context signature is not searched twice.
- Comparison never adds products while evaluating prices. The shopper explicitly chooses one retailer after the results, and only that retailer's cached verified matches can continue into its existing cart flow.
- A retailer can be labeled lowest only after every participating search finishes and at least two complete baskets cover every requested item with fresh, reliable prices and equivalent package sizes. Partial baskets and mismatched sizes remain visible but cannot win.
- Verified exact-store totals and reliable localized estimates stay clearly separated. Kroger conditional promotions do not become the comparison baseline, and the subtotal excludes taxes, fees, tips, deposits, memberships, and checkout changes.

- Kroger-family retailer selection with the returned banner name (Kroger, Ralphs, Fry's, King Soopers, and others).
- Official Kroger ZIP location lookup, exact-location product search, one-time customer OAuth connection, and protected official cart adding.
- Kroger cart requests use a stable operation ID for the same store, fulfillment mode, UPCs, and quantities. If Kroger cannot confirm an outcome, Cartiva opens the cart for inspection and will not retry automatically.

- A progressive, mobile-first side panel with ZIP, list, and comparison stages in Cartiva's warm white, bright grass-green, and lime design.
- Local list parsing for lines, commas, simple sentences, quantities, brands, and package requirements.
- Optional browser speech recognition that writes editable text into the list.
- Exact Walmart product suggestions for the active item after a short typing pause. Suggestions come from the selected store search and keep the exact product ID separate from the shopper's text.
- ZIP-first pickup-store selection with human-readable addresses; Walmart store numbers remain internal.
- Progressive, batched list search and product-detail verification through the Cartiva backend.
- Strict named-brand, seller, fulfillment, product-ID, product-URL, stock, and category safeguards.
- A localized Walmart subtotal that excludes unresolved, demo, marketplace, unavailable, or identity-unverified products.
- A Change item workflow that always re-searches and re-verifies the alternative.
- Automatic cart building after the shopper presses **Build my Walmart cart**. Unresolved items stay visible and are not added.
- Sequential interaction with Walmart's visible Add controls and honest Ready, Adding, Added, Needs choice, Unavailable, Failed, and Skipped states.
- Persisted list, settings, results, and cart-build progress.
- Target delivery/shipping estimates localized by ZIP, pickup verification by Target store ID, canonical TCIN links, and sequential visible-control cart building.

The extension never completes checkout, reads payment information, bypasses login or CAPTCHA, or exposes retailer credentials or customer tokens. Cartiva is independent and is not affiliated with or endorsed by Walmart, Target, or Kroger.

## Architecture

- `manifest.json` — minimum MV3 permissions, side panel, background worker, and Walmart/Target content-script registration.
- `public/sidepanel.html` — accessible side-panel document with no inline JavaScript.
- `public/sidepanel.css` — responsive styling with visible focus states and reduced-motion support.
- `src/sidepanel.ts` — list entry, voice input, exact-product typeahead, progressive results, totals, automatic cart building, and recovery UI.
- `src/background.ts` — persisted cart-build coordinator, visible Walmart store-finder fallback, and sequential retailer navigation.
- `src/walmart-content.ts`, `src/target-content.ts` — exact-product checks and visible Add-control interaction behind centralized selectors.
- `src/backend-client.ts` — batched progressive backend clients, isolated comparison streams, cancellation, caching, and fulfillment checks.
- `src/comparison.ts` — deterministic basket coverage, freshness, package-equivalence, promotion, and lowest-total rules.
- `src/data-status.ts` — honest Demo, Live, partial-failure, and unavailable data badges.
- `src/parser.ts`, `src/totals.ts`, `src/cart-state.ts`, `src/storage.ts` — deterministic pure logic.
- `src/types.ts`, `src/messages.ts` — shared data and runtime-message contracts.

No Albertsons, coupons, payments, advertisements, private retailer cart APIs, or checkout automation are included.

## Run the Cartiva backend

From the repository root, install packages and create `.env.local`:

```dotenv
SERPAPI_API_KEY=your_private_serpapi_key_here
WALMART_DATA_PROVIDER=serpapi
PARSEBOT_API_KEY=your_private_parsebot_key_here
TARGET_DATA_PROVIDER=parsebot
KROGER_CLIENT_ID=your_private_kroger_client_id_here
KROGER_CLIENT_SECRET=your_private_kroger_client_secret_here
KROGER_REDIRECT_URI=http://localhost:3000/api/kroger/oauth/callback
REDCIRCLE_API_KEY=
DECODO_AUTH_TOKEN=
WALMART_STORE_ID=512
WALMART_STORE_NAME=El Paso Walmart
WALMART_STORE_LOCATION=El Paso, TX
CARTIVA_EXTENSION_ID=
CARTIVA_EXTENSION_DEV_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:8088,http://127.0.0.1:8088
```

Then run:

```bash
npm install
npm run dev
```

Run the Cartiva app on port 3000 and the packaged local extension proxy/launcher on `http://127.0.0.1:8088`. The extension's backend field should stay on `http://127.0.0.1:8088`; the Kroger OAuth callback alone returns to `http://localhost:3000/api/kroger/oauth/callback`. Private credentials remain in the server environment—never put them in an extension file or the side-panel settings field.

The extension uses these backend endpoints:

- `POST /api/extension/stores` accepts a ZIP and returns supported Walmart locations.
- `POST /api/extension/suggestions` returns exact Walmart products for the active item.
- `POST /api/extension/search` streams newline-delimited list search and verification events.
- `POST /api/extension/target/search` streams Target product matches. Target products are never sent to Walmart cart automation.
- `GET /api/extension/kroger/locations?zipCode=...` returns official Kroger-family locations and banner names.
- `POST /api/extension/kroger/search` streams exact-location official Kroger product matches.
- `POST /api/extension/kroger/auth/start` returns the official Kroger OAuth authorization URL; `GET /api/extension/kroger/auth/status` returns only connection state; `POST /api/extension/kroger/auth/disconnect` clears a stale or unwanted connection.
- `POST /api/extension/kroger/cart` adds verified UPCs through Kroger's public Cart API using an idempotent operation ID.

Kroger client credentials, customer access tokens, and refresh tokens stay on the backend. The extension never receives them. Search prices are tied to the selected location, but Kroger's Cart API does not accept a location ID; the shopper must verify the active retailer store and checkout price after the cart opens.

If the store directory has no exact-ZIP result, Cartiva can visibly open Walmart's public store finder and offer only the locations Walmart displays near that ZIP. It does not calculate or invent distance.

## Build and test

From `cartiva-extension`:

```bash
npm test
npm run typecheck
npm run build
```

The unpacked build is written to `cartiva-extension/dist`. A release ZIP can be created from that directory with `manifest.json` at the ZIP root.

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the absolute `cartiva-extension/dist` folder, or the stable outside-OneDrive `C:\Users\josh\Cartiva-extension` folder created by the release process.
5. Pin Cartiva if desired, then select its toolbar icon to open the side panel.

If Cartiva was already loaded, rebuild it and select **Reload** on its extension card.

## Walmart test flow

1. Start Cartiva and its extension proxy, then confirm the side-panel backend field says `http://127.0.0.1:8088`.
2. Enter a five-digit ZIP, then choose the pickup Walmart by address.
3. Enter a list such as:

   ```text
   Takis
   eggs
   bread
   Diet Coke
   Coke Zero 24 pack
   chicken breast 3 lb
   ```

4. Pause briefly on an item to see exact Walmart products from the selected location.
5. Select **Build my Walmart cart**. Parsed rows appear immediately and update independently.
6. Confirm the top badge says **Live Walmart data**. A complete failure says **Walmart data unavailable**; a partial failure says **Live data · some failed**.
7. Demo, unresolved, marketplace, unavailable, or identity-unverified rows must not enter the subtotal or automatic cart build.
8. Watch Walmart and the side panel. A row may say Added only after Walmart visibly confirms it.
9. If Walmart requires an option, login, store confirmation, or security check, complete it on Walmart and choose **I finished the choice — continue**.
10. Use **Review Walmart cart** and verify products, quantities, prices, and substitutions before checkout.

Walmart changes its page structure regularly. A selector failure must produce Failed or Needs choice—not a fabricated success.

## Target test flow

1. Choose **Target** at the top of Cartiva.
2. Enter a ZIP. Delivery or shipping works from ZIP alone; pickup testing also requires the three- or four-digit Target store ID.
3. Enter a grocery list and choose **Find my Target matches**.
4. Cartiva verifies the Target product identity from Parse.bot Search and checks selected-store inventory through Parse.bot availability only when the returned product, ZIP, and store all match the request.
5. Submit the list. Cartiva opens each canonical Target product page, selects the requested visible fulfillment tab, and clicks only the exact product's visible Add control.
6. If Target needs sign-in, a store, or another visible choice, complete it and choose **I finished the choice — continue**. Cartiva verifies the cart count before retrying and never retries blindly.
7. Review the Target cart before checkout. Cartiva never places the order.

## Kroger-family test flow

1. Choose **Kroger family**, enter a ZIP, and select one of the official nearby stores. Cartiva displays the returned banner name automatically.
2. Enter a list and submit it. Cartiva searches Kroger's official catalog for that exact location and includes only fresh, in-stock matches with an official UPC and the selected fulfillment mode.
3. Choose **Connect Kroger** once and finish Kroger sign-in in the new tab. OAuth credentials and customer tokens remain on the local backend.
4. Cartiva sends verified UPCs through Kroger's official Cart API. The same verified cart gets the same protected operation ID. If the outcome is uncertain, Cartiva will not retry; inspect the opened cart first.
5. Review the opened banner cart and confirm its active store, quantities, availability, and checkout prices. Cartiva never places the order.

## Automatic comparison test flow

1. Enter one ZIP and pause. Cartiva automatically selects the current provider-returned Walmart and Kroger contexts. Target is included by ZIP as an estimate; no Target store ID is requested.
2. Enter the grocery list once and stop typing for 1.4 seconds. Include explicit package sizes for the fairest result, such as `eggs 12 count`, `milk 1 gallon`, or `2 x cereal 18 oz`.
3. Cartiva searches each ready retailer independently and never adds anything during comparison.
4. Confirm incomplete, stale, differently sized, weighted-without-size, or unverified baskets have no lowest badge. A lowest result requires at least two complete equivalent baskets.
5. Explicitly choose one basket. Cartiva reuses that retailer's cached matches without re-searching and asks for the existing retailer-specific cart confirmation. No other retailer cart is changed.

## Price and production limitations

Cartiva localizes Walmart Search with the selected store and ZIP, then uses Product Details separately to verify identity without replacing the selected-store Search price. It uses exact-store wording only when Search returns matching store evidence; otherwise it labels the amount as a localized Walmart pickup estimate and keeps Walmart checkout final. Shipping products remain excluded from guided cart building until shipping-specific price provenance is available.

Target product search uses Parse.bot. Availability can confirm inventory at the selected store only after strict product, ZIP, and store identity checks, but it does not prove the displayed Search price is exact-store. Cartiva therefore labels Target amounts as estimates. Cart building uses only canonical TCIN pages and visible Target controls; it does not use a private Target cart API.

The local release accepts loopback Cartiva backends. A production release needs a real HTTPS backend origin in `host_permissions`, a matching UI allowlist entry, and the Chrome Web Store extension ID in `CARTIVA_EXTENSION_ID`. No fake production domain is hard-coded.

## Data and recovery

- The list, parsed items, results, and settings use `chrome.storage.local`.
- Cart-build progress is background-owned and restored when the side panel reopens.
- **Stop after current item** prevents later products from starting; it cannot undo a Walmart click already dispatched.
- The extension never stores or receives a SerpApi, Parse.bot, RedCircle, or Decodo credential.
