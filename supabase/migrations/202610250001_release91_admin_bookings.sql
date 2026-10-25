-- Release 9.1: structured passenger requirements and audited admin corrections.
begin;

alter table public.bookings
  add column if not exists wheelchair_required boolean not null default false,
  add column if not exists accessibility_requirements text,
  add column if not exists special_instructions text,
  add column if not exists airport_information text;

alter table public.bookings drop constraint if exists bookings_accessibility_requirements_length;
alter table public.bookings add constraint bookings_accessibility_requirements_length
  check (length(coalesce(accessibility_requirements,'')) <= 1000);
alter table public.bookings drop constraint if exists bookings_special_instructions_length;
alter table public.bookings add constraint bookings_special_instructions_length
  check (length(coalesce(special_instructions,'')) <= 1000);
alter table public.bookings drop constraint if exists bookings_airport_information_length;
alter table public.bookings add constraint bookings_airport_information_length
  check (length(coalesce(airport_information,'')) <= 500);

create or replace function public.admin_update_booking_requirements(
  target_company_id uuid,
  target_booking_id uuid,
  wheelchair_required_value boolean,
  accessibility_requirements_value text,
  special_instructions_value text,
  airport_information_value text,
  correction_reason text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare old_row bookings%rowtype; new_row bookings%rowtype; changed text[] := array[]::text[];
begin
  if not public.release73_admin(target_company_id) then
    raise exception 'Only a company Owner or Administrator can correct bookings' using errcode='42501';
  end if;
  if length(trim(coalesce(correction_reason,''))) < 5 then raise exception 'A meaningful correction reason is required'; end if;
  select * into old_row from bookings where id=target_booking_id and company_id=target_company_id for update;
  if not found then raise exception 'Booking not found for this company' using errcode='P0002'; end if;
  if length(coalesce(accessibility_requirements_value,'')) > 1000 or length(coalesce(special_instructions_value,'')) > 1000 or length(coalesce(airport_information_value,'')) > 500 then
    raise exception 'Passenger or airport information is too long';
  end if;
  if old_row.wheelchair_required is distinct from coalesce(wheelchair_required_value,false) then changed:=array_append(changed,'wheelchair_required'); end if;
  if old_row.accessibility_requirements is distinct from nullif(trim(accessibility_requirements_value),'') then changed:=array_append(changed,'accessibility_requirements'); end if;
  if old_row.special_instructions is distinct from nullif(trim(special_instructions_value),'') then changed:=array_append(changed,'special_instructions'); end if;
  if old_row.airport_information is distinct from nullif(trim(airport_information_value),'') then changed:=array_append(changed,'airport_information'); end if;
  if coalesce(array_length(changed,1),0)=0 then return jsonb_build_object('ok',true,'changed_fields',changed); end if;
  update bookings set wheelchair_required=coalesce(wheelchair_required_value,false),
    accessibility_requirements=nullif(trim(accessibility_requirements_value),''),
    special_instructions=nullif(trim(special_instructions_value),''),
    airport_information=nullif(trim(airport_information_value),''),
    edit_version=edit_version+1
  where id=target_booking_id and company_id=target_company_id returning * into new_row;
  insert into admin_booking_audit(company_id,booking_id,booking_reference,admin_user_id,changed_fields,previous_values,new_values,change_reason)
  values(target_company_id,target_booking_id,old_row.booking_reference,auth.uid(),changed,
    jsonb_build_object('wheelchair_required',old_row.wheelchair_required,'accessibility_requirements',old_row.accessibility_requirements,'special_instructions',old_row.special_instructions,'airport_information',old_row.airport_information),
    jsonb_build_object('wheelchair_required',new_row.wheelchair_required,'accessibility_requirements',new_row.accessibility_requirements,'special_instructions',new_row.special_instructions,'airport_information',new_row.airport_information),trim(correction_reason));
  return jsonb_build_object('ok',true,'changed_fields',changed,'edit_version',new_row.edit_version);
end $$;

revoke all on function public.admin_update_booking_requirements(uuid,uuid,boolean,text,text,text,text) from public,anon,authenticated;
grant execute on function public.admin_update_booking_requirements(uuid,uuid,boolean,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
