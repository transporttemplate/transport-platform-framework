-- Additive payment-state fields for Stripe test-mode full/deposit payments.
-- Apply only after review. No Stripe credentials are stored in database rows.

begin;

alter table public.bookings add column if not exists payment_type text;
alter table public.bookings add column if not exists amount_paid numeric not null default 0;
alter table public.bookings add column if not exists balance_due numeric not null default 0;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.bookings'::regclass and conname='bookings_payment_amounts_nonnegative') then
    alter table public.bookings add constraint bookings_payment_amounts_nonnegative
      check (amount_paid >= 0 and balance_due >= 0);
  end if;
end $$;

create unique index if not exists payments_stripe_reference_unique
  on public.payments(reference)
  where reference is not null and method = 'stripe';

notify pgrst, 'reload schema';
commit;
