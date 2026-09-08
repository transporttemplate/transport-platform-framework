-- Additive operational metadata for Admin Bookings / Dispatch.
begin;

alter table public.bookings add column if not exists accepted_at timestamptz;
alter table public.bookings add column if not exists cancellation_reason text;
alter table public.bookings add column if not exists cancelled_by text;
alter table public.bookings add column if not exists no_show_at timestamptz;
alter table public.bookings add column if not exists no_show_by text;

grant select (accepted_at,cancellation_reason,cancelled_by,no_show_at,no_show_by)
on public.bookings to authenticated;

commit;
notify pgrst, 'reload schema';
