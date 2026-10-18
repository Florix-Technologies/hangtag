-- WRITES (DDL: one function). The undo of 2026-10-18-console-permissions.sql: puts back the console permissions function
-- the live project had on 2026-10-18 (3w, from supabase/migrations/20261009120000_hangtag_plans_autopay_platform.sql),
-- byte for byte. Suspend, Restore and End all sign-ins are then refused again for every role. Reads and changes no row.
-- Run it whole: the last row says whether it took (both columns true).
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions(p_role TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_role
        WHEN 'super_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view', 'inventory.view', 'diagnostics.view',
            'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'settings.manage', 'staff.manage']
        WHEN 'admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'communications.view', 'health.view', 'inventory.view', 'diagnostics.view',
            'growth.view', 'employees.view', 'incentives.view', 'reports.view', 'audit.view', 'settings.view', 'staff.manage']
        WHEN 'billing_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'promotions.view',
            'promotions.manage', 'plans.manage', 'referrals.view', 'wallet.view', 'incentives.view', 'reports.view']
        WHEN 'support_admin' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'communications.view', 'health.view',
            'inventory.view', 'diagnostics.view']
        WHEN 'read_only' THEN ARRAY['dashboard.view', 'customers.view', 'subscriptions.view', 'payments.view', 'promotions.view', 'health.view',
            'growth.view', 'reports.view']
        ELSE ARRAY[]::TEXT[] END;
$$;
COMMIT;
SELECT NOT (public.hangtag_platform_permissions('super_admin') @> ARRAY['customers.suspend']) AS suspend_refused_again,
       md5(replace(p.prosrc, chr(13), '')) = '7342300eb255b846420b71ef43d64e36' AS same_as_before
  FROM pg_proc p WHERE p.oid = 'public.hangtag_platform_permissions(text)'::regprocedure;
