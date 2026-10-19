-- Release 8.4: realtime visibility and query indexes. No backup/export schedule is activated.
begin;
create index if not exists bookings_company_updated_realtime_idx on public.bookings(company_id,updated_at desc);
create index if not exists drivers_company_location_realtime_idx on public.drivers(company_id,location_updated_at desc);
create index if not exists external_offers_receiver_updated_idx on public.external_dispatch_offers(receiving_company_id,updated_at desc);
do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='bookings') then alter publication supabase_realtime add table public.bookings;end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='drivers') then alter publication supabase_realtime add table public.drivers;end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='external_dispatch_offers') then alter publication supabase_realtime add table public.external_dispatch_offers;end if;
end$$;
notify pgrst,'reload schema';commit;
