# Release 7.5 API architecture

The versioned base path is `/api/v1`. External integrations authenticate with a server-held `X-API-Key`; keys are never suitable for browser, iPhone, Android driver, or passenger apps.

Supported endpoints:

- `GET /api/v1/bookings` — `bookings:read`
- `POST /api/v1/bookings` — `bookings:create` plus an `Idempotency-Key`
- `PATCH /api/v1/bookings` — `bookings.status:write`; only the existing operational sequence through passenger-on-board is allowed. Completion, cancellation and payment transitions remain in their protected workflows.
- `GET /api/v1/availability` — `drivers.availability:read`
- `GET /api/v1/vehicles` — `vehicles:read`

The booking response deliberately excludes payment secrets, driver banking, private credentials, and GPS history. Booking creation uses the existing company reference counter and atomic booking-bundle function. Integrations start disabled and no credential is created by migration.

Outbound webhooks are company-scoped, HMAC-SHA256 signed, idempotent by event/endpoint, and use bounded exponential retry. Endpoint creation rejects non-HTTPS, local and private destinations; delivery resolves DNS again and rejects private IPv4 results. The dispatcher has no schedule in Release 7.5, so no webhook can leave the platform until an endpoint is explicitly configured, enabled, and the dispatcher is separately authorised.

Future native apps must use short-lived Supabase Auth sessions and user/company authorization. Permanent integration API keys must never be embedded in an app package. Branding and accessible data remain derived from the authenticated company.
