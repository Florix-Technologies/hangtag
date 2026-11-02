-- WRITES (DDL: one function). Run only with the owner's approval of this exact operation (2026-10-18).
-- Why: the live project runs the older console permissions function (3w; AUDIT.md 78), so the console refuses Suspend,
-- Restore and End all sign-ins for every role. This puts back the current definition from supabase/schema.sql, byte for
-- byte — the one the repair would put back — and nothing else. The function maps a role to its permission list: it reads
-- no table and changes no row. Added: customers.suspend and customers.sessions for super_admin and admin,
-- customers.sessions for support_admin; nothing removed. CREATE OR REPLACE keeps its owner and grants.
-- Before (read-only, false today):  SELECT public.hangtag_platform_permissions('super_admin') @> ARRAY['customers.suspend'];
-- Undo: 2026-10-18-console-permissions-undo.sql (the body the live project has now).
-- Afterwards supabase/checks/2026-10-13-function-versions.sql shows this function ok (17 older versions, not 18), and
-- supabase/checks/2026-10-13-repair-undo.sql would put the older body back too (run this again after such an undo).
-- Run it whole: the last row says whether it took (both columns true).
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions(p_role TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_role
        WHEN 'super_admin' THEN ARRAY['dashboard.view', 'customers.view', 'customers.suspend', 'customers.sessions', 'subscriptions.view', 'subscriptions.manage',
            'payments.view', 'promotions.view', 'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view', 'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view',
            'settings.manage', 'staff.manage']
        WHEN 'admin' THEN ARRAY['dashboard.view', 'customers.view', 'customers.suspend', 'customers.sessions', 'subscriptions.view', 'subscriptions.manage',
            'payments.view', 'promotions.view', 'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view', 'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'staff.manage']
        WHEN 'billing_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'incentives.view', 'reports.view']
        WHEN 'support_admin' THEN ARRAY['dashboard.view', 'customers.view', 'customers.sessions', 'subscriptions.view', 'payments.view', 'communications.view',
            'health.view', 'inventory.view', 'diagnostics.view']
        WHEN 'read_only' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'promotions.view', 'health.view',
            'growth.view', 'reports.view']
        ELSE ARRAY[]::TEXT[] END;
$$;
COMMIT;
SELECT public.hangtag_platform_permissions('super_admin') @> ARRAY['customers.suspend', 'customers.sessions'] AS suspend_and_sign_out_allowed,
       md5(replace(p.prosrc, chr(13), '')) = 'e42da56343a38176477dc90914e0a977' AS same_as_schema_sql
  FROM pg_proc p WHERE p.oid = 'public.hangtag_platform_permissions(text)'::regprocedure;
