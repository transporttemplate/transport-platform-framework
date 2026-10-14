begin;

alter table public.company_users add column if not exists can_permanently_delete_bookings boolean not null default false;
alter table public.company_users add column if not exists can_view_driver_banking boolean not null default false;
alter table public.drivers add column if not exists active boolean not null default true;
alter table public.drivers add column if not exists licence_authority text;
alter table public.drivers add column if not exists customer_phone_sharing boolean not null default false;
alter table public.drivers add column if not exists public_contact_phone text;
alter table public.drivers add column if not exists portal_theme text not null default 'device' check(portal_theme in ('dark','light','device'));
alter table public.drivers add column if not exists portal_text_size text not null default 'normal' check(portal_text_size in ('normal','large','extra_large'));
alter table public.settings add column if not exists driver_phone_sharing_allowed boolean not null default false;
alter table public.settings add column if not exists driver_gps_history_enabled boolean not null default false;
alter table public.settings add column if not exists driver_gps_retention_days integer not null default 30 check(driver_gps_retention_days between 7 and 90);
alter table public.settings add column if not exists driver_message_retention_days integer not null default 365 check(driver_message_retention_days between 30 and 730);
alter table public.bookings add column if not exists archived_at timestamptz;
alter table public.bookings add column if not exists archived_by uuid;
alter table public.bookings add column if not exists archive_reason text;

create table if not exists public.vehicles(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 registration text not null, make text, model text, model_year integer check(model_year between 1900 and 2200), colour text,
 passenger_seats integer not null default 4 check(passenger_seats between 1 and 80), vehicle_type text,
 taxi_plate_number text, taxi_plate_expiry date, mot_expiry date, insurance_policy_reference text, insurance_expiry date,
 licensing_authority text, active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,registration), unique(id,company_id)
);
alter table public.vehicles add column if not exists model_year integer;
alter table public.vehicles add column if not exists seats integer;
alter table public.vehicles add column if not exists passenger_seats integer;
alter table public.vehicles add column if not exists vehicle_type text;
alter table public.vehicles add column if not exists taxi_plate_number text;
alter table public.vehicles add column if not exists taxi_plate_expiry date;
alter table public.vehicles add column if not exists mot_expiry date;
alter table public.vehicles add column if not exists insurance_policy_reference text;
alter table public.vehicles add column if not exists insurance_expiry date;
alter table public.vehicles add column if not exists licensing_authority text;
alter table public.vehicles add column if not exists updated_at timestamptz not null default now();
update public.vehicles set passenger_seats=coalesce(passenger_seats,seats,4) where passenger_seats is null;
alter table public.vehicles alter column passenger_seats set default 4;
alter table public.vehicles alter column passenger_seats set not null;
create unique index if not exists vehicles_id_company_unique on public.vehicles(id,company_id);
create table if not exists public.driver_vehicle_assignments(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 driver_id uuid not null, vehicle_id uuid not null, effective_from timestamptz not null default now(), effective_to timestamptz,
 created_by uuid references auth.users(id), created_at timestamptz not null default now(),
 foreign key(driver_id,company_id) references public.drivers(id,company_id), foreign key(vehicle_id,company_id) references public.vehicles(id,company_id),
 check(effective_to is null or effective_to>effective_from)
);
create unique index if not exists one_current_vehicle_per_driver on public.driver_vehicle_assignments(company_id,driver_id) where effective_to is null;
do $$ begin if not exists(select 1 from pg_constraint where conname='bookings_vehicle_company_fk') then alter table public.bookings add constraint bookings_vehicle_company_fk foreign key(vehicle_id,company_id) references public.vehicles(id,company_id) not valid; end if; end $$;

create table if not exists public.driver_bank_accounts(
 driver_id uuid primary key, company_id uuid not null references public.companies(id) on delete cascade,
 account_name_ciphertext text not null, sort_code_ciphertext text not null, account_number_ciphertext text not null,
 payment_reference_ciphertext text, last_four text not null check(last_four~'^[0-9]{4}$'), updated_by uuid not null references auth.users(id), updated_at timestamptz not null default now(),
 foreign key(driver_id,company_id) references public.drivers(id,company_id)
);

create table if not exists public.driver_messages(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 driver_id uuid not null, booking_id uuid, sender_type text not null check(sender_type in ('admin','driver')),
 sender_user_id uuid, body text not null check(length(trim(body)) between 1 and 1000), client_key text not null,
 created_at timestamptz not null default now(), delivered_at timestamptz, read_at timestamptz,
 foreign key(driver_id,company_id) references public.drivers(id,company_id), foreign key(booking_id,company_id) references public.bookings(id,company_id),
 unique(company_id,client_key)
);
create index if not exists driver_messages_conversation_idx on public.driver_messages(company_id,driver_id,created_at desc);

create table if not exists public.driver_gps_points(
 id bigint generated always as identity primary key, company_id uuid not null references public.companies(id) on delete cascade,
 driver_id uuid not null, booking_id uuid, recorded_at timestamptz not null, latitude numeric(9,6) not null check(latitude between -90 and 90),
 longitude numeric(9,6) not null check(longitude between -180 and 180), accuracy_metres numeric(8,2), speed_mps numeric(8,2), journey_state text,
 foreign key(driver_id,company_id) references public.drivers(id,company_id), foreign key(booking_id,company_id) references public.bookings(id,company_id)
);
create index if not exists driver_gps_playback_idx on public.driver_gps_points(company_id,driver_id,recorded_at);
create index if not exists booking_gps_playback_idx on public.driver_gps_points(company_id,booking_id,recorded_at) where booking_id is not null;

create table if not exists public.booking_deletion_audit(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), booking_reference text not null,
 actor_id uuid not null references auth.users(id), reason text not null, linked_return_reference text, deleted_at timestamptz not null default now()
);
create table if not exists public.booking_assignment_audit(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 booking_id uuid not null, previous_driver_id uuid, next_driver_id uuid, previous_vehicle_id uuid, next_vehicle_id uuid,
 reason text, actor_id uuid not null references auth.users(id), created_at timestamptz not null default now()
);

create or replace function public.release73_admin(c uuid) returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.company_users u where u.company_id=c and u.user_id=auth.uid() and lower(u.role) in ('admin','owner'))
$$;

create or replace function public.booking_permanent_delete_eligibility(target_company_id uuid,target_booking_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; blockers text[]:=array[]::text[]; linked jsonb; permitted boolean;
begin
 permitted:=exists(select 1 from public.company_users u where u.company_id=target_company_id and u.user_id=auth.uid() and lower(u.role) in('admin','owner') and u.can_permanently_delete_bookings);
 if not permitted then raise exception 'Explicit permanent deletion permission is required'; end if;
 select * into b from public.bookings where id=target_booking_id and company_id=target_company_id;
 if not found then raise exception 'Booking not found'; end if;
 if lower(coalesce(b.status,'')) in('on_way','arrived','passenger_onboard','completed') then blockers:=array_append(blockers,'Journey status requires retention'); end if;
 if lower(coalesce(b.payment_status,'')) not in('','unpaid') or coalesce(b.amount_paid,0)>0 then blockers:=array_append(blockers,'Payment history requires retention'); end if;
 if exists(select 1 from public.payments p where p.company_id=target_company_id and p.booking_id=b.id and (p.status in('paid','refunded') or p.amount>0)) then blockers:=array_append(blockers,'Financial payment records exist'); end if;
 if b.invoice_id is not null or exists(select 1 from public.invoice_items i where i.company_id=target_company_id and i.booking_id=b.id) then blockers:=array_append(blockers,'Invoice records exist'); end if;
 if exists(select 1 from public.receipts r where r.company_id=target_company_id and r.booking_id=b.id) then blockers:=array_append(blockers,'Receipt records exist'); end if;
 if b.google_calendar_event_id is not null then blockers:=array_append(blockers,'Google Calendar event must be removed safely before deletion'); end if;
 select jsonb_build_object('id',x.id,'reference',x.booking_reference) into linked from public.bookings x where x.company_id=target_company_id and x.id<>b.id and (x.booking_reference=b.booking_reference||'-R' or b.booking_reference=x.booking_reference||'-R') limit 1;
 return jsonb_build_object('eligible',cardinality(blockers)=0,'blockers',to_jsonb(blockers),'booking_reference',b.booking_reference,'customer_name',b.customer_name,'journey_date',b.journey_date,'journey_time',b.journey_time,'pickup',b.pickup_address,'destination',b.dropoff_address,'status',b.status,'payment_status',b.payment_status,'linked_return',linked);
end $$;

create or replace function public.permanently_delete_booking(target_company_id uuid,target_booking_id uuid,typed_reference text,deletion_reason text,confirm_linked_scope boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; check_result jsonb; linked_ref text; jwt_iat bigint;
begin
 jwt_iat:=coalesce((auth.jwt()->>'iat')::bigint,0);
 if extract(epoch from now())::bigint-jwt_iat>300 then raise exception 'Recent password reauthentication is required'; end if;
 check_result:=public.booking_permanent_delete_eligibility(target_company_id,target_booking_id);
 if not (check_result->>'eligible')::boolean then raise exception 'Booking has retained financial or operational records; archive it instead'; end if;
 select * into b from public.bookings where id=target_booking_id and company_id=target_company_id for update;
 if b.booking_reference is distinct from typed_reference then raise exception 'Booking reference confirmation does not match'; end if;
 select x.booking_reference into linked_ref from public.bookings x where x.company_id=target_company_id and x.id<>b.id and (x.booking_reference=b.booking_reference||'-R' or b.booking_reference=x.booking_reference||'-R') limit 1;
 if linked_ref is not null and not confirm_linked_scope then raise exception 'Linked return exists; confirm deletion applies only to this journey'; end if;
 if length(trim(coalesce(deletion_reason,'')))<5 then raise exception 'A deletion reason is required'; end if;
 delete from public.booking_stops where company_id=target_company_id and booking_id=b.id;
 delete from public.driver_booking_events where company_id=target_company_id and booking_id=b.id;
 delete from public.admin_booking_audit where company_id=target_company_id and booking_id=b.id;
 delete from public.customer_booking_audit where company_id=target_company_id and booking_id=b.id;
 delete from public.booking_claim_tokens where company_id=target_company_id and booking_id=b.id;
 delete from public.driver_gps_points where company_id=target_company_id and booking_id=b.id;
 update public.sms_messages set booking_id=null where company_id=target_company_id and booking_id=b.id;
 update public.email_deliveries set booking_id=null where company_id=target_company_id and booking_id=b.id;
 delete from public.bookings where id=b.id and company_id=target_company_id;
 insert into public.booking_deletion_audit(company_id,booking_reference,actor_id,reason,linked_return_reference) values(target_company_id,b.booking_reference,auth.uid(),left(trim(deletion_reason),500),linked_ref);
 return jsonb_build_object('deleted',true,'booking_reference',b.booking_reference,'calendar_cleanup_required',false);
end $$;

create or replace function public.admin_reassign_booking(target_company_id uuid,target_booking_id uuid,target_driver_id uuid,target_vehicle_id uuid,reassignment_reason text)
returns boolean language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; starts timestamptz; ends timestamptz;
begin
 if not public.release73_admin(target_company_id) then raise exception 'Admin company access required'; end if;
 select * into b from public.bookings where id=target_booking_id and company_id=target_company_id for update;
 if not found then raise exception 'Booking not found'; end if;
 if lower(coalesce(b.status,'')) in('on_way','arrived','passenger_onboard','completed','cancelled','canceled','no_show') then raise exception 'Active or final journeys cannot be reassigned'; end if;
 starts:=(b.journey_date+b.journey_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London'); ends:=starts+make_interval(mins=>greatest(60,coalesce(b.route_duration_minutes,60))::integer);
 if target_driver_id is not null and not exists(select 1 from public.drivers d where d.id=target_driver_id and d.company_id=target_company_id and d.active) then raise exception 'Eligible active driver not found'; end if;
 if target_driver_id is not null and exists(select 1 from public.driver_unavailability u where u.company_id=target_company_id and u.driver_id=target_driver_id and u.active and u.from_datetime<ends and u.to_datetime>starts) then raise exception 'Driver is unavailable'; end if;
 if target_driver_id is not null and exists(select 1 from public.bookings x where x.company_id=target_company_id and x.driver_id=target_driver_id and x.id<>b.id and lower(coalesce(x.status,'')) in('assigned','accepted','on_way','arrived','passenger_onboard') and ((x.journey_date+x.journey_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London'))<ends and (((x.journey_date+x.journey_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London'))+make_interval(mins=>greatest(60,coalesce(x.route_duration_minutes,60))::integer))>starts) then raise exception 'Driver has a conflicting job'; end if;
 if target_vehicle_id is not null and not exists(select 1 from public.vehicles v where v.id=target_vehicle_id and v.company_id=target_company_id and v.active and v.passenger_seats>=coalesce(b.passengers,1)) then raise exception 'Eligible vehicle with sufficient capacity not found'; end if;
 insert into public.booking_assignment_audit(company_id,booking_id,previous_driver_id,next_driver_id,previous_vehicle_id,next_vehicle_id,reason,actor_id) values(target_company_id,b.id,b.driver_id,target_driver_id,b.vehicle_id,target_vehicle_id,nullif(trim(reassignment_reason),''),auth.uid());
 update public.bookings set driver_id=target_driver_id,vehicle_id=target_vehicle_id,dispatched_at=case when target_driver_id is null then null else now() end,status=case when target_driver_id is null then 'waiting' else 'assigned' end where id=b.id and company_id=target_company_id;
 return true;
end $$;

create or replace function public.archive_booking(target_company_id uuid,target_booking_id uuid,reason text) returns boolean language plpgsql security definer set search_path=public as $$
begin
 if not public.release73_admin(target_company_id) then raise exception 'Admin company access required'; end if;
 if length(trim(coalesce(reason,'')))<5 then raise exception 'An archive reason is required'; end if;
 update public.bookings set archived_at=now(),archived_by=auth.uid(),archive_reason=left(trim(reason),500) where id=target_booking_id and company_id=target_company_id and lower(coalesce(status,'')) not in('on_way','arrived','passenger_onboard');
 if not found then raise exception 'Active journey cannot be archived'; end if; return true;
end $$;

create or replace function public.release73_apply_retention() returns jsonb language plpgsql security definer set search_path=public as $$
declare gps_count integer;message_count integer;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 delete from public.driver_gps_points p using public.settings s where p.company_id=s.company_id and p.recorded_at<now()-make_interval(days=>s.driver_gps_retention_days);get diagnostics gps_count=row_count;
 delete from public.driver_messages m using public.settings s where m.company_id=s.company_id and m.created_at<now()-make_interval(days=>s.driver_message_retention_days);get diagnostics message_count=row_count;
 return jsonb_build_object('gps_deleted',gps_count,'messages_deleted',message_count);
end $$;

alter table public.vehicles enable row level security; alter table public.driver_vehicle_assignments enable row level security; alter table public.driver_bank_accounts enable row level security;
alter table public.driver_messages enable row level security; alter table public.driver_gps_points enable row level security; alter table public.booking_deletion_audit enable row level security; alter table public.booking_assignment_audit enable row level security;
create policy vehicles_admin_all on public.vehicles for all to authenticated using(public.release73_admin(company_id)) with check(public.release73_admin(company_id));
create policy assignments_admin_all on public.driver_vehicle_assignments for all to authenticated using(public.release73_admin(company_id)) with check(public.release73_admin(company_id));
create policy messages_admin_select on public.driver_messages for select to authenticated using(public.release73_admin(company_id));
create policy messages_admin_insert on public.driver_messages for insert to authenticated with check(public.release73_admin(company_id) and sender_type='admin' and sender_user_id=auth.uid());
create policy gps_admin_select on public.driver_gps_points for select to authenticated using(public.release73_admin(company_id));
create policy deletion_audit_admin_select on public.booking_deletion_audit for select to authenticated using(public.release73_admin(company_id));
create policy assignment_audit_admin_select on public.booking_assignment_audit for select to authenticated using(public.release73_admin(company_id));
revoke all on public.driver_bank_accounts from public,anon,authenticated; grant all on public.driver_bank_accounts to service_role;
revoke all on public.driver_messages,public.driver_gps_points from anon; grant select,insert,update on public.driver_messages to authenticated; grant select on public.driver_gps_points to authenticated;
grant select,insert,update on public.vehicles,public.driver_vehicle_assignments to authenticated;
revoke all on function public.booking_permanent_delete_eligibility(uuid,uuid),public.permanently_delete_booking(uuid,uuid,text,text,boolean),public.admin_reassign_booking(uuid,uuid,uuid,uuid,text),public.archive_booking(uuid,uuid,text) from public,anon;
grant execute on function public.booking_permanent_delete_eligibility(uuid,uuid),public.permanently_delete_booking(uuid,uuid,text,text,boolean),public.admin_reassign_booking(uuid,uuid,uuid,uuid,text),public.archive_booking(uuid,uuid,text) to authenticated;
revoke all on function public.release73_apply_retention() from public,anon,authenticated;grant execute on function public.release73_apply_retention() to service_role;
do $$ begin alter publication supabase_realtime add table public.driver_messages; exception when duplicate_object then null; end $$;

-- Jeff Bailey / 301 keeps the existing Expenses value; no other driver is enabled here.
update public.drivers d set driver_expenses_enabled=true from public.companies c where d.company_id=c.id and c.company_code='0003' and d.driver_number='301' and lower(d.full_name)='jeff bailey';
notify pgrst,'reload schema';
commit;
