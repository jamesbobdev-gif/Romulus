-- Read limits for the Romulus server. Writes were already limited (sync_guard); reads weren't, so one script
-- pulling its own row in a loop could use up the project's bandwidth (and with the spend cap on, get the whole
-- project restricted, the owner's sync included).
--   * only what's actually sent counts: a poll that comes back "unchanged" (p_since) costs nothing.
--   * each account may download twice its storage allowance an hour (free 100 MB, the $5 plan 1.2 GB):
--     a new device pulling everything, plus a restore, fits easily.
--   * each network may download read_bytes_per_ip_day (2 GB) a day across all its accounts, so making more
--     accounts doesn't buy more bandwidth.
--   * the owner's accounts (sync_accounts.owner, 20261110_sync_owner_and_grants.sql) are never limited or counted.
-- A refused read is an error ('read_limit'), never an empty row: every build already treats an error as
-- "sync failed, try again later", while an empty row could look like a list that doesn't exist.
-- Attached files (task-files, a public bucket) are downloaded straight from storage and aren't covered here.
-- Paste it all in the SQL editor and press Run, after 20261110_sync_owner_and_grants.sql.

alter table public.sync_settings add column if not exists read_quota_multiple int not null default 2;
alter table public.sync_settings add column if not exists read_bytes_per_ip_day bigint not null default 2 * 1024 * 1024 * 1024::bigint;
alter table public.sync_accounts add column if not exists read_bytes bigint not null default 0;
alter table public.sync_accounts add column if not exists read_window_start timestamptz not null default now();

create table if not exists public.sync_read_ips (
  ip_hash text not null,
  day     date not null,
  bytes   bigint not null default 0,
  primary key (ip_hash, day)
);
alter table public.sync_read_ips enable row level security;
revoke all on table public.sync_read_ips from anon, authenticated;

-- count p_bytes against the row's account and the caller's network; raises 'read_limit' once either is used up
create or replace function public.sync_read_charge(p_sync_key text, p_bytes bigint)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  s public.sync_settings;
  a text := public.sync_account_of(p_sync_key);
  acc public.sync_accounts;
  has_acc boolean;
  ip text;
  used bigint;
begin
  if p_bytes is null or p_bytes <= 0 then return; end if;
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = a for update;
  has_acc := found;
  if has_acc and acc.owner then return; end if;

  -- check both before counting anything: the error rolls the call back, so a refused read isn't counted
  if has_acc and acc.read_window_start > now() - interval '1 hour'
     and acc.read_bytes >= s.read_quota_multiple * public.sync_quota_of(acc, s) then
    raise exception 'read_limit' using hint = 'this account downloaded its hourly allowance; it frees up within the hour';
  end if;
  ip := public.sync_caller_ip_hash();
  if ip is not null then
    select x.bytes into used from public.sync_read_ips x where x.ip_hash = ip and x.day = current_date;
    if coalesce(used, 0) >= s.read_bytes_per_ip_day then
      raise exception 'read_limit' using hint = 'this network downloaded its daily allowance';
    end if;
  end if;

  if has_acc then
    update public.sync_accounts set
        read_bytes        = case when read_window_start > now() - interval '1 hour' then read_bytes + p_bytes else p_bytes end,
        read_window_start = case when read_window_start > now() - interval '1 hour' then read_window_start else now() end
      where account = a;
  end if;
  if ip is not null then
    delete from public.sync_read_ips where day < current_date - 1;
    insert into public.sync_read_ips as x (ip_hash, day, bytes) values (ip, current_date, p_bytes)
      on conflict (ip_hash, day) do update set bytes = x.bytes + p_bytes;
  end if;
end $$;
revoke all on function public.sync_read_charge(text, bigint) from public, anon, authenticated;

-- same answers as before (one row; doc left out while unchanged), now counted
create or replace function public.sync_get(p_sync_key text, p_since timestamptz default null)
returns table(doc jsonb, updated_at timestamptz, topic text, unchanged boolean)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare r public.tasks_sync; got boolean; same boolean;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:[a-z-]+)?$' then return; end if; -- the side rows too (:files-gone has a hyphen)
  select * into r from public.tasks_sync s where s.sync_key = p_sync_key;
  got := found;
  same := p_since is not null and got and r.updated_at = p_since;
  if got and not same then perform public.sync_read_charge(p_sync_key, public.sync_doc_size(r.doc)); end if;
  return query select case when same then null else r.doc end, r.updated_at, public.sync_topic_of(p_sync_key), same;
end $$;

create or replace function public.sync_history_get(p_sync_key text, p_day date)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return null; end if;
  select h.doc into d from public.sync_history h where h.sync_key = p_sync_key and h.day = p_day;
  if d is not null then perform public.sync_read_charge(p_sync_key, public.sync_doc_size(d)); end if;
  return d;
end $$;
