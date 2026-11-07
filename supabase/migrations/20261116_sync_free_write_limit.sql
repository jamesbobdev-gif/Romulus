-- A lower write limit for free accounts on the Romulus server.
-- Every account could already save writes_per_minute (120) times a minute. Each save also wakes the account's
-- other devices over Realtime, so one free install stuck in a save loop could send about 170,000 Realtime
-- messages a day, a third of the Pro plan's monthly allowance in under a week.
--   * free accounts (storage allowance no bigger than free_quota_bytes) get free_writes_per_minute (40).
--     The app waits 2.5 seconds after a change before it saves, so one person typing stays well under it.
--   * paying accounts, family members on a plan and the owner's accounts keep writes_per_minute (120).
--   * a refused save is the same 'rate' refusal as before: the app shows "sync paused for a minute" and saves
--     on its next try, so no build needs changing.
-- Paste it all in the SQL editor and press Run, after 20261110_sync_owner_and_grants.sql (it needs the owner
-- column). This is that file's sync_guard with only the rate line changed.

alter table public.sync_settings add column if not exists free_writes_per_minute int not null default 40;

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
  lim int;
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
  -- (worked out here, not inside the if: plpgsql would read the case's own "then" as the end of the condition)
  lim := case when acc.owner or public.sync_quota_of(acc, s) > s.free_quota_bytes
              then s.writes_per_minute else s.free_writes_per_minute end;
  if cnt > lim then
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
