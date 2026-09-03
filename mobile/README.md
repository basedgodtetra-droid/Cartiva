# Cartiva mobile

Cartiva mobile is the iPhone-first Expo client for the existing Cartiva backend. It keeps grocery parsing in `@cartiva/shared`, sends retailer work to the Cartiva API, and never contains Kroger credentials.

The current vertical slice is real and deliberately narrow:

- natural grocery-list entry and local parsing;
- material, category-aware clarification;
- ZIP-based Kroger-family location lookup;
- official Kroger candidate search and strict verification at one location;
- complete versus incomplete basket enforcement;
- item evidence, alternatives, rejection, editing, and removal;
- capability-aware retailer handoff with an honest shopping-page fallback.

Basic comparison remains anonymous. When a deployed Cartiva backend has the separately registered mobile Kroger callback, a claimed iOS universal return link, secure temporary sessions, and reviewed secure-state storage configured, customer authorization stays in an ephemeral system-browser session. The callback stores Kroger tokens only as a short-lived encrypted pending connection; it cannot activate them. The signed Cartiva app must redeem the callback's opaque one-use completion with the same owner bearer that started authorization. Kroger tokens remain encrypted and owner-scoped on the server, and Cartiva can submit only the immutable complete comparison receipt. A complete comparison may contain honestly labeled `LIKELY_AVAILABLE` or `UNKNOWN` inventory evidence when the exact product, store price, UPC, quantity, and fulfillment eligibility are verified; only explicit `OUT_OF_STOCK` evidence blocks cart writing. A Kroger `204` response is required before the app can claim products were added.

Temporary mobile access bearers live for one hour and stop protected operations during their final five minutes. A separate high-entropy `r1` recovery credential in iOS SecureStore preserves the anonymous owner across renewal without turning an expired access bearer into an unlimited credential. The server persists only a domain-separated recovery hash and removes recovery owners after 30 days without a successful rotation. Each renewal proposes a fresh recovery token and atomically rotates current to next; the previous hash is accepted only for an exact lost-response retry that also proves the already-current next token. Reuse of that authentic previous token with a different successor revokes the whole credential family. `DELETE /api/mobile/v1/session` durably and idempotently revokes future recovery before the device deletes its only revocation handle, while an already-issued access bearer naturally ages out within one hour. Losing or resetting the device keychain ends recovery in this account-free MVP. An optional `CARTIVA_SESSION_PREVIOUS_SECRET` verifies access/OAuth records during signing-key rotation, while all new writes use the current key. Unactivated OAuth completions expire after five minutes; the supported persistent backend starts a bounded one-minute janitor that physically removes their pending encrypted tokens, and foreground authorization also prunes before use. Owner-scoped active Kroger token files retain their separate seven-day inactivity policy; disconnect durably invalidates outstanding OAuth state and removes the current owner's active and pending connections immediately. Its signed disconnect marker is needed only for the ten-minute OAuth-state window and is safely removed after that window, so a dormant marker cannot pin a retired signing key.

Confirmed and outcome-unknown cart-operation records intentionally survive disconnect. Reconnecting creates a new authorization generation, and an already submitted comparison cannot be replayed under a different Kroger account; the shopper must make a fresh comparison. The file-backed implementation serializes OAuth completion, disconnect, and cart mutation for one owner in one Node process and treats corrupt or unavailable durable state as a blocked operation, never as a first attempt.

## Run the backend

From the repository root:

```bash
npm install
copy .env.example .env.local
npm run dev:mobile-api
```

Add `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` only to the root `.env.local`. Do not copy them into `mobile/`. Anonymous comparison works without customer authorization. Mobile cart transfer additionally requires:

- `CARTIVA_SESSION_SECRET` (and the immediately previous value in `CARTIVA_SESSION_PREVIOUS_SECRET` while rotating it);
- a publicly reachable HTTPS `KROGER_MOBILE_REDIRECT_URI` registered exactly in the Kroger developer application;
- an HTTPS `CARTIVA_MOBILE_APP_RETURN_URI` ending in `/oauth/kroger`, served from a domain whose Apple App Site Association file claims the final Cartiva team and bundle identifier;
- the explicit `CARTIVA_ENABLE_KROGER_CART_WRITES=true` opt-in;
- reviewed owner-state storage and deployment topology.

A LAN or `localhost` callback cannot return an iPhone browser to the backend. Local development uses one Node process, local state files, and may fall back to `cartiva://oauth/kroger`. Production deliberately rejects that interceptable custom scheme and requires the claimed HTTPS universal link. Production local-file mode additionally requires `CARTIVA_SECURE_STATE_MODE=SINGLE_INSTANCE_FILESYSTEM`, all six absolute state paths from the root `.env.example` (including `CARTIVA_MOBILE_SESSION_FILE` and `CARTIVA_MOBILE_OAUTH_COMPLETION_DIR`), a non-Windows runtime with durable directory sync, exactly one backend replica, and a private persistent encrypted volume. It also requires `CARTIVA_TRUSTED_EDGE=true`, but only after the trusted rate-limiting edge strips spoofed forwarding headers and makes the backend origin unreachable directly. Do not select that mode on serverless or horizontally scaled hosting; use a transactional shared-state adapter there.

## Run the iPhone app

In a second terminal:

```bash
cd mobile
npm install
copy .env.example .env
npx expo start
```

Set `EXPO_PUBLIC_CARTIVA_API_URL` to the computer's LAN URL, for example `http://192.168.1.10:3000`. The iPhone and computer must be on the same trusted network. Local list editing works without a connection; store comparison requires the backend and internet access.

That LAN `http://` value is only for a locally served Expo Go or development-client bundle. Every EAS profile is guarded during Expo configuration: the build stops before compilation if `EXPO_PUBLIC_CARTIVA_API_URL` is missing, malformed, or not a deployed HTTPS origin. After `eas init`, set the public (non-secret) API origin in each named EAS environment from `mobile/`:

```bash
npx eas-cli@latest env:set --name EXPO_PUBLIC_CARTIVA_API_URL --value https://dev-api.example.com --environment development --visibility plaintext
npx eas-cli@latest env:set --name EXPO_PUBLIC_CARTIVA_API_URL --value https://preview-api.example.com --environment preview --visibility plaintext
npx eas-cli@latest env:set --name EXPO_PUBLIC_CARTIVA_API_URL --value https://api.example.com --environment production --visibility plaintext

npx eas-cli@latest env:list --environment development
npx eas-cli@latest env:list --environment preview
npx eas-cli@latest env:list --environment production
```

Replace all three example hosts with Cartiva-owned HTTPS deployments. `EXPO_PUBLIC_` values are included in the app bundle, so this variable must contain only the public API origin—never a credential. The `environment` fields in `eas.json` bind each build profile to the matching named EAS environment.

The development build requests local-network access so iOS can reach that LAN address without weakening transport security for normal internet traffic. Tap **Allow** when iOS asks. Production builds still require an HTTPS backend; remove the development-only local-network description when the public backend replaces LAN testing.

Cartiva development, preview, and production builds target iOS 17.4 or newer. That minimum is intentional: Expo's secure system-browser return through an HTTPS universal link is available on iOS 17.4+, and the app explicitly requests universal-link handling whenever the backend supplies the production HTTPS `/oauth/kroger` return. A callback is accepted only when its scheme, host, port, and path exactly match the validated return base supplied for that authorization attempt. Older iPhones can still use the website, but must not be offered Kroger authorization from a Cartiva native build.

Expo Go can test list entry, store selection, matching, and results when its installed SDK supports this project. Kroger sign-in requires an iOS 17.4+ development build. Before production, replace the placeholder bundle identifier and `applinks:api.example.com` associated domain in `mobile/app.json`, then publish the matching AASA file; do not enable cart transfer until iOS verifies that universal link:

```bash
npx eas-cli@latest init
npx eas-cli@latest build --platform ios --profile development
```

The app already has an Expo Router entry, `cartiva` URL scheme, iPhone-only tablet setting, icon and splash assets, and EAS development/preview/production profiles. `com.cartiva.mobile` is a placeholder bundle identifier and must be replaced with the final owned identifier before distribution.

## TestFlight preparation

After linking the Expo project, choosing the final bundle identifier, configuring an Apple team, publishing privacy/terms documents, and deploying the Cartiva read API over HTTPS:

```bash
npx eas-cli@latest build --platform ios --profile production
```

This repository does not submit to App Store Connect. Do not run `eas submit` until the release, legal, privacy, and backend security gates have been reviewed.

## Mobile API

The anonymous comparison boundary uses:

- `GET /api/mobile/v1/capabilities`
- `POST /api/mobile/v1/kroger/locations`
- `POST /api/mobile/v1/kroger/search` (NDJSON progress/results)

When mobile cart transfer is configured, the client also uses an opaque bearer held in iOS secure storage with:

- `POST /api/mobile/v1/session`
- `GET|POST /api/mobile/v1/kroger/auth/*`
- `POST /api/mobile/v1/kroger/auth/complete` (redeems the one-use pending callback with the initiating mobile bearer)
- `POST /api/mobile/v1/kroger/cart`

Browser CORS is deny-by-default and may be enabled with `CARTIVA_MOBILE_ALLOWED_ORIGINS`. Native clients omit `Origin`. Requests are size-limited, strictly validated, rate-limited, and never receive retailer credentials or Kroger OAuth tokens.

## Release gates

Before public distribution, deploy the backend over HTTPS, register its exact callback with Kroger, configure a managed session secret, explicitly enable reviewed cart writes, provide either one persistent single-process state volume or a transactional shared-state adapter, replace process-local abuse limits with durable edge limits, and complete security/privacy review. Without those deployment settings the capability endpoint keeps cart transfer disabled and the app clearly says that no cart was transferred.
