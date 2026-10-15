# Release 8.0.2 External Dispatch API

External Dispatch integrations are receiver-owned and linked server-side to one authorised originating company. They are created disabled and use existing one-time API credential issuance, rotation, revocation, HMAC signing, replay prevention, rate limiting and sanitised audit records.

## API operations

- `POST /api/v1/offers` — submit an idempotent booking offer using `Idempotency-Key`.
- `GET /api/v1/offers?id=…` — retrieve the offer and financial responsibility status.
- `GET /api/v1/dispatch?offer_id=…` — retrieve the accepted booking, permitted assignment data and authoritative timeline.
- `POST /api/v1/tracking-links` — issue a short-lived, booking-specific link after acceptance.

HMAC credentials sign `timestamp`, `nonce`, method, `/v1/resource` and the SHA-256 body hash. Company identity comes only from the verified credential and its reviewed partner-company link.

## Payment model

Offers explicitly select `sender_collects`, `receiver_collects` or `sender_account`. Supplier settlement and actual customer payment are separate. Supplier payment is not driver earnings, and a zero customer fare never marks the receiving booking paid.

## Privacy and tracking

Driver provider-phone and passenger-phone sharing are separate, off-by-default preferences. The driver notice is versioned; a material company edit requires a new acknowledgement but never blocks safety controls. Tracking tokens are random, stored only as hashes, expire automatically, are rate limited, and reveal GPS only for an active assigned journey with a sufficiently accurate recorded point.

The customer tracking SMS template is installed disabled. Company SMS gates, gateway pairing, consent, opt-out, quiet-hour and deduplication controls remain authoritative.

## Operational state

No integrations, credentials, offers, tracking tokens or webhook destinations are created by the migration. Provider adapters and sending schedules remain disabled. Independent recovery custody for `INTEGRATION_ENCRYPTION_KEY` must be completed before enabling a secret-dependent live connection.
