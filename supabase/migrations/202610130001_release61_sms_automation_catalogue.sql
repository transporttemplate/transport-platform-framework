-- Release 6.1: complete company-scoped SMS automation catalogue.
begin;

-- Conditions distinguish intentionally specialised rules while preventing an
-- accidental duplicate for the same company, event and recipient.
create unique index sms_automation_rules_event_recipient_conditions_unique
on public.sms_automation_rules(company_id,trigger_key,recipient_type,md5(conditions::text));

create or replace function public.sms_default_templates()
returns table(template_key text,name text,body text,marketing boolean)
language sql immutable set search_path='' as $$ values
 ('customer_confirmation','Customer booking confirmation',E'{{company_name}}\n\nBooking confirmed\nRef: {{booking_reference}}\nDate: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nThank you for booking with us.',false),
 ('customer_pickup_reminder','Customer pickup reminder',E'{{company_name}} reminder\n\nYour journey is scheduled for {{pickup_date}} at {{pickup_time}}.\n\nPickup: {{pickup_address}}\n\nRef: {{booking_reference}}',false),
 ('driver_on_route','Driver on route',E'{{company_name}}\n\nYour driver is on the way.\n\nPickup: {{pickup_address}}\nRef: {{booking_reference}}',false),
 ('driver_arrived','Driver arrived / outside',E'{{company_name}}\n\nYour driver has arrived and is waiting outside at {{pickup_address}}.\n\nRef: {{booking_reference}}',false),
 ('passenger_on_board','Passenger on board',E'{{company_name}}\n\nYour journey is now underway.\n\nRef: {{booking_reference}}',false),
 ('booking_completed','Booking completed',E'Thank you for travelling with {{company_name}}.\n\nYour journey {{booking_reference}} is complete.',false),
 ('booking_cancelled','Booking cancellation',E'{{company_name}}\n\nYour booking {{booking_reference}} for {{pickup_date}} at {{pickup_time}} has been cancelled.\n\nPlease contact our office if this is unexpected.',false),
 ('driver_assignment','Driver job assignment',E'{{company_name}} - New job\n\nRef: {{booking_reference}}\nPickup: {{pickup_date}} {{pickup_time}}\nFrom: {{pickup_address}}\nTo: {{destination_address}}\n\nPlease check your Driver Portal.',false),
 ('driver_reminder','Driver journey reminder',E'{{company_name}} - Job reminder\n\nRef: {{booking_reference}}\nPickup: {{pickup_date}} at {{pickup_time}}\nFrom: {{pickup_address}}\n\nPlease check your Driver Portal.',false),
 ('office_reminder','Office booking reminder',E'{{company_name}}\n\nBooking reminder:\n{{booking_reference}}\n\nPickup: {{pickup_date}} at {{pickup_time}}',false),
 ('office_unassigned','Office unassigned warning',E'{{company_name}}\n\nUnassigned booking:\n{{booking_reference}}\n\nPickup: {{pickup_date}} at {{pickup_time}}\n\nPlease allocate a driver.',false),
 ('driver_document_expiry','Driver document expiry',E'{{company_name}}\n\nReminder: {{document_label}} expires on {{expiry_date}}.\n\nPlease update your documents.',false),
 ('review_request','Customer review request',E'Thank you for travelling with {{company_name}}.\n\nWe would appreciate your feedback:\n{{google_review_link}}',true)
$$;

create or replace function public.sms_default_rules()
returns table(rule_name text,trigger_key text,recipient_type text,template_key text,delay_minutes integer)
language sql immutable set search_path='' as $$ values
 ('Customer booking created','booking_created','customer','customer_confirmation',0),
 ('Customer booking confirmed','booking_confirmed','customer','customer_confirmation',0),
 ('Customer driver on route','driver_on_route','customer','driver_on_route',0),
 ('Customer driver arrived','driver_arrived','customer','driver_arrived',0),
 ('Customer passenger on board','passenger_on_board','customer','passenger_on_board',0),
 ('Customer booking completed','booking_completed','customer','booking_completed',0),
 ('Customer booking cancelled','booking_cancelled','customer','booking_cancelled',0),
 ('Customer pickup reminder','pickup_reminder_due','customer','customer_pickup_reminder',0),
 ('Customer review request','review_request','customer','review_request',0),
 ('Driver job assignment','driver_assigned','driver','driver_assignment',0),
 ('Driver journey reminder','driver_reminder_due','driver','driver_reminder',0),
 ('Driver document expiry','driver_document_expiry','driver','driver_document_expiry',0),
 ('Office booking reminder','office_reminder_due','office','office_reminder',0),
 ('Office unassigned 48 hour warning','office_unassigned_48h','office','office_unassigned',0),
 ('Office unassigned 24 hour warning','office_unassigned_24h','office','office_unassigned',0)
$$;

create or replace function public.sms_default_channels(existing jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select coalesce(existing,'{}'::jsonb)||jsonb_build_object(
  -- These categories already have transactional email support. Both preserves
  -- that channel; the existing email master/event switches still govern it.
  'customer_booking_confirmation','["email","sms"]'::jsonb,
  'driver_assignment','["email","sms"]'::jsonb,'cancellations','["email","sms"]'::jsonb,
  'driver_booking_reminder_12h','["email","sms"]'::jsonb,'office_booking_reminder_24h','["email","sms"]'::jsonb,
  'unassigned_48h','["email","sms"]'::jsonb,'unassigned_24h','["email","sms"]'::jsonb,
  'driver_document_expiry','["email","sms"]'::jsonb,
  'driver_on_route','["sms"]'::jsonb,'driver_arrived','["sms"]'::jsonb,'passenger_on_board','["sms"]'::jsonb,
  'booking_completed','["sms"]'::jsonb,'customer_reminder','["sms"]'::jsonb,'review_request','["sms"]'::jsonb
 )
$$;

create or replace function public.sms_provision_company(c uuid,refresh_catalogue boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.sms_settings(company_id,enabled,sending_enabled) values(c,false,false) on conflict(company_id) do nothing;
 insert into public.sms_templates(company_id,template_key,name,body,enabled,marketing)
 select c,t.template_key,t.name,t.body,true,t.marketing from public.sms_default_templates() t
 on conflict(company_id,template_key) do update set
  name=case when refresh_catalogue then excluded.name else sms_templates.name end,
  body=case when refresh_catalogue then excluded.body else sms_templates.body end,
  enabled=case when refresh_catalogue then true else sms_templates.enabled end,
  marketing=case when excluded.template_key='review_request' then true when refresh_catalogue then excluded.marketing else sms_templates.marketing end,
  updated_at=case when refresh_catalogue then now() else sms_templates.updated_at end;
 insert into public.sms_automation_rules(company_id,name,trigger_key,recipient_type,conditions,delay_minutes,template_id,enabled,sending_start,sending_end)
 select c,r.rule_name,r.trigger_key,r.recipient_type,'{}'::jsonb,r.delay_minutes,t.id,true,'00:00','00:00'
 from public.sms_default_rules() r join public.sms_templates t on t.company_id=c and t.template_key=r.template_key
 on conflict(company_id,trigger_key,recipient_type,md5(conditions::text)) do update set
  name=excluded.name,template_id=excluded.template_id,delay_minutes=excluded.delay_minutes,enabled=true,updated_at=now();
 update public.settings set notification_channels=public.sms_default_channels(notification_channels) where company_id=c;
end $$;

create or replace function public.sms_provision_company_trigger()
returns trigger language plpgsql security definer set search_path='' as $$begin perform public.sms_provision_company(new.id,false);return new;end$$;
drop trigger if exists provision_company_sms_catalogue_after_insert on public.companies;
create trigger provision_company_sms_catalogue_after_insert after insert on public.companies for each row execute function public.sms_provision_company_trigger();

create or replace function public.sms_provision_settings_trigger()
returns trigger language plpgsql security definer set search_path='' as $$begin
 new.notification_channels:=public.sms_default_channels(new.notification_channels);return new;
end$$;
drop trigger if exists provision_company_sms_channels_before_insert on public.settings;
create trigger provision_company_sms_channels_before_insert before insert on public.settings for each row execute function public.sms_provision_settings_trigger();

-- The approved catalogue refresh applies only to these four companies. It does
-- not touch sending_enabled, PINs, paired devices, messages or other settings.
do $$declare x record;begin
 for x in select id from public.companies where company_code in('0001','0002','0003','0004') loop perform public.sms_provision_company(x.id,true);end loop;
end$$;

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
   vars:=jsonb_build_object('company_name',coalesce(co.trading_name,co.name),'booking_reference',b->>'booking_reference','customer_name',b->>'customer_name','pickup_date',case when b->>'journey_date' is null then '' else to_char((b->>'journey_date')::date,'DD/MM/YYYY') end,'pickup_time',left(b->>'journey_time',5),'pickup_address',b->>'pickup_address','destination_address',b->>'dropoff_address','driver_name',d->>'full_name','driver_phone',d->>'phone','google_review_link',s.google_review_link,'document_label',doc_label,'expiry_date',case when doc_expiry is null then '' else to_char(doc_expiry,'DD/MM/YYYY') end);
   body1:=r.body;for v in select * from jsonb_each_text(vars) loop body1:=replace(body1,'{{'||v.key||'}}',coalesce(v.value,''));end loop;if body1 like '%{{%' then continue;end if;
   if marketing1 then body1:=body1||E'\n\nReply STOP to opt out.';end if;
   due:=e.created_at+make_interval(mins=>r.delay_minutes);expiry:=due+interval '1 hour';if r.trigger_key in('driver_arrived','driver_on_route','passenger_on_board') then expiry:=least(expiry,e.created_at+interval '15 minutes');end if;
   perform public.sms_enqueue(c,phone,body1,'auto:'||e.id||':'||r.id,e.booking_id,nullif(d->>'id','')::uuid,r.id,due,expiry,marketing1,pref);
  end loop;
 end loop;
end $$;

revoke all on function public.sms_default_templates(),public.sms_default_rules(),public.sms_default_channels(jsonb),public.sms_provision_company(uuid,boolean),public.sms_provision_company_trigger(),public.sms_provision_settings_trigger(),public.sms_run_automations(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
