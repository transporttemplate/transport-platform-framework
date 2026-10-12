-- Forward-only return booking fix. Historical booking rows are not modified.

begin;

alter table public.bookings add column if not exists creation_idempotency_key text;
create unique index if not exists bookings_company_creation_idempotency_unique
  on public.bookings(company_id,creation_idempotency_key)
  where creation_idempotency_key is not null;

create or replace function public.create_booking_bundle(
  target_company_id uuid,
  booking_rows jsonb,
  stop_rows jsonb default '[]'::jsonb,
  payment_row jsonb default null,
  request_key text default null
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  caller_role text:=coalesce(auth.role(),'');
  caller_id uuid:=auth.uid();
  item jsonb;
  inserted_row public.bookings%rowtype;
  inserted_stop public.booking_stops%rowtype;
  inserted_payment public.payments%rowtype;
  result jsonb:='[]'::jsonb;
  row_count integer;
  first_ref text;
  second_ref text;
  existing_id uuid;
begin
  if caller_role='authenticated' then
    if caller_id is null or not exists(
      select 1 from public.company_users cu
      where cu.company_id=target_company_id and cu.user_id=caller_id and lower(cu.role) in ('admin','owner')
    ) then raise exception 'Company Admin access required'; end if;
    if payment_row is not null then raise exception 'Admin creation cannot create payment records'; end if;
  elsif caller_role<>'service_role' then
    raise exception 'Authorised booking creation required';
  end if;

  if jsonb_typeof(booking_rows)<>'array' then raise exception 'Booking rows must be an array'; end if;
  row_count:=jsonb_array_length(booking_rows);
  if row_count not in (1,2) then raise exception 'A booking bundle must contain one or two jobs'; end if;
  if stop_rows is null then stop_rows:='[]'::jsonb; end if;
  if jsonb_typeof(stop_rows)<>'array' then raise exception 'Booking stops must be an array'; end if;
  if request_key is not null and request_key !~ '^[A-Za-z0-9_-]{16,100}$' then raise exception 'Invalid booking request key'; end if;

  perform pg_advisory_xact_lock(hashtextextended(target_company_id::text||coalesce(request_key,gen_random_uuid()::text),0));
  if request_key is not null then
    select id into existing_id from public.bookings
    where company_id=target_company_id and creation_idempotency_key=request_key;
    if existing_id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'booking_reference',b.booking_reference,'price',b.price) order by b.booking_reference),'[]'::jsonb)
      into result from public.bookings b
      where b.company_id=target_company_id
        and regexp_replace(b.booking_reference,'-R$','')=(select regexp_replace(x.booking_reference,'-R$','') from public.bookings x where x.id=existing_id);
      return jsonb_build_object('bookings',result,'idempotent',true);
    end if;
  end if;

  first_ref:=booking_rows->0->>'booking_reference';
  if row_count=2 then
    second_ref:=booking_rows->1->>'booking_reference';
    if second_ref<>first_ref||'-R' then raise exception 'Return reference must use the outbound -R relationship'; end if;
    if booking_rows->1->>'pickup_address'<>booking_rows->0->>'dropoff_address'
       or booking_rows->1->>'dropoff_address'<>booking_rows->0->>'pickup_address' then
      raise exception 'Return route must reverse the outbound route';
    end if;
    if (booking_rows->1->>'journey_date')::date < (booking_rows->0->>'journey_date')::date
       or ((booking_rows->1->>'journey_date')::date=(booking_rows->0->>'journey_date')::date
           and (booking_rows->1->>'journey_time')::time<=(booking_rows->0->>'journey_time')::time) then
      raise exception 'Return journey must be after the outbound journey';
    end if;
  end if;

  for item in select value from jsonb_array_elements(booking_rows)
  loop
    item:=item||jsonb_build_object('company_id',target_company_id);
    if caller_role='authenticated' then
      item:=item||jsonb_build_object('payment_status','unpaid','amount_paid',0,'paid_at',null);
    end if;
    inserted_row:=jsonb_populate_record(null::public.bookings,item);
    inserted_row.id:=coalesce(inserted_row.id,gen_random_uuid());
    inserted_row.amount_paid:=coalesce(inserted_row.amount_paid,0);
    inserted_row.balance_due:=coalesce(inserted_row.balance_due,0);
    inserted_row.edit_version:=coalesce(inserted_row.edit_version,0);
    insert into public.bookings
      select inserted_row.*
      returning * into inserted_row;
    result:=result||jsonb_build_array(jsonb_build_object('id',inserted_row.id,'booking_reference',inserted_row.booking_reference,'price',inserted_row.price));
  end loop;

  if jsonb_array_length(stop_rows)>0 then
    for item in select value from jsonb_array_elements(stop_rows)
    loop
      inserted_stop:=jsonb_populate_record(null::public.booking_stops,item||jsonb_build_object('company_id',target_company_id));
      inserted_stop.id:=coalesce(inserted_stop.id,gen_random_uuid());
      inserted_stop.stop_order:=coalesce(inserted_stop.stop_order,1);
      insert into public.booking_stops select inserted_stop.*;
    end loop;
  end if;

  if payment_row is not null then
    inserted_payment:=jsonb_populate_record(null::public.payments,payment_row||jsonb_build_object('company_id',target_company_id));
    inserted_payment.id:=coalesce(inserted_payment.id,gen_random_uuid());
    insert into public.payments select inserted_payment.*;
  end if;

  return jsonb_build_object('bookings',result,'idempotent',false);
end $$;

revoke all on function public.create_booking_bundle(uuid,jsonb,jsonb,jsonb,text) from public,anon;
grant execute on function public.create_booking_bundle(uuid,jsonb,jsonb,jsonb,text) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
