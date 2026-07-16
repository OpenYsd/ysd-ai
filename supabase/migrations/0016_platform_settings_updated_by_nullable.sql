begin;

alter table public.platform_settings
  alter column updated_by drop not null;

alter table public.platform_settings
  drop constraint if exists platform_settings_updated_by_fkey;

alter table public.platform_settings
  add constraint platform_settings_updated_by_fkey
  foreign key (updated_by)
  references public.profiles(id)
  on delete set null;

commit;