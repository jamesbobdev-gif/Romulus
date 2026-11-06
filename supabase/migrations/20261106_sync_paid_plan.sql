-- Romulus sync for everyone: new installs sync through this project by default (renderer/js/hosted-sync.js).
-- Each account (the id part of its sync key) gets free_quota_bytes; past that, writes that grow the lists are
-- refused ('full') until the person either pays $5/month (Stripe, supabase/functions/stripe-webhook) or moves to
-- a Supabase project of their own. A paid account gets paid_quota_bytes while paid_until is in the future; when
-- a subscription stops being paid it simply runs out, and nothing is deleted (a smaller list always saves).
-- Built from the live sync_guard and sync_usage (2026-11-06); sync_usage keeps every side-row key, with devices.
-- Paste it all in the SQL editor and press Run.

alter table public.sync_settings add column if not exists paid_quota_bytes bigint not null default 600 * 1024 * 1024;
-- the space each account gets: 5 MB free, 600 MB paid (raise either here any time; nothing already saved is cut)
update public.sync_settings set free_quota_bytes = 5 * 1024 * 1024, paid_quota_bytes = 600 * 1024 * 1024 where id;
alter table public.sync_accounts add column if not exists paid_until timestamptz;
alter table public.sync_accounts add column if not exists stripe_customer text;
alter table public.sync_accounts add column if not exists stripe_subscription text;
create index if not exists sync_accounts_stripe_subscription on public.sync_accounts (stripe_subscription);

-- the space an account may use right now
create or replace function public.sync_quota_of(acc public.sync_accounts, s public.sync_settings)
returns bigint
language sql stable
set search_path = public
as $$ select coalesce(acc.quota_bytes, case when acc.paid_until > now() then s.paid_quota_bytes else s.free_quota_bytes end) $$;

-- how big the whole database may grow before new space is refused ('server_full'): max_total_bytes is the room
-- set aside for the free accounts, and each account paid up right now adds its own paid_quota_bytes on top, so
-- paying accounts never fill the server for everyone else (on Pro, extra disk is about $0.125/GB a month)
create or replace function public.sync_server_cap(s public.sync_settings)
returns bigint
language sql stable security definer
set search_path = public
as $$ select s.max_total_bytes + s.paid_quota_bytes * (select count(*) from public.sync_accounts where paid_until > now()) $$;

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
    if length(regexp_replace(p_sync_key, '^tk_(work_|agent_|school_)?([^:]+)(:.*)?$', '\2')) < 32 then return 'weak_key'; end if;
    if pg_database_size(current_database()) > public.sync_server_cap(s) then return 'server_full'; end if;
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
      if acc.used_bytes - coalesce(old_size, 0) + new_size > public.sync_quota_of(acc, s) then
        why := 'full';
      elsif pg_database_size(current_database()) > public.sync_server_cap(s) then
        why := 'server_full';
      end if;
    end if;
  end if;
  if why is not null then
    update public.sync_accounts set refused = why, refused_at = now() where account = a;
  end if;
  return why;
end $$;

-- now also says until when the account is paid for (null = the free space), and what paying would give
drop function if exists public.sync_usage(text);
create function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text, paid_until timestamptz, paid_quota_bytes bigint)
language plpgsql stable security definer
set search_path = public
as $$
declare s public.sync_settings; acc public.sync_accounts; ip text; cnt int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return; end if;
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if found then
    return query select acc.used_bytes, public.sync_quota_of(acc, s),
      case when acc.refused_at > now() - interval '30 seconds' then acc.refused end,
      case when acc.paid_until > now() then acc.paid_until end, s.paid_quota_bytes;
    return;
  end if;
  -- no account yet: say whether making one would be refused right now
  ip := public.sync_caller_ip_hash();
  select x.n into cnt from public.sync_new_accounts x where x.ip_hash = ip and x.hour = date_trunc('hour', now());
  return query select 0::bigint, s.free_quota_bytes,
    case when pg_database_size(current_database()) > public.sync_server_cap(s) then 'server_full'
         when coalesce(cnt, 0) >= s.new_accounts_per_ip_hour then 'new_accounts' end,
    null::timestamptz, s.paid_quota_bytes;
end $$;

-- Stripe said an account paid (supabase/functions/stripe-webhook, service role only). p_account = the account
-- id the app put in the checkout link (sha256 of its key id), or null to find it by the subscription.
-- Returns false when no such account exists (a paid link opened for an account that never synced).
create or replace function public.sync_mark_paid(p_account text, p_subscription text, p_customer text, p_until timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_account is not null and p_account !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.sync_accounts set
      paid_until = greatest(coalesce(paid_until, p_until), p_until),
      stripe_subscription = coalesce(p_subscription, stripe_subscription),
      stripe_customer = coalesce(p_customer, stripe_customer)
    where (p_account is not null and account = p_account)
       or (p_account is null and p_subscription is not null and stripe_subscription = p_subscription);
  return found;
end $$;

revoke all on function public.sync_quota_of(public.sync_accounts, public.sync_settings), public.sync_server_cap(public.sync_settings), public.sync_mark_paid(text, text, text, timestamptz) from public;
revoke execute on function public.sync_quota_of(public.sync_accounts, public.sync_settings), public.sync_server_cap(public.sync_settings), public.sync_mark_paid(text, text, text, timestamptz) from anon, authenticated;
grant execute on function public.sync_mark_paid(text, text, text, timestamptz) to service_role;
revoke all on function public.sync_usage(text) from public;
grant execute on function public.sync_usage(text) to anon, authenticated, service_role;
