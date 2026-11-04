-- End-to-end encrypted sync (renderer/js/sync-crypto.js). When a device moves its lists to v2 it copies each
-- row, sealed, under a new lookup id and leaves {"moved":"v2"} under the old key. An older build that still
-- knows only the old key would read that as an empty list and upload its own copy, in the clear, on top.
-- From here on a row that says moved takes no write but another moved marker.
-- setup.sql carries the same lines (and the side-row list sync_put takes has grown there since); a project that
-- ran setup.sql on or after 2026-11-04 has this. Apply by re-running setup.sql rather than this file.

create or replace function public.sync_is_moved(p_sync_key text)
returns boolean
language sql stable
set search_path = public
as $$ select coalesce((select doc->>'moved' = 'v2' from public.tasks_sync where sync_key = p_sync_key), false) $$;
revoke all on function public.sync_is_moved(text) from public;
revoke execute on function public.sync_is_moved(text) from anon, authenticated;

create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|finance|files|files-gone))?$' then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|finance|files|files-gone))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;

-- the linter's one warning: a fixed search_path
alter function public.sync_doc_size(jsonb) set search_path = public;
