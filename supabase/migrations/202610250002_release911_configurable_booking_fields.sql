-- Release 9.1.1: company-scoped booking requirement field visibility.
begin;

alter table public.settings
  add column if not exists show_wheelchair_requirements boolean not null default false,
  add column if not exists show_accessibility_requirements boolean not null default false;

-- Existing settings RLS continues to provide tenant isolation. State the new
-- Data API surface explicitly: Admins may manage both flags; anonymous public
-- forms may read only these non-sensitive booleans.
grant select (show_wheelchair_requirements,show_accessibility_requirements) on table public.settings to authenticated;
grant update (show_wheelchair_requirements,show_accessibility_requirements) on table public.settings to authenticated;
grant select (show_wheelchair_requirements,show_accessibility_requirements) on table public.settings to anon;

notify pgrst, 'reload schema';
commit;
