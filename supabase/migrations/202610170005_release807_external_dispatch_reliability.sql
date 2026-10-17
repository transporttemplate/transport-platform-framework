-- Release 8.0.7: duplicate dispatch guard and auditable supplier-obligation handling.
begin;

create unique index if not exists external_dispatch_one_active_journey
 on public.external_dispatch_offers(originating_company_id,external_booking_reference)
 where status in('offered','viewed','accepted','active');

alter table public.external_dispatch_offers
 add column if not exists supplier_obligation_voided numeric(12,2) not null default 0 check(supplier_obligation_voided>=0),
 add column if not exists supplier_obligation_voided_at timestamptz,
 add column if not exists financial_resolution_required boolean not null default false;

create table if not exists public.external_dispatch_financial_events(
 id uuid primary key default gen_random_uuid(), offer_id uuid not null references public.external_dispatch_offers(id),
 originating_company_id uuid not null references public.companies(id), receiving_company_id uuid not null references public.companies(id),
 event_type text not null check(event_type in('supplier_obligation_voided','financial_resolution_required','supplier_obligation_resolved')),
 amount numeric(12,2) not null default 0 check(amount>=0), reason text not null, actor_id uuid references auth.users(id),
 created_at timestamptz not null default now(), unique(offer_id,event_type)
);
create index if not exists external_dispatch_financial_events_offer on public.external_dispatch_financial_events(offer_id,created_at);
alter table public.external_dispatch_financial_events enable row level security;
revoke all on public.external_dispatch_financial_events from public,anon,authenticated;
grant all on public.external_dispatch_financial_events to service_role;

create or replace function public.return_external_dispatch_to_provider(target_offer uuid,target_company uuid,target_actor uuid,target_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;b bookings%rowtype;stamp timestamptz:=clock_timestamp(); event_id uuid;event_key text;voided numeric(12,2);requires_resolution boolean;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 if length(trim(coalesce(target_reason,'')))<3 then raise exception 'A return reason is required';end if;
 select * into o from external_dispatch_offers where id=target_offer and receiving_company_id=target_company for update;
 if not found or o.status not in('accepted','active') or o.receiving_booking_id is null then raise exception 'Accepted external offer not found';end if;
 select * into b from bookings where id=o.receiving_booking_id and company_id=target_company for update;
 if not found then raise exception 'Receiving booking not found';end if;
 if lower(coalesce(b.status,b.booking_status,'')) in('passenger_onboard','pob','completed','dropped_off') or b.passenger_onboard_at is not null then raise exception 'Passenger pickup requires the incident and handover process';end if;
 requires_resolution:=coalesce(o.supplier_amount_paid,0)>0;
 voided:=case when requires_resolution then 0 else greatest(coalesce(o.supplier_payment,0)-coalesce(o.supplier_amount_paid,0),0) end;
 update bookings set status='returned_to_provider',booking_status='returned_to_provider',driver_id=null,vehicle_id=null where id=b.id and company_id=target_company;
 update external_dispatch_offers set status='returned',returned_at=stamp,return_reason=left(trim(target_reason),500),return_actor_id=target_actor,reallocation_required=true,
  supplier_obligation_voided=voided,supplier_obligation_voided_at=case when voided>0 then stamp else null end,
  supplier_settlement_status=case when voided>0 then 'not_applicable' when requires_resolution then 'disputed' else supplier_settlement_status end,
  financial_resolution_required=requires_resolution,updated_at=stamp where id=o.id;
 insert into external_dispatch_financial_events(offer_id,originating_company_id,receiving_company_id,event_type,amount,reason,actor_id)
 values(o.id,o.originating_company_id,o.receiving_company_id,case when requires_resolution then 'financial_resolution_required' else 'supplier_obligation_voided' end,case when requires_resolution then coalesce(o.supplier_amount_paid,0) else voided end,left(trim(target_reason),500),target_actor) on conflict do nothing;
 event_key:='dispatch:'||o.id||':returned';
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,event_timestamp,idempotency_key) values(o.id,target_company,'booking.returned',b.booking_reference,'returned',stamp,event_key) on conflict(idempotency_key) do nothing returning id into event_id;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(target_company,'booking.returned','external_dispatch_offer',o.id,event_key,jsonb_build_object('offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',b.booking_reference,'status','returned','reason',left(trim(target_reason),500),'event_timestamp',stamp,'reallocation_required',true,'financial_resolution_required',requires_resolution)) on conflict(company_id,event_key) do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select target_company,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=target_company and w.event_key=event_key where e.integration_id=o.integration_id and e.status='active' and 'booking.returned'=any(e.event_types) on conflict(endpoint_id,event_id) do nothing;
 return jsonb_build_object('offer_id',o.id,'booking_id',b.id,'status','returned','reallocation_required',true,'returned_at',stamp,'supplier_obligation_voided',voided,'financial_resolution_required',requires_resolution);
end$$;
revoke all on function public.return_external_dispatch_to_provider(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.return_external_dispatch_to_provider(uuid,uuid,uuid,text) to service_role;

commit;
notify pgrst,'reload schema';
