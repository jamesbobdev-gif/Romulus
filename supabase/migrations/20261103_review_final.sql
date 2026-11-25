-- 2026-11-03, the review's last pass. The LAST migration in name order must be the complete one: each earlier file
-- re-creates sync_put/sync_set/sync_usage with the side rows it knew, so applying them in order ends with whatever the
-- last file carried. This one carries everything (:updates from the review, :finance/:files/:files-gone from the
-- downloads and Finance work), the moved-to-v2 check and the rate guard; sync_get reads every side row; the agent-files
-- bucket admits, lists and removes only for a request that proves the agent key (x-romulus-key header), with the same
-- caps as the photo bucket; pairing can't be made 'busy' by one network. Safe to run again; setup.sql carries the same.

create or replace function public.sync_get(p_sync_key text, p_since timestamptz default null)
returns table(doc jsonb, updated_at timestamptz, topic text, unchanged boolean)
language sql stable security definer
set search_path = public
as $$
  select case when p_since is not null and s.updated_at = p_since then null else s.doc end,
         s.updated_at,
         public.sync_topic_of(p_sync_key),
         (p_since is not null and s.updated_at = p_since)
  from (select 1) x left join public.tasks_sync s on s.sync_key = p_sync_key
  where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}(:[a-z-]+)?$'; -- the side rows too (:files-gone has a hyphen)
$$;

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

-- ───────────── the local model's downloads ─────────────
-- Files the local model's browser downloaded on its own computer (a worksheet off Blackboard) reach the other
-- computers through this bucket (agent/worker-files.js), so no device has to reach the mini PC. Documents up to
-- 10 MB, in a folder named by a hash of the agent key (never the key). The bucket is public, so a file is served by
-- its exact address without any policy; everything else (adding, listing, removing) is allowed only to a request
-- that proves the agent key in an x-romulus-key header, and only for that key's own folder. Without the proof the
-- bucket lists nothing: a folder name was all it took to read or remove everything in it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('agent-files', 'agent-files', true, 10485760, array['application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.text',
    'application/rtf', 'text/csv', 'text/plain', 'text/markdown', 'application/json', 'application/zip',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- the request proves the agent key (the storage server hands request headers to Postgres as request.headers, like
-- PostgREST does): true when the object's folder is that key's folder, so a request sees, adds to and removes from
-- its own folder only
create or replace function public.agent_folder_proved(p_name text)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare k text;
begin
  begin k := (nullif(current_setting('request.headers', true), '')::json)->>'x-romulus-key'; exception when others then k := null; end;
  if k is null or k !~ '^tk_agent_[A-Za-z0-9_-]{13,}$' then return false; end if;
  return split_part(coalesce(p_name, ''), '/', 1) = 'tk_agent_att_' || left(encode(sha256(convert_to(k, 'UTF8')), 'hex'), 40);
end $$;
revoke all on function public.agent_folder_proved(text) from public;
grant execute on function public.agent_folder_proved(text) to anon, authenticated, service_role;

-- A plain file name (no page that a browser would render from this address), at most 300 files and 100 MB in a
-- folder, at most 60 uploads per network-hour (the counter is shared with agent-attachments).
create or replace function public.agent_file_upload_allowed(p_name text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare folder text; cnt int; bytes bigint;
begin
  if p_name is null or p_name !~ '^tk_agent_att_[0-9a-f]{40}/[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$' then return false; end if;
  if p_name ~* '\.(html?|xhtml|svg|xml|js|mjs)$' then return false; end if;
  folder := split_part(p_name, '/', 1);
  begin
    select count(*), coalesce(sum((metadata->>'size')::bigint), 0) into cnt, bytes
      from storage.objects where bucket_id = 'agent-files' and name like folder || '/%';
    if cnt >= 300 or bytes >= 100 * 1024 * 1024 then return false; end if;
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
  with check (bucket_id = 'agent-files' and public.agent_folder_proved(name) and public.agent_file_upload_allowed(name));
drop policy if exists "agent files: app can see" on storage.objects;
create policy "agent files: app can see" on storage.objects for select to anon
  using (bucket_id = 'agent-files' and public.agent_folder_proved(name));
drop policy if exists "agent files: app can remove" on storage.objects;
create policy "agent files: app can remove" on storage.objects for delete to anon
  using (bucket_id = 'agent-files' and public.agent_folder_proved(name));

create or replace function public.sync_pair_put(p_id text, p_sealed text, p_watch text)
returns text
language plpgsql security definer
set search_path = public
as $$
begin
  if p_id is null or p_id !~ '^[0-9a-f]{64}$' or p_watch is null or p_watch !~ '^[0-9a-f]{64}$'
     or p_sealed is null or length(p_sealed) > 8192 then return 'bad'; end if;
  if not public.sync_pair_allow('put', 20) then return 'rate'; end if;
  delete from public.sync_pairs where created_at < now() - interval '1 hour';
  if (select count(*) from public.sync_pairs where created_at > now() - interval '10 minutes') >= 5000 then return 'busy'; end if; -- each network makes at most 20 an hour
  insert into public.sync_pairs (id, sealed, watch_hash) values (p_id, p_sealed, encode(sha256(convert_to(p_watch, 'UTF8')), 'hex'))
    on conflict (id) do nothing;
  return case when found then null else 'bad' end;
end $$;

create or replace function public.sync_pair_take(p_id text)
returns table(sealed text, refused text)
language plpgsql security definer
set search_path = public
as $$
declare s text;
begin
  if p_id is null or p_id !~ '^[0-9a-f]{64}$' then return; end if;
  if not public.sync_pair_allow('take', 30) then return query select null::text, 'rate'::text; return; end if;
  select p.sealed into s from public.sync_pairs p
   where p.id = p_id and p.taken_at is null and p.sealed is not null and p.created_at > now() - interval '10 minutes'
   for update;
  if s is null then return; end if;
  update public.sync_pairs set sealed = null, taken_at = now() where id = p_id;
  return query select s, null::text;
end $$;

