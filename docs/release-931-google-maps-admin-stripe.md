# Release 9.3.1 — Google Maps, Premium Admin UI and Stripe Payment Links

## Google Maps

Each company now uses only its own `settings.googlemapsapi` browser key. The previous trial fallback that returned company 0001's browser key to company 0004 was removed so one tenant's credential is never shared with another. The loader reports missing keys, blocked browser referrers, disabled Maps JavaScript/Places APIs and timeouts separately. Integration Settings includes an in-browser key test.

For companies 0001 and 0002, confirm their existing browser keys are saved against the matching company and permit only the deployed Admin/public origins plus the Maps JavaScript API and Places API. Server route pricing remains separate and uses `GOOGLE_ROUTES_API_KEY_0001`, `GOOGLE_ROUTES_API_KEY_0002`, etc.; a browser key is never substituted for a server key.

## Stripe sandbox configuration

The Admin payment-link function requires all of the following before it can create a link:

- the company is active and Stripe is enabled;
- its saved publishable key begins `pk_test_`;
- `STRIPE_SECRET_KEY_<company code>` begins `sk_test_` (company 0001 may reuse the legacy `STRIPE_SECRET_KEY` during migration);
- `STRIPE_WEBHOOK_SECRET_<company code>` is configured for reconciliation (company 0001 may reuse the legacy `STRIPE_WEBHOOK_SECRET`);
- `PUBLIC_SITE_URL` is an HTTPS origin.

The function refuses live credentials. Checkout Session and PaymentIntent metadata bind the payment to the tenant and booking. Stable idempotency keys prevent duplicate Checkout Sessions for the same booking, type and amount, while the payments ledger and webhook prevent duplicate reconciliation.

## Protected scope

No booking-form fields or workflows were changed. No SMS Gateway, Driver Portal, native app, external API or external-dispatch implementation was modified. The existing SMS RPC is called only when an administrator explicitly chooses **Send by SMS Gateway** after creating a test link.

## Verification and activation limitations

Repository verification completed with all 504 automated tests passing. An authenticated Vercel preview was checked across 19 major Admin routes at 1440×900 desktop, 1024×768 tablet and 390×844 mobile sizes. No route produced page-level horizontal overflow or clipped interactive controls. Bookings, All Bookings and SMS retain their existing status, payment and account colours while using the premium light panels and charcoal navigation. The existing booking form fields and workflow remain unchanged; its address rows are readable at desktop size and stack without overlap on mobile. The existing booking Actions menu visibly includes **Send 20% Deposit Link** and **Send Full Payment Link**.

The preview test selected companies 0001, 0002, 0003 and 0004 independently and confirmed the company switcher remained on the requested tenant. Google Maps returned `RefererNotAllowedMapError` for every company on the preview only. Google identified the rejected URL as the generated Vercel preview hostname, proving that the browser key loads but its HTTP referrer restriction does not include that preview origin. Add the exact preview origin pattern (for example, `https://<approved-preview-host>/*`) to each relevant company's own browser key for preview QA; keep Maps JavaScript API and Places API enabled and do not share keys or broaden restrictions. Remove the temporary preview origin after QA if it is no longer required. Company 0003's map was also checked on its existing live `www.jeffscars.com` origin and rendered successfully, confirming that the production-authorised key path still works.

The connected Supabase project exposes server Route keys for the platform/0001 fallback and company 0002, and test Stripe secret names for 0001 (legacy fallback), 0002 and 0003. `PUBLIC_SITE_URL` is not currently present, so Admin Checkout links correctly fail closed until that HTTPS origin is added during an approved deployment. No Checkout Session was created, no payment message was sent and no live Stripe operation was attempted during verification.

Google browser-key values are protected by authenticated settings access and were not extracted. After deployment, an authorised administrator must use **Settings → Integrations → Test this company key** separately in 0001 and 0002. If either fails, Google Cloud must allow the exact deployed web origins and enable Maps JavaScript API and Places API on that company's own key. No Google Cloud restrictions were changed in this release.
