-- Add the missing office recipient for the existing shared new-booking channel.
-- This does not alter any master sending gate, booking, payment, gateway device,
-- SIM selection or existing notification-channel choice.
begin;

-- Preserve the established professional catalogue and extend it for future
-- companies without duplicating its existing entries.
alter function public.sms_default_templates() rename to sms_default_templates_before_office_booking;
revoke all on function public.sms_default_templates_before_office_booking() from public,anon,authenticated;
create function public.sms_default_templates()
returns table(template_key text,name text,body text,marketing boolean)
language sql immutable set search_path='' as $$
 select * from public.sms_default_templates_before_office_booking()
 union all
 values ('office_new_booking','Office new booking',E'{{company_name}}\n\nNew booking received.\n\nRef: {{booking_reference}}\nCustomer: {{customer_name}}\nPickup: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}',false)
$$;

alter function public.sms_default_rules() rename to sms_default_rules_before_office_booking;
revoke all on function public.sms_default_rules_before_office_booking() from public,anon,authenticated;
create function public.sms_default_rules()
returns table(rule_name text,trigger_key text,recipient_type text,template_key text,delay_minutes integer)
language sql immutable set search_path='' as $$
 select * from public.sms_default_rules_before_office_booking()
 union all
 values ('Office new booking','booking_created','office','office_new_booking',0)
$$;

revoke all on function public.sms_default_templates(),public.sms_default_rules() from public,anon,authenticated;

-- Route booking-created rules through the recipient-specific shared channel.
-- The earlier catalogue runner mapped every booking-created rule to the
-- customer channel, which would make Email/SMS/Neither choices ambiguous once
-- the missing office rule exists.
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
   pref:=case r.trigger_key when 'booking_created' then case r.recipient_type when 'office' then 'office_new_booking' else 'customer_booking_confirmation' end when 'booking_confirmed' then 'customer_booking_confirmation' when 'driver_assigned' then 'driver_assignment' when 'pickup_reminder_due' then 'customer_reminder' when 'driver_reminder_due' then 'driver_booking_reminder_12h' when 'office_reminder_due' then 'office_booking_reminder_24h' when 'office_unassigned_48h' then 'unassigned_48h' when 'office_unassigned_24h' then 'unassigned_24h' when 'booking_cancelled' then 'cancellations' else r.trigger_key end;
   if not public.sms_channel(c,pref) then continue;end if;
   if pref='customer_booking_confirmation' and exists(select 1 from public.sms_messages sm where sm.company_id=c and sm.booking_id=e.booking_id and sm.preference_key=pref and sm.state not in('cancelled','expired','failed')) then continue;end if;
   if exists(select 1 from jsonb_each_text(r.conditions) cond where coalesce(b->>cond.key,'')<>cond.value) then continue;end if;
   phone:=public.sms_phone(case r.recipient_type when 'driver' then d->>'phone' when 'office' then s.office_phone else coalesce(b->>'customer_phone',b->>'phone') end);if phone is null then insert into public.sms_gateway_audit(company_id,action,details) values(c,'automation_recipient_invalid',jsonb_build_object('event_id',e.id,'rule_id',r.id,'recipient_type',r.recipient_type));continue;end if;
   marketing1:=r.marketing or r.trigger_key='review_request';if r.trigger_key='review_request' and (r.recipient_type<>'customer' or nullif(s.google_review_link,'') is null) then continue;end if;
   vars:=jsonb_build_object('company_name',coalesce(co.trading_name,co.name),'booking_reference',b->>'booking_reference','customer_name',b->>'customer_name','pickup_date',case when b->>'journey_date' is null then '' else to_char((b->>'journey_date')::date,'DD/MM/YYYY') end,'pickup_time',left(b->>'journey_time',5),'pickup_address',b->>'pickup_address','destination_address',b->>'dropoff_address','driver_name',d->>'full_name','google_review_link',s.google_review_link,'document_label',doc_label,'expiry_date',case when doc_expiry is null then '' else to_char(doc_expiry,'DD/MM/YYYY') end);
   if e.booking_id is not null then vars:=vars||public.sms_booking_variables(c,e.booking_id,nullif(d->>'id','')::uuid);end if;
   body1:=r.body;for v in select * from jsonb_each_text(vars) loop body1:=replace(body1,'{{'||v.key||'}}',coalesce(v.value,''));end loop;if body1 like '%{{%' then insert into public.sms_gateway_audit(company_id,action,details) values(c,'automation_template_unresolved',jsonb_build_object('event_id',e.id,'rule_id',r.id));continue;end if;
   body1:=regexp_replace(body1,E'\n[ \t]+\n',E'\n\n','g');body1:=regexp_replace(body1,E'\n{3,}',E'\n\n','g');body1:=trim(body1);
   if marketing1 then body1:=body1||E'\n\nReply STOP to opt out.';end if;
   due:=e.created_at+make_interval(mins=>r.delay_minutes);expiry:=due+interval '1 hour';if r.trigger_key in('driver_arrived','driver_on_route','passenger_on_board') then expiry:=least(expiry,e.created_at+interval '15 minutes');end if;
   perform public.sms_enqueue(c,phone,body1,'auto:'||e.id||':'||r.id,e.booking_id,nullif(d->>'id','')::uuid,r.id,due,expiry,marketing1,pref);
  end loop;
 end loop;
end $$;
revoke all on function public.sms_run_automations(uuid) from public,anon,authenticated;

-- Install the catalogue entry for existing tenants, operationally disabled.
insert into public.sms_templates(company_id,template_key,name,body,enabled,marketing)
select c.id,'office_new_booking','Office new booking',E'{{company_name}}\n\nNew booking received.\n\nRef: {{booking_reference}}\nCustomer: {{customer_name}}\nPickup: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}',false,false
from public.companies c
on conflict(company_id,template_key) do nothing;

insert into public.sms_automation_rules(company_id,name,trigger_key,recipient_type,conditions,delay_minutes,template_id,enabled,sending_start,sending_end)
select c.id,'Office new booking','booking_created','office','{}'::jsonb,0,t.id,false,'00:00','00:00'
from public.companies c
join public.sms_templates t on t.company_id=c.id and t.template_key='office_new_booking'
where not exists(
 select 1 from public.sms_automation_rules r
 where r.company_id=c.id and r.trigger_key='booking_created' and r.recipient_type='office' and r.conditions='{}'::jsonb
);

-- Honour company 0003's existing explicit Both/SMS selection. Other tenants
-- retain a disabled rule and therefore cannot start sending from this deploy.
update public.sms_templates t set enabled=true,updated_at=now()
from public.companies c,public.settings s
where t.company_id=c.id and s.company_id=c.id and c.company_code='0003'
 and t.template_key='office_new_booking'
 and coalesce(s.notification_channels->'office_new_booking' ? 'sms',false);

update public.sms_automation_rules r set enabled=true,updated_at=now()
from public.companies c,public.settings s
where r.company_id=c.id and s.company_id=c.id and c.company_code='0003'
 and r.trigger_key='booking_created' and r.recipient_type='office' and r.conditions='{}'::jsonb
 and coalesce(s.notification_channels->'office_new_booking' ? 'sms',false);

insert into public.sms_gateway_audit(company_id,action,details)
select c.id,'office_new_booking_rule_provisioned',jsonb_build_object('enabled',true,'channel','office_new_booking')
from public.companies c join public.settings s on s.company_id=c.id
where c.company_code='0003' and coalesce(s.notification_channels->'office_new_booking' ? 'sms',false);

notify pgrst,'reload schema';
commit;
