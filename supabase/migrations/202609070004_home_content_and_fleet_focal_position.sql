-- Additive company-scoped Home page content and fleet image focal position.

begin;

alter table public.settings add column if not exists homeheroheading text;
alter table public.settings add column if not exists homeherodescription text;
alter table public.settings add column if not exists homeherobuttontext text;
alter table public.settings add column if not exists homesellingpoint1enabled boolean;
alter table public.settings add column if not exists homesellingpoint1text text;
alter table public.settings add column if not exists homesellingpoint2enabled boolean;
alter table public.settings add column if not exists homesellingpoint2text text;
alter table public.settings add column if not exists homesellingpoint3enabled boolean;
alter table public.settings add column if not exists homesellingpoint3text text;
alter table public.settings add column if not exists homesellingpoint4enabled boolean;
alter table public.settings add column if not exists homesellingpoint4text text;

grant select (
  homeheroheading, homeherodescription, homeherobuttontext,
  homesellingpoint1enabled, homesellingpoint1text,
  homesellingpoint2enabled, homesellingpoint2text,
  homesellingpoint3enabled, homesellingpoint3text,
  homesellingpoint4enabled, homesellingpoint4text
) on table public.settings to anon;

alter table public.fleet_items
  add column if not exists image_position text not null default 'center';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fleet_items_image_position_valid'
      and conrelid = 'public.fleet_items'::regclass
  ) then
    alter table public.fleet_items
      add constraint fleet_items_image_position_valid
      check (image_position in ('center', 'left', 'right', 'top', 'bottom'));
  end if;
end
$$;

grant select (image_position) on table public.fleet_items to anon;

commit;

notify pgrst, 'reload schema';
