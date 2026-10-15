-- Release 7.9: secure, dormant Integrations Centre. No provider is activated.
begin;

alter table public.api_credentials add column if not exists credential_mode text not null default 'single' check(credential_mode in('single','hmac'));
alter table public.api_credentials add column if not exists signing_secret_hash text check(signing_secret_hash is null or signing_secret_hash~'^[a-f0-9]{64}$');
alter table public.api_credentials add column if not exists signing_secret_ciphertext text;
alter table public.api_credentials add constraint api_credentials_hmac_material check(credential_mode='single' or (signing_secret_hash is not null and signing_secret_ciphertext is not null));
create table public.api_signature_nonces(
 credential_id uuid not null references public.api_credentials(id) on delete cascade,
 nonce text not null, used_at timestamptz not null default now(), primary key(credential_id,nonce)
);
create index api_signature_nonces_expiry on public.api_signature_nonces(used_at);

create table public.external_integrations(
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check(length(trim(name)) between 2 and 100),
 provider text not null check(provider in('icabbi','pulse','cmac','custom','other')),
 environment text not null default 'test' check(environment in('test','production')),
 base_url text not null,
 auth_method text not null check(auth_method in('api_key','api_key_secret','bearer','oauth2_client_credentials','hmac','provider_custom')),
 credential_ciphertext text not null,
 credential_key_version integer not null default 1 check(credential_key_version > 0),
 test_path text,
 webhook_url text,
 request_timeout_ms integer not null default 5000 check(request_timeout_ms between 1000 and 15000),
 rate_limit_per_minute integer not null default 60 check(rate_limit_per_minute between 1 and 600),
 enabled boolean not null default false,
 readiness text not null default 'credentials_saved' check(readiness in('not_configured','credentials_saved','connection_test_passed','adapter_available','ready_for_activation','active','error','disabled')),
 adapter_key text,
 notes text,
 last_tested_at timestamptz,
 last_test_succeeded boolean,
 last_response_category text,
 last_error text,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 revoked_at timestamptz,
 unique(company_id,name), unique(id,company_id),
 check(enabled=false or readiness='active'),
 check(provider='custom' or adapter_key is null)
);
create index external_integrations_company_recent on public.external_integrations(company_id,created_at desc);

create table public.incoming_webhook_endpoints(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 external_integration_id uuid not null, public_id uuid not null default gen_random_uuid() unique,
 status text not null default 'disabled' check(status in('disabled','active','revoked')),
 signing_secret_ciphertext text not null, secret_version integer not null default 1,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), revoked_at timestamptz,
 foreign key(external_integration_id,company_id) references public.external_integrations(id,company_id)
);
create table public.incoming_webhook_events(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 endpoint_id uuid not null references public.incoming_webhook_endpoints(id), provider_event_id text not null,
 event_type text not null, request_id uuid not null, payload_hash text not null,
 state text not null default 'received' check(state in('received','validated','rejected','duplicate','failed')),
 error_code text, received_at timestamptz not null default now(), processed_at timestamptz,
 unique(endpoint_id,provider_event_id)
);
create index incoming_webhook_events_recent on public.incoming_webhook_events(company_id,received_at desc);

create table public.integration_activity(
 id bigint generated always as identity primary key, company_id uuid not null references public.companies(id),
 integration_id uuid, integration_kind text not null check(integration_kind in('external','our_api','incoming_webhook','outgoing_webhook')),
 direction text not null check(direction in('incoming','outgoing','internal')),
 operation text not null, result text not null check(result in('success','failure','rejected','pending')),
 http_status integer, request_id uuid not null default gen_random_uuid(), duration_ms integer,
 retry_count integer not null default 0, error_code text, error_message text,
 created_at timestamptz not null default now(),
 check(error_message is null or length(error_message)<=500)
);
create index integration_activity_company_recent on public.integration_activity(company_id,created_at desc,id desc);
create index integration_activity_integration_recent on public.integration_activity(integration_id,created_at desc);

create table public.integration_credential_audit(
 id bigint generated always as identity primary key, company_id uuid not null references public.companies(id),
 external_integration_id uuid references public.external_integrations(id), actor_id uuid references auth.users(id),
 action text not null check(action in('created','replaced','rotated','revoked','deleted','secret_view_denied')),
 key_version integer, created_at timestamptz not null default now()
);
create index integration_credential_audit_company_recent on public.integration_credential_audit(company_id,created_at desc);

alter table public.outbound_webhook_deliveries add column if not exists last_error text;
alter table public.outbound_webhook_deliveries add column if not exists request_id uuid not null default gen_random_uuid();
alter table public.outbound_webhook_endpoints add column if not exists previous_secret_ciphertext text;
alter table public.outbound_webhook_endpoints add column if not exists previous_secret_valid_until timestamptz;

create or replace function public.prune_integration_operational_data() returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 delete from integration_activity where created_at < now()-interval '90 days';
 delete from incoming_webhook_events where received_at < now()-interval '90 days';
 delete from api_rate_buckets where bucket_start < now()-interval '1 day';
 delete from api_idempotency where created_at < now()-interval '30 days';
 delete from api_signature_nonces where used_at < now()-interval '10 minutes';
end $$;

do $$declare t text;begin foreach t in array array['api_signature_nonces','external_integrations','incoming_webhook_endpoints','incoming_webhook_events','integration_activity','integration_credential_audit'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
end loop;end$$;
revoke all on function public.prune_integration_operational_data() from public,anon,authenticated;
grant execute on function public.prune_integration_operational_data() to service_role;
notify pgrst,'reload schema';
commit;
