-- Phone notifications when the Agent needs you or finishes, with a reply typed right in the notification
-- (renderer/js/push.js, supabase/functions/push, the Android app's Push*.java).
-- What the server holds, per account (sync_account_of, as in link_email):
--   push_tokens   each phone's Firebase token, so the push function knows where to send
--   push_replies  what was typed into a notification, waiting for a device with the lists open to take it
-- Both the notification's words and a reply are sealed on the device with a key made from the sync key
-- (AES-256-GCM, {iv, ct}), so this database, the push function and Firebase only ever carry ciphertext.
-- An account is named by one of its lists' row keys, which only its devices know. Deleting the account
-- (sync_delete_account) removes its rows here with it. The tables are closed (row-level security, no policies).
-- Paste it all in the SQL editor and press Run (after 20261122_cloud_agent_account_id.sql).

create table if not exists public.push_tokens (
  token      text primary key,
  account    text not null references public.sync_accounts(account) on delete cascade,
  platform   text not null default 'android',
  updated_at timestamptz not null default now()
);
create index if not exists push_tokens_account on public.push_tokens(account);
alter table public.push_tokens enable row level security;

create table if not exists public.push_replies (
  id         bigint generated always as identity primary key,
  account    text not null references public.sync_accounts(account) on delete cascade,
  env        jsonb not null,               -- {iv, ct}: the task id and the words, sealed on the phone
  created_at timestamptz not null default now()
);
create index if not exists push_replies_account on public.push_replies(account);
alter table public.push_replies enable row level security;

-- notifications sent today, per account
create table if not exists public.push_sent (
  account text primary key references public.sync_accounts(account) on delete cascade,
  day     date not null default current_date,
  n       int  not null default 0
);
alter table public.push_sent enable row level security;

-- the limits, in one place: phones per account, notifications per account a day, replies waiting, a sealed
-- message's size in characters
create or replace function public.push_limits()
returns table(tokens_per_account int, sends_per_account int, replies_waiting int, env_chars int)
language sql immutable
as $$ select 8, 300, 40, 8000 $$;

-- the account a row key belongs to, only when it has synced here (null otherwise)
create or replace function public.push_account(p_row_key text)
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

create or replace function public.push_env_ok(p_env jsonb)
returns boolean
language sql immutable
as $$
  select p_env is not null and jsonb_typeof(p_env) = 'object'
     and jsonb_typeof(p_env->'iv') = 'string' and jsonb_typeof(p_env->'ct') = 'string'
     and length(p_env::text) <= (select env_chars from public.push_limits())
$$;

-- this phone wants the account's notifications. A token belongs to one account: registering it again moves it.
create or replace function public.push_register(p_row_key text, p_token text, p_platform text default 'android')
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare a text := public.push_account(p_row_key);
begin
  if a is null or p_token is null or length(p_token) < 20 or length(p_token) > 4096 then return false; end if;
  insert into public.push_tokens (token, account, platform, updated_at)
    values (p_token, a, case when p_platform = 'ios' then 'ios' else 'android' end, now())
    on conflict (token) do update set account = excluded.account, platform = excluded.platform, updated_at = now();
  -- the oldest go when an account has more phones than the limit
  delete from public.push_tokens where account = a and token not in (
    select token from public.push_tokens where account = a order by updated_at desc
     limit (select tokens_per_account from public.push_limits()));
  return true;
end $$;

-- notifications turned off on this phone
create or replace function public.push_unregister(p_row_key text, p_token text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare a text := public.push_account(p_row_key);
begin
  if a is null then return false; end if;
  delete from public.push_tokens where account = a and token = p_token;
  return found;
end $$;

-- a reply typed into a notification: 'ok', or why not ('no_account', 'bad', 'too_many')
create or replace function public.push_reply_put(p_row_key text, p_env jsonb)
returns text
language plpgsql security definer
set search_path = public
as $$
declare a text := public.push_account(p_row_key);
begin
  if a is null then return 'no_account'; end if;
  if not public.push_env_ok(p_env) then return 'bad'; end if;
  delete from public.push_replies where created_at < now() - interval '14 days';
  if (select count(*) from public.push_replies where account = a) >= (select replies_waiting from public.push_limits()) then return 'too_many'; end if;
  insert into public.push_replies (account, env) values (a, p_env);
  return 'ok';
end $$;

-- a device with the lists open takes the waiting replies, oldest first. Each goes to one device only.
create or replace function public.push_reply_take(p_row_key text)
returns setof jsonb
language plpgsql security definer
set search_path = public
as $$
declare a text := public.push_account(p_row_key);
begin
  if a is null then return; end if;
  return query
    with gone as (delete from public.push_replies where account = a returning id, env)
    select env from gone order by id;
end $$;

-- the push function is about to send one notification: the account's tokens, or none when it has sent its
-- share today (service role only)
create or replace function public.push_send_tokens(p_row_key text)
returns setof text
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.push_account(p_row_key);
  cnt int;
begin
  if a is null then return; end if;
  if not exists (select 1 from public.push_tokens where account = a) then return; end if;
  insert into public.push_sent (account) values (a) on conflict (account) do nothing;
  update public.push_sent set day = current_date, n = 0 where account = a and day <> current_date;
  select n into cnt from public.push_sent where account = a for update;
  if cnt >= (select sends_per_account from public.push_limits()) then return; end if;
  update public.push_sent set n = n + 1 where account = a;
  return query select token from public.push_tokens where account = a;
end $$;

-- a token Firebase says is gone (the app was removed): forget it (service role only)
create or replace function public.push_token_gone(p_token text)
returns void
language sql security definer
set search_path = public
as $$ delete from public.push_tokens where token = p_token $$;

revoke all on table public.push_tokens, public.push_replies, public.push_sent from public, anon, authenticated;
revoke all on function public.push_limits(), public.push_account(text), public.push_env_ok(jsonb),
  public.push_register(text, text, text), public.push_unregister(text, text), public.push_reply_put(text, jsonb),
  public.push_reply_take(text), public.push_send_tokens(text), public.push_token_gone(text) from public, anon, authenticated;
grant execute on function public.push_register(text, text, text), public.push_unregister(text, text),
  public.push_reply_put(text, jsonb), public.push_reply_take(text) to anon, authenticated, service_role;
grant execute on function public.push_send_tokens(text), public.push_token_gone(text) to service_role;
