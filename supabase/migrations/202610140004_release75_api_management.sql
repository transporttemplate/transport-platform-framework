-- Release 7.5: dormant, company-scoped API and outbound webhook infrastructure.
-- Creates no integration, credential, endpoint or delivery records.
begin;
create extension if not exists pgcrypto;

create table public.api_integrations(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 name text not null check(length(trim(name)) between 2 and 100), status text not null default 'disabled' check(status in('disabled','active','revoked')),
 scopes text[] not null default '{}', rate_limit_per_minute integer not null default 60 check(rate_limit_per_minute between 1 and 600),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 last_used_at timestamptz, revoked_at timestamptz, unique(company_id,name), unique(id,company_id),
 check(scopes <@ array['bookings:read','bookings:create','bookings.status:write','drivers.availability:read','vehicles:read','webhooks:manage']::text[])
);
create table public.api_credentials(
 id uuid primary key default gen_random_uuid(), integration_id uuid not null references public.api_integrations(id) on delete cascade,
 company_id uuid not null, key_prefix text not null unique check(key_prefix~'^tpf_[A-Za-z0-9_-]{10,20}$'), key_hash text not null unique check(key_hash~'^[a-f0-9]{64}$'),
 status text not null default 'active' check(status in('active','revoked','expired','rotated')), expires_at timestamptz,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz,
 foreign key(integration_id,company_id) references public.api_integrations(id,company_id), check(expires_at is null or expires_at>created_at)
);
create index api_credentials_lookup on public.api_credentials(key_prefix,status);
create table public.api_request_audit(
 id bigint generated always as identity primary key, company_id uuid not null references public.companies(id), integration_id uuid not null references public.api_integrations(id),
 credential_id uuid references public.api_credentials(id), request_id uuid not null, method text not null, path text not null,
 scope text, response_status integer not null, duration_ms integer not null default 0, remote_fingerprint text,
 created_at timestamptz not null default now(), unique(integration_id,request_id)
);
create index api_request_audit_recent on public.api_request_audit(company_id,integration_id,created_at desc);
create table public.api_rate_buckets(
 integration_id uuid not null references public.api_integrations(id) on delete cascade, bucket_start timestamptz not null,
 request_count integer not null default 0, primary key(integration_id,bucket_start)
);
create table public.api_idempotency(
 integration_id uuid not null references public.api_integrations(id) on delete cascade, idempotency_key text not null,
 request_hash text not null, response_status integer not null, response_body jsonb not null, created_at timestamptz not null default now(),
 primary key(integration_id,idempotency_key)
);
create table public.outbound_webhook_endpoints(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), integration_id uuid not null,
 url text not null, event_types text[] not null, status text not null default 'disabled' check(status in('disabled','active','revoked')),
 secret_ciphertext text not null, secret_version integer not null default 1, created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_verified_at timestamptz, revoked_at timestamptz,
 foreign key(integration_id,company_id) references public.api_integrations(id,company_id),
 check(event_types <@ array['booking.created','booking.updated','booking.cancelled','driver.assigned','driver.arrived','booking.completed']::text[])
);
create table public.outbound_webhook_events(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), event_type text not null,
 aggregate_type text not null, aggregate_id uuid not null, event_key text not null, payload jsonb not null,
 created_at timestamptz not null default now(), unique(company_id,event_key)
);
create table public.outbound_webhook_deliveries(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), endpoint_id uuid not null references public.outbound_webhook_endpoints(id),
 event_id uuid not null references public.outbound_webhook_events(id), state text not null default 'pending' check(state in('pending','processing','delivered','retry','failed','cancelled')),
 attempt_count integer not null default 0 check(attempt_count between 0 and 8), next_attempt_at timestamptz not null default now(),
 claimed_at timestamptz, response_status integer, error_code text, delivered_at timestamptz, created_at timestamptz not null default now(),
 unique(endpoint_id,event_id)
);
create index webhook_delivery_queue on public.outbound_webhook_deliveries(state,next_attempt_at);

create or replace function public.claim_outbound_webhooks(batch_size integer default 20)
returns setof public.outbound_webhook_deliveries language plpgsql security definer set search_path=public as $$
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 return query with candidates as(select id from public.outbound_webhook_deliveries where state in('pending','retry') and next_attempt_at<=now() order by next_attempt_at for update skip locked limit least(greatest(batch_size,1),50))
 update public.outbound_webhook_deliveries d set state='processing',claimed_at=now(),attempt_count=attempt_count+1 from candidates c where d.id=c.id returning d.*;
end $$;

create or replace function public.api_rate_limit_take(target_integration_id uuid,maximum integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare stamp timestamptz:=date_trunc('minute',clock_timestamp()); n integer;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 insert into public.api_rate_buckets(integration_id,bucket_start,request_count) values(target_integration_id,stamp,1)
 on conflict(integration_id,bucket_start) do update set request_count=api_rate_buckets.request_count+1 returning request_count into n;
 return n<=least(greatest(maximum,1),600);
end $$;
create or replace function public.api_integration_transition(target_company_id uuid,target_booking_id uuid,next_status text,target_integration_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; old_status text; desired text:=lower(trim(next_status));
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from public.api_integrations where id=target_integration_id and company_id=target_company_id and status='active') then raise exception 'Active integration required'; end if;
 if desired not in('accepted','on_way','arrived','passenger_onboard') then raise exception 'Unsupported integration status transition'; end if;
 select * into b from public.bookings where company_id=target_company_id and id=target_booking_id for update;
 if not found then raise exception 'Booking not found'; end if; old_status:=lower(coalesce(b.status,''));
 if not ((old_status in('waiting','assigned') and desired='accepted') or (old_status='accepted' and desired='on_way') or (old_status='on_way' and desired='arrived') or (old_status='arrived' and desired='passenger_onboard')) then raise exception 'Invalid booking status transition'; end if;
 update public.bookings set status=desired,accepted_at=case when desired='accepted' then now() else accepted_at end,on_way_at=case when desired='on_way' then now() else on_way_at end,arrived_at=case when desired='arrived' then now() else arrived_at end,passenger_onboard_at=case when desired='passenger_onboard' then now() else passenger_onboard_at end where id=b.id and company_id=target_company_id;
 insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id)
 values(target_company_id,b.id,b.driver_id,'integration_status_changed',old_status,desired,'integration',target_integration_id::text);
 return true;
end $$;

create or replace function public.capture_outbound_booking_webhook() returns trigger language plpgsql security definer set search_path='' as $$
declare kind text; key1 text;
begin
 if tg_op='INSERT' then kind:='booking.created';key1:=new.id||':created';
 elsif new.status is distinct from old.status then kind:=case lower(new.status) when 'cancelled' then 'booking.cancelled' when 'canceled' then 'booking.cancelled' when 'arrived' then 'driver.arrived' when 'completed' then 'booking.completed' end;key1:=new.id||':'||coalesce(kind,'booking.updated')||':'||new.edit_version;
 elsif new.driver_id is distinct from old.driver_id and new.driver_id is not null then kind:='driver.assigned';key1:=new.id||':driver.assigned:'||new.driver_id;
 else kind:='booking.updated';key1:=new.id||':updated:'||new.edit_version; end if;
 kind:=coalesce(kind,'booking.updated');
 insert into public.outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload)
 values(new.company_id,kind,'booking',new.id,key1,jsonb_build_object('booking_id',new.id,'booking_reference',new.booking_reference,'status',new.status,'driver_id',new.driver_id,'updated_at',now())) on conflict do nothing;
 insert into public.outbound_webhook_deliveries(company_id,endpoint_id,event_id)
 select new.company_id,e.id,w.id from public.outbound_webhook_endpoints e join public.outbound_webhook_events w on w.company_id=new.company_id and w.event_key=key1
 where e.company_id=new.company_id and e.status='active' and kind=any(e.event_types) on conflict do nothing;
 return new;
exception when others then return new; end $$;
create trigger release75_outbound_booking_webhook after insert or update of status,driver_id,edit_version on public.bookings for each row execute function public.capture_outbound_booking_webhook();

do $$declare t text;begin foreach t in array array['api_integrations','api_credentials','api_request_audit','api_rate_buckets','api_idempotency','outbound_webhook_endpoints','outbound_webhook_events','outbound_webhook_deliveries'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;end$$;
revoke all on function public.api_rate_limit_take(uuid,integer),public.api_integration_transition(uuid,uuid,text,uuid),public.claim_outbound_webhooks(integer),public.capture_outbound_booking_webhook() from public,anon,authenticated;
grant execute on function public.api_rate_limit_take(uuid,integer),public.api_integration_transition(uuid,uuid,text,uuid),public.claim_outbound_webhooks(integer) to service_role;
notify pgrst,'reload schema';
commit;
