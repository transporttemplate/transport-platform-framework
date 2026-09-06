-- Company-scoped transactional email configuration, delivery deduplication,
-- and default templates. Additive only; no existing data is removed.

begin;

alter table public.settings add column if not exists customer_booking_emails boolean not null default true;
alter table public.settings add column if not exists office_new_booking_emails boolean not null default true;
alter table public.settings add column if not exists driver_assignment_emails boolean not null default true;
alter table public.settings add column if not exists booking_change_emails boolean not null default true;
alter table public.settings add column if not exists cancellation_emails boolean not null default true;
alter table public.settings add column if not exists payment_confirmation_emails boolean not null default true;
alter table public.settings add column if not exists unallocated_reminder_emails boolean not null default true;
alter table public.settings add column if not exists office_notification_email text;
alter table public.settings add column if not exists additional_office_recipients text;
alter table public.settings add column if not exists email_reply_to text;
alter table public.settings add column if not exists email_sender_name text;
alter table public.settings add column if not exists unallocated_reminder_minutes integer[] not null default array[2880,1440];

alter table public.email_deliveries add column if not exists recipient_type text;
alter table public.email_deliveries add column if not exists event_key text;
alter table public.email_deliveries add column if not exists retry_count integer not null default 0;
alter table public.email_deliveries add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_deliveries'::regclass
      and conname = 'email_deliveries_recipient_type_check'
  ) then
    alter table public.email_deliveries
      add constraint email_deliveries_recipient_type_check
      check (recipient_type is null or recipient_type in ('customer','office','driver','admin_test'));
  end if;
end $$;

create unique index if not exists email_deliveries_event_recipient_unique
  on public.email_deliveries(company_id, event_key, lower(recipient))
  where event_key is not null;

create index if not exists bookings_unallocated_reminder_idx
  on public.bookings(company_id, journey_date, journey_time)
  where driver_id is null;

insert into public.email_templates(company_id, template_key, subject, body, active)
select c.id, defaults.template_key, defaults.subject, defaults.body, true
from public.companies c
cross join (values
  ('customer_booking_confirmation', 'Booking {{booking_reference}} received', E'Hello {{customer_name}},\n\nThank you for booking with {{company_name}}.\n\n{{journey_summary}}\n\n{{payment_summary}}\n\nWe will send any important updates separately.'),
  ('customer_payment_confirmation', 'Payment received for {{booking_reference}}', E'Hello {{customer_name}},\n\nYour payment has been verified securely.\n\n{{journey_summary}}\n\n{{payment_summary}}'),
  ('customer_booking_changed', 'Booking {{booking_reference}} updated', E'Hello {{customer_name}},\n\nYour booking has been updated.\n\n{{journey_summary}}\n\n{{payment_summary}}'),
  ('customer_booking_cancelled', 'Booking {{booking_reference}} cancelled', E'Hello {{customer_name}},\n\nBooking {{booking_reference}} has been cancelled. Please contact us if you need any help.'),
  ('office_new_booking', 'NEW BOOKING — {{booking_reference}}', E'NEW BOOKING\n\nCustomer: {{customer_name}}\nPhone: {{customer_phone}}\nEmail: {{customer_email}}\n\n{{journey_summary}}\n\n{{payment_summary}}\n\nSource: {{booking_source}}\nDriver: {{driver_name}}\nNotes: {{notes}}'),
  ('office_booking_changed', 'BOOKING UPDATED — {{booking_reference}}', E'Booking {{booking_reference}} has been updated.\n\n{{journey_summary}}\n\n{{payment_summary}}\n\nDriver: {{driver_name}}'),
  ('office_booking_cancelled', 'BOOKING CANCELLED — {{booking_reference}}', E'Booking {{booking_reference}} has been cancelled.\n\nCustomer: {{customer_name}}\n{{journey_summary}}'),
  ('office_payment_received', 'PAYMENT RECEIVED — {{booking_reference}}', E'Payment has been verified for {{booking_reference}}.\n\nCustomer: {{customer_name}}\n{{payment_summary}}'),
  ('driver_assignment', 'New job {{booking_reference}}', E'Hello {{driver_name}},\n\nA job has been assigned to you.\n\n{{journey_summary}}\n\nPassenger: {{customer_name}}\nPassengers: {{passengers}}\nLuggage: {{luggage}}\nFlight: {{flight_number}}\nDriver amount: {{driver_amount}}\nNotes: {{notes}}'),
  ('driver_job_changed', 'Job {{booking_reference}} updated', E'Hello {{driver_name}},\n\nYour assigned job has changed.\n\n{{journey_summary}}\n\nNotes: {{notes}}'),
  ('driver_job_removed', 'Job {{booking_reference}} removed', E'Hello {{driver_name}},\n\nJob {{booking_reference}} has been removed from your allocation. Please contact the office if you have questions.'),
  ('driver_job_cancelled', 'Job {{booking_reference}} cancelled', E'Hello {{driver_name}},\n\nYour assigned job {{booking_reference}} has been cancelled.\n\n{{journey_summary}}'),
  ('office_unallocated_48h', 'DRIVER NOT ALLOCATED — {{booking_reference}} (48 hours)', E'DRIVER NOT ALLOCATED\n\nBooking {{booking_reference}} is due within 48 hours and has no driver.\n\n{{journey_summary}}'),
  ('office_unallocated_24h', 'URGENT: DRIVER NOT ALLOCATED — {{booking_reference}} (24 hours)', E'DRIVER NOT ALLOCATED\n\nBooking {{booking_reference}} is due within 24 hours and has no driver.\n\n{{journey_summary}}'),
  ('admin_test_email', 'TEST — {{company_name}} email configuration', E'This is a test email from {{company_name}}.\n\nCompany-scoped email delivery is configured correctly.')
) as defaults(template_key, subject, body)
on conflict (company_id, template_key) do nothing;

notify pgrst, 'reload schema';
commit;
