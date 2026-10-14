-- Expose the existing Release 7.4 permission safely to company Owners and
-- platform administrators. This migration grants nobody permission.
begin;
create table if not exists public.booking_deletion_permission_audit(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 target_user_id uuid not null references auth.users(id), actor_id uuid not null references auth.users(id),
 previous_allowed boolean not null, next_allowed boolean not null, actor_authority text not null check(actor_authority in('company_owner','platform_admin')),
 created_at timestamptz not null default now()
);
alter table public.booking_deletion_permission_audit enable row level security;
revoke all on public.booking_deletion_permission_audit from public,anon,authenticated;
grant all on public.booking_deletion_permission_audit to service_role;

create or replace function public.booking_deletion_permission_manager(target_company_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and (
  exists(select 1 from public.company_users where company_id=target_company_id and user_id=auth.uid() and lower(role)='owner')
  or lower(coalesce(auth.jwt()->'app_metadata'->>'platform_role','')) in('platform_admin','super_admin','owner')
 )
$$;
create or replace function public.set_booking_deletion_permission(target_company_id uuid,target_user_id uuid,allowed boolean)
returns boolean language plpgsql security definer set search_path=public as $$
declare previous boolean;authority text;
begin
 if not public.booking_deletion_permission_manager(target_company_id) then raise exception 'Company Owner or platform administrator access required' using errcode='42501'; end if;
 select can_permanently_delete_bookings into previous from public.company_users
 where company_id=target_company_id and user_id=target_user_id and lower(role) in('admin','owner') for update;
 if not found then raise exception 'Eligible company Admin or Owner not found'; end if;
 update public.company_users set can_permanently_delete_bookings=coalesce(allowed,false) where company_id=target_company_id and user_id=target_user_id;
 authority:=case when exists(select 1 from public.company_users where company_id=target_company_id and user_id=auth.uid() and lower(role)='owner') then 'company_owner' else 'platform_admin' end;
 if previous is distinct from coalesce(allowed,false) then
  insert into public.booking_deletion_permission_audit(company_id,target_user_id,actor_id,previous_allowed,next_allowed,actor_authority)
  values(target_company_id,target_user_id,auth.uid(),previous,coalesce(allowed,false),authority);
 end if;
 return true;
end $$;
create or replace function public.booking_deletion_permission_members(target_company_id uuid)
returns table(user_id uuid,role text,allowed boolean) language sql stable security definer set search_path=public as $$
 select u.user_id,u.role,u.can_permanently_delete_bookings from public.company_users u
 where u.company_id=target_company_id and lower(u.role) in('admin','owner') and public.booking_deletion_permission_manager(target_company_id)
 order by case when u.user_id=auth.uid() then 0 else 1 end,lower(u.role) desc,u.user_id
$$;
revoke all on function public.booking_deletion_permission_manager(uuid),public.set_booking_deletion_permission(uuid,uuid,boolean),public.booking_deletion_permission_members(uuid) from public,anon;
grant execute on function public.booking_deletion_permission_manager(uuid),public.set_booking_deletion_permission(uuid,uuid,boolean),public.booking_deletion_permission_members(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
