-- Release 8.3: additive account audit and invoice preference safeguards.
begin;
alter table public.account_customers alter column invoice_preferences set default '{"show_booking_reference":true,"show_journey_date":true,"show_route":true,"group_by":"booking","tax_display":"company_default"}'::jsonb;

create or replace function public.release83_audit_account() returns trigger language plpgsql security definer set search_path=public as $$
declare changed text[];
begin
 if tg_op='INSERT' then
  insert into account_activity(company_id,account_customer_id,actor_id,action,details) values(new.company_id,new.id,auth.uid(),'account.created',jsonb_build_object('account_code',new.account_code));return new;
 end if;
 select array_agg(key order by key) into changed from jsonb_each(to_jsonb(new)-array['updated_at','notes']) n(key,value) where value is distinct from (to_jsonb(old)-array['updated_at','notes'])->key;
 if changed is not null then insert into account_activity(company_id,account_customer_id,actor_id,action,details) values(new.company_id,new.id,auth.uid(),'account.updated',jsonb_build_object('changed_fields',changed));end if;
 return new;
end$$;
drop trigger if exists release83_audit_account on public.account_customers;
create trigger release83_audit_account after insert or update on public.account_customers for each row execute function public.release83_audit_account();

create or replace function public.release83_audit_contact() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into account_activity(company_id,account_customer_id,actor_id,action,details) values(new.company_id,new.account_customer_id,auth.uid(),case when tg_op='INSERT' then 'contact.created' else 'contact.updated' end,jsonb_build_object('contact_id',new.id,'name',new.name));return new;end$$;
drop trigger if exists release83_audit_contact on public.account_contacts;
create trigger release83_audit_contact after insert or update on public.account_contacts for each row execute function public.release83_audit_contact();
revoke all on function public.release83_audit_account(),public.release83_audit_contact() from public,anon,authenticated;
notify pgrst,'reload schema';commit;
