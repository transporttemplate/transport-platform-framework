-- Release 8.2: tenant-scoped external-offer notifications and secure decisions.
-- Email creation is opt-in and no dispatcher schedule is activated here.
begin;

alter table public.settings
  add column if not exists external_offer_emails boolean not null default false,
  add column if not exists external_offer_recipient_preferences jsonb not null default '{"primary":true,"additional":true}'::jsonb;

create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  notification_type text not null check (notification_type in ('external_offer','system','delivery')),
  event_key text not null,
  title text not null,
  body text not null,
  severity text not null default 'info' check (severity in ('info','success','warning','critical')),
  action_url text,
  external_offer_id uuid references public.external_dispatch_offers(id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id,event_key)
);
create index if not exists admin_notifications_unread on public.admin_notifications(company_id,created_at desc) where read_at is null;

create table if not exists public.external_offer_decision_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  offer_id uuid not null references public.external_dispatch_offers(id) on delete cascade,
  token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  decision text check(decision is null or decision in ('accepted','declined')),
  created_at timestamptz not null default now(),
  unique(company_id,offer_id)
);

alter table public.admin_notifications enable row level security;
alter table public.external_offer_decision_tokens enable row level security;
revoke all on public.admin_notifications,public.external_offer_decision_tokens from public,anon;
grant select on public.admin_notifications to authenticated;
grant update(read_at) on public.admin_notifications to authenticated;
grant all on public.admin_notifications,public.external_offer_decision_tokens to service_role;
do $$ begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='admin_notifications' and policyname='tenant_select') then
    create policy tenant_select on public.admin_notifications for select using(public.user_can_access_company(company_id));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='admin_notifications' and policyname='tenant_update') then
    create policy tenant_update on public.admin_notifications for update using(public.user_can_access_company(company_id)) with check(public.user_can_access_company(company_id));
  end if;
end $$;

insert into public.email_templates(company_id,template_key,subject,body,active)
select c.id,'office_external_offer','NEW EXTERNAL BOOKING — {{external_booking_reference}}',
E'A new external booking requires a decision.\n\nReference: {{external_booking_reference}}\nCustomer: {{customer_name}}\nJourney: {{journey_datetime}}\n{{pickup_address}} → {{dropoff_address}}\nPassengers: {{passengers}}\nSupplier payment: {{supplier_payment}}\nExpires: {{expires_at}}\n\nReview securely: {{decision_url}}',true
from public.companies c on conflict(company_id,template_key) do nothing;

create or replace function public.release82_notify_external_offer() returns trigger
language plpgsql security definer set search_path=public,extensions as $$
declare s public.settings%rowtype; raw_token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
declare recipient text; recipients text[]:='{}'; payload jsonb; base_url text:='https://www.etbm.co.uk';
begin
  payload:=new.booking_payload;
  insert into public.admin_notifications(company_id,notification_type,event_key,title,body,severity,action_url,external_offer_id,metadata)
  values(new.receiving_company_id,'external_offer','external-offer:'||new.id,'New external booking — '||new.external_booking_reference,
    coalesce(payload->>'pickup_address','Pickup not supplied')||' → '||coalesce(payload->>'dropoff_address','Drop-off not supplied'),
    'warning','job-exchange.html?offer='||new.id,new.id,jsonb_build_object('status',new.status,'expires_at',new.expires_at))
  on conflict(company_id,event_key) do nothing;
  insert into public.external_offer_decision_tokens(company_id,offer_id,token_hash,expires_at)
  values(new.receiving_company_id,new.id,encode(digest(raw_token,'sha256'),'hex'),least(new.expires_at,now()+interval '7 days'))
  on conflict(company_id,offer_id) do nothing;
  select * into s from public.settings where company_id=new.receiving_company_id;
  if not found or s.emailnotifications=false or s.external_offer_emails=false then return new; end if;
  if coalesce((s.external_offer_recipient_preferences->>'primary')::boolean,true) then
    recipient:=lower(trim(coalesce(s.office_notification_email,s.officeemail,s.companyemail,'')));
    if recipient~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then recipients:=array_append(recipients,recipient);end if;
  end if;
  if coalesce((s.external_offer_recipient_preferences->>'additional')::boolean,true) then
    recipients:=recipients||regexp_split_to_array(lower(coalesce(s.additional_office_recipients,'')),'[,;[:space:]]+');
  end if;
  foreach recipient in array recipients loop
    if recipient~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      insert into public.email_messages(company_id,category,recipient_type,recipient,template_key,idempotency_key,scheduled_for,next_attempt_at,priority,metadata)
      values(new.receiving_company_id,'external_offer','office',recipient,'office_external_offer','external-offer:'||new.id||':to:'||recipient,now(),now(),95,
        jsonb_build_object('offer_id',new.id,'decision_url',base_url||'/external-offer.html?token='||raw_token))
      on conflict(company_id,idempotency_key) do nothing;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists release82_notify_external_offer on public.external_dispatch_offers;
create trigger release82_notify_external_offer after insert on public.external_dispatch_offers for each row execute function public.release82_notify_external_offer();

create or replace function public.release82_sync_offer_notification() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status is distinct from old.status then
    update public.admin_notifications set metadata=metadata||jsonb_build_object('status',new.status),
      resolved_at=case when new.status not in('offered','viewed') then coalesce(resolved_at,now()) else null end,updated_at=now()
    where company_id=new.receiving_company_id and external_offer_id=new.id;
  end if; return new;
end $$;
drop trigger if exists release82_sync_offer_notification on public.external_dispatch_offers;
create trigger release82_sync_offer_notification after update of status on public.external_dispatch_offers for each row execute function public.release82_sync_offer_notification();

revoke all on function public.release82_notify_external_offer(),public.release82_sync_offer_notification() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
