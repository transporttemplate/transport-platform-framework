-- Release 7.7: reusable company staff roles, granular permissions and audited bootstrap.
-- No existing membership, platform role or deletion permission is changed here.
begin;
alter table public.company_users add column if not exists active boolean not null default true;
alter table public.company_users add column if not exists permission_grants text[] not null default '{}';
alter table public.company_users add column if not exists permission_denials text[] not null default '{}';
alter table public.company_users add column if not exists invited_at timestamptz;
alter table public.company_users add column if not exists disabled_at timestamptz;
alter table public.company_users add column if not exists updated_at timestamptz not null default now();

create table if not exists public.company_permission_catalog(
 permission text primary key,category text not null,description text not null,sensitive boolean not null default false
);
insert into public.company_permission_catalog(permission,category,description,sensitive) values
('bookings.read','Bookings','View bookings',false),('bookings.create','Bookings','Create bookings',false),('bookings.update','Bookings','Edit bookings',false),('bookings.assign_driver','Bookings','Assign and reassign drivers',false),('bookings.cancel','Bookings','Cancel bookings',false),('bookings.delete_permanent','Security','Permanently delete eligible bookings',true),
('customers.read','Customers','View customers required for operations',false),('customers.message','Customers','Message customers',false),
('drivers.read','Drivers','View drivers',false),('drivers.manage','Drivers','Manage drivers',true),('drivers.message','Drivers','Message drivers',false),
('vehicles.read','Vehicles','View vehicles',false),('vehicles.manage','Vehicles','Manage vehicles and assignments',false),('availability.manage','Dispatch','Manage driver availability',false),
('payments.read','Payments','View payment status',true),('payments.record','Payments','Record authorised customer payments',true),
('reports.operational.read','Reports','View operational reports',false),('reports.financial.read','Reports','View financial reports and exports',true),
('sms.inbox.read','Communications','Read the SMS Inbox',false),('sms.inbox.reply','Communications','Reply from the SMS Inbox',true),('sms.settings.manage','Communications','Manage SMS settings',true),('email.settings.manage','Communications','Manage email settings',true),
('integrations.company.manage','Integrations','Manage company integrations',true),('staff.manage','Security','Manage company staff',true),('security.permissions.manage','Security','Manage sensitive permissions',true),('gps.history.read','Security','View protected driver GPS history',true)
on conflict(permission) do update set category=excluded.category,description=excluded.description,sensitive=excluded.sensitive;

create table if not exists public.company_role_presets(
 role text primary key check(role in('office_manager','office_staff')),permissions text[] not null,updated_at timestamptz not null default now()
);
insert into public.company_role_presets(role,permissions) values
('office_manager',array['bookings.read','bookings.create','bookings.update','bookings.assign_driver','bookings.cancel','customers.read','customers.message','drivers.read','drivers.message','vehicles.read','availability.manage','reports.operational.read']),
('office_staff',array['bookings.read','bookings.create','bookings.update','bookings.assign_driver','customers.read','customers.message','drivers.read','drivers.message','vehicles.read'])
on conflict(role) do update set permissions=excluded.permissions,updated_at=now();

create table if not exists public.staff_access_audit(
 id uuid primary key default gen_random_uuid(),company_id uuid references public.companies(id),actor_id uuid references auth.users(id),target_user_id uuid references auth.users(id),action text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create table if not exists public.platform_security_audit(
 id uuid primary key default gen_random_uuid(),actor_id uuid,target_user_id uuid not null references auth.users(id),action text not null,evidence jsonb not null,created_at timestamptz not null default now()
);
create table if not exists public.company_staff_invitations(
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),email text not null,role text not null check(role in('office_manager','office_staff')),permission_grants text[] not null default '{}',permission_denials text[] not null default '{}',status text not null default 'pending' check(status in('pending','accepted','cancelled','expired')),invited_by uuid not null references auth.users(id),auth_user_id uuid references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(company_id,email,status)
);
create or replace function public.accept_company_staff_invitation()
returns trigger language plpgsql security definer set search_path='' as $$
begin if new.email_confirmed_at is not null and old.email_confirmed_at is null then update public.company_staff_invitations set status='accepted',updated_at=now() where auth_user_id=new.id and status='pending';end if;return new;end $$;
drop trigger if exists release77_accept_staff_invitation on auth.users;
create trigger release77_accept_staff_invitation after update of email_confirmed_at on auth.users for each row execute function public.accept_company_staff_invitation();

create or replace function public.company_role_permissions(target_role text)
returns text[] language sql stable security definer set search_path=public as $$
 select case lower(target_role) when 'owner' then array(select permission from public.company_permission_catalog where permission<>'bookings.delete_permanent') when 'admin' then array(select permission from public.company_permission_catalog where permission<>'bookings.delete_permanent') else coalesce((select permissions from public.company_role_presets where role=lower(target_role)),'{}') end
$$;
create or replace function public.has_company_permission(target_company_id uuid,required_permission text)
returns boolean language sql stable security definer set search_path=public as $$
 select public.is_platform_administrator() or exists(select 1 from public.company_users cu where cu.company_id=target_company_id and cu.user_id=auth.uid() and cu.active and required_permission<>all(cu.permission_denials) and (required_permission=any(cu.permission_grants) or required_permission=any(public.company_role_permissions(cu.role))) and (required_permission<>'bookings.delete_permanent' or cu.can_permanently_delete_bookings))
$$;
create or replace function public.user_can_access_company(target_company_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.company_users cu where cu.user_id=auth.uid() and cu.company_id=target_company_id and cu.active and lower(cu.role) in('admin','owner'))
$$;
create or replace function public.can_manage_company_staff(target_company_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select public.is_platform_administrator() or exists(select 1 from public.company_users cu where cu.company_id=target_company_id and cu.user_id=auth.uid() and cu.active and lower(cu.role) in('admin','owner'))
$$;
create or replace function public.booking_deletion_permission_manager(target_company_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and (public.is_platform_administrator() or exists(select 1 from public.company_users where company_id=target_company_id and user_id=auth.uid() and active and lower(role) in('owner','admin')))
$$;
create or replace function public.booking_deletion_management_companies()
returns table(company_id uuid,company_code text,company_name text,authority text)
language sql stable security definer set search_path=public as $$
 select c.id,c.company_code,coalesce(c.trading_name,c.name),case when public.is_platform_administrator() then 'platform_admin' else 'company_administrator' end from public.companies c
 where public.is_platform_administrator() or exists(select 1 from public.company_users cu where cu.company_id=c.id and cu.user_id=auth.uid() and cu.active and lower(cu.role) in('owner','admin')) order by c.company_code
$$;
create or replace function public.revoke_company_user_sessions(target_company_id uuid,target_user_id uuid)
returns boolean language plpgsql security definer set search_path=public,auth as $$
begin if auth.role()<>'service_role' then raise exception 'Service role required' using errcode='42501';end if;if not exists(select 1 from public.company_users where company_id=target_company_id and user_id=target_user_id) then raise exception 'Company membership not found';end if;delete from auth.sessions where user_id=target_user_id;return true;end $$;
create or replace function public.bootstrap_platform_super_admin(target_user_id uuid,evidence jsonb)
returns boolean language plpgsql security definer set search_path=public,auth as $$
begin
 if auth.role()<>'service_role' then raise exception 'Service role bootstrap required' using errcode='42501';end if;
 if coalesce(evidence->>'verified_by','')='' or coalesce(evidence->>'verification_method','')='' or coalesce(evidence->>'evidence_reference','')='' or evidence->>'confirmation'<>'GRANT PLATFORM SUPER ADMIN' then raise exception 'Complete trusted verification evidence is required';end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'Authenticated account not found';end if;
 if not exists(select 1 from public.company_users where user_id=target_user_id and active and lower(role)='owner') then raise exception 'Existing verified company ownership is required for first bootstrap';end if;
 update auth.users set raw_app_meta_data=coalesce(raw_app_meta_data,'{}')||jsonb_build_object('platform_role','super_admin') where id=target_user_id;
 insert into public.platform_security_audit(actor_id,target_user_id,action,evidence) values(null,target_user_id,'bootstrap_super_admin',evidence);return true;
end $$;
create or replace function public.assign_verified_company_owner(target_company_id uuid,target_user_id uuid,evidence jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid();begin
 if auth.role()<>'service_role' and not public.is_platform_administrator() then raise exception 'Platform administrator or service role required' using errcode='42501';end if;
 if coalesce(evidence->>'verification_method','')='' or coalesce(evidence->>'evidence_reference','')='' or evidence->>'confirmation'<>'ASSIGN VERIFIED COMPANY OWNER' then raise exception 'Complete identity and authority evidence is required';end if;
 update public.company_users set role='owner',updated_at=now() where company_id=target_company_id and user_id=target_user_id and active;if not found then raise exception 'Active company membership not found';end if;
 insert into public.staff_access_audit(company_id,actor_id,target_user_id,action,details) values(target_company_id,actor,target_user_id,'verified_owner_assigned',evidence);return true;
end $$;

alter table public.company_permission_catalog enable row level security;alter table public.company_role_presets enable row level security;alter table public.staff_access_audit enable row level security;alter table public.platform_security_audit enable row level security;alter table public.company_staff_invitations enable row level security;
revoke all on public.company_permission_catalog,public.company_role_presets,public.staff_access_audit,public.platform_security_audit,public.company_staff_invitations from public,anon,authenticated;
grant select on public.company_permission_catalog,public.company_role_presets to authenticated;grant all on public.company_permission_catalog,public.company_role_presets,public.staff_access_audit,public.platform_security_audit,public.company_staff_invitations to service_role;
revoke all on function public.accept_company_staff_invitation(),public.company_role_permissions(text),public.has_company_permission(uuid,text),public.can_manage_company_staff(uuid),public.revoke_company_user_sessions(uuid,uuid),public.bootstrap_platform_super_admin(uuid,jsonb),public.assign_verified_company_owner(uuid,uuid,jsonb) from public,anon;
grant execute on function public.company_role_permissions(text),public.has_company_permission(uuid,text),public.can_manage_company_staff(uuid) to authenticated;
grant execute on function public.revoke_company_user_sessions(uuid,uuid),public.bootstrap_platform_super_admin(uuid,jsonb),public.assign_verified_company_owner(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';commit;
