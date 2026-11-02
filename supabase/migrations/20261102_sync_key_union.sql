-- 2026-11-02: the write functions once more, with every side row both lines of work added. 20261102_sync_hardening.sql
-- (the security review: the moved-to-v2 check, the :updates row, the rate guard) and 20261101_sync_files_key.sql
-- (:finance, :files, :files-gone for the local model's downloads) each re-create sync_put/sync_set/sync_usage, so
-- whichever was pasted last dropped the other's rows. These are the final versions with all of them. Also the caps
-- the review put on the photo bucket, for the new agent-files bucket. Safe to run again; supabase/setup.sql carries the same.

-- ── the writes: every side row, the moved check, the guard ──
create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  if p_prev is null then
    insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now()) on conflict (sync_key) do nothing;
  else
    update public.tasks_sync set doc = p_doc, updated_at = now() where sync_key = p_sync_key and updated_at = p_prev;
  end if;
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.sync_set(p_sync_key text, p_doc jsonb)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;

create or replace function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text)
language plpgsql stable security definer
set search_path = public
as $$
declare s public.sync_settings; acc public.sync_accounts; ip text; cnt int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone))?$' then return; end if;
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if found then
    return query select acc.used_bytes, coalesce(acc.quota_bytes, s.free_quota_bytes),
      case when acc.refused_at > now() - interval '30 seconds' then acc.refused end;
    return;
  end if;
  -- no account yet: say whether making one would be refused right now
  ip := public.sync_caller_ip_hash();
  select x.n into cnt from public.sync_new_accounts x where x.ip_hash = ip and x.hour = date_trunc('hour', now());
  return query select 0::bigint, s.free_quota_bytes,
    case when pg_database_size(current_database()) > s.max_total_bytes then 'server_full'
         when coalesce(cnt, 0) >= s.new_accounts_per_ip_hour then 'new_accounts' end;
end $$;

-- ── the local model's downloads bucket (20261101_agent_files_bucket.sql): the same caps as the photo attachments ──
-- A folder shaped like the app's (the hash of the agent key), a plain file name, at most 300 files in a folder and at most
-- 60 uploads per network-hour (the counter is shared with agent-attachments), so the anon key alone can't fill the bucket.
create or replace function public.agent_file_upload_allowed(p_name text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare folder text; cnt int;
begin
  if p_name is null or p_name !~ '^tk_agent_att_[0-9a-f]{40}/[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$' then return false; end if;
  folder := split_part(p_name, '/', 1);
  begin
    select count(*) into cnt from storage.objects where bucket_id = 'agent-files' and name like folder || '/%';
    if cnt >= 300 then return false; end if;
  exception when others then null; end;
  delete from public.sync_upload_tries where hour < now() - interval '1 day';
  insert into public.sync_upload_tries as u (ip_hash, hour, n)
    values (coalesce(public.sync_caller_ip_hash(), 'none'), date_trunc('hour', now()), 1)
    on conflict (ip_hash, hour) do update set n = u.n + 1
    returning u.n into cnt;
  return cnt <= 60;
end $$;
revoke all on function public.agent_file_upload_allowed(text) from public;
grant execute on function public.agent_file_upload_allowed(text) to anon, authenticated, service_role;
drop policy if exists "agent files: app can upload" on storage.objects;
create policy "agent files: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'agent-files' and public.agent_file_upload_allowed(name));
