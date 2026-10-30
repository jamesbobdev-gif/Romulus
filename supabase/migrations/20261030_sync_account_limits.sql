-- Limits per person, so one key (or a script holding the app's anon key) can't fill the database:
--   * an account is the id part of a key: tk_<id> and the lists made from it (tk_work_/tk_agent_/tk_school_<id>)
--     plus their side rows (:prefs, :locked, …) all count as one. A list given its own key is its own account.
--     sync_accounts keys it by a hash of that id, never the id itself.
--   * each account has a storage allowance (free_quota_bytes, or its own quota_bytes once it buys more). A write
--     that would grow the account past it is refused; a write that shrinks a list always goes through, so
--     deleting tasks is how a full account gets going again. Sizes are the documents as JSON text.
--   * at most writes_per_minute writes a minute per account (refused ones count too).
--   * at most new_accounts_per_ip_hour new accounts an hour from one network (by a hash of the caller's IP).
--   * no new account, and no list may grow, once the whole database is over max_total_bytes.
-- A refusal makes sync_put/sync_set return false as before (old app builds keep working). sync_usage(key) says
-- how full the account is and, for 30 seconds after a refusal, why, so the app can tell a full account
-- from someone else writing in between. The numbers live in sync_settings (one row) and can be changed there.
-- (Applied to the live project 2026-10-30 as migration sync_account_limits. Checked through the API that day: a new
-- key saves, the caller's IP hash is recorded, sync_guard and the new tables are closed to the anon key.)

-- ───────────── settings and counters ─────────────
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

-- ───────────── helpers ─────────────
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

-- ───────────── the two writes, now guarded ─────────────
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

-- ───────────── the counts for what is already there ─────────────
insert into public.sync_accounts (account, used_bytes)
  select public.sync_account_of(sync_key), sum(public.sync_doc_size(doc)) from public.tasks_sync group by 1
  on conflict (account) do update set used_bytes = excluded.used_bytes;

drop trigger if exists tasks_sync_count_bytes on public.tasks_sync;
create trigger tasks_sync_count_bytes after insert or update or delete on public.tasks_sync
  for each row execute function public.tasks_sync_count_bytes();

-- ───────────── who may do what ─────────────
revoke all on table public.sync_settings, public.sync_accounts, public.sync_new_accounts from anon, authenticated;
revoke all on function public.sync_account_of(text), public.sync_doc_size(jsonb), public.sync_caller_ip_hash(),
  public.tasks_sync_count_bytes(), public.sync_guard(text, jsonb), public.sync_usage(text) from public;
revoke execute on function public.sync_account_of(text), public.sync_doc_size(jsonb), public.sync_caller_ip_hash(),
  public.tasks_sync_count_bytes(), public.sync_guard(text, jsonb) from anon, authenticated;
grant execute on function public.sync_usage(text) to anon, authenticated, service_role;
