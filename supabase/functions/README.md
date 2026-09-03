# Edge Function deployment

Deploy `send-booking-email`, `send-invoice-email`, `send-driver-statement-email`, and `generate-invoice-pdf` after applying the migration.

Set `EMAIL_PROVIDER_API_KEY` and `EMAIL_FROM_ADDRESS` as Supabase Edge Function secrets. `EMAIL_PROVIDER_URL` is optional and defaults to the Resend-compatible API endpoint. Never place these values in browser JavaScript.

`generate-invoice-pdf` currently returns tenant-scoped printable HTML. Connect it to a trusted server-side HTML-to-PDF renderer and private Storage bucket before treating it as binary PDF generation.
