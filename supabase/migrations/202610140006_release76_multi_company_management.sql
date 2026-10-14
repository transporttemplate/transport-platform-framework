-- Release 7.6: explicit platform authority and company-scoped deletion management.
-- This migration grants no deletion permission and creates no API credential.
begin;
create or replace function public.is_platform_administrator()
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and lower(coalesce(auth.jwt()->'app_metadata'->>'platform_role','')) in('platform_admin','super_admin')
$$;
create or replace function public.booking_deletion_permission_manager(target_company_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and (public.is_platform_administrator() or exists(select 1 from public.company_users where company_id=target_company_id and user_id=auth.uid() and lower(role)='owner'))
$$;
create or replace function public.booking_deletion_management_companies()
returns table(company_id uuid,company_code text,company_name text,authority text)
language sql stable security definer set search_path=public as $$
 select c.id,c.company_code,coalesce(c.trading_name,c.name),case when public.is_platform_administrator() then 'platform_admin' else 'company_owner' end
 from public.companies c where public.is_platform_administrator() or exists(select 1 from public.company_users cu where cu.company_id=c.id and cu.user_id=auth.uid() and lower(cu.role)='owner') order by c.company_code
$$;
drop function if exists public.booking_deletion_permission_members(uuid);
create or replace function public.booking_deletion_permission_members(target_company_id uuid)
returns table(user_id uuid,role text,allowed boolean,last_changed_at timestamptz)
language sql stable security definer set search_path=public as $$
 select u.user_id,u.role,u.can_permanently_delete_bookings,(select max(a.created_at) from public.booking_deletion_permission_audit a where a.company_id=u.company_id and a.target_user_id=u.user_id)
 from public.company_users u where u.company_id=target_company_id and lower(u.role) in('admin','owner') and public.booking_deletion_permission_manager(target_company_id)
 order by case when u.user_id=auth.uid() then 0 else 1 end,lower(u.role) desc,u.user_id
$$;
create or replace function public.booking_deletion_permission_history(target_company_id uuid)
returns table(id uuid,target_user_id uuid,actor_id uuid,previous_allowed boolean,next_allowed boolean,actor_authority text,created_at timestamptz)
language sql stable security definer set search_path=public as $$
 select a.id,a.target_user_id,a.actor_id,a.previous_allowed,a.next_allowed,a.actor_authority,a.created_at from public.booking_deletion_permission_audit a
 where a.company_id=target_company_id and public.booking_deletion_permission_manager(target_company_id) order by a.created_at desc limit 100
$$;
create or replace function public.set_booking_deletion_permission(target_company_id uuid,target_user_id uuid,allowed boolean)
returns boolean language plpgsql security definer set search_path=public as $$
declare previous boolean;authority text;
begin
 if not public.booking_deletion_permission_manager(target_company_id) then raise exception 'Company Owner or platform administrator access required' using errcode='42501'; end if;
 select can_permanently_delete_bookings into previous from public.company_users where company_id=target_company_id and user_id=target_user_id and lower(role) in('admin','owner') for update;
 if not found then raise exception 'Eligible company Admin or Owner not found'; end if;
 update public.company_users set can_permanently_delete_bookings=coalesce(allowed,false) where company_id=target_company_id and user_id=target_user_id;
 authority:=case when public.is_platform_administrator() then 'platform_admin' else 'company_owner' end;
 if previous is distinct from coalesce(allowed,false) then insert into public.booking_deletion_permission_audit(company_id,target_user_id,actor_id,previous_allowed,next_allowed,actor_authority) values(target_company_id,target_user_id,auth.uid(),previous,coalesce(allowed,false),authority); end if;
 return true;
end $$;
revoke all on function public.is_platform_administrator(),public.booking_deletion_management_companies(),public.booking_deletion_permission_manager(uuid),public.booking_deletion_permission_members(uuid),public.booking_deletion_permission_history(uuid),public.set_booking_deletion_permission(uuid,uuid,boolean) from public,anon;
grant execute on function public.is_platform_administrator(),public.booking_deletion_management_companies(),public.booking_deletion_permission_manager(uuid),public.booking_deletion_permission_members(uuid),public.booking_deletion_permission_history(uuid),public.set_booking_deletion_permission(uuid,uuid,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
