-- Release 8.0.5: explicit External Dispatch receiver mapping and controlled activation.
begin;

alter table public.external_integrations
 add column if not exists receiver_api_integration_id uuid references public.api_integrations(id);

update public.external_integrations e
set receiver_api_integration_id=i.id,updated_at=now()
from public.companies sender,public.companies receiver,public.api_integrations i
where e.company_id=sender.id and sender.company_code='0001'
 and lower(e.name)=lower('matts external dispatch test')
 and i.company_id=receiver.id and receiver.company_code='0002'
 and i.partner_company_id=sender.id and i.integration_type='external_dispatch'
 and e.receiver_api_integration_id is null;

create or replace function public.activate_external_dispatch_connection(
 target_connection_id uuid,target_actor uuid,expected_sender_code text,
 expected_receiver_code text,expected_connection_name text,explicit_confirmation text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.external_integrations%rowtype;i public.api_integrations%rowtype;sender_code text;receiver_code text;active_credentials integer;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 select * into e from external_integrations where id=target_connection_id for update;
 if not found then raise exception 'External connection not found';end if;
 select company_code into sender_code from companies where id=e.company_id;
 select * into i from api_integrations where id=e.receiver_api_integration_id for update;
 if not found then raise exception 'Receiving API mapping is missing';end if;
 select company_code into receiver_code from companies where id=i.company_id;
 if sender_code<>expected_sender_code or receiver_code<>expected_receiver_code or lower(e.name)<>lower(trim(expected_connection_name)) then raise exception 'Connection identity confirmation failed';end if;
 if explicit_confirmation<>format('ACTIVATE %s TO %s - %s',sender_code,receiver_code,e.name) then raise exception 'Exact activation confirmation is required';end if;
 if sender_code<>'0001' or receiver_code<>'0002' then raise exception 'Only the approved 0001 to 0002 controlled test may be activated';end if;
 if i.partner_company_id<>e.company_id or i.integration_type<>'external_dispatch' then raise exception 'Receiving API company mapping is invalid';end if;
 if not coalesce((select approved from job_exchange_company_approvals where company_id=e.company_id),false)
  or not coalesce((select approved from job_exchange_company_approvals where company_id=i.company_id),false) then raise exception 'Both companies must independently approve the pilot';end if;
 if e.revoked_at is not null or e.auth_method<>'hmac' or e.provider<>'custom' then raise exception 'Connection is revoked or is not an HMAC External API connection';end if;
 if e.last_test_succeeded is distinct from true or e.readiness<>'connection_test_passed' or e.last_tested_at<now()-interval '7 days' then raise exception 'A successful authentication test within seven days is required';end if;
 if not ('dispatch.offers:write'=any(i.scopes) and 'dispatch.offers:read'=any(i.scopes) and 'dispatch.tracking:read'=any(i.scopes)) then raise exception 'Required dispatch scopes are missing';end if;
 select count(*) into active_credentials from api_credentials k where k.integration_id=i.id and k.company_id=i.company_id and k.status='active' and k.credential_mode='hmac' and k.revoked_at is null and (k.expires_at is null or k.expires_at>now());
 if active_credentials<>1 then raise exception 'Exactly one active HMAC credential is required';end if;
 update api_integrations set status='active',updated_at=now() where id=i.id and status='disabled' and revoked_at is null;
 if not found and i.status<>'active' then raise exception 'Receiving API is revoked or cannot be activated';end if;
 update external_integrations set enabled=true,readiness='active',updated_at=now() where id=e.id;
 insert into integration_activity(company_id,integration_id,integration_kind,direction,operation,result,error_message)
 values(e.company_id,e.id,'external','internal','controlled_external_dispatch_activation','success',format('%s to %s activated by authorised Super Admin',sender_code,receiver_code));
 return jsonb_build_object('ok',true,'connection_id',e.id,'sender_company_code',sender_code,'receiver_company_code',receiver_code,'connection_name',e.name,'enabled',true);
end$$;

revoke all on function public.activate_external_dispatch_connection(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.activate_external_dispatch_connection(uuid,uuid,text,text,text,text) to service_role;

commit;
notify pgrst,'reload schema';
