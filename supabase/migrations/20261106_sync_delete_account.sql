-- "Delete my synced data" (Settings → Device sync, renderer/js/hosted-sync.js): everything one account keeps on
-- this project goes, for the stores' data-deletion rules (Google Play, Apple). An account is the id part of a sync
-- key, so tk_<id>, tk_work_/tk_agent_/tk_school_<id> and every side row of those are one account. The app calls
-- this through the sync-delete edge function (service role only), which also removes the account's photos and
-- files from storage (plain SQL can't delete storage objects) and cancels a paid plan at Stripe.
-- Returns the Stripe subscription the account had, so the function can cancel it, and how many rows went.
-- Paste it all in the SQL editor and press Run (after 20261106_sync_paid_plan.sql).

create or replace function public.sync_delete_account(p_sync_key text)
returns table(rows_deleted bigint, stripe_subscription text)
language plpgsql security definer
set search_path = public
as $$
declare
  id text;
  a text;
  sub text;
  n bigint;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:[a-z-]+)?$' then return; end if;
  id := regexp_replace(p_sync_key, '^tk_(work_|agent_|school_)?([^:]+)(:.*)?$', '\2');
  a := public.sync_account_of(p_sync_key);
  select x.stripe_subscription into sub from public.sync_accounts x where x.account = a;
  -- the id is letters, digits, '-' and '_' only (checked above), so it is safe inside the pattern as it is
  delete from public.tasks_sync where sync_key ~ ('^tk_(work_|agent_|school_)?' || id || '(:.*)?$');
  get diagnostics n = row_count;
  delete from public.sync_accounts where account = a;
  return query select n, sub;
end $$;

revoke all on function public.sync_delete_account(text) from public;
revoke execute on function public.sync_delete_account(text) from anon, authenticated;
grant execute on function public.sync_delete_account(text) to service_role;
