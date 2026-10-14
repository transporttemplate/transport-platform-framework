-- Release 7.4: professional SMS rendering, transactional cancellation and
-- owner-managed permanent-deletion permission. Forward-only; no booking data
-- is deleted and no permission or sending gate is enabled by this migration.
begin;

-- Improve only untouched catalogue defaults. Company customisations are never
-- overwritten. Template identifiers and the 13-template catalogue stay intact.
update public.sms_templates t set body=v.next_body,updated_at=now()
from (values
 ('customer_confirmation',E'{{company_name}}\n\nBooking confirmed\nRef: {{booking_reference}}\nDate: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nThank you for booking with us.',E'{{company_name}}\n\nBooking confirmed.\n\nRef: {{booking_reference}}\nDate: {{pickup_date}}\nTime: {{pickup_time}}\n\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nThank you for booking with us.'),
 ('customer_pickup_reminder',E'{{company_name}} reminder\n\nYour journey is scheduled for {{pickup_date}} at {{pickup_time}}.\n\nPickup: {{pickup_address}}\n\nRef: {{booking_reference}}',E'{{company_name}}\n\nReminder: Your taxi is booked for {{pickup_date}} at {{pickup_time}}.\n\nPickup: {{pickup_address}}\n\nRef: {{booking_reference}}\n\nThank you.'),
 ('driver_on_route',E'{{company_name}}\n\nYour driver is on the way.\n\nPickup: {{pickup_address}}\nRef: {{booking_reference}}',E'{{company_name}}\n\nYour driver {{driver_name}} is on the way.\n\n{{vehicle_details}}\n{{driver_contact_line}}\n\nThank you for booking with us.'),
 ('driver_arrived',E'{{company_name}}\n\nYour driver has arrived and is waiting outside at {{pickup_address}}.\n\nRef: {{booking_reference}}',E'{{company_name}}\n\nYour driver {{driver_name}} has arrived at your pickup location.\n\nBooking: {{booking_reference}}\n\nPlease make your way to the vehicle when ready.'),
 ('booking_cancelled',E'{{company_name}}\n\nYour booking {{booking_reference}} for {{pickup_date}} at {{pickup_time}} has been cancelled.\n\nPlease contact our office if this is unexpected.',E'{{company_name}}\n\nYour booking {{booking_reference}} for {{pickup_date}} at {{pickup_time}} has been cancelled.\n\nIf you believe this is incorrect, please contact our office.'),
 ('driver_assignment',E'{{company_name}} - New job\n\nRef: {{booking_reference}}\nPickup: {{pickup_date}} {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nPlease check your Driver Portal.',E'{{company_name}}\n\nNew job assigned.\n\nRef: {{booking_reference}}\nPickup: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nPlease check your Driver Portal.')
) as v(template_key,previous_body,next_body)
where t.template_key=v.template_key and t.body=v.previous_body;

-- Future companies receive the professional defaults without touching existing
-- customised rows when provisioning is run normally.
create or replace function public.sms_default_templates()
returns table(template_key text,name text,body text,marketing boolean)
language sql immutable set search_path='' as $$ values
 ('customer_confirmation','Customer booking confirmation',E'{{company_name}}\n\nBooking confirmed.\n\nRef: {{booking_reference}}\nDate: {{pickup_date}}\nTime: {{pickup_time}}\n\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nThank you for booking with us.',false),
 ('customer_pickup_reminder','Customer pickup reminder',E'{{company_name}}\n\nReminder: Your taxi is booked for {{pickup_date}} at {{pickup_time}}.\n\nPickup: {{pickup_address}}\n\nRef: {{booking_reference}}\n\nThank you.',false),
 ('driver_on_route','Driver on route',E'{{company_name}}\n\nYour driver {{driver_name}} is on the way.\n\n{{vehicle_details}}\n{{driver_contact_line}}\n\nThank you for booking with us.',false),
 ('driver_arrived','Driver arrived / outside',E'{{company_name}}\n\nYour driver {{driver_name}} has arrived at your pickup location.\n\nBooking: {{booking_reference}}\n\nPlease make your way to the vehicle when ready.',false),
 ('passenger_on_board','Passenger on board',E'{{company_name}}\n\nYour journey is now underway.\n\nRef: {{booking_reference}}',false),
 ('booking_completed','Booking completed',E'Thank you for travelling with {{company_name}}.\n\nYour journey {{booking_reference}} is complete.',false),
 ('booking_cancelled','Booking cancellation',E'{{company_name}}\n\nYour booking {{booking_reference}} for {{pickup_date}} at {{pickup_time}} has been cancelled.\n\nIf you believe this is incorrect, please contact our office.',false),
 ('driver_assignment','Driver job assignment',E'{{company_name}}\n\nNew job assigned.\n\nRef: {{booking_reference}}\nPickup: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nPlease check your Driver Portal.',false),
 ('driver_reminder','Driver journey reminder',E'{{company_name}} - Job reminder\n\nRef: {{booking_reference}}\nPickup: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\n\nPlease check your Driver Portal.',false),
 ('office_reminder','Office booking reminder',E'{{company_name}}\n\nBooking reminder:\n{{booking_reference}}\n\nPickup: {{pickup_date}} at {{pickup_time}}',false),
 ('office_unassigned','Office unassigned warning',E'{{company_name}}\n\nUnassigned booking:\n{{booking_reference}}\n\nPickup: {{pickup_date}} at {{pickup_time}}\n\nPlease allocate a driver.',false),
 ('driver_document_expiry','Driver document expiry',E'{{company_name}}\n\nReminder: {{document_label}} expires on {{expiry_date}}.\n\nPlease update your documents.',false),
 ('review_request','Customer review request',E'{{company_name}}\n\nThank you for travelling with us.\n\nWe would appreciate your feedback:\n\n{{google_review_link}}',true)
$$;

-- Render optional On Way fields server-side from this booking's assigned
-- vehicle. Driver contact requires both company policy and driver opt-in.
create or replace function public.sms_booking_variables(c uuid,bid uuid,did uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b public.bookings%rowtype; d public.drivers%rowtype; v public.vehicles%rowtype;
 co public.companies%rowtype; policy boolean:=false; vehicle_lines text[]:=array[]::text[];
 contact text:='';
begin
 select * into b from public.bookings where company_id=c and id=bid;
 if not found then return '{}'::jsonb; end if;
 select * into co from public.companies where id=c;
 select * into d from public.drivers where company_id=c and id=coalesce(did,b.driver_id);
 if b.vehicle_id is not null then select * into v from public.vehicles where company_id=c and id=b.vehicle_id; end if;
 if v.id is not null then
  if nullif(trim(concat_ws(' ',v.colour,v.make,v.model)),'') is not null then vehicle_lines:=array_append(vehicle_lines,'Vehicle: '||trim(concat_ws(' ',v.colour,v.make,v.model))); end if;
  if nullif(trim(v.registration),'') is not null then vehicle_lines:=array_append(vehicle_lines,'Registration: '||trim(v.registration)); end if;
 end if;
 select coalesce(driver_phone_sharing_allowed,false) into policy from public.settings where company_id=c;
 if policy and coalesce(d.customer_phone_sharing,false) then
  contact:=coalesce(public.sms_phone(nullif(d.public_contact_phone,'')),public.sms_phone(d.phone),'');
  if contact<>'' then contact:='Contact: '||contact; end if;
 end if;
 return jsonb_build_object('company_name',coalesce(co.trading_name,co.name),'booking_reference',b.booking_reference,
  'customer_name',b.customer_name,'pickup_date',to_char(b.journey_date,'DD/MM/YYYY'),'pickup_time',left(b.journey_time::text,5),
  'pickup_address',b.pickup_address,'destination_address',b.dropoff_address,'driver_name',coalesce(d.full_name,''),
  'vehicle_colour',coalesce(v.colour,''),'vehicle_make',coalesce(v.make,''),'vehicle_model',coalesce(v.model,''),
  'vehicle_registration',coalesce(v.registration,''),'vehicle_details',array_to_string(vehicle_lines,E'\n'),
  'driver_contact_line',contact);
end $$;
revoke all on function public.sms_booking_variables(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.sms_run_automations(c uuid) returns void language plpgsql security definer set search_path='' as $$
declare e record;r record;b jsonb;d jsonb;s public.sms_settings;co public.companies;phone text;body1 text;vars jsonb;v record;pref text;marketing1 boolean;due timestamptz;expiry timestamptz;doc_label text;doc_expiry date;tz text;begin
 if not (select live_sending_enabled from public.sms_release_control) then return;end if;
 select * into s from public.sms_settings where company_id=c;if not coalesce(s.enabled and s.sending_enabled,false) then return;end if;
 select * into co from public.companies where id=c;select coalesce(timezone,'Europe/London') into tz from public.settings where company_id=c;tz:=coalesce(tz,'Europe/London');
 insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id)
 select c,bk.id||':'||x.k||':'||bk.journey_date||':'||bk.journey_time,x.k,bk.id from public.bookings bk cross join(values('pickup_reminder_due',12),('driver_reminder_due',12),('office_reminder_due',24),('office_unassigned_48h',48),('office_unassigned_24h',24)) x(k,h)
 where bk.company_id=c and lower(coalesce(bk.status,'')) not in('completed','cancelled','canceled','no_show') and (x.k not like 'office_unassigned%' or bk.driver_id is null)
 and ((bk.journey_date+bk.journey_time) at time zone tz) between now()+make_interval(hours=>x.h)-interval '5 minutes' and now()+make_interval(hours=>x.h) on conflict do nothing;
 insert into public.sms_automation_events(company_id,event_key,trigger_key,driver_id)
 select c,'doc:'||dd.id||':'||dd.expiry_date,'driver_document_expiry',dd.driver_id from public.driver_documents dd where dd.company_id=c and dd.expiry_date=(now() at time zone tz)::date+7 and lower(coalesce(dd.status,''))='active' on conflict do nothing;
 insert into public.sms_automation_events(company_id,event_key,trigger_key,driver_id)
 select c,'licence:'||dr.id||':'||dr.licence_expiry,'driver_document_expiry',dr.id from public.drivers dr where dr.company_id=c and dr.licence_expiry=(now() at time zone tz)::date+7 on conflict do nothing;
 for e in select * from public.sms_automation_events where company_id=c and created_at>now()-interval '5 minutes' loop
  b:='{}';d:='{}';doc_label:=null;doc_expiry:=null;
  if e.booking_id is not null then select to_jsonb(bk) into b from public.bookings bk where bk.company_id=c and bk.id=e.booking_id;end if;
  select jsonb_build_object('id',dr.id,'full_name',dr.full_name,'phone',dr.phone,'licence_expiry',dr.licence_expiry) into d from public.drivers dr where dr.company_id=c and dr.id=coalesce(e.driver_id,nullif(b->>'driver_id','')::uuid);
  if e.event_key like 'doc:%' then select coalesce(dd.document_label,replace(initcap(dd.document_type),'_',' ')),dd.expiry_date into doc_label,doc_expiry from public.driver_documents dd where dd.company_id=c and dd.id=split_part(e.event_key,':',2)::uuid;end if;
  if e.event_key like 'licence:%' then doc_label:='Driving licence';doc_expiry:=nullif(d->>'licence_expiry','')::date;end if;
  if e.trigger_key not in('booking_completed','booking_cancelled') and lower(coalesce(b->>'status','')) in('completed','cancelled','canceled','no_show') then continue;end if;
  for r in select rr.*,t.body,t.marketing from public.sms_automation_rules rr join public.sms_templates t on t.id=rr.template_id and t.company_id=rr.company_id where rr.company_id=c and rr.enabled and t.enabled and rr.created_at<=e.created_at and (rr.trigger_key=e.trigger_key or (e.trigger_key='booking_completed' and rr.trigger_key='review_request')) loop
   pref:=case r.trigger_key when 'booking_created' then 'customer_booking_confirmation' when 'booking_confirmed' then 'customer_booking_confirmation' when 'driver_assigned' then 'driver_assignment' when 'pickup_reminder_due' then 'customer_reminder' when 'driver_reminder_due' then 'driver_booking_reminder_12h' when 'office_reminder_due' then 'office_booking_reminder_24h' when 'office_unassigned_48h' then 'unassigned_48h' when 'office_unassigned_24h' then 'unassigned_24h' when 'booking_cancelled' then 'cancellations' else r.trigger_key end;
   if not public.sms_channel(c,pref) then continue;end if;
   if pref='customer_booking_confirmation' and exists(select 1 from public.sms_messages sm where sm.company_id=c and sm.booking_id=e.booking_id and sm.preference_key=pref and sm.state not in('cancelled','expired','failed')) then continue;end if;
   if exists(select 1 from jsonb_each_text(r.conditions) cond where coalesce(b->>cond.key,'')<>cond.value) then continue;end if;
   phone:=public.sms_phone(case r.recipient_type when 'driver' then d->>'phone' when 'office' then s.office_phone else coalesce(b->>'customer_phone',b->>'phone') end);if phone is null then continue;end if;
   marketing1:=r.marketing or r.trigger_key='review_request';if r.trigger_key='review_request' and (r.recipient_type<>'customer' or nullif(s.google_review_link,'') is null) then continue;end if;
   vars:=jsonb_build_object('company_name',coalesce(co.trading_name,co.name),'booking_reference',b->>'booking_reference','customer_name',b->>'customer_name','pickup_date',case when b->>'journey_date' is null then '' else to_char((b->>'journey_date')::date,'DD/MM/YYYY') end,'pickup_time',left(b->>'journey_time',5),'pickup_address',b->>'pickup_address','destination_address',b->>'dropoff_address','driver_name',d->>'full_name','google_review_link',s.google_review_link,'document_label',doc_label,'expiry_date',case when doc_expiry is null then '' else to_char(doc_expiry,'DD/MM/YYYY') end);
   if e.booking_id is not null then vars:=vars||public.sms_booking_variables(c,e.booking_id,nullif(d->>'id','')::uuid); end if;
   body1:=r.body;for v in select * from jsonb_each_text(vars) loop body1:=replace(body1,'{{'||v.key||'}}',coalesce(v.value,''));end loop;if body1 like '%{{%' then continue;end if;
   body1:=regexp_replace(body1,E'\n[ \t]+\n',E'\n\n','g');body1:=regexp_replace(body1,E'\n{3,}',E'\n\n','g');body1:=trim(body1);
   if marketing1 then body1:=body1||E'\n\nReply STOP to opt out.';end if;
   due:=e.created_at+make_interval(mins=>r.delay_minutes);expiry:=due+interval '1 hour';if r.trigger_key in('driver_arrived','driver_on_route','passenger_on_board') then expiry:=least(expiry,e.created_at+interval '15 minutes');end if;
   perform public.sms_enqueue(c,phone,body1,'auto:'||e.id||':'||r.id,e.booking_id,nullif(d->>'id','')::uuid,r.id,due,expiry,marketing1,pref);
  end loop;
 end loop;
end $$;
revoke all on function public.sms_run_automations(uuid) from public,anon,authenticated;

-- One authoritative, locked cancellation boundary for one leg or an explicitly
-- selected linked pair. Financial values and relationships are never changed.
create or replace function public.cancel_booking_jobs(target_company_id uuid,target_booking_id uuid,cancel_scope text default 'single',reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; linked public.bookings%rowtype; ids uuid[]; changed uuid[]:=array[]::uuid[]; row1 public.bookings%rowtype;
begin
 if not public.release73_admin(target_company_id) then raise exception 'Admin company access required' using errcode='42501'; end if;
 if cancel_scope not in('single','both') then raise exception 'Cancellation scope must be single or both'; end if;
 select * into b from public.bookings where company_id=target_company_id and id=target_booking_id for update;
 if not found then raise exception 'Booking not found'; end if;
 select * into linked from public.bookings x where x.company_id=target_company_id and x.id<>b.id
  and regexp_replace(x.booking_reference,'-R$','')=regexp_replace(b.booking_reference,'-R$','') order by x.created_at limit 1 for update;
 ids:=case when cancel_scope='both' and linked.id is not null then array[b.id,linked.id] else array[b.id] end;
 for row1 in select * from public.bookings where company_id=target_company_id and id=any(ids) for update loop
  if lower(coalesce(row1.status,row1.booking_status,'')) not in('cancelled','canceled') then
   if lower(coalesce(row1.status,row1.booking_status,'')) in('completed','no_show') then raise exception 'Completed or no-show journeys cannot be cancelled'; end if;
   update public.bookings set status='cancelled',booking_status='cancelled',cancelled_at=now(),cancelled_by=auth.uid()::text,
    cancellation_reason=nullif(left(trim(coalesce(reason,'')),500),'') where company_id=target_company_id and id=row1.id;
   insert into public.admin_booking_audit(company_id,booking_id,booking_reference,admin_user_id,changed_fields,previous_values,new_values)
    values(target_company_id,row1.id,row1.booking_reference,auth.uid(),array['status','cancellation'],
     jsonb_build_object('status',coalesce(row1.status,row1.booking_status),'driver_id',row1.driver_id,'payment_status',row1.payment_status,'amount_paid',row1.amount_paid),
     jsonb_build_object('status','cancelled','reason',nullif(trim(coalesce(reason,'')),'')));
   changed:=array_append(changed,row1.id);
  end if;
 end loop;
 return jsonb_build_object('ok',true,'booking_ids',to_jsonb(ids),'changed_ids',to_jsonb(changed),'idempotent',cardinality(changed)=0,
  'linked_booking_id',linked.id,'scope',cancel_scope);
end $$;
revoke all on function public.cancel_booking_jobs(uuid,uuid,text,text) from public,anon;
grant execute on function public.cancel_booking_jobs(uuid,uuid,text,text) to authenticated;

-- Only an existing company Owner may grant/revoke this high-risk permission.
create or replace function public.set_booking_deletion_permission(target_company_id uuid,target_user_id uuid,allowed boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.company_users where company_id=target_company_id and user_id=auth.uid() and lower(role)='owner') then
  raise exception 'Company Owner access required' using errcode='42501';
 end if;
 update public.company_users set can_permanently_delete_bookings=coalesce(allowed,false)
 where company_id=target_company_id and user_id=target_user_id and lower(role) in('admin','owner');
 if not found then raise exception 'Eligible company Admin or Owner not found'; end if;
 return true;
end $$;
create or replace function public.booking_deletion_permission_members(target_company_id uuid)
returns table(user_id uuid,role text,allowed boolean) language sql stable security definer set search_path=public as $$
 select u.user_id,u.role,u.can_permanently_delete_bookings from public.company_users u
 where u.company_id=target_company_id and lower(u.role) in('admin','owner')
 and exists(select 1 from public.company_users me where me.company_id=target_company_id and me.user_id=auth.uid() and lower(me.role)='owner')
 order by lower(u.role) desc,u.user_id
$$;
revoke all on function public.set_booking_deletion_permission(uuid,uuid,boolean),public.booking_deletion_permission_members(uuid) from public,anon;
grant execute on function public.set_booking_deletion_permission(uuid,uuid,boolean),public.booking_deletion_permission_members(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
