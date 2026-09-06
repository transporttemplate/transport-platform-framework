# Edge Function deployment

Deploy `send-booking-email`, `send-invoice-email`, `send-driver-statement-email`, and `generate-invoice-pdf` after applying the migration.

Deploy `google-calendar-sync` after applying the Google Calendar sync migration. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` as Supabase Edge Function secrets, then share each configured Google calendar with that service-account email and grant permission to make changes to events.

Set `EMAIL_PROVIDER_API_KEY` and `EMAIL_FROM_ADDRESS` as Supabase Edge Function secrets. `EMAIL_PROVIDER_URL` is optional and defaults to the Resend-compatible API endpoint. Never place these values in browser JavaScript.

The booking notification system uses `send-booking-email` for authenticated admin and trusted service-to-service events. Deploy `unallocated-booking-reminders` and invoke it every 15 minutes with a service-role bearer token from a protected Supabase Cron/Vault job or another trusted scheduler. Never put the service-role token in browser code.

`generate-invoice-pdf` currently returns tenant-scoped printable HTML. Connect it to a trusted server-side HTML-to-PDF renderer and private Storage bucket before treating it as binary PDF generation.
