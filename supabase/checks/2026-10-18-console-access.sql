-- Read-only (2026-10-18). Before the first console super admin: is there one already, and is this account known, on the
-- team, and the one /platform/ refused? One row. Fill in the account ID from the console's "No access" page.
--   your_email empty: that ID isn't an account on this project — stop.
--   your_last_no_access empty: the console never saw this ID — check it.
--   your_console_role 'super_admin (active)': nothing to do; sign out and in at /platform/.
--   active_super_admins 1 or more (not you): no SQL — that super admin adds you in the console (Settings → Staff).
--   active_super_admins 0: supabase/operations/2026-10-18-first-super-admin.sql (approval).
WITH me AS (SELECT '<account ID>'::uuid AS id)
SELECT (SELECT count(*) FROM public.hangtag_platform_staff WHERE role = 'super_admin' AND active) AS active_super_admins,
       (SELECT count(*) FROM public.hangtag_platform_staff) AS staff_rows,
       (SELECT u.email FROM auth.users u, me WHERE u.id = me.id) AS your_email,
       (SELECT s.role || CASE WHEN s.active THEN ' (active)' ELSE ' (switched off)' END FROM public.hangtag_platform_staff s, me WHERE s.user_id = me.id) AS your_console_role,
       (SELECT max(a.t) FROM public.hangtag_platform_audit a, me WHERE a.action = 'console.denied' AND a.actor = me.id) AS your_last_no_access;
