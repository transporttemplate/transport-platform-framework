import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const token=execFileSync('security',['find-generic-password','-s','Supabase CLI','-w'],{encoding:'utf8'}).trim();
const migration=readFileSync('supabase/migrations/202610130001_release61_sms_automation_catalogue.sql','utf8');
if(!/commit;\s*$/.test(migration))throw Error('Missing transaction guard');
const query=migration.replace(/notify pgrst,'reload schema';\s*commit;\s*$/,'')+readFileSync('tests/release61-sms-security.sql','utf8')+'\nrollback;';
const r=await fetch('https://api.supabase.com/v1/projects/fewbszrvmvjiojijogra/database/query',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query})});
const body=await r.text();if(!r.ok)throw Error(`Rollback test failed ${r.status}: ${body}`);console.log(body);
