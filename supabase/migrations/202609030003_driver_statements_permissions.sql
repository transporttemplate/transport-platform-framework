-- Restore authenticated access to driver statements.
-- RLS remains responsible for limiting every row to the user's company.

grant select, insert, update, delete
on table public.driver_statements, public.driver_statement_items
to authenticated;

grant execute on function public.user_can_access_company(uuid) to authenticated;

alter table public.driver_statements enable row level security;
alter table public.driver_statement_items enable row level security;

do $$
declare
    target_table text;
begin
    foreach target_table in array array['driver_statements', 'driver_statement_items']
    loop
        if not exists (
            select 1
            from pg_policies
            where schemaname = 'public'
              and tablename = target_table
              and policyname = 'tenant_admin_all'
        ) then
            execute format(
                'create policy tenant_admin_all on public.%I for all to authenticated using (public.user_can_access_company(company_id)) with check (public.user_can_access_company(company_id))',
                target_table
            );
        end if;
    end loop;
end
$$;

notify pgrst, 'reload schema';
