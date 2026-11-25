-- Two fixes for the Romulus server now that strangers sync on it too:
--   * the owner's lists keep saving when the server is full. Before this, once strangers filled the database to
--     max_total_bytes, sync_guard refused growth for every account, the owner's included. Accounts marked owner
--     skip the server_full check (their own quota still applies). New accounts and everyone else are unchanged.
--   * the four tables the paid-plan perks added (family invites and shares, history, supporters) had the anon and
--     authenticated grants every older table has revoked. Row-level security with no policies already blocked them;
--     this matches the rest so a policy added by mistake later can't open them.
-- Paste it all in the SQL editor and press Run, after 20261109_task_files.sql.
-- After "Rotate sync key" the new key is a new account: mark it with the update at the bottom (by its first
-- characters from sync_accounts.account), or it won't be exempt.

alter table public.sync_accounts add column if not exists owner boolean not null default false;

-- the owner's accounts are the ones from before the server was opened to everyone (the account-limits backfill)
update public.sync_accounts set owner = true where created_at < '2026-10-31' and not owner;

create or replace function public.sync_guard(p_sync_key text, p_doc jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  s public.sync_settings;
  a text := public.sync_account_of(p_sync_key);
  acc public.sync_accounts;
  ip text;
  old_size bigint;
  new_size bigint := public.sync_doc_size(p_doc);
  cnt int;
  why text;
begin
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = a for update;
  if not found then
    -- someone new: refused accounts leave no row behind, so a flood of them costs nothing to keep
    if length(regexp_replace(p_sync_key, '^tk_(work_|agent_|school_)?([^:]+)(:.*)?$', '\2')) < 32 then return 'weak_key'; end if;
    if pg_database_size(current_database()) > public.sync_server_cap(s) then return 'server_full'; end if;
    ip := public.sync_caller_ip_hash();
    if ip is not null then
      delete from public.sync_new_accounts where hour < now() - interval '1 day';
      insert into public.sync_new_accounts as x (ip_hash, hour, n) values (ip, date_trunc('hour', now()), 1)
        on conflict (ip_hash, hour) do update set n = x.n + 1
        returning x.n into cnt;
      if cnt > s.new_accounts_per_ip_hour then return 'new_accounts'; end if;
    end if;
    insert into public.sync_accounts (account) values (a) on conflict (account) do nothing;
    select * into acc from public.sync_accounts where account = a for update;
  end if;

  update public.sync_accounts set
      writes_in_window = case when window_start > now() - interval '1 minute' then writes_in_window + 1 else 1 end,
      window_start     = case when window_start > now() - interval '1 minute' then window_start else now() end
    where account = a
    returning writes_in_window into cnt;
  if cnt > s.writes_per_minute then
    why := 'rate';
  else
    select public.sync_doc_size(doc) into old_size from public.tasks_sync where sync_key = p_sync_key;
    if new_size > coalesce(old_size, 0) then -- only growth is checked: a smaller list always saves
      if acc.used_bytes + public.sync_files_bytes(a) - coalesce(old_size, 0) + new_size > public.sync_quota_of(acc, s) then
        why := 'full';
      elsif not acc.owner and pg_database_size(current_database()) > public.sync_server_cap(s) then
        why := 'server_full'; -- the owner's lists keep saving while strangers have filled the server
      end if;
    end if;
  end if;
  if why is not null then
    update public.sync_accounts set refused = why, refused_at = now() where account = a;
  end if;
  return why;
end $$;
revoke all on function public.sync_guard(text, jsonb) from public, anon, authenticated;

revoke all on table public.sync_family_invites, public.sync_family_shares, public.sync_history, public.sync_supporters
  from anon, authenticated;

-- to mark a rotated key's account as yours, put its first characters here and run just this line:
-- update public.sync_accounts set owner = true where account like 'abcdef1234%';
