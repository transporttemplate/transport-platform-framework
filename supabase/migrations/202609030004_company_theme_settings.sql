-- Additive, company-scoped theme settings.

alter table public.settings add column if not exists primarycolour text default '#37d4d4';
alter table public.settings add column if not exists secondarycolour text default '#111111';
alter table public.settings add column if not exists accentcolour text default '#d71a1a';
alter table public.settings add column if not exists buttoncolour text default '#37d4d4';
alter table public.settings add column if not exists buttontextcolour text default '#111111';
alter table public.settings add column if not exists adminsidebarcolour text default '#1f2937';

notify pgrst, 'reload schema';
