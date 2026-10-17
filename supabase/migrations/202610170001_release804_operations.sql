-- Release 8.0.4: repair driver allocation visibility and add audited fare adjustments.
begin;

grant select(active) on public.drivers to authenticated;

create table if not exists public.booking_fare_adjustments(
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 booking_id uuid not null,
 booking_reference text not null,
 previous_fare numeric(12,2) not null check(previous_fare>=0),
 new_fare numeric(12,2) not null check(new_fare>=0),
 difference numeric(12,2) not null,
 amount_received_snapshot numeric(12,2) not null default 0,
 previous_balance_snapshot numeric(12,2) not null default 0,
 new_balance numeric(12,2) not null,
 overpayment numeric(12,2) not null default 0,
 driver_amount_snapshot numeric(12,2),
 payment_status_snapshot text,
 journey_status_snapshot text,
 reason text not null check(length(trim(reason)) between 5 and 500),
 document_resolution_required boolean not null default false,
 actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 foreign key(booking_id,company_id) references public.bookings(id,company_id)
);
create index if not exists booking_fare_adjustments_booking_idx on public.booking_fare_adjustments(company_id,booking_id,created_at desc);
alter table public.booking_fare_adjustments enable row level security;
revoke all on public.booking_fare_adjustments from public,anon,authenticated;
grant select on public.booking_fare_adjustments to authenticated;
grant all on public.booking_fare_adjustments to service_role;
drop policy if exists booking_fare_adjustments_company_select on public.booking_fare_adjustments;
create policy booking_fare_adjustments_company_select on public.booking_fare_adjustments for select to authenticated using(public.user_can_access_company(company_id));

create or replace function public.adjust_booking_fare(target_company_id uuid,target_booking_id uuid,new_fare numeric,adjustment_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype;old_fare numeric;received numeric;balance numeric;credit numeric;needs_document boolean;adjustment_id uuid;
begin
 if not public.release73_admin(target_company_id) then raise exception 'Admin company access required';end if;
 if new_fare is null or new_fare<0 or new_fare>100000 then raise exception 'Fare must be between 0 and 100000';end if;
 if length(trim(coalesce(adjustment_reason,'')))<5 then raise exception 'A meaningful adjustment reason is required';end if;
 select * into b from public.bookings where id=target_booking_id and company_id=target_company_id for update;
 if not found then raise exception 'Booking not found';end if;
 if lower(coalesce(b.status,'')) in('cancelled','canceled','no_show','archived') then raise exception 'Cancelled, no-show or archived bookings cannot be fare adjusted';end if;
 old_fare:=round(coalesce(b.price,b.job_price,0)::numeric,2);new_fare:=round(new_fare,2);
 if old_fare=new_fare then raise exception 'New fare must differ from the current fare';end if;
 received:=round(greatest(0,coalesce(b.amount_paid,0))::numeric,2);
 balance:=round(greatest(new_fare-received,0),2);credit:=round(greatest(received-new_fare,0),2);
 select exists(select 1 from public.invoice_items i where i.company_id=target_company_id and i.booking_id=target_booking_id) into needs_document;
 insert into public.booking_fare_adjustments(company_id,booking_id,booking_reference,previous_fare,new_fare,difference,amount_received_snapshot,previous_balance_snapshot,new_balance,overpayment,driver_amount_snapshot,payment_status_snapshot,journey_status_snapshot,reason,document_resolution_required,actor_id)
 values(target_company_id,b.id,b.booking_reference,old_fare,new_fare,new_fare-old_fare,received,coalesce(b.balance_due,0),balance,credit,b.driver_amount,b.payment_status,b.status,trim(adjustment_reason),needs_document,auth.uid()) returning id into adjustment_id;
 update public.bookings set price=new_fare,job_price=new_fare,balance_due=balance,
  payment_status=case when received=0 then 'unpaid' when balance=0 then 'paid' else 'part_paid' end,
  edit_version=coalesce(edit_version,0)+1
 where id=b.id and company_id=target_company_id;
 insert into public.admin_booking_audit(company_id,booking_id,booking_reference,admin_user_id,changed_fields,previous_values,new_values,price_override_reason)
 values(target_company_id,b.id,b.booking_reference,auth.uid(),array['price','balance_due','payment_status'],jsonb_build_object('price',old_fare,'amount_paid',received,'balance_due',b.balance_due,'payment_status',b.payment_status),jsonb_build_object('price',new_fare,'amount_paid',received,'balance_due',balance,'payment_status',case when received=0 then 'unpaid' when balance=0 then 'paid' else 'part_paid' end,'overpayment',credit),trim(adjustment_reason));
 return jsonb_build_object('ok',true,'adjustment_id',adjustment_id,'booking_reference',b.booking_reference,'previous_fare',old_fare,'new_fare',new_fare,'difference',new_fare-old_fare,'amount_received',received,'outstanding',balance,'overpayment',credit,'journey_status',b.status,'driver_amount_unchanged',b.driver_amount,'document_resolution_required',needs_document);
end$$;
revoke all on function public.adjust_booking_fare(uuid,uuid,numeric,text) from public,anon;
grant execute on function public.adjust_booking_fare(uuid,uuid,numeric,text) to authenticated;

commit;
notify pgrst,'reload schema';
