-- Additive professional document metadata and canonical company-scoped receipts.

begin;

alter table public.settings add column if not exists receiptprefix text not null default 'REC';
alter table public.company_counters add column if not exists next_receipt_number bigint not null default 1 check (next_receipt_number > 0);
alter table public.invoices add column if not exists file_name text;
alter table public.invoices add column if not exists file_path text;
alter table public.driver_statements add column if not exists file_name text;
alter table public.driver_statements add column if not exists file_path text;
alter table public.driver_statement_items add column if not exists booking_reference text;
alter table public.driver_statement_items add column if not exists job_date date;
alter table public.driver_statement_items add column if not exists job_time time;
alter table public.driver_statement_items add column if not exists pickup_address text;
alter table public.driver_statement_items add column if not exists dropoff_address text;

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  customer_id uuid,
  receipt_number text not null,
  booking_reference text not null,
  customer_name text,
  customer_email text,
  job_date date,
  job_time time,
  pickup_address text,
  dropoff_address text,
  amount numeric not null check (amount >= 0),
  payment_method text,
  paid_at timestamptz not null,
  status text not null default 'issued' check (status in ('issued','void')),
  file_name text,
  file_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, booking_id),
  unique (company_id, receipt_number),
  unique (id, company_id),
  foreign key (booking_id, company_id) references public.bookings(id, company_id)
);

create index if not exists receipts_company_paid_idx on public.receipts(company_id, paid_at desc);
alter table public.receipts enable row level security;
revoke all on table public.receipts from public, anon, authenticated;
grant select, insert, update on table public.receipts to authenticated;
drop policy if exists admin_company_receipts on public.receipts;
create policy admin_company_receipts on public.receipts for all to authenticated
  using (public.user_can_access_company(company_id))
  with check (public.user_can_access_company(company_id));

create or replace function public.create_paid_booking_receipt(target_booking_id uuid, target_company_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; n bigint; prefix text; receipt_id uuid;
begin
  select * into b from public.bookings where id=target_booking_id and company_id=target_company_id;
  if not found or lower(coalesce(b.status,'')) <> 'completed' or lower(coalesce(b.payment_status,'')) <> 'paid' then return null; end if;
  select id into receipt_id from public.receipts where company_id=target_company_id and booking_id=target_booking_id;
  if receipt_id is not null then return receipt_id; end if;
  insert into public.company_counters(company_id,next_booking_number,next_receipt_number)
    values(target_company_id,1,2)
    on conflict(company_id) do update set next_receipt_number=public.company_counters.next_receipt_number+1,updated_at=now()
    returning next_receipt_number-1 into n;
  select coalesce(nullif(regexp_replace(receiptprefix,'[^A-Za-z0-9_-]','','g'),''),'REC') into prefix from public.settings where company_id=target_company_id;
  insert into public.receipts(company_id,booking_id,customer_id,receipt_number,booking_reference,customer_name,customer_email,job_date,job_time,pickup_address,dropoff_address,amount,payment_method,paid_at,file_name)
  values(target_company_id,b.id,b.customer_id,coalesce(prefix,'REC')||'-'||extract(year from coalesce(b.paid_at,now()))::int||'-'||lpad(n::text,4,'0'),coalesce(b.booking_reference,b.id::text),b.customer_name,b.customer_email,b.journey_date,b.journey_time,b.pickup_address,b.dropoff_address,greatest(coalesce(b.amount_paid,0),coalesce(b.price,b.job_price,0)),b.payment_method,coalesce(b.paid_at,now()),coalesce(prefix,'REC')||'-'||extract(year from coalesce(b.paid_at,now()))::int||'-'||lpad(n::text,4,'0')||'_'||regexp_replace(coalesce(b.customer_name,'Customer'),'[^A-Za-z0-9]+','-','g')||'.pdf')
  on conflict(company_id,booking_id) do nothing returning id into receipt_id;
  if receipt_id is null then select id into receipt_id from public.receipts where company_id=target_company_id and booking_id=target_booking_id; end if;
  return receipt_id;
end $$;

create or replace function public.booking_paid_receipt_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin perform public.create_paid_booking_receipt(new.id,new.company_id); return new; end $$;
drop trigger if exists booking_paid_receipt on public.bookings;
create trigger booking_paid_receipt after insert or update of status,payment_status,paid_at on public.bookings for each row execute function public.booking_paid_receipt_trigger();

do $$ declare booking_row record; begin
  for booking_row in select id,company_id from public.bookings where lower(coalesce(status,''))='completed' and lower(coalesce(payment_status,''))='paid'
  loop perform public.create_paid_booking_receipt(booking_row.id,booking_row.company_id); end loop;
end $$;

revoke all on function public.create_paid_booking_receipt(uuid,uuid) from public,anon,authenticated;

alter table public.email_deliveries add column if not exists receipt_id uuid;
do $$ begin if not exists(select 1 from pg_constraint where conname='email_deliveries_receipt_company_fk' and conrelid='public.email_deliveries'::regclass) then
  alter table public.email_deliveries add constraint email_deliveries_receipt_company_fk foreign key(receipt_id,company_id) references public.receipts(id,company_id) not valid;
end if; end $$;

commit;
notify pgrst, 'reload schema';
