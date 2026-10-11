-- Additive, disabled-by-default gate for foreground Driver Portal navigation.
-- Enabling a company remains a separate, explicitly approved production action.

alter table public.settings
  add column if not exists driver_integrated_navigation boolean not null default false;

comment on column public.settings.driver_integrated_navigation is
  'Enables foreground in-portal driver navigation. Keep false until device and billing checks are approved.';
