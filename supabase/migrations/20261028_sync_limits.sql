-- Limits on what the two write functions accept (the key is the only credential, so anyone holding the
-- anon key could otherwise fill the table with rows of any size under any 16-character string):
--   * the key has to look like one the app makes: tk_<id> (Generate key), tk_work_/tk_agent_/tk_school_<id>
--     (the lists made from it), each optionally followed by one of the side rows the app keeps next to a
--     list (:prefs, :locked, :routing on the agent key; :ideas, :hours on the personal key). The id part is
--     13+ characters of letters, digits, - and _ (a UUID, or the 16-character fallback key).
--   * a document is at most 4 MB as stored.
-- sync_get, widget_complete_task and agent_claim_task are unchanged. The same regex is in
-- renderer/js/settings.js (SYNC_KEY_SHAPE, without the suffix part) and test/locked-crypto.test.js.
-- (Applied to the live project 2026-10-28 as migration sync_limits. Every row then in the table matched the key shape
-- except one leftover realtime test row, tk_<id>:rt-test-…, which can no longer be written to and can be deleted.)

create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|ideas|hours))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|ideas|hours))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;
