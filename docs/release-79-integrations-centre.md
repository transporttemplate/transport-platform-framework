# Release 7.9 Integrations Centre

Release 7.9 adds a dormant, company-scoped centre for external connections, existing platform API credentials, signed incoming and outgoing webhooks, and sanitised activity logs.

## Deployment requirement

Set `INTEGRATION_ENCRYPTION_KEY` independently on the `integration-centre`, `incoming-webhook`, and `api-v1` Edge Functions. It must be a base64-encoded 32-byte random key held by the deployment secret manager. If it is missing or malformed, credential creation, replacement, decryption, and HMAC credential issuance fail closed with HTTP 503. Never store this key in PostgreSQL or source control.

The existing `WEBHOOK_ENCRYPTION_KEY` remains required by the Release 7.5 outbound dispatcher. Release 7.9 does not rotate either key automatically.

## Provider readiness

iCabbi, Pulse Taxi Apps, and CMAC are catalogue labels only. Their connections remain disabled because reviewed API documentation, authentication specifications, safe read-only test endpoints, webhook signing rules, field/status mappings, limits, and sandbox credentials have not been supplied. Custom connections may run an explicit same-origin GET test only when an administrator provides a documented `test_path`; a successful response proves reachability/authentication only, not full compatibility.

Incoming events are authenticated, deduplicated and recorded but cannot mutate bookings, drivers, payments, messages, or dispatch state. Outgoing delivery scheduling remains deliberately unconfigured until a reviewed production schedule is authorised.

## HMAC credentials for our API

Existing single API keys remain the default and require no migration. An explicitly issued `hmac` credential returns an API key and signing secret once. Requests use:

- `X-API-Key`
- `X-API-Timestamp` (Unix seconds; five-minute window)
- `X-API-Nonce` (16–100 URL-safe characters; single use)
- `X-API-Signature: v1=<hex HMAC-SHA256>`

Canonical input is `timestamp + "\n" + nonce + "\n" + uppercase_method + "\n" + /v1/resource + "\n" + sha256(raw_body)`.
