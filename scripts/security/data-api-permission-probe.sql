-- Run through an authorised database session. Every change is rolled back.
begin;

create table public.codex_data_api_permission_probe (
  id bigint generated always as identity primary key,
  note text not null
);

alter table public.codex_data_api_permission_probe enable row level security;
revoke all on table public.codex_data_api_permission_probe
  from public, anon, authenticated, service_role;
revoke all on sequence public.codex_data_api_permission_probe_id_seq
  from public, anon, authenticated, service_role;
grant select, insert on table public.codex_data_api_permission_probe to service_role;
grant usage, select on sequence public.codex_data_api_permission_probe_id_seq to service_role;

do $probe$
declare
  denied boolean;
begin
  denied := false;
  begin
    set local role anon;
    perform * from public.codex_data_api_permission_probe;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'anon unexpectedly allowed'; end if;
  reset role;

  denied := false;
  begin
    set local role authenticated;
    perform * from public.codex_data_api_permission_probe;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'authenticated unexpectedly allowed'; end if;
  reset role;

  set local role service_role;
  insert into public.codex_data_api_permission_probe(note) values ('transient probe');
  if not exists (
    select 1 from public.codex_data_api_permission_probe where note = 'transient probe'
  ) then
    raise exception 'service_role unexpectedly denied';
  end if;
  reset role;
end
$probe$;

rollback;
