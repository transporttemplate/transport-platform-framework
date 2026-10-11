-- Release 2: additive company-scoped email automation, attempts and driver documents.
-- The dispatcher schedule is deliberately NOT enabled by this migration.
begin;

alter table public.settings add column if not exists office_booking_reminder_emails boolean not null default false;
alter table public.settings add column if not exists driver_booking_reminder_emails boolean not null default false;
alter table public.settings add column if not exists unallocated_48h_emails boolean not null default true;
alter table public.settings add column if not exists unallocated_24h_emails boolean not null default true;
alter table public.settings add column if not exists driver_document_expiry_emails boolean not null default false;

-- Required by composite tenant-safe foreign keys and template upserts. The
-- preflight verifies there are no duplicate company/template pairs.
create unique index if not exists bookings_id_company_unique on public.bookings(id,company_id);
create unique index if not exists email_templates_company_key_unique on public.email_templates(company_id,template_key);

create table if not exists public.driver_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null,
  document_type text not null check (document_type in ('taxi_badge','driving_licence','dbs_recheck','insurance','other')),
  document_label text,
  expiry_date date not null,
  reference text,
  status text not null default 'active' check (status in ('active','expired','replaced','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (driver_id, company_id) references public.drivers(id, company_id) on delete cascade
);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  category text not null,
  recipient_type text not null check (recipient_type in ('customer','office','driver','admin_test')),
  recipient text not null,
  template_key text not null,
  idempotency_key text not null,
  booking_id uuid,
  driver_document_id uuid,
  subject text,
  scheduled_for timestamptz not null default now(),
  state text not null default 'pending' check (state in ('pending','processing','accepted','delivered','delayed','bounced','complained','failed','cancelled')),
  priority smallint not null default 50,
  attempt_count integer not null default 0,
  max_attempts integer not null default 4 check (max_attempts between 1 and 4),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  provider_message_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  unique (company_id, idempotency_key),
  unique (id, company_id),
  foreign key (booking_id, company_id) references public.bookings(id, company_id),
  foreign key (driver_document_id, company_id) references public.driver_documents(id, company_id)
);

create table if not exists public.email_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  message_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 4),
  state text not null check (state in ('started','accepted','failed','permanent_failure','uncertain')),
  provider_message_id text,
  response_code integer,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (message_id, attempt_number),
  foreign key (message_id, company_id) references public.email_messages(id, company_id) on delete cascade
);

create index if not exists driver_documents_company_expiry_idx on public.driver_documents(company_id, expiry_date) where status='active';
create index if not exists email_messages_due_idx on public.email_messages(state, next_attempt_at, scheduled_for, priority desc);
create index if not exists email_messages_company_created_idx on public.email_messages(company_id, created_at desc);
create unique index if not exists email_messages_provider_id_unique on public.email_messages(provider_message_id) where provider_message_id is not null;
create index if not exists email_attempts_company_started_idx on public.email_attempts(company_id, started_at desc);

alter table public.driver_documents enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_attempts enable row level security;

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='driver_documents' and policyname='tenant_admin_all') then
    create policy tenant_admin_all on public.driver_documents for all using(public.user_can_access_company(company_id)) with check(public.user_can_access_company(company_id));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='email_messages' and policyname='tenant_admin_select') then
    create policy tenant_admin_select on public.email_messages for select using(public.user_can_access_company(company_id));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='email_attempts' and policyname='tenant_admin_select') then
    create policy tenant_admin_select on public.email_attempts for select using(public.user_can_access_company(company_id));
  end if;
end $$;

revoke all on public.driver_documents, public.email_messages, public.email_attempts from public, anon;
grant select, insert, update, delete on public.driver_documents to authenticated;
grant select on public.email_messages, public.email_attempts to authenticated;

create or replace function public.claim_due_email_messages(batch_size integer default 50)
returns setof public.email_messages
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  return query
  with due as (
    select m.id from public.email_messages m
    where (m.state in ('pending','failed','delayed')
       or (m.state='processing' and m.claimed_at < now()-interval '10 minutes'))
      and coalesce(m.next_attempt_at,m.scheduled_for) <= now()
      and m.attempt_count < m.max_attempts
    order by m.priority desc,coalesce(m.next_attempt_at,m.scheduled_for),m.created_at
    for update skip locked limit greatest(1,least(batch_size,100))
  )
  update public.email_messages m set state='processing',claimed_at=now(),attempt_count=m.attempt_count+1,updated_at=now()
  from due where m.id=due.id returning m.*;
end $$;
revoke all on function public.claim_due_email_messages(integer) from public,anon,authenticated;
grant execute on function public.claim_due_email_messages(integer) to service_role;

-- Not scheduled by this release. This only removes email telemetry and never
-- touches bookings, invoices, payments, customers or provider records.
create or replace function public.delete_expired_email_telemetry(retain_for interval default interval '12 months')
returns table(deleted_attempts bigint, deleted_messages bigint, deleted_legacy_deliveries bigint)
language plpgsql security definer set search_path=public as $$
declare cutoff timestamptz := now()-greatest(retain_for,interval '12 months');
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  with removed as (delete from public.email_attempts where started_at < cutoff returning 1)
  select count(*) into deleted_attempts from removed;
  with removed as (delete from public.email_messages where created_at < cutoff returning 1)
  select count(*) into deleted_messages from removed;
  with removed as (delete from public.email_deliveries where created_at < cutoff returning 1)
  select count(*) into deleted_legacy_deliveries from removed;
  return next;
end $$;
revoke all on function public.delete_expired_email_telemetry(interval) from public,anon,authenticated;
grant execute on function public.delete_expired_email_telemetry(interval) to service_role;

insert into public.email_templates(company_id,template_key,subject,body,active)
select c.id,d.template_key,d.subject,d.body,true from public.companies c cross join (values
 ('office_booking_reminder_24h','UPCOMING BOOKING — {{booking_reference}} (24 hours)',E'Booking {{booking_reference}} is due in approximately 24 hours.\n\nCustomer: {{customer_name}}\nPhone: {{customer_phone}}\n{{journey_summary}}\n\nDriver: {{driver_name}}\nNotes: {{notes}}'),
 ('driver_booking_reminder_12h','Job reminder — {{booking_reference}} (12 hours)',E'Hello {{driver_name}},\n\nReminder: your job {{booking_reference}} is due in approximately 12 hours.\n\n{{journey_summary}}\n\nDriver amount: {{driver_amount}}\nNotes: {{notes}}'),
 ('office_unallocated_48h','DRIVER NOT ALLOCATED — {{booking_reference}} (48 hours)',E'Booking {{booking_reference}} is due within 48 hours and still has no driver.\n\n{{journey_summary}}'),
 ('office_unallocated_24h','URGENT: DRIVER NOT ALLOCATED — {{booking_reference}} (24 hours)',E'Booking {{booking_reference}} is due within 24 hours and still has no driver.\n\n{{journey_summary}}'),
 ('office_driver_document_expiry','DRIVER DOCUMENT EXPIRY — {{driver_name}}',E'Driver: {{driver_name}}\nDocument: {{document_type}}\nExpiry/recheck date: {{document_expiry_date}}\nDays remaining: {{days_remaining}}')
) d(template_key,subject,body)
on conflict(company_id,template_key) do nothing;

create or replace function public.provision_company_email_templates()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.email_templates(company_id,template_key,subject,body,active)
  select new.id,t.template_key,t.subject,t.body,t.active from public.email_templates t
  join public.companies c on c.id=t.company_id and c.company_code='0001'
  on conflict(company_id,template_key) do nothing;
  return new;
end $$;
drop trigger if exists provision_company_email_templates_after_insert on public.companies;
create trigger provision_company_email_templates_after_insert after insert on public.companies for each row execute function public.provision_company_email_templates();

notify pgrst,'reload schema';
commit;
