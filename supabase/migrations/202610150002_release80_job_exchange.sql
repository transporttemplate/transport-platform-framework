-- Release 8.0: dormant, explicitly approved company-to-company job exchange.
begin;

create table public.job_exchange_company_approvals(
 company_id uuid primary key references public.companies(id), approved boolean not null default false,
 approved_by uuid references auth.users(id), approved_at timestamptz, updated_at timestamptz not null default now()
);
insert into public.job_exchange_company_approvals(company_id) select id from public.companies on conflict do nothing;

create table public.job_exchange_offers(
 id uuid primary key default gen_random_uuid(), sender_company_id uuid not null references public.companies(id),
 receiver_company_id uuid not null references public.companies(id), source_booking_id uuid not null references public.bookings(id),
 receiving_booking_id uuid references public.bookings(id), source_booking_reference text not null,
 status text not null default 'draft' check(status in('draft','offered','viewed','accepted','declined','expired','withdrawn','completed')),
 journey_status text, supplier_payment numeric(12,2) not null check(supplier_payment>=0), customer_fare_snapshot numeric(12,2) not null default 0,
 supplier_amount_paid numeric(12,2) not null default 0 check(supplier_amount_paid>=0),
 booking_snapshot jsonb not null, expires_at timestamptz not null,
 offered_by uuid not null references auth.users(id), offered_at timestamptz, viewed_at timestamptz,
 accepted_by uuid references auth.users(id), accepted_at timestamptz, declined_by uuid references auth.users(id), declined_at timestamptz,
 withdrawn_by uuid references auth.users(id), withdrawn_at timestamptz, completed_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(sender_company_id<>receiver_company_id), check(supplier_amount_paid<=supplier_payment),
 unique(sender_company_id,source_booking_id,receiver_company_id)
);
create index job_exchange_sender_recent on public.job_exchange_offers(sender_company_id,created_at desc,id desc);
create index job_exchange_receiver_recent on public.job_exchange_offers(receiver_company_id,created_at desc,id desc);
create index job_exchange_expiry on public.job_exchange_offers(status,expires_at) where status in('draft','offered','viewed');

create table public.job_exchange_audit(
 id bigint generated always as identity primary key, offer_id uuid not null references public.job_exchange_offers(id) on delete cascade,
 sender_company_id uuid not null references public.companies(id), receiver_company_id uuid not null references public.companies(id),
 actor_id uuid references auth.users(id), action text not null, from_status text, to_status text,
 details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index job_exchange_audit_offer_recent on public.job_exchange_audit(offer_id,created_at desc,id desc);

create table public.api_test_runs(
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references auth.users(id), sender_company_id uuid references public.companies(id),
 receiver_company_id uuid references public.companies(id), status text not null check(status in('passed','failed')),
 duration_ms integer not null, summary jsonb not null, created_at timestamptz not null default now()
);
create index api_test_runs_recent on public.api_test_runs(created_at desc);

create or replace function public.create_job_exchange_offer(
 target_sender uuid,target_receiver uuid,target_booking uuid,target_supplier_payment numeric,target_expires_at timestamptz,target_actor uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; offer_id uuid; snap jsonb;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 if target_sender=target_receiver then raise exception 'Sending and receiving companies must differ';end if;
 if not coalesce((select approved from job_exchange_company_approvals where company_id=target_sender),false)
    or not coalesce((select approved from job_exchange_company_approvals where company_id=target_receiver),false) then
   raise exception 'Both companies must explicitly approve pilot exchange';end if;
 if target_supplier_payment<0 or target_supplier_payment>100000 then raise exception 'Supplier payment is invalid';end if;
 if target_expires_at<=now() or target_expires_at>now()+interval '30 days' then raise exception 'Offer expiry is invalid';end if;
 select * into b from bookings where id=target_booking and company_id=target_sender for share;
 if not found then raise exception 'Booking not found for sending company';end if;
 if lower(coalesce(b.status,b.booking_status,'')) in('completed','cancelled','canceled','no_show','archived') then raise exception 'Terminal bookings cannot be offered';end if;
 snap:=jsonb_build_object('booking_reference',b.booking_reference,'journey_date',b.journey_date,'journey_time',b.journey_time,
   'pickup_address',b.pickup_address,'dropoff_address',b.dropoff_address,'passengers',b.passengers,
   'vehicle_type',b.vehicle_type,'luggage',b.luggage,'flight_number',b.flight_number,'route_duration_minutes',b.route_duration_minutes);
 insert into job_exchange_offers(sender_company_id,receiver_company_id,source_booking_id,source_booking_reference,status,supplier_payment,customer_fare_snapshot,booking_snapshot,expires_at,offered_by,offered_at)
 values(target_sender,target_receiver,b.id,b.booking_reference,'offered',target_supplier_payment,coalesce(b.price,0),snap,target_expires_at,target_actor,now()) returning id into offer_id;
 insert into job_exchange_audit(offer_id,sender_company_id,receiver_company_id,actor_id,action,to_status)
 values(offer_id,target_sender,target_receiver,target_actor,'offer_created','offered');return offer_id;
end $$;

create or replace function public.transition_job_exchange_offer(
 target_offer uuid,target_company uuid,target_action text,target_actor uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.job_exchange_offers%rowtype;b public.bookings%rowtype;created public.bookings%rowtype;old_status text;new_status text;new_ref text;clone jsonb;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 select * into o from job_exchange_offers where id=target_offer for update;if not found then raise exception 'Offer not found';end if;
 old_status:=o.status;
 if o.status in('offered','viewed') and o.expires_at<=now() then
   update job_exchange_offers set status='expired',updated_at=now() where id=o.id;
   insert into job_exchange_audit(offer_id,sender_company_id,receiver_company_id,actor_id,action,from_status,to_status) values(o.id,o.sender_company_id,o.receiver_company_id,target_actor,'expired',old_status,'expired');
   return jsonb_build_object('offer_id',o.id,'status','expired');
 end if;
 if target_action='view' then
   if target_company<>o.receiver_company_id or old_status not in('offered','viewed') then raise exception 'Offer cannot be viewed';end if;
   new_status:='viewed';update job_exchange_offers set status=new_status,viewed_at=coalesce(viewed_at,now()),updated_at=now() where id=o.id;
 elsif target_action='decline' then
   if target_company<>o.receiver_company_id or old_status not in('offered','viewed') then raise exception 'Offer cannot be declined';end if;
   new_status:='declined';update job_exchange_offers set status=new_status,declined_by=target_actor,declined_at=now(),updated_at=now() where id=o.id;
 elsif target_action='withdraw' then
   if target_company<>o.sender_company_id or old_status not in('draft','offered','viewed') then raise exception 'Offer cannot be withdrawn';end if;
   new_status:='withdrawn';update job_exchange_offers set status=new_status,withdrawn_by=target_actor,withdrawn_at=now(),updated_at=now() where id=o.id;
 elsif target_action='accept' then
   if target_company<>o.receiver_company_id then raise exception 'Offer cannot be accepted';end if;
   if o.receiving_booking_id is not null and old_status in('accepted','completed') then return jsonb_build_object('offer_id',o.id,'status',old_status,'booking_id',o.receiving_booking_id,'duplicate',true);end if;
   if old_status not in('offered','viewed') then raise exception 'Offer cannot be accepted';end if;
   if not coalesce((select approved from job_exchange_company_approvals where company_id=o.sender_company_id),false)
      or not coalesce((select approved from job_exchange_company_approvals where company_id=o.receiver_company_id),false) then raise exception 'Both company approvals are required';end if;
   select * into b from bookings where id=o.source_booking_id and company_id=o.sender_company_id for share;if not found then raise exception 'Source booking unavailable';end if;
   new_ref:=public.next_company_booking_reference(o.receiver_company_id);
   clone:=to_jsonb(b)-array['id','company_id','booking_reference','driver_id','accepted_at','on_way_at','arrived_at','passenger_onboard_at','completed_at','cancelled_at','created_at','updated_at','creation_idempotency_key'];
   clone:=clone||jsonb_build_object('id',gen_random_uuid(),'company_id',o.receiver_company_id,'booking_reference',new_ref,'driver_id',null,
     'status','waiting','booking_status','waiting','booking_source','job_exchange','price',0,'amount_paid',0,'balance_due',0,
     'payment_status','paid','driver_amount',o.supplier_payment,'creation_idempotency_key','exchange_'||o.id);
   created:=jsonb_populate_record(null::bookings,clone);insert into bookings select created.* returning * into created;
   new_status:='accepted';update job_exchange_offers set status=new_status,receiving_booking_id=created.id,accepted_by=target_actor,accepted_at=now(),journey_status='waiting',updated_at=now() where id=o.id;
 else raise exception 'Unsupported offer action';end if;
 insert into job_exchange_audit(offer_id,sender_company_id,receiver_company_id,actor_id,action,from_status,to_status)
 values(o.id,o.sender_company_id,o.receiver_company_id,target_actor,target_action,old_status,new_status);
 return jsonb_build_object('offer_id',o.id,'status',new_status,'booking_id',created.id,'duplicate',false);
end $$;

create or replace function public.sync_job_exchange_journey_status() returns trigger language plpgsql security definer set search_path=public as $$
declare next_status text:=lower(coalesce(new.status,new.booking_status,''));
begin
 update job_exchange_offers set journey_status=next_status,status=case when next_status='completed' then 'completed' else status end,
 completed_at=case when next_status='completed' then coalesce(completed_at,now()) else completed_at end,updated_at=now()
 where receiving_booking_id=new.id and receiver_company_id=new.company_id and status in('accepted','completed');
 return new;
end $$;
create trigger release80_exchange_status after update of status,booking_status on public.bookings for each row execute function public.sync_job_exchange_journey_status();

create or replace function public.expire_job_exchange_offers() returns integer language plpgsql security definer set search_path=public as $$
declare n integer;begin if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 with changed as(update job_exchange_offers set status='expired',updated_at=now() where status in('offered','viewed') and expires_at<=now() returning *)
 insert into job_exchange_audit(offer_id,sender_company_id,receiver_company_id,action,from_status,to_status)
 select id,sender_company_id,receiver_company_id,'expired',status,'expired' from changed;
 get diagnostics n=row_count;return n;end $$;

do $$declare t text;begin foreach t in array array['job_exchange_company_approvals','job_exchange_offers','job_exchange_audit','api_test_runs'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;end$$;
revoke all on function public.create_job_exchange_offer(uuid,uuid,uuid,numeric,timestamptz,uuid),public.transition_job_exchange_offer(uuid,uuid,text,uuid),public.expire_job_exchange_offers(),public.sync_job_exchange_journey_status() from public,anon,authenticated;
grant execute on function public.create_job_exchange_offer(uuid,uuid,uuid,numeric,timestamptz,uuid),public.transition_job_exchange_offer(uuid,uuid,text,uuid),public.expire_job_exchange_offers() to service_role;
notify pgrst,'reload schema';commit;
