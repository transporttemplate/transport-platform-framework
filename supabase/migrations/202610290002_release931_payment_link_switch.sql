begin;

-- Fail closed for every existing and future company. This switch controls only
-- Admin-created Stripe payment links; it does not change existing payment flows.
alter table public.settings
  add column if not exists stripe_payment_links_enabled boolean not null default false;

update public.settings
set stripe_payment_links_enabled = false
where stripe_payment_links_enabled is distinct from false;

notify pgrst, 'reload schema';
commit;
