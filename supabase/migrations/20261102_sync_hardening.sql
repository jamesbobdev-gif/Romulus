-- Security review, 2026-11-01: the write functions as they must end up whatever order the 20261031 files were
-- applied in, and a few guards the review found missing. Safe to run again; supabase/setup.sql carries the same.
--
-- 1. The three 20261031 migrations each re-create sync_put/sync_set/sync_usage, and in file-name order
--    (moved_v2 < updates_key < worker_key) the last one has neither the "moved to v2" check nor the :updates
--    key, so applying them in order silently undid both. This file states the final versions once more.
-- 2. The caller's IP for the per-network limits was read from headers a client can send itself
--    (x-real-ip, the first x-forwarded-for entry), so new-account and pairing limits could be sidestepped.
--    Now: cf-connecting-ip (set by the edge, overwriting any sent) or the LAST x-forwarded-for entry (the one the
--    nearest trusted hop appended), and the hash is peppered with a per-project secret so it can't be reversed.
-- 3. widget_complete_task and agent_claim_task took any key shape and skipped the rate guard.
-- 4. The public agent-attachments bucket took any number of anonymous uploads: now a key-shaped folder, a cap
--    per folder and per network-hour.

-- ── the pepper ──
alter table public.sync_settings add column if not exists ip_pepper text;
update public.sync_settings set ip_pepper = md5(random()::text || clock_timestamp()::text || random()::text) where ip_pepper is null;
alter table public.sync_settings alter column ip_pepper set not null;

create or replace function public.sync_caller_ip_hash()
returns text
language plpgsql stable
set search_path = public
as $$
declare h json; ip text; xff text; pepper text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  xff := h->>'x-forwarded-for';
  -- the entry the nearest proxy appended is the last one; anything before it is the client's own claim
  ip := nullif(trim(coalesce(h->>'cf-connecting-ip', case when xff is null then null else split_part(xff, ',', array_length(string_to_array(xff, ','), 1)) end)), '');
  if ip is null then return null; end if;
  select s.ip_pepper into pepper from public.sync_settings s where s.id;
  return encode(sha256(convert_to(coalesce(pepper, '') || '|' || ip, 'UTF8')), 'hex');
end $$;

-- ── moved-to-v2 marker (20261031_sync_moved_v2.sql) ──
create or replace function public.sync_is_moved(p_sync_key text)
returns boolean
language sql stable
set search_path = public
as $$ select coalesce((select doc->>'moved' = 'v2' from public.tasks_sync where sync_key = p_sync_key), false) $$;
revoke all on function public.sync_is_moved(text) from public;
revoke execute on function public.sync_is_moved(text) from anon, authenticated;
alter function public.sync_doc_size(jsonb) set search_path = public;

-- ── the writes, final form: :worker and :updates side rows, the moved check, the guard ──
create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates))?$' then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates))?$' then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates))?$' then return; end if;
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if found then
    return query select acc.used_bytes, coalesce(acc.quota_bytes, s.free_quota_bytes),
      case when acc.refused_at > now() - interval '30 seconds' then acc.refused end;
    return;
  end if;
  ip := public.sync_caller_ip_hash();
  select x.n into cnt from public.sync_new_accounts x where x.ip_hash = ip and x.hour = date_trunc('hour', now());
  return query select 0::bigint, s.free_quota_bytes,
    case when pg_database_size(current_database()) > s.max_total_bytes then 'server_full'
         when coalesce(cnt, 0) >= s.new_accounts_per_ip_hour then 'new_accounts' end;
end $$;

-- ── the two small writes: a key shaped like the app's, an existing row, and the same rate guard ──
create or replace function public.widget_complete_task(p_sync_key text, p_task_id text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int; d jsonb;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_task_id is null or length(p_task_id) > 80 then return false; end if;
  select doc into d from public.tasks_sync where sync_key = p_sync_key;
  if not found or public.sync_guard(p_sync_key, d) is not null then return false; end if;
  update public.tasks_sync
     set doc = jsonb_set(doc, '{tasks}', (
           select jsonb_agg(case when t->>'id' = p_task_id
             then t || jsonb_build_object('done', true,
                                          'updatedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)
                    || case when p_sync_key like 'tk_agent_%' then '{"status":"done"}'::jsonb else '{}'::jsonb end
             else t end)
           from jsonb_array_elements(doc->'tasks') t)),
         updated_at = now()
   where sync_key = p_sync_key
     and exists (select 1 from jsonb_array_elements(doc->'tasks') t where t->>'id' = p_task_id);
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.agent_claim_task(p_sync_key text, p_task_id text, p_worker text, p_lane text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int; d jsonb;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_agent_[A-Za-z0-9_-]{13,}$' or p_lane not in ('claude', 'local')
     or p_task_id is null or length(p_task_id) > 80 then return false; end if;
  select doc into d from public.tasks_sync where sync_key = p_sync_key;
  if not found or public.sync_guard(p_sync_key, d) is not null then return false; end if;
  update public.tasks_sync
     set doc = jsonb_set(doc, '{tasks}', (
           select jsonb_agg(case when t->>'id' = p_task_id
             then t || jsonb_build_object('status', 'working', 'lane', p_lane,
                                          'claimedBy', left(p_worker, 60),
                                          'claimedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint,
                                          'updatedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)
             else t end)
           from jsonb_array_elements(doc->'tasks') t)),
         updated_at = now()
   where sync_key = p_sync_key
     and exists (select 1 from jsonb_array_elements(doc->'tasks') t
                  where t->>'id' = p_task_id
                    and coalesce((t->>'done')::boolean, false) = false
                    and coalesce(t->>'status', 'queued') = 'queued'
                    and coalesce(t->>'lane', p_lane) = p_lane);
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ── photo attachments: a folder shaped like the app's, at most 300 files in it, at most 60 uploads per network-hour ──
create table if not exists public.sync_upload_tries (
  ip_hash text not null,
  hour    timestamptz not null,
  n       int not null default 0,
  primary key (ip_hash, hour)
);
alter table public.sync_upload_tries enable row level security;
revoke all on table public.sync_upload_tries from anon, authenticated;

create or replace function public.attachment_upload_allowed(p_name text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare folder text; cnt int;
begin
  if p_name is null or p_name !~ '^tk_agent_att_[0-9a-f]{40}/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$' then return false; end if;
  folder := split_part(p_name, '/', 1);
  begin
    select count(*) into cnt from storage.objects where bucket_id = 'agent-attachments' and name like folder || '/%';
    if cnt >= 300 then return false; end if;
  exception when others then null; end; -- cannot read the bucket's table here: the per-network cap still holds
  delete from public.sync_upload_tries where hour < now() - interval '1 day';
  insert into public.sync_upload_tries as u (ip_hash, hour, n)
    values (coalesce(public.sync_caller_ip_hash(), 'none'), date_trunc('hour', now()), 1)
    on conflict (ip_hash, hour) do update set n = u.n + 1
    returning u.n into cnt;
  return cnt <= 60;
end $$;
revoke all on function public.attachment_upload_allowed(text) from public;
grant execute on function public.attachment_upload_allowed(text) to anon, authenticated, service_role;

drop policy if exists "agent attachments: app can upload" on storage.objects;
create policy "agent attachments: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'agent-attachments' and public.attachment_upload_allowed(name));
