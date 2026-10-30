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

-- per-account storage allowance, write rate and new-account counts (supabase/migrations/20261030_sync_account_limits.sql):
-- an account is the id part of a key, so tk_<id>, tk_work_/tk_agent_/tk_school_<id> and their side rows count as one
create table if not exists public.sync_settings (
  id                       boolean primary key default true check (id),
  free_quota_bytes         bigint not null default 25 * 1024 * 1024,
  writes_per_minute        int    not null default 120,
  new_accounts_per_ip_hour int    not null default 10,
  max_total_bytes          bigint not null default 6 * 1024 * 1024 * 1024::bigint
);
insert into public.sync_settings (id) values (true) on conflict (id) do nothing;
alter table public.sync_settings enable row level security;

create table if not exists public.sync_accounts (
  account          text primary key,          -- sha256 of the key's id part (sync_account_of)
  used_bytes       bigint not null default 0, -- kept by the tasks_sync_count_bytes trigger
  quota_bytes      bigint,                    -- null = the free allowance in sync_settings
  window_start     timestamptz not null default now(),
  writes_in_window int not null default 0,
  refused          text,                      -- 'full' | 'rate' | 'server_full': the last refusal and when
  refused_at       timestamptz,
  created_at       timestamptz not null default now()
);
alter table public.sync_accounts enable row level security;

create table if not exists public.sync_new_accounts (
  ip_hash text not null,
  hour    timestamptz not null,
  n       int not null default 0,
  primary key (ip_hash, hour)
);
alter table public.sync_new_accounts enable row level security;

-- ───────────── reading and writing a list ─────────────
-- a list's live-update channel: a hash of its key, so hearing "changed" needs the key but never shows it
create or replace function public.sync_topic_of(p_sync_key text)
returns text
language sql immutable
set search_path = public
as $$ select 'sync:' || encode(sha256(convert_to(p_sync_key, 'UTF8')), 'hex') $$;

-- one row always: doc and updated_at are null when the list doesn't exist yet. p_since = when the caller
-- last pulled: a row unchanged since then comes back without its document (unchanged = true), so a poll
-- of an unchanged list costs ~100 bytes, not the whole list (supabase/migrations/20261029_sync_get_since.sql)
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
  where length(p_sync_key) >= 16;
$$;

-- ───────────── limits per account ─────────────
create or replace function public.sync_account_of(p_sync_key text)
returns text
language sql immutable
set search_path = public
as $$ select encode(sha256(convert_to(regexp_replace(p_sync_key, '^tk_(work_|agent_|school_)?([^:]+)(:.*)?$', '\2'), 'UTF8')), 'hex') $$;

create or replace function public.sync_doc_size(p_doc jsonb)
returns bigint
language sql immutable
as $$ select coalesce(octet_length(p_doc::text), 0)::bigint $$;

-- hash of the caller's IP from the request PostgREST is answering; null when there is none (SQL editor, service role)
create or replace function public.sync_caller_ip_hash()
returns text
language plpgsql stable
set search_path = public
as $$
declare h json; ip text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  ip := nullif(trim(coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', split_part(h->>'x-forwarded-for', ',', 1))), '');
  return case when ip is null then null else encode(sha256(convert_to(ip, 'UTF8')), 'hex') end;
end $$;

-- every write to tasks_sync, from any path (the functions, the edge functions' service role), keeps the
-- account's used_bytes right
create or replace function public.tasks_sync_count_bytes()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.doc = new.doc and old.sync_key = new.sync_key then return null; end if;
  if tg_op in ('UPDATE', 'DELETE') then
    update public.sync_accounts set used_bytes = greatest(0, used_bytes - public.sync_doc_size(old.doc))
     where account = public.sync_account_of(old.sync_key);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.sync_accounts as a (account, used_bytes)
      values (public.sync_account_of(new.sync_key), public.sync_doc_size(new.doc))
      on conflict (account) do update set used_bytes = a.used_bytes + excluded.used_bytes;
  end if;
  return null;
end $$;

-- null = the write may go ahead; otherwise why not ('new_accounts' | 'rate' | 'full' | 'server_full')
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
    if pg_database_size(current_database()) > s.max_total_bytes then return 'server_full'; end if;
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
      if acc.used_bytes - coalesce(old_size, 0) + new_size > coalesce(acc.quota_bytes, s.free_quota_bytes) then
        why := 'full';
      elsif pg_database_size(current_database()) > s.max_total_bytes then
        why := 'server_full';
      end if;
    end if;
  end if;
  if why is not null then
    update public.sync_accounts set refused = why, refused_at = now() where account = a;
  end if;
  return why;
end $$;

-- ───────────── the two writes ─────────────
-- Both writes take only a key shaped like one the app makes (tk_<id>, tk_work_/tk_agent_/tk_school_<id>, each
-- optionally with one of the side rows the app keeps next to a list: :prefs, :locked, :routing, :standing, :ideas, :hours;
-- the id is 13+ characters of letters, digits, - and _) and a document of at most 4 MB, so the anon key alone
-- can't fill the table (supabase/migrations/20261028_sync_limits.sql), and sync_guard has to let the write through:
-- false is also the answer for an account that is full or saving too often (sync_usage says which).
-- compare-and-swap write: p_prev null = make the row (false if it exists); else replace it only if it is
-- still the version read (updated_at unchanged). false = someone else wrote in between: read and merge again.
create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;

-- how full the key's account is, and why its last write was refused if that was in the last 30 seconds
create or replace function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text)
language plpgsql stable security definer
set search_path = public
as $$
declare s public.sync_settings; acc public.sync_accounts; ip text; cnt int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours))?$' then return; end if;
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

-- used_bytes per account, kept by every write whatever path it takes; the insert counts what is already there
insert into public.sync_accounts (account, used_bytes)
  select public.sync_account_of(sync_key), sum(public.sync_doc_size(doc)) from public.tasks_sync group by 1
  on conflict (account) do update set used_bytes = excluded.used_bytes;
drop trigger if exists tasks_sync_count_bytes on public.tasks_sync;
create trigger tasks_sync_count_bytes after insert or update or delete on public.tasks_sync
  for each row execute function public.tasks_sync_count_bytes();

-- ───────────── who may do what ─────────────
-- no policy and no table rights for the API roles: the anon key reaches lists only through the functions
drop policy if exists "sync read write" on public.tasks_sync;
revoke all on table public.tasks_sync from anon, authenticated;
revoke all on table public.app_secrets from anon, authenticated;

revoke all on function public.sync_topic_of(text) from public;
revoke all on function public.sync_get(text, timestamptz) from public;
revoke all on function public.sync_put(text, jsonb, timestamptz) from public;
revoke all on function public.sync_set(text, jsonb) from public;
revoke all on function public.widget_complete_task(text, text) from public;
revoke all on function public.agent_claim_task(text, text, text, text) from public;
revoke all on function public.tasks_sync_broadcast() from public;
-- (new functions in public get execute for the API roles by default: take it back from the two helpers)
revoke execute on function public.tasks_sync_broadcast(), public.sync_topic_of(text) from anon, authenticated;
grant execute on function public.sync_get(text, timestamptz), public.sync_put(text, jsonb, timestamptz), public.sync_set(text, jsonb),
  public.widget_complete_task(text, text), public.agent_claim_task(text, text, text, text) to anon, authenticated, service_role;

revoke all on table public.sync_settings, public.sync_accounts, public.sync_new_accounts from anon, authenticated;
revoke all on function public.sync_account_of(text), public.sync_doc_size(jsonb), public.sync_caller_ip_hash(),
  public.tasks_sync_count_bytes(), public.sync_guard(text, jsonb), public.sync_usage(text) from public;
revoke execute on function public.sync_account_of(text), public.sync_doc_size(jsonb), public.sync_caller_ip_hash(),
  public.tasks_sync_count_bytes(), public.sync_guard(text, jsonb) from anon, authenticated;
grant execute on function public.sync_usage(text) to anon, authenticated, service_role;

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
