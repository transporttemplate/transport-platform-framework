# Release 8.0 Job Exchange and API Tester

Release 8.0 adds an explicitly authorised company-to-company booking-offer workflow. It does not grant one tenant general access to another tenant's bookings.

## Live-pilot gate

Each company independently controls its `job_exchange_company_approvals` record. Both the sending and receiving company must be approved when an offer is created and again when it is accepted. All approvals default to false and deployment creates no offers or receiving bookings.

Acceptance creates one receiver-owned operational booking with its own company reference. Customer fare, customer payments and supplier settlement are not copied into the receiving company's customer balance. The agreed supplier payment remains on the offer ledger; no Stripe charge, refund or supplier transfer occurs.

Customer contact fields are absent from the offered booking snapshot and are available to the receiver only through the receiver-owned job created after explicit acceptance. Journey status feedback updates only the offer record visible to the sender; it does not bypass the sender booking's protected status or payment workflow.

## Private API Tester

Only a JWT carrying the verified `super_admin` platform role can run the tester. It validates synthetic payloads, credential modes, scopes, tenant rejection, read-only API behavior and HMAC signing without returning secrets or sending provider requests. Test runs record bounded pass/fail summaries and duration, not request bodies or credentials.

## Upcoming default

Bookings and All Bookings default to Upcoming for a company with no explicit preference. URL `view`, `status_tab` or supported `status` values take precedence, followed by the user's saved company-specific choice. Upcoming uses the configured company timezone, includes future allocated and unallocated active work, and excludes completed, cancelled, no-show and archived jobs.
