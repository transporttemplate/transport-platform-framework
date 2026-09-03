-- Additive multi-company stage: finance, invoices, email, statements and booking stops.
-- Review in a staging Supabase project before applying to production.

create extension if not exists pgcrypto;

create or replace function public.user_can_access_company(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.company_users cu
        where cu.user_id = auth.uid() and cu.company_id = target_company_id
    );
$$;

create or replace function public.booking_matches_company(target_booking_id uuid, target_company_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.bookings where id = target_booking_id and company_id = target_company_id);
$$;

alter table public.bookings add column if not exists payment_status text not null default 'unpaid';
alter table public.bookings add column if not exists paid_at timestamptz;
alter table public.bookings add column if not exists pickup_name text;
alter table public.bookings add column if not exists pickup_postcode text;
alter table public.bookings add column if not exists pickup_place_id text;
alter table public.bookings add column if not exists pickup_lat numeric;
alter table public.bookings add column if not exists pickup_lng numeric;
alter table public.bookings add column if not exists dropoff_name text;
alter table public.bookings add column if not exists dropoff_postcode text;
alter table public.bookings add column if not exists dropoff_place_id text;
alter table public.bookings add column if not exists dropoff_lat numeric;
alter table public.bookings add column if not exists dropoff_lng numeric;

alter table public.drivers add column if not exists pay_type text not null default 'commission';
alter table public.drivers add column if not exists commission_percent numeric;
alter table public.drivers add column if not exists fixed_job_amount numeric;

alter table public.settings add column if not exists vatrate numeric not null default 0;
alter table public.settings add column if not exists statementprefix text not null default 'REM';

create unique index if not exists bookings_id_company_unique on public.bookings(id, company_id);
create unique index if not exists drivers_id_company_unique on public.drivers(id, company_id);
create unique index if not exists customers_id_company_unique on public.customers(id, company_id);

create table if not exists public.booking_stops (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    booking_id uuid not null,
    stop_order integer not null check (stop_order > 0),
    label text not null default 'Via',
    address_name text,
    formatted_address text not null,
    postcode text,
    latitude numeric,
    longitude numeric,
    place_id text,
    created_at timestamptz not null default now(),
    unique (booking_id, stop_order),
    foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);
alter table public.booking_stops add column if not exists id uuid default gen_random_uuid();
alter table public.booking_stops add column if not exists company_id uuid;
alter table public.booking_stops add column if not exists booking_id uuid;
alter table public.booking_stops add column if not exists stop_order integer;
alter table public.booking_stops add column if not exists label text default 'Via';
alter table public.booking_stops add column if not exists address_name text;
alter table public.booking_stops add column if not exists formatted_address text;
alter table public.booking_stops add column if not exists postcode text;
alter table public.booking_stops add column if not exists latitude numeric;
alter table public.booking_stops add column if not exists longitude numeric;
alter table public.booking_stops add column if not exists place_id text;
alter table public.booking_stops add column if not exists created_at timestamptz default now();

create table if not exists public.invoices (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    customer_id uuid,
    invoice_number text not null,
    status text not null default 'draft' check (status in ('draft','sent','paid','overdue','cancelled')),
    issue_date date not null default current_date,
    due_date date not null,
    customer_name text not null,
    customer_email text,
    billing_address text,
    notes text,
    subtotal numeric not null default 0,
    tax_rate numeric not null default 0,
    tax_total numeric not null default 0,
    total numeric not null default 0,
    paid_total numeric not null default 0,
    sent_at timestamptz,
    paid_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, invoice_number),
    unique (id, company_id),
    foreign key (customer_id, company_id) references public.customers(id, company_id)
);
alter table public.invoices add column if not exists id uuid default gen_random_uuid();
alter table public.invoices add column if not exists company_id uuid;
alter table public.invoices add column if not exists customer_id uuid;
alter table public.invoices add column if not exists invoice_number text;
alter table public.invoices add column if not exists status text default 'draft';
alter table public.invoices add column if not exists issue_date date default current_date;
alter table public.invoices add column if not exists due_date date;
alter table public.invoices add column if not exists customer_name text;
alter table public.invoices add column if not exists customer_email text;
alter table public.invoices add column if not exists billing_address text;
alter table public.invoices add column if not exists notes text;
alter table public.invoices add column if not exists subtotal numeric default 0;
alter table public.invoices add column if not exists tax_rate numeric default 0;
alter table public.invoices add column if not exists tax_total numeric default 0;
alter table public.invoices add column if not exists total numeric default 0;
alter table public.invoices add column if not exists paid_total numeric default 0;
alter table public.invoices add column if not exists sent_at timestamptz;
alter table public.invoices add column if not exists paid_at timestamptz;
alter table public.invoices add column if not exists created_at timestamptz default now();
alter table public.invoices add column if not exists updated_at timestamptz default now();
create unique index if not exists invoices_company_number_unique on public.invoices(company_id, invoice_number);
create unique index if not exists invoices_id_company_unique on public.invoices(id, company_id);

create table if not exists public.invoice_items (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    invoice_id uuid not null,
    booking_id uuid,
    description text not null,
    quantity numeric not null default 1,
    unit_price numeric not null default 0,
    line_total numeric not null default 0,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    foreign key (invoice_id, company_id) references public.invoices(id, company_id) on delete cascade,
    foreign key (booking_id, company_id) references public.bookings(id, company_id)
);
alter table public.invoice_items add column if not exists id uuid default gen_random_uuid();
alter table public.invoice_items add column if not exists company_id uuid;
alter table public.invoice_items add column if not exists invoice_id uuid;
alter table public.invoice_items add column if not exists booking_id uuid;
alter table public.invoice_items add column if not exists description text;
alter table public.invoice_items add column if not exists quantity numeric default 1;
alter table public.invoice_items add column if not exists unit_price numeric default 0;
alter table public.invoice_items add column if not exists line_total numeric default 0;
alter table public.invoice_items add column if not exists sort_order integer default 0;
alter table public.invoice_items add column if not exists created_at timestamptz default now();

alter table public.bookings add column if not exists invoice_id uuid;
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'bookings_invoice_company_fk' and conrelid = 'public.bookings'::regclass) then
        alter table public.bookings add constraint bookings_invoice_company_fk foreign key (invoice_id, company_id) references public.invoices(id, company_id) not valid;
    end if;
end $$;

create or replace function public.link_booking_to_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.booking_id is not null then
        update public.bookings set invoice_id = new.invoice_id
        where id = new.booking_id and company_id = new.company_id;
    end if;
    return new;
end;
$$;
do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 'invoice_item_link_booking' and tgrelid = 'public.invoice_items'::regclass) then
        create trigger invoice_item_link_booking after insert on public.invoice_items for each row execute function public.link_booking_to_invoice();
    end if;
end $$;

create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    booking_id uuid,
    invoice_id uuid,
    amount numeric not null check (amount >= 0),
    method text not null,
    status text not null default 'paid' check (status in ('pending','paid','refunded','failed')),
    reference text,
    paid_at timestamptz,
    created_at timestamptz not null default now(),
    foreign key (booking_id, company_id) references public.bookings(id, company_id),
    foreign key (invoice_id, company_id) references public.invoices(id, company_id)
);
alter table public.payments add column if not exists id uuid default gen_random_uuid();
alter table public.payments add column if not exists company_id uuid;
alter table public.payments add column if not exists booking_id uuid;
alter table public.payments add column if not exists invoice_id uuid;
alter table public.payments add column if not exists amount numeric;
alter table public.payments add column if not exists method text;
alter table public.payments add column if not exists status text default 'paid';
alter table public.payments add column if not exists reference text;
alter table public.payments add column if not exists paid_at timestamptz;
alter table public.payments add column if not exists created_at timestamptz default now();

create table if not exists public.email_templates (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    template_key text not null,
    subject text not null,
    body text not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, template_key)
);
alter table public.email_templates add column if not exists id uuid default gen_random_uuid();
alter table public.email_templates add column if not exists company_id uuid;
alter table public.email_templates add column if not exists template_key text;
alter table public.email_templates add column if not exists subject text;
alter table public.email_templates add column if not exists body text;
alter table public.email_templates add column if not exists active boolean default true;
alter table public.email_templates add column if not exists created_at timestamptz default now();
alter table public.email_templates add column if not exists updated_at timestamptz default now();
create unique index if not exists email_templates_company_key_unique on public.email_templates(company_id, template_key);

create table if not exists public.email_deliveries (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    template_key text not null,
    recipient text not null,
    subject text,
    status text not null default 'queued' check (status in ('queued','sent','failed')),
    booking_id uuid,
    invoice_id uuid,
    driver_statement_id uuid,
    provider_message_id text,
    error_message text,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    foreign key (booking_id, company_id) references public.bookings(id, company_id),
    foreign key (invoice_id, company_id) references public.invoices(id, company_id)
);
alter table public.email_deliveries add column if not exists id uuid default gen_random_uuid();
alter table public.email_deliveries add column if not exists company_id uuid;
alter table public.email_deliveries add column if not exists template_key text;
alter table public.email_deliveries add column if not exists recipient text;
alter table public.email_deliveries add column if not exists subject text;
alter table public.email_deliveries add column if not exists status text default 'queued';
alter table public.email_deliveries add column if not exists booking_id uuid;
alter table public.email_deliveries add column if not exists invoice_id uuid;
alter table public.email_deliveries add column if not exists driver_statement_id uuid;
alter table public.email_deliveries add column if not exists provider_message_id text;
alter table public.email_deliveries add column if not exists error_message text;
alter table public.email_deliveries add column if not exists created_at timestamptz default now();
alter table public.email_deliveries add column if not exists sent_at timestamptz;

create table if not exists public.driver_statements (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    driver_id uuid not null,
    statement_number text not null,
    period_start date not null,
    period_end date not null,
    status text not null default 'draft' check (status in ('draft','finalised','paid','cancelled')),
    gross_total numeric not null default 0,
    driver_total numeric not null default 0,
    company_total numeric not null default 0,
    finalised_at timestamptz,
    paid_at timestamptz,
    created_at timestamptz not null default now(),
    unique (company_id, statement_number),
    unique (id, company_id),
    foreign key (driver_id, company_id) references public.drivers(id, company_id)
);
alter table public.driver_statements add column if not exists id uuid default gen_random_uuid();
alter table public.driver_statements add column if not exists company_id uuid;
alter table public.driver_statements add column if not exists driver_id uuid;
alter table public.driver_statements add column if not exists statement_number text;
alter table public.driver_statements add column if not exists period_start date;
alter table public.driver_statements add column if not exists period_end date;
alter table public.driver_statements add column if not exists status text default 'draft';
alter table public.driver_statements add column if not exists gross_total numeric default 0;
alter table public.driver_statements add column if not exists driver_total numeric default 0;
alter table public.driver_statements add column if not exists company_total numeric default 0;
alter table public.driver_statements add column if not exists finalised_at timestamptz;
alter table public.driver_statements add column if not exists paid_at timestamptz;
alter table public.driver_statements add column if not exists created_at timestamptz default now();
create unique index if not exists driver_statements_company_number_unique on public.driver_statements(company_id, statement_number);
create unique index if not exists driver_statements_id_company_unique on public.driver_statements(id, company_id);

do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'email_deliveries_statement_company_fk' and conrelid = 'public.email_deliveries'::regclass) then
        alter table public.email_deliveries add constraint email_deliveries_statement_company_fk foreign key (driver_statement_id, company_id) references public.driver_statements(id, company_id) not valid;
    end if;
end $$;

create table if not exists public.driver_statement_items (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    statement_id uuid not null,
    booking_id uuid not null,
    gross_fare numeric not null default 0,
    commission_percent numeric not null default 0,
    driver_amount numeric not null default 0,
    company_amount numeric not null default 0,
    created_at timestamptz not null default now(),
    foreign key (statement_id, company_id) references public.driver_statements(id, company_id) on delete cascade,
    foreign key (booking_id, company_id) references public.bookings(id, company_id),
    unique (company_id, statement_id, booking_id)
);
alter table public.driver_statement_items add column if not exists id uuid default gen_random_uuid();
alter table public.driver_statement_items add column if not exists company_id uuid;
alter table public.driver_statement_items add column if not exists statement_id uuid;
alter table public.driver_statement_items add column if not exists booking_id uuid;
alter table public.driver_statement_items add column if not exists gross_fare numeric default 0;
alter table public.driver_statement_items add column if not exists commission_percent numeric default 0;
alter table public.driver_statement_items add column if not exists driver_amount numeric default 0;
alter table public.driver_statement_items add column if not exists company_amount numeric default 0;
alter table public.driver_statement_items add column if not exists created_at timestamptz default now();
create unique index if not exists driver_statement_items_company_booking_unique on public.driver_statement_items(company_id, statement_id, booking_id);

alter table public.booking_stops enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.email_templates enable row level security;
alter table public.email_deliveries enable row level security;
alter table public.driver_statements enable row level security;
alter table public.driver_statement_items enable row level security;

do $$
declare table_name text;
begin
    foreach table_name in array array['booking_stops','invoices','invoice_items','payments','email_templates','email_deliveries','driver_statements','driver_statement_items']
    loop
        if not exists (
            select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = table_name and p.policyname = 'tenant_admin_all'
        ) then
            execute format('create policy tenant_admin_all on public.%I for all using (public.user_can_access_company(company_id)) with check (public.user_can_access_company(company_id))', table_name);
        end if;
    end loop;
end $$;

-- Anonymous customers may add stops only to a booking belonging to the same company.
do $$ begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'booking_stops' and policyname = 'public_insert_booking_stops'
    ) then
        create policy public_insert_booking_stops on public.booking_stops
        for insert to anon with check (public.booking_matches_company(booking_id, company_id));
    end if;
end $$;

create or replace function public.get_driver_booking_stops(target_company_id uuid, target_driver_id uuid, target_pin text)
returns setof public.booking_stops
language sql stable security definer set search_path = public as $$
    select bs.* from public.booking_stops bs
    join public.bookings b on b.id = bs.booking_id and b.company_id = bs.company_id
    where bs.company_id = target_company_id
      and b.driver_id = target_driver_id
      and exists (
          select 1 from public.drivers d
          where d.id = target_driver_id and d.company_id = target_company_id
            and coalesce(d.pin::text, '') = coalesce(target_pin, '')
      )
    order by bs.booking_id, bs.stop_order;
$$;
grant execute on function public.get_driver_booking_stops(uuid, uuid, text) to anon, authenticated;

create index if not exists booking_stops_company_booking_idx on public.booking_stops(company_id, booking_id, stop_order);
create unique index if not exists booking_stops_booking_order_unique on public.booking_stops(booking_id, stop_order);
create index if not exists invoices_company_status_idx on public.invoices(company_id, status, issue_date);
create index if not exists invoice_items_company_invoice_idx on public.invoice_items(company_id, invoice_id, sort_order);
create index if not exists payments_company_paid_idx on public.payments(company_id, paid_at);
create index if not exists email_templates_company_idx on public.email_templates(company_id, template_key);
create index if not exists email_deliveries_company_created_idx on public.email_deliveries(company_id, created_at desc);
create index if not exists driver_statements_company_driver_idx on public.driver_statements(company_id, driver_id, period_start);
create index if not exists driver_statement_items_company_statement_idx on public.driver_statement_items(company_id, statement_id);

-- Ask PostgREST to refresh the Supabase API schema cache after this migration.
notify pgrst, 'reload schema';
