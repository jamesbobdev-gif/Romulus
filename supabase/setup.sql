-- Romulus: everything a new sync project needs, in one paste.
-- Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
-- Safe to run again: it only creates what is missing and re-applies the same functions and rights.
--
-- How it works: one table, tasks_sync, holds every list as a JSON document under its sync key (the key is
-- the password to the list). The table itself is closed to the app's anon key; lists are reached only through
-- the functions below, each of which needs the row's key. The service role (edge functions) reads the table
-- directly. supabase/migrations/*.sql is the history of how the live project got here; this file is the
-- current state, assembled by hand, so a fresh project needs nothing else.

-- ───────────── tables ─────────────
create table if not exists public.tasks_sync (
  sync_key   text primary key,
  doc        jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.tasks_sync enable row level security;

-- secrets the edge functions read (their access tokens, the lists' keys for the MCP server). Row-level
-- security with no policies: only the service role can read it.
create table if not exists public.app_secrets (
  name  text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;

-- ───────────── reading and writing a list ─────────────
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

-- Both writes take only a key shaped like one the app makes (tk_<id>, tk_work_/tk_agent_/tk_school_<id>, each
-- optionally with one of the side rows the app keeps next to a list: :prefs, :locked, :routing, :ideas, :hours;
-- the id is 13+ characters of letters, digits, - and _) and a document of at most 4 MB, so the anon key alone
-- can't fill the table (supabase/migrations/20261028_sync_limits.sql).
-- compare-and-swap write: p_prev null = make the row (false if it exists); else replace it only if it is
-- still the version read (updated_at unchanged). false = someone else wrote in between: read and merge again.
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

-- plain write (the settings pages: routing rules, the Locked profile, which the app encrypts before it comes here)
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

-- the phone widget ticks a task off by its id
create or replace function public.widget_complete_task(p_sync_key text, p_task_id text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
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

-- A worker (the home PC's Claude runner, or the mini PC's local lane) claims a queued Agent task before
-- starting it. Atomic: the row lock + re-checked WHERE mean only one worker can win. p_lane: the lane the
-- worker serves ('claude' | 'local'). A task with no lane yet is claimable by either and gets stamped with
-- the claimer's lane.
create or replace function public.agent_claim_task(p_sync_key text, p_task_id text, p_worker text, p_lane text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key not like 'tk_agent_%' or p_lane not in ('claude', 'local') then return false; end if;
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

-- ───────────── live updates ─────────────
-- every write says "changed" on the list's channel (renderer/js/sync.js listens). No data goes with it: the
-- app syncs the normal way when it hears this. The table itself is not in the realtime publication, so no
-- row ever reaches a client that way.
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

-- ───────────── who may do what ─────────────
-- no policy and no table rights for the API roles: the anon key reaches lists only through the functions
drop policy if exists "sync read write" on public.tasks_sync;
revoke all on table public.tasks_sync from anon, authenticated;
revoke all on table public.app_secrets from anon, authenticated;

revoke all on function public.sync_topic_of(text) from public;
revoke all on function public.sync_get(text) from public;
revoke all on function public.sync_put(text, jsonb, timestamptz) from public;
revoke all on function public.sync_set(text, jsonb) from public;
revoke all on function public.widget_complete_task(text, text) from public;
revoke all on function public.agent_claim_task(text, text, text, text) from public;
revoke all on function public.tasks_sync_broadcast() from public;
-- (new functions in public get execute for the API roles by default: take it back from the two helpers)
revoke execute on function public.tasks_sync_broadcast(), public.sync_topic_of(text) from anon, authenticated;
grant execute on function public.sync_get(text), public.sync_put(text, jsonb, timestamptz), public.sync_set(text, jsonb),
  public.widget_complete_task(text, text), public.agent_claim_task(text, text, text, text) to anon, authenticated, service_role;

-- ───────────── photo attachments ─────────────
-- Photos attached to Agent tasks (renderer/js/agent-chat.js) and the mini PC's "I'm stuck" screenshots
-- (agent/qwen-browser.js) go in a public bucket, small images only. Uploads land in a folder named by a hash
-- of the agent key (tk_agent_att_…), never the key itself: the addresses end up in task history.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('agent-attachments', 'agent-attachments', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;
drop policy if exists "agent attachments: app can upload" on storage.objects;
create policy "agent attachments: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'agent-attachments' and (storage.foldername(name))[1] like 'tk_agent_att_%');
