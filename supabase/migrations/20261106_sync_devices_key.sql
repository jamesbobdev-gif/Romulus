-- The ':devices' side row next to the personal list (renderer/js/devices.js): every device that syncs, by name,
-- with the public half of its own key pair, and after a key change the new settings sealed to each kept device.
-- Built from 20261102_sync_files_live.sql (the live functions): every key it accepts stays, 'devices' is added.
-- sync_usage already takes the devices key: 20261106_sync_paid_plan.sql replaced it with more columns, so it is not
-- redefined here (doing so fails with "cannot change return type").
-- Paste it all in the SQL editor and press Run. Until then the app syncs as before and Settings says this is needed.

create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;
