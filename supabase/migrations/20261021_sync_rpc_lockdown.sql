-- Lists are reached only through these functions, each of which needs the row's sync key. Before this,
-- the one policy on tasks_sync was "ALL for public, true": anyone with the project's anon key (it's in
-- the phone build and every config file) could read, change or delete every list without a sync key.
-- Now the anon role can't touch the table at all; the functions run as their owner and look up one row
-- by its key. The service role (edge functions) still reads the table directly.
-- (Applied to the live project 2026-10-21.)

-- a list's live-update channel: a hash of its key, so hearing "changed" needs the key but never shows it
create or replace function public.sync_topic_of(p_sync_key text)
returns text
language sql immutable
set search_path = public
as $$ select 'sync:' || encode(sha256(convert_to(p_sync_key, 'UTF8')), 'hex') $$;

-- one row always: doc and updated_at are null when the list doesn't exist yet
create or replace function public.sync_get(p_sync_key text)
returns table(doc jsonb, updated_at timestamptz, topic text)
language sql stable security definer
set search_path = public
as $$
  select s.doc, s.updated_at, public.sync_topic_of(p_sync_key)
  from (select 1) x left join public.tasks_sync s on s.sync_key = p_sync_key
  where length(p_sync_key) >= 16;
$$;

-- compare-and-swap write: p_prev null = make the row (false if it exists); else replace it only if it is
-- still the version read (updated_at unchanged). false = someone else wrote in between: read and merge again.
create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if length(p_sync_key) < 16 or p_doc is null then return false; end if;
  if p_prev is null then
    insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now()) on conflict (sync_key) do nothing;
  else
    update public.tasks_sync set doc = p_doc, updated_at = now() where sync_key = p_sync_key and updated_at = p_prev;
  end if;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- plain write (the settings pages: routing rules, locked words)
create or replace function public.sync_set(p_sync_key text, p_doc jsonb)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if length(p_sync_key) < 16 or p_doc is null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;

-- live updates: every write says "changed" on the list's channel (renderer/js/sync.js listens).
-- No data goes with it: the app syncs the normal way when it hears this.
create or replace function public.tasks_sync_broadcast()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform realtime.send('{}'::jsonb, 'changed', public.sync_topic_of(new.sync_key), false);
  return new;
end $$;
drop trigger if exists tasks_sync_changed on public.tasks_sync;
create trigger tasks_sync_changed after insert or update on public.tasks_sync
  for each row execute function public.tasks_sync_broadcast();

-- the older functions (widget tick-off, agent claim) ran as the caller; they need to own their access now
alter function public.widget_complete_task(text, text) security definer;
alter function public.agent_claim_task(text, text, text, text) security definer;

revoke all on function public.sync_get(text) from public;
revoke all on function public.sync_put(text, jsonb, timestamptz) from public;
revoke all on function public.sync_set(text, jsonb) from public;
revoke all on function public.sync_topic_of(text) from public;
revoke all on function public.widget_complete_task(text, text) from public;
revoke all on function public.agent_claim_task(text, text, text, text) from public;
revoke all on function public.tasks_sync_broadcast() from public;
-- (new functions in public get execute for the API roles by default: take it back from the two helpers)
revoke execute on function public.tasks_sync_broadcast(), public.sync_topic_of(text) from anon, authenticated;
grant execute on function public.sync_get(text), public.sync_put(text, jsonb, timestamptz), public.sync_set(text, jsonb),
  public.widget_complete_task(text, text), public.agent_claim_task(text, text, text, text) to anon, authenticated, service_role;

-- the lockdown itself: no policy, no table rights for the API roles, no row-change feed
drop policy if exists "sync read write" on public.tasks_sync;
revoke all on table public.tasks_sync from anon, authenticated;
revoke all on table public.app_secrets from anon, authenticated;
alter publication supabase_realtime drop table public.tasks_sync;
