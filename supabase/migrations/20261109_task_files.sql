-- Photos and files on any task (renderer/js/task-files.js), for everyone on the Romulus server:
--   * end-to-end encrypted: the app encrypts each file with a key of its own before it goes up, and that key lives
--     only in the task, which is sealed like every list. The bucket holds ciphertext under random names.
--   * kept as long as the task has them (no 30-day clean-up, unlike the older agent-attachments photos).
--   * counted toward the account's space with its lists: 50 MB free (was 5 MB), 600 MB on the $5 plan. An upload
--     is refused once the account is full, and a list stops growing once lists and files fill the space.
-- Files sit in a folder named after the account ('acct_' + sync_account_of, a hash of the key's id part, never
-- the key), so the server can add up an account's files without being able to read them.
-- Paste it all in the SQL editor and press Run, after 20261108_sync_family_lists.sql.

update public.sync_settings set free_quota_bytes = 50 * 1024 * 1024 where id;
alter table public.sync_settings add column if not exists max_files_bytes bigint not null default 50 * 1024 * 1024 * 1024::bigint;

insert into storage.buckets (id, name, public, file_size_limit)
  values ('task-files', 'task-files', true, 10485760)
  on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- the bytes of an account's files ('acct_<account>/…' in task-files)
create or replace function public.sync_files_bytes(p_account text)
returns bigint
language sql stable security definer
set search_path = public, storage
as $$ select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint from storage.objects o
       where o.bucket_id = 'task-files' and o.name like 'acct_' || p_account || '/%' $$;

-- may one more file go into this folder: an account that exists, with room left, on a server with room left.
-- The file's own size isn't known yet here, so an account can go over by at most one file (10 MB at most).
create or replace function public.sync_files_room(p_folder text)
returns boolean
language plpgsql stable security definer
set search_path = public, storage
as $$
declare acc public.sync_accounts; s public.sync_settings; a text;
begin
  if p_folder is null or p_folder !~ '^acct_[0-9a-f]{64}$' then return false; end if;
  a := substr(p_folder, 6);
  select * into acc from public.sync_accounts where account = a;
  if not found then return false; end if;
  select * into s from public.sync_settings where id;
  if acc.used_bytes + public.sync_files_bytes(a) >= public.sync_quota_of(acc, s) then return false; end if;
  return (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'task-files') < s.max_files_bytes;
end $$;

-- Upload only: no list and no delete for the app's key, so nobody can see which folders exist or remove someone
-- else's files. Files are read by their (random) address; removing one goes through the task-files-remove
-- function, which checks the sync key owns the folder.
drop policy if exists "task files: app can upload" on storage.objects;
create policy "task files: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'task-files' and public.sync_files_room((storage.foldername(name))[1]));

-- a list can't grow into space the account's files already use
create or replace function public.sync_guard(p_sync_key text, p_doc jsonb)
returns text
language plpgsql security definer
set search_path = public
as $$
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
      elsif pg_database_size(current_database()) > public.sync_server_cap(s) then
        why := 'server_full';
      end if;
    end if;
  end if;
  if why is not null then
    update public.sync_accounts set refused = why, refused_at = now() where account = a;
  end if;
  return why;
end $$;

-- used_bytes now counts the account's files with its lists (the same columns as before)
create or replace function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text, paid_until timestamptz, paid_quota_bytes bigint, history_bytes bigint)
language plpgsql stable security definer
set search_path = public
as $$
declare s public.sync_settings; acc public.sync_accounts; ip text; cnt int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return; end if;
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if found then
    return query select acc.used_bytes + public.sync_files_bytes(acc.account), public.sync_quota_of(acc, s),
      case when acc.refused_at > now() - interval '30 seconds' then acc.refused end,
      public.sync_paid_until(acc), s.paid_quota_bytes, acc.history_bytes;
    return;
  end if;
  -- no account yet: say whether making one would be refused right now
  ip := public.sync_caller_ip_hash();
  select x.n into cnt from public.sync_new_accounts x where x.ip_hash = ip and x.hour = date_trunc('hour', now());
  return query select 0::bigint, s.free_quota_bytes,
    case when pg_database_size(current_database()) > public.sync_server_cap(s) then 'server_full'
         when coalesce(cnt, 0) >= s.new_accounts_per_ip_hour then 'new_accounts' end,
    null::timestamptz, s.paid_quota_bytes, 0::bigint;
end $$;

revoke all on function public.sync_files_bytes(text) from public;
revoke execute on function public.sync_files_bytes(text) from anon, authenticated;
-- the upload policy runs as the caller, so the room check is theirs to call (it says yes or no, nothing more)
revoke all on function public.sync_files_room(text) from public;
grant execute on function public.sync_files_room(text) to anon, authenticated, service_role;
revoke all on function public.sync_usage(text) from public;
grant execute on function public.sync_usage(text) to anon, authenticated, service_role;
