-- Release 8.0.6: separate customer collection from supplier settlement.
begin;

alter table public.job_exchange_offers
 add column if not exists customer_collection_responsibility text check(customer_collection_responsibility in('sender_collects','receiver_collects')),
 add column if not exists supplier_settlement_method text check(supplier_settlement_method in('on_account','direct','receiver_retains')),
 add column if not exists customer_amount_paid_snapshot numeric(12,2) not null default 0 check(customer_amount_paid_snapshot>=0),
 add column if not exists customer_payment_status text;
alter table public.external_dispatch_offers
 add column if not exists customer_collection_responsibility text check(customer_collection_responsibility in('sender_collects','receiver_collects')),
 add column if not exists supplier_settlement_method text check(supplier_settlement_method in('on_account','direct','receiver_retains')),
 add column if not exists customer_amount_paid numeric(12,2) not null default 0 check(customer_amount_paid>=0),
 add column if not exists supplier_amount_paid numeric(12,2) not null default 0 check(supplier_amount_paid>=0);

-- Preserve the legacy column verbatim. Only unambiguous historic meanings are projected.
update public.job_exchange_offers set
 customer_collection_responsibility=case payment_responsibility when 'sender_collects' then 'sender_collects' when 'receiver_collects' then 'receiver_collects' else null end,
 supplier_settlement_method='on_account'
where customer_collection_responsibility is null and supplier_settlement_method is null;
update public.external_dispatch_offers set
 customer_collection_responsibility=case payment_responsibility when 'sender_collects' then 'sender_collects' when 'receiver_collects' then 'receiver_collects' else null end,
 supplier_settlement_method='on_account'
where customer_collection_responsibility is null and supplier_settlement_method is null;

create or replace function public.create_job_exchange_offer_v806(
 target_sender uuid,target_receiver uuid,target_booking uuid,target_supplier_payment numeric,target_expires_at timestamptz,target_actor uuid,
 target_customer_collection text,target_supplier_settlement text
) returns uuid language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype;offer_id uuid;snap jsonb;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 if target_sender=target_receiver then raise exception 'Sending and receiving companies must differ';end if;
 if target_customer_collection not in('sender_collects','receiver_collects') then raise exception 'Customer fare collection is required';end if;
 if target_supplier_settlement not in('on_account','direct','receiver_retains') then raise exception 'Supplier settlement method is required';end if;
 if target_supplier_settlement='receiver_retains' and target_customer_collection<>'receiver_collects' then raise exception 'Receiver-retained settlement requires receiver customer collection';end if;
 if not coalesce((select approved from job_exchange_company_approvals where company_id=target_sender),false)
  or not coalesce((select approved from job_exchange_company_approvals where company_id=target_receiver),false) then raise exception 'Both companies must explicitly approve pilot exchange';end if;
 if target_supplier_payment<0 or target_supplier_payment>100000 then raise exception 'Supplier payment is invalid';end if;
 if target_expires_at<=now() or target_expires_at>now()+interval '30 days' then raise exception 'Offer expiry is invalid';end if;
 select * into b from bookings where id=target_booking and company_id=target_sender for share;
 if not found then raise exception 'Booking not found for sending company';end if;
 if lower(coalesce(b.status,b.booking_status,'')) in('completed','cancelled','canceled','no_show','archived') then raise exception 'Terminal bookings cannot be offered';end if;
 snap:=jsonb_build_object('booking_reference',b.booking_reference,'journey_date',b.journey_date,'journey_time',b.journey_time,
  'pickup_address',b.pickup_address,'dropoff_address',b.dropoff_address,'passengers',b.passengers,'vehicle_type',b.vehicle_type,
  'luggage',b.luggage,'flight_number',b.flight_number,'route_duration_minutes',b.route_duration_minutes,'customer_payment_status',b.payment_status);
 insert into job_exchange_offers(sender_company_id,receiver_company_id,source_booking_id,source_booking_reference,status,supplier_payment,customer_fare_snapshot,customer_amount_paid_snapshot,customer_payment_status,booking_snapshot,expires_at,offered_by,offered_at,payment_responsibility,customer_collection_responsibility,supplier_settlement_method,supplier_settlement_status)
 values(target_sender,target_receiver,b.id,b.booking_reference,'offered',target_supplier_payment,coalesce(b.price,b.job_price,0),coalesce(b.amount_paid,0),coalesce(b.payment_status,'unpaid'),snap,target_expires_at,target_actor,now(),target_customer_collection,target_customer_collection,target_supplier_settlement,case when target_supplier_payment=0 then 'not_applicable' else 'unpaid' end)
 returning id into offer_id;
 insert into job_exchange_audit(offer_id,sender_company_id,receiver_company_id,actor_id,action,to_status,details)
 values(offer_id,target_sender,target_receiver,target_actor,'offer_created','offered',jsonb_build_object('customer_collection',target_customer_collection,'supplier_settlement',target_supplier_settlement));
 return offer_id;
end$$;

revoke all on function public.create_job_exchange_offer_v806(uuid,uuid,uuid,numeric,timestamptz,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_job_exchange_offer_v806(uuid,uuid,uuid,numeric,timestamptz,uuid,text,text) to service_role;

create or replace function public.release806_apply_internal_exchange_finance() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.receiving_booking_id is not null and old.receiving_booking_id is null then
  update bookings set
   price=case when new.customer_collection_responsibility='receiver_collects' then new.customer_fare_snapshot else 0 end,
   job_price=case when new.customer_collection_responsibility='receiver_collects' then new.customer_fare_snapshot else 0 end,
   balance_due=case when new.customer_collection_responsibility='receiver_collects' then new.customer_fare_snapshot else 0 end,
   amount_paid=0,payment_status='unpaid',payment_type=case when new.customer_collection_responsibility='receiver_collects' then 'integration' else 'account' end,
   driver_amount=0
  where id=new.receiving_booking_id and company_id=new.receiver_company_id;
 end if;
 return new;
end$$;
drop trigger if exists release806_internal_exchange_finance on public.job_exchange_offers;
create trigger release806_internal_exchange_finance after update of receiving_booking_id on public.job_exchange_offers for each row execute function public.release806_apply_internal_exchange_finance();

create or replace function public.release806_sync_external_customer_payment() returns trigger language plpgsql security definer set search_path=public as $$
begin
 update job_exchange_offers set customer_amount_paid_snapshot=greatest(coalesce(new.amount_paid,0),0),customer_payment_status=coalesce(new.payment_status,'unpaid'),updated_at=clock_timestamp()
 where (customer_collection_responsibility='sender_collects' and source_booking_id=new.id and sender_company_id=new.company_id)
    or (customer_collection_responsibility='receiver_collects' and receiving_booking_id=new.id and receiver_company_id=new.company_id);
 update external_dispatch_offers set customer_amount_paid=greatest(coalesce(new.amount_paid,0),0),
  customer_payment_status=case when coalesce(new.amount_paid,0)<=0 then 'unpaid' when coalesce(new.balance_due,0)>0 then 'partial' else 'paid' end,
  updated_at=clock_timestamp()
 where receiving_booking_id=new.id and receiving_company_id=new.company_id and customer_collection_responsibility='receiver_collects';
 return new;
end$$;
drop trigger if exists release806_external_customer_payment on public.bookings;
create trigger release806_external_customer_payment after update of amount_paid,payment_status,balance_due on public.bookings for each row execute function public.release806_sync_external_customer_payment();

revoke all on function public.release806_apply_internal_exchange_finance(),public.release806_sync_external_customer_payment() from public,anon,authenticated;

commit;
notify pgrst,'reload schema';
