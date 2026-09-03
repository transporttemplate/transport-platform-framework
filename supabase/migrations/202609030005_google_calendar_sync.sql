-- Additive Google Calendar sync state for each company-owned booking.

alter table public.bookings add column if not exists google_calendar_event_id text;
alter table public.bookings add column if not exists google_calendar_synced_at timestamptz;
alter table public.bookings add column if not exists google_calendar_sync_error text;

create index if not exists bookings_company_google_calendar_event_idx
on public.bookings(company_id, google_calendar_event_id)
where google_calendar_event_id is not null;

notify pgrst, 'reload schema';
