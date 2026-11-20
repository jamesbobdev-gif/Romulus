-- "Email me links" for everyone on the Romulus server (Choose this / Print this / Send me link on an Agent
-- task). Each account (sync_account_of) can keep one address, confirmed first with a 6-digit code sent to it,
-- and the buy-email edge function only ever mails that confirmed address. So the server can't be used to mail
-- strangers: the only mail that goes to an address nobody has confirmed is the code, and that is capped per
-- account, per address and in total each day. The edge function makes the code; only its hash is kept here.
-- Deleting the account (sync_delete_account) removes the row with it. Every table is closed (row-level
-- security, no policies) and the functions are for the service role only (the edge function).
-- Paste it all in the SQL editor and press Run (after 20261117_sync_delete_account_group.sql).

create table if not exists public.link_email (
  account      text primary key references public.sync_accounts(account) on delete cascade,
  email        text,                       -- the confirmed address (null = none yet)
  confirmed_at timestamptz,
  pending      text,                       -- the address a code was last sent to
  code_hash    text,                       -- sha256 hex of row key + ':' + code (buy-email makes the code)
  code_at      timestamptz,
  code_tries   int not null default 0,
  codes_day    date,
  codes_n      int not null default 0,     -- codes sent today
  sent_day     date,
  sent_n       int not null default 0      -- links mailed today
);
alter table public.link_email enable row level security;

-- daily counts not tied to one account: codes per address (sha256 of it) and the server's totals
create table if not exists public.link_email_daily (
  day  date not null,
  kind text not null,                      -- 'code_to' (key = address hash), 'codes', 'sends' (key = '')
  key  text not null default '',
  n    int  not null default 0,
  primary key (day, kind, key)
);
alter table public.link_email_daily enable row level security;

-- the limits, in one place
create or replace function public.link_email_limits()
returns table(codes_per_account int, codes_per_address int, codes_total int, sends_per_account int, sends_total int, code_minutes int, code_tries int)
language sql immutable
as $$ select 5, 3, 200, 30, 90, 15, 5 $$;

-- the account a personal row key belongs to, only when it has synced here (null otherwise)
create or replace function public.link_email_account(p_row_key text)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare a text;
begin
  if p_row_key is null or p_row_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return null; end if;
  a := public.sync_account_of(p_row_key);
  if not exists (select 1 from public.sync_accounts where account = a) then return null; end if;
  return a;
end $$;

create or replace function public.link_email_bump(p_kind text, p_key text, p_max int)
returns boolean -- false = that count is already at p_max today
language plpgsql security definer
set search_path = public
as $$
declare cnt int;
begin
  delete from public.link_email_daily where day < current_date - 2;
  insert into public.link_email_daily as d (day, kind, key, n) values (current_date, p_kind, p_key, 0)
    on conflict (day, kind, key) do nothing;
  select d.n into cnt from public.link_email_daily d where d.day = current_date and d.kind = p_kind and d.key = p_key for update;
  if cnt >= p_max then return false; end if;
  update public.link_email_daily set n = n + 1 where day = current_date and kind = p_kind and key = p_key;
  return true;
end $$;

-- a code is about to go to p_email: 'ok', or why not ('no_account', 'bad_email', 'wait', 'too_many', 'busy')
create or replace function public.link_email_start(p_row_key text, p_email text, p_code_hash text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.link_email_account(p_row_key);
  e text := lower(btrim(coalesce(p_email, '')));
  l record;
  r public.link_email;
begin
  select * into l from public.link_email_limits();
  if a is null then return 'no_account'; end if;
  if length(e) > 254 or e !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[a-z]{2,}$' then return 'bad_email'; end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then return 'bad'; end if;
  insert into public.link_email (account) values (a) on conflict (account) do nothing;
  select * into r from public.link_email where account = a for update;
  if r.code_at > now() - interval '60 seconds' then return 'wait'; end if;
  if r.codes_day = current_date and r.codes_n >= l.codes_per_account then return 'too_many'; end if;
  if not public.link_email_bump('code_to', encode(sha256(convert_to(e, 'UTF8')), 'hex'), l.codes_per_address) then return 'too_many'; end if;
  if not public.link_email_bump('codes', '', l.codes_total) then return 'busy'; end if;
  update public.link_email set
    pending = e, code_hash = p_code_hash, code_at = now(), code_tries = 0,
    codes_n = case when codes_day = current_date then codes_n + 1 else 1 end,
    codes_day = current_date
    where account = a;
  return 'ok';
end $$;

-- the code typed back in: 'ok' (the address is confirmed), 'no_code', 'expired', 'wrong', 'too_many'
create or replace function public.link_email_confirm(p_row_key text, p_code_hash text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.link_email_account(p_row_key);
  l record;
  r public.link_email;
begin
  select * into l from public.link_email_limits();
  if a is null then return 'no_account'; end if;
  select * into r from public.link_email where account = a for update;
  if r.account is null or r.code_hash is null then return 'no_code'; end if;
  if r.code_at < now() - make_interval(mins => l.code_minutes) then return 'expired'; end if;
  if r.code_tries >= l.code_tries then return 'too_many'; end if;
  if r.code_hash <> coalesce(p_code_hash, '') then
    update public.link_email set code_tries = code_tries + 1 where account = a;
    return 'wrong';
  end if;
  update public.link_email set email = pending, confirmed_at = now(), pending = null, code_hash = null, code_tries = 0
    where account = a;
  return 'ok';
end $$;

-- the confirmed address (null = none), for Settings
create or replace function public.link_email_status(p_row_key text)
returns text
language sql stable security definer
set search_path = public
as $$ select email from public.link_email where account = public.link_email_account(p_row_key) $$;

-- one link is about to be mailed: the address to send it to, or null with why ('no_account', 'no_email',
-- 'too_many', 'busy')
create or replace function public.link_email_take(p_row_key text)
returns table(status text, email text)
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.link_email_account(p_row_key);
  l record;
  r public.link_email;
begin
  select * into l from public.link_email_limits();
  if a is null then return query select 'no_account'::text, null::text; return; end if;
  select * into r from public.link_email where account = a for update;
  if r.account is null or r.email is null then return query select 'no_email'::text, null::text; return; end if;
  if r.sent_day = current_date and r.sent_n >= l.sends_per_account then return query select 'too_many'::text, null::text; return; end if;
  if not public.link_email_bump('sends', '', l.sends_total) then return query select 'busy'::text, null::text; return; end if;
  update public.link_email set
    sent_n = case when sent_day = current_date then sent_n + 1 else 1 end,
    sent_day = current_date
    where account = a;
  return query select 'ok'::text, r.email;
end $$;

-- "Stop emailing me": the address and any code go
create or replace function public.link_email_forget(p_row_key text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare a text := public.link_email_account(p_row_key);
begin
  if a is null then return false; end if;
  update public.link_email set email = null, confirmed_at = null, pending = null, code_hash = null where account = a;
  return true;
end $$;

revoke all on table public.link_email, public.link_email_daily from public, anon, authenticated;
revoke all on function public.link_email_limits(), public.link_email_account(text), public.link_email_bump(text, text, int),
  public.link_email_start(text, text, text), public.link_email_confirm(text, text), public.link_email_status(text),
  public.link_email_take(text), public.link_email_forget(text) from public, anon, authenticated;
grant execute on function public.link_email_start(text, text, text), public.link_email_confirm(text, text),
  public.link_email_status(text), public.link_email_take(text), public.link_email_forget(text) to service_role;
