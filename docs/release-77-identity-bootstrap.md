# Release 7.7 identity bootstrap

No browser route or public endpoint can create the first Platform Super Admin or assign a missing company Owner.

Before either operation, an authorised operator must verify the already authenticated account using evidence independent of its email address, display name, company code, URL, or browser session. Record who verified it, the verification method, and a controlled evidence reference. Do not put identity documents or secrets in Git.

After verification, an operator with production service-role access runs exactly one reviewed call to:

- `bootstrap_platform_super_admin(target_user_id, evidence)` with confirmation `GRANT PLATFORM SUPER ADMIN`; or
- `assign_verified_company_owner(target_company_id, target_user_id, evidence)` with confirmation `ASSIGN VERIFIED COMPANY OWNER`.

Both functions reject browser/authenticated callers, validate the existing Auth user or membership, and write an immutable audit row. The first bootstrap additionally requires that the target is already an active, verified company Owner. Refresh the user's Supabase session after a platform-role assignment so the new signed JWT contains the explicit role.

For Jeff and Matt, the required one-time step is an out-of-band identity and company-authority check tied to the exact existing Supabase Auth user ID. Their business email address alone is not sufficient evidence.
