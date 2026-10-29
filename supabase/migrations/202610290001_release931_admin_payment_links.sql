begin;

create table if not exists public.admin_payment_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  payment_kind text not null check (payment_kind in ('deposit_20','full')),
  amount numeric(12,2) not null check (amount > 0),
  stripe_checkout_session_id text not null,
  stripe_payment_intent_id text not null,
  checkout_url text not null,
  status text not null default 'pending' check (status in ('pending','paid','failed','expired')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (booking_id,company_id) references public.bookings(id,company_id) on delete cascade
);

create unique index if not exists admin_payment_links_pending_unique
  on public.admin_payment_links(company_id,booking_id,payment_kind,amount)
  where status='pending';
create unique index if not exists admin_payment_links_intent_unique
  on public.admin_payment_links(company_id,stripe_payment_intent_id);
create index if not exists admin_payment_links_booking_idx
  on public.admin_payment_links(company_id,booking_id,created_at desc);

alter table public.admin_payment_links enable row level security;
revoke all on public.admin_payment_links from public,anon,authenticated;

commit;
