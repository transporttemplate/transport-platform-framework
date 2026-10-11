-- Release 2 final-stage safety primitives. This migration does not create or
-- activate a schedule and does not enqueue or send any email.
begin;

alter table public.email_messages drop constraint if exists email_messages_state_check;
alter table public.email_messages add constraint email_messages_state_check
  check (state in ('pending','processing','accepted','delivered','delayed','bounced','complained','suppressed','failed','cancelled','uncertain'));

create table if not exists public.email_dispatch_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  state text not null default 'running' check (state in ('running','succeeded','failed','quota_paused')),
  scheduled_count integer not null default 0,
  claimed_count integer not null default 0,
  accepted_count integer not null default 0,
  retry_count integer not null default 0,
  failed_count integer not null default 0,
  uncertain_count integer not null default 0,
  error_code text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.email_dispatch_runs enable row level security;
revoke all on public.email_dispatch_runs from public,anon,authenticated;
grant select,insert,update,delete on public.email_dispatch_runs to service_role;
create index if not exists email_dispatch_runs_started_idx on public.email_dispatch_runs(started_at desc);

create or replace function public.claim_due_email_messages(batch_size integer default 50)
returns setof public.email_messages
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;

  -- A provider request may have succeeded immediately before a worker died.
  -- Resend retains idempotency keys for 24 hours, so never automatically
  -- reclaim an ambiguous attempt after the protected retry window.
  update public.email_messages
     set state='uncertain',next_attempt_at=null,last_error='Manual review required after interrupted delivery',updated_at=now()
   where state='processing'
     and claimed_at < now()-interval '23 hours';

  return query
  with due as (
    select m.id from public.email_messages m
    where (m.state in ('pending','failed','delayed')
       or (m.state='processing'
           and m.claimed_at < now()-interval '10 minutes'
           and m.claimed_at >= now()-interval '23 hours'))
      and coalesce(m.next_attempt_at,m.scheduled_for) <= now()
      and m.attempt_count < m.max_attempts
    order by m.priority desc,coalesce(m.next_attempt_at,m.scheduled_for),m.created_at
    for update skip locked limit greatest(1,least(batch_size,100))
  )
  update public.email_messages m
     set state='processing',claimed_at=now(),attempt_count=m.attempt_count+1,updated_at=now()
    from due where m.id=due.id returning m.*;
end $$;
revoke all on function public.claim_due_email_messages(integer) from public,anon,authenticated;
grant execute on function public.claim_due_email_messages(integer) to service_role;

create or replace function public.complete_email_attempt(
  p_message_id uuid,
  p_company_id uuid,
  p_attempt_number integer,
  p_attempt_state text,
  p_message_state text,
  p_provider_message_id text default null,
  p_error_message text default null,
  p_next_attempt_at timestamptz default null
) returns public.email_messages
language plpgsql security definer set search_path=public as $$
declare current_message public.email_messages;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_attempt_state not in ('accepted','failed','permanent_failure','uncertain') then raise exception 'Invalid attempt state'; end if;
  if p_message_state not in ('accepted','failed','cancelled','uncertain') then raise exception 'Invalid message state'; end if;

  select * into current_message from public.email_messages
   where id=p_message_id and company_id=p_company_id for update;
  if not found then raise exception 'Email message not found'; end if;

  update public.email_attempts set
    state=p_attempt_state,
    provider_message_id=coalesce(p_provider_message_id,provider_message_id),
    error_message=left(p_error_message,500),
    completed_at=now()
  where message_id=p_message_id and company_id=p_company_id and attempt_number=p_attempt_number;

  -- Never regress a state already advanced by the signed provider webhook.
  if current_message.state in ('delivered','bounced','complained','suppressed') then
    return current_message;
  end if;

  update public.email_messages set
    state=p_message_state,
    provider_message_id=coalesce(p_provider_message_id,provider_message_id),
    accepted_at=case when p_message_state='accepted' then coalesce(accepted_at,now()) else accepted_at end,
    next_attempt_at=p_next_attempt_at,
    last_error=left(p_error_message,500),
    updated_at=now()
  where id=p_message_id and company_id=p_company_id
  returning * into current_message;
  return current_message;
end $$;
revoke all on function public.complete_email_attempt(uuid,uuid,integer,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_email_attempt(uuid,uuid,integer,text,text,text,text,timestamptz) to service_role;

notify pgrst,'reload schema';
commit;
