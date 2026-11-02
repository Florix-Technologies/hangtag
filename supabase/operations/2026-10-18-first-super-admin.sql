-- WRITES (one row). Run only with the owner's approval of this exact operation (2026-10-18), and only if
-- supabase/checks/2026-10-18-console-access.sql shows no active super admin.
-- Makes one account the console's first super admin: one row in hangtag_platform_staff (that account, super_admin,
-- active). No shop, trial, plan or other account changes; nothing runs when the row is added. It inserts only while no
-- active super admin exists and only for an existing account, so a second run, a mistyped ID or a later run (when staff
-- are added in the console, Settings → Staff) changes nothing. There is no public sign-up for the console.
-- Fill in the account ID that /platform/ shows on its "No access" page. One row back: granted. No rows: nothing changed.
-- Undo: UPDATE public.hangtag_platform_staff SET active = false WHERE user_id = '<account ID>';
INSERT INTO public.hangtag_platform_staff (user_id, role)
SELECT u.id, 'super_admin' FROM auth.users u
 WHERE u.id = '<account ID>'::uuid
   AND NOT EXISTS (SELECT 1 FROM public.hangtag_platform_staff s WHERE s.role = 'super_admin' AND s.active)
ON CONFLICT (user_id) DO NOTHING
RETURNING user_id, role, active, created_at;
