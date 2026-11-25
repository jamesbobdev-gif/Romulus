-- "Delete my account" (Settings -> Device sync, renderer/js/hosted-sync.js) for someone who runs a group: the people
-- on their group were left with family_of pointing at an account that no longer exists, so they couldn't start a
-- group of their own or join another ('member'). Now they are let go first, the same way taking someone off a group
-- does (20261115_sync_group_plans.sql). Their invites already go with the account (on delete cascade).
-- Everything else is as in 20261106_sync_delete_account.sql.
-- Paste it all in the SQL editor and press Run (after 20261115_sync_group_plans.sql).

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
  update public.sync_accounts set family_of = null, family_since = null, family_key = null, family_key_next = null
    where family_of = a;
  -- the id is letters, digits, '-' and '_' only (checked above), so it is safe inside the pattern as it is
  delete from public.tasks_sync where sync_key ~ ('^tk_(work_|agent_|school_)?' || id || '(:.*)?$');
  get diagnostics n = row_count;
  delete from public.sync_accounts where account = a;
  return query select n, sub;
end $$;

revoke all on function public.sync_delete_account(text) from public;
revoke execute on function public.sync_delete_account(text) from anon, authenticated;
grant execute on function public.sync_delete_account(text) to service_role;
