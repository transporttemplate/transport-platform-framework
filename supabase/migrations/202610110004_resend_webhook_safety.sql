-- Atomic, replay-safe Resend webhook processing. No scheduler or historical
-- backfill is installed by this migration.
begin;

alter table public.email_messages drop constraint if exists email_messages_state_check;
alter table public.email_messages add constraint email_messages_state_check
  check (state in ('pending','processing','accepted','delivered','delayed','bounced','complained','failed','suppressed','cancelled'));
alter table public.email_messages add column if not exists provider_event_at timestamptz;

create table if not exists public.email_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  provider_message_id text not null,
  message_id uuid not null,
  company_id uuid not null,
  event_type text not null check (event_type in ('email.sent','email.delivered','email.bounced','email.failed','email.complained','email.delivery_delayed','email.suppressed')),
  provider_created_at timestamptz not null,
  resulting_state text not null check (resulting_state in ('accepted','delivered','bounced','failed','complained','delayed','suppressed')),
  reason text,
  applied boolean not null default false,
  processing_result text not null default 'received' check (processing_result in ('received','applied','ignored_older','ignored_regression','ignored_equal')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (id, company_id),
  foreign key (message_id, company_id) references public.email_messages(id, company_id) on delete cascade
);

create index if not exists email_webhook_events_company_received_idx on public.email_webhook_events(company_id, received_at desc);
create index if not exists email_webhook_events_provider_idx on public.email_webhook_events(provider_message_id, provider_created_at desc);
alter table public.email_webhook_events enable row level security;
revoke all on public.email_webhook_events from public, anon, authenticated;
grant select, insert, update on public.email_webhook_events to service_role;

create or replace function public.process_resend_webhook_event(
  p_event_id text,
  p_provider_message_id text,
  p_event_type text,
  p_provider_created_at timestamptz,
  p_reason text default null
)
returns table(processing_result text, applied boolean, resulting_state text)
language plpgsql security definer set search_path=public as $$
declare
  target public.email_messages%rowtype;
  event_row_id uuid;
  incoming_state text;
  incoming_priority integer;
  current_priority integer;
  should_apply boolean := false;
  outcome text := 'received';
  clean_reason text := nullif(left(regexp_replace(coalesce(p_reason,''),'[\r\n]+',' ','g'),500),'');
begin
  if current_setting('request.jwt.claim.role',true) <> 'service_role' then raise exception 'Service role required'; end if;
  if nullif(trim(p_event_id),'') is null or nullif(trim(p_provider_message_id),'') is null or p_provider_created_at is null then raise exception 'Invalid webhook event'; end if;

  incoming_state := case p_event_type
    when 'email.sent' then 'accepted'
    when 'email.delivered' then 'delivered'
    when 'email.bounced' then 'bounced'
    when 'email.failed' then 'failed'
    when 'email.complained' then 'complained'
    when 'email.delivery_delayed' then 'delayed'
    when 'email.suppressed' then 'suppressed'
    else null end;
  if incoming_state is null then raise exception 'Unsupported webhook event'; end if;

  select * into target from public.email_messages
   where provider_message_id=p_provider_message_id for update;
  if not found then return query select 'unmatched'::text,false,incoming_state; return; end if;

  insert into public.email_webhook_events(event_id,provider_message_id,message_id,company_id,event_type,provider_created_at,resulting_state,reason)
  values(trim(p_event_id),trim(p_provider_message_id),target.id,target.company_id,p_event_type,p_provider_created_at,incoming_state,clean_reason)
  on conflict(event_id) do nothing returning id into event_row_id;
  if event_row_id is null then return query select 'duplicate'::text,false,incoming_state; return; end if;

  incoming_priority := case incoming_state when 'accepted' then 10 when 'delayed' then 20 when 'delivered' then 30 when 'failed' then 40 when 'suppressed' then 50 when 'bounced' then 60 when 'complained' then 70 else 0 end;
  current_priority := case target.state when 'accepted' then 10 when 'delayed' then 20 when 'delivered' then 30 when 'failed' then 40 when 'suppressed' then 50 when 'bounced' then 60 when 'complained' then 70 when 'cancelled' then 100 else 0 end;

  if target.state='cancelled' or (target.state in ('delivered','bounced','failed','complained','suppressed') and incoming_state in ('accepted','delayed')) then
    outcome := 'ignored_regression';
  elsif target.provider_event_at is not null and p_provider_created_at < target.provider_event_at then
    outcome := 'ignored_older';
  elsif target.provider_event_at is not null and p_provider_created_at = target.provider_event_at and incoming_priority <= current_priority then
    outcome := 'ignored_equal';
  else
    should_apply := true; outcome := 'applied';
    update public.email_messages set
      state=incoming_state,
      provider_event_at=p_provider_created_at,
      updated_at=now(),
      accepted_at=case when incoming_state='accepted' then coalesce(accepted_at,p_provider_created_at) else accepted_at end,
      delivered_at=case when incoming_state='delivered' then coalesce(delivered_at,p_provider_created_at) else delivered_at end,
      last_error=case when incoming_state in ('bounced','failed','complained','suppressed') then coalesce(clean_reason,p_event_type) else null end
    where id=target.id and company_id=target.company_id;
  end if;

  update public.email_webhook_events set applied=should_apply,processing_result=outcome,processed_at=now() where id=event_row_id and company_id=target.company_id;
  return query select outcome,should_apply,incoming_state;
end $$;

revoke all on function public.process_resend_webhook_event(text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.process_resend_webhook_event(text,text,text,timestamptz,text) to service_role;
notify pgrst,'reload schema';
commit;
