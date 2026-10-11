# Production email automation activation

Automatic reminder sending is intentionally disabled until the final production approval.

## Provider and cost

The existing Vercel project is on Pro. Vercel supports cron intervals down to one minute on Pro, and cron has no separate fee; ordinary Function invocation and execution usage applies. A five-minute schedule produces about 8,640 invocations in a 30-day month. Vercel does not retry failed cron invocations, so the next five-minute run provides recovery and the database claim is overlap-safe.

Resend usage is shared by every company/domain in the Resend account. The dispatcher fails closed when the provider Usage API cannot be read, pauses before either the daily or monthly allowance reaches 95%, and caps each claim to the remaining safe allowance. The Usage API requires a full-access Resend API key. Sender-domain status must be verified in the Resend dashboard before activation.

## Required production secrets

Generate independent random values; never copy a Supabase service-role key into Vercel.

- Vercel: `CRON_SECRET`, `EMAIL_DISPATCHER_SECRET`, `SUPABASE_URL`, `EMAIL_AUTOMATION_ENABLED=true`
- Supabase Edge Functions: the same `EMAIL_DISPATCHER_SECRET`, `EMAIL_AUTOMATION_ENABLED=true`, and `EMAIL_AUTOMATION_NOT_BEFORE=<approval timestamp in ISO 8601>`
- Supabase Edge Functions: `RESEND_USAGE_API_KEY` with permission to call `GET /usage` (the sender key remains `EMAIL_PROVIDER_API_KEY`)

Keep both `EMAIL_AUTOMATION_ENABLED` switches absent or set to `false` until approval.

## Activation-only Vercel configuration

Do not add this block until approval because deploying it registers the live schedule:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/email-dispatcher-cron", "schedule": "*/5 * * * *" }
  ]
}
```

Deploy `email-dispatcher` with JWT verification disabled; it authenticates the dedicated dispatcher secret itself. Do not schedule `delete_expired_email_telemetry`.

## Activation checks

1. Confirm `jeffscars.com` and `etbm.co.uk` show sending status **Verified** in Resend.
2. Confirm the Resend Usage API reports both daily and monthly limits.
3. Confirm each company’s five reminder toggles and office address.
4. Set the activation timestamp to the approval time; the dispatcher will not backfill older reminder thresholds.
5. Add the cron block, deploy Production, then confirm the Cron Jobs page shows `*/5 * * * *`.
6. Watch the first runs in Vercel logs and `email_dispatch_runs`; non-2xx responses must alert an operator.
7. Confirm no message is `uncertain`; such rows require manual provider reconciliation and are never retried automatically.

Rollback is immediate: set either `EMAIL_AUTOMATION_ENABLED=false` and remove the cron block in the next production deployment. Do not delete queued history.
