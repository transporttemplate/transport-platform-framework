-- Public company logos. Objects are stored beneath a company-id folder.
-- Browser uploads are restricted to authenticated users belonging to that company.

alter table public.settings
    add column if not exists companylogo text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'company-logos',
    'company-logos',
    true,
    5242880,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = 'Public can view company logos'
    ) then
        create policy "Public can view company logos"
        on storage.objects for select
        using (bucket_id = 'company-logos');
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = 'Company users can upload company logos'
    ) then
        create policy "Company users can upload company logos"
        on storage.objects for insert to authenticated
        with check (
            bucket_id = 'company-logos'
            and exists (
                select 1
                from public.company_users cu
                where cu.user_id = auth.uid()
                  and cu.company_id::text = (storage.foldername(storage.objects.name))[1]
            )
        );
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = 'Company users can update company logos'
    ) then
        create policy "Company users can update company logos"
        on storage.objects for update to authenticated
        using (
            bucket_id = 'company-logos'
            and exists (
                select 1
                from public.company_users cu
                where cu.user_id = auth.uid()
                  and cu.company_id::text = (storage.foldername(storage.objects.name))[1]
            )
        )
        with check (
            bucket_id = 'company-logos'
            and exists (
                select 1
                from public.company_users cu
                where cu.user_id = auth.uid()
                  and cu.company_id::text = (storage.foldername(storage.objects.name))[1]
            )
        );
    end if;

    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = 'Company users can delete company logos'
    ) then
        create policy "Company users can delete company logos"
        on storage.objects for delete to authenticated
        using (
            bucket_id = 'company-logos'
            and exists (
                select 1
                from public.company_users cu
                where cu.user_id = auth.uid()
                  and cu.company_id::text = (storage.foldername(storage.objects.name))[1]
            )
        );
    end if;
end
$$;
