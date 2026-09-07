-- Additive company-scoped bank transfer details for authenticated invoice use.

begin;

alter table public.settings add column if not exists bankaccountname text;
alter table public.settings add column if not exists banksortcode text;
alter table public.settings add column if not exists bankaccountnumber text;
alter table public.settings add column if not exists bankpaymentreferenceinstruction text;
alter table public.settings add column if not exists showbankdetailsoninvoices boolean not null default false;

-- Deliberately no anon/PUBLIC grants: bank details are private settings.
-- Existing authenticated settings RLS continues to enforce company membership.

commit;

notify pgrst, 'reload schema';
