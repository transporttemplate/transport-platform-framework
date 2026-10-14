import {readFileSync} from "node:fs";import {execFileSync} from "node:child_process";
const token=execFileSync("security",["find-generic-password","-s","Supabase CLI","-w"],{encoding:"utf8"}).trim();
const migration=readFileSync("supabase/migrations/202610140002_release73_messaging_driver_permission_fix.sql","utf8");
const query=migration.replace(/notify pgrst,'reload schema';\s*commit;\s*$/,"" )+`
do $$ begin
 if not has_table_privilege('service_role','public.driver_messages','SELECT,INSERT,UPDATE,DELETE') then raise exception 'message service grants missing'; end if;
 if has_column_privilege('authenticated','public.drivers','licence_authority','SELECT') then raise exception 'new driver field exposed directly'; end if;
 if (select count(*) from public.drivers d join public.companies c on c.id=d.company_id where c.company_code='0003')<>3 then raise exception 'company 0003 driver count changed'; end if;
 if not (select d.driver_expenses_enabled from public.drivers d join public.companies c on c.id=d.company_id where c.company_code='0003' and d.driver_number='301' and lower(d.full_name)='jeff bailey') then raise exception 'Jeff Expenses permission changed'; end if;
end $$;
select 'release 7.3 regression migration rollback passed; no production data changed' result;
rollback;`;
const response=await fetch("https://api.supabase.com/v1/projects/fewbszrvmvjiojijogra/database/query",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({query})});const body=await response.text();if(!response.ok)throw Error(body);console.log(body);
