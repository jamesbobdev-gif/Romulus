-- What the $5 plan (or $50 a year) gives besides space, on the Romulus server (renderer/js/hosted-sync.js):
--   Family: a paying account shares its plan with up to 4 more accounts, through a one-time invite code.
--   History: every list of a covered account keeps one copy a day for 30 days, so a bad day can be undone
--            ("restore my lists from Tuesday"). The copies are the rows as stored: sealed, so the server still
--            can't read them. They use the account's spare space: a copy that wouldn't fit isn't kept.
--   Supporters: a name the payer typed into the optional field on the Stripe checkout page shows in the app's
--            list of supporters while they pay. No name typed, no listing.
-- Paste it all in the SQL editor and press Run, after 20261106_sync_paid_plan.sql.

alter table public.sync_accounts add column if not exists family_of text;          -- the paying account that covers this one
alter table public.sync_accounts add column if not exists family_since timestamptz;
alter table public.sync_accounts add column if not exists history_bytes bigint not null default 0;
create index if not exists sync_accounts_family_of on public.sync_accounts (family_of);

-- is this account covered by a paid plan right now: its own, or the family plan it joined
create or replace function public.sync_paid_now(acc public.sync_accounts)
returns boolean
language sql stable security definer
set search_path = public
as $$ select coalesce(acc.paid_until > now(), false)
          or (acc.family_of is not null and exists (select 1 from public.sync_accounts p where p.account = acc.family_of and p.paid_until > now())) $$;

-- until when it's covered (its own plan, else the family's), null = the free space
create or replace function public.sync_paid_until(acc public.sync_accounts)
returns timestamptz
language sql stable security definer
set search_path = public
as $$ select case when acc.paid_until > now() then acc.paid_until
                  else (select p.paid_until from public.sync_accounts p where p.account = acc.family_of and p.paid_until > now()) end $$;

create or replace function public.sync_quota_of(acc public.sync_accounts, s public.sync_settings)
returns bigint
language sql stable security definer
set search_path = public
as $$ select coalesce(acc.quota_bytes, case when public.sync_paid_now(acc) then s.paid_quota_bytes else s.free_quota_bytes end) $$;

-- a family member gets the paid space too, so the server's room grows for each one as it does for a payer
create or replace function public.sync_server_cap(s public.sync_settings)
returns bigint
language sql stable security definer
set search_path = public
as $$ select s.max_total_bytes + s.paid_quota_bytes * (select count(*) from public.sync_accounts a where public.sync_paid_now(a)) $$;

-- paid_until now also says when a family plan covers the account; history_bytes is the daily copies (they only
-- ever take room the lists don't need: a copy that wouldn't fit isn't kept, and a list write never waits on one)
drop function if exists public.sync_usage(text);
create function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text, paid_until timestamptz, paid_quota_bytes bigint, history_bytes bigint)
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
      public.sync_paid_until(acc), s.paid_quota_bytes, acc.history_bytes;
    return;
  end if;
  -- no account yet: say whether making one would be refused right now
  ip := public.sync_caller_ip_hash();
  select x.n into cnt from public.sync_new_accounts x where x.ip_hash = ip and x.hour = date_trunc('hour', now());
  return query select 0::bigint, s.free_quota_bytes,
    case when pg_database_size(current_database()) > public.sync_server_cap(s) then 'server_full'
         when coalesce(cnt, 0) >= s.new_accounts_per_ip_hour then 'new_accounts' end,
    null::timestamptz, s.paid_quota_bytes, 0::bigint;
end $$;

-- ── family ──
create table if not exists public.sync_family_invites (
  code     text primary key,
  payer    text not null references public.sync_accounts (account) on delete cascade,
  made_at  timestamptz not null default now()
);
alter table public.sync_family_invites enable row level security; -- no policies: only the functions below reach it

-- a code for one more person ('ABCD-EF12-3456'), good for 2 days. why: 'not_paid' | 'family_full' | 'bad'
create or replace function public.sync_family_invite(p_sync_key text)
returns table(code text, why text)
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; c text; n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return query select null::text, 'bad'::text; return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found or not coalesce(acc.paid_until > now(), false) then return query select null::text, 'not_paid'::text; return; end if;
  select count(*) into n from public.sync_accounts where family_of = acc.account;
  if n >= 4 then return query select null::text, 'family_full'::text; return; end if;
  delete from public.sync_family_invites where made_at < now() - interval '2 days' or payer = acc.account;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  c := substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4);
  insert into public.sync_family_invites (code, payer) values (c, acc.account);
  return query select c, null::text;
end $$;

-- join with a code. null = joined; else 'bad' | 'rate' | 'no_code' | 'no_account' | 'own' | 'family_full'
create or replace function public.sync_family_join(p_sync_key text, p_code text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; inv public.sync_family_invites; n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_code is null then return 'bad'; end if;
  if not public.sync_pair_allow('family', 30) then return 'rate'; end if; -- guessing codes from one network
  select * into inv from public.sync_family_invites
    where replace(code, '-', '') = upper(regexp_replace(trim(p_code), '[^A-Za-z0-9]', '', 'g')) and made_at > now() - interval '2 days';
  if not found then return 'no_code'; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return 'no_account'; end if;
  if acc.account = inv.payer then return 'own'; end if;
  select count(*) into n from public.sync_accounts where family_of = inv.payer and account <> acc.account;
  if n >= 4 then return 'family_full'; end if;
  update public.sync_accounts set family_of = inv.payer, family_since = now() where account = acc.account;
  delete from public.sync_family_invites where code = inv.code; -- one code, one person
  return null;
end $$;

-- who's on the plan: for the payer, every member; for a member, just that it's covered. role: 'payer' | 'member' | null
create or replace function public.sync_family_list(p_sync_key text)
returns table(role text, member text, since timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
declare acc public.sync_accounts;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return; end if;
  if acc.family_of is not null then
    return query select 'member'::text, null::text, acc.family_since; return;
  end if;
  if coalesce(acc.paid_until > now(), false) or exists (select 1 from public.sync_accounts where family_of = acc.account) then
    return query select 'payer'::text, m.account, m.family_since from public.sync_accounts m where m.family_of = acc.account order by m.family_since;
    if not found then return query select 'payer'::text, null::text, null::timestamptz; end if;
  end if;
end $$;

-- leave a family plan (p_member null), or the payer takes a member off (p_member = its id from sync_family_list)
create or replace function public.sync_family_remove(p_sync_key text, p_member text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare a text;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return false; end if;
  a := public.sync_account_of(p_sync_key);
  if p_member is null then
    update public.sync_accounts set family_of = null, family_since = null where account = a and family_of is not null;
  else
    update public.sync_accounts set family_of = null, family_since = null where account = p_member and family_of = a;
  end if;
  return found;
end $$;

-- ── history ──
create table if not exists public.sync_history (
  sync_key  text not null,
  day       date not null,
  doc       jsonb not null,
  primary key (sync_key, day)
);
create index if not exists sync_history_day on public.sync_history (day);
alter table public.sync_history enable row level security; -- no policies: only the functions below reach it

-- history_bytes per account, kept by every change to the copies
create or replace function public.sync_history_count_bytes()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.sync_accounts set history_bytes = greatest(0, history_bytes - public.sync_doc_size(old.doc))
     where account = public.sync_account_of(old.sync_key);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update public.sync_accounts set history_bytes = history_bytes + public.sync_doc_size(new.doc)
     where account = public.sync_account_of(new.sync_key);
  end if;
  return null;
end $$;
drop trigger if exists sync_history_count_bytes on public.sync_history;
create trigger sync_history_count_bytes after insert or update or delete on public.sync_history
  for each row execute function public.sync_history_count_bytes();

-- each write to a list keeps it as today's copy (the last one of a day is the day's copy), while the account
-- is covered and the copies fit its space; a list's row going (Delete my synced data) takes its copies with it
create or replace function public.tasks_sync_history()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; s public.sync_settings; old_copy bigint;
begin
  if tg_op = 'DELETE' then
    delete from public.sync_history where sync_key = old.sync_key;
    return null;
  end if;
  if position(':' in new.sync_key) > 0 or new.doc ? 'moved' then return null; end if; -- whole lists only, not markers
  if tg_op = 'UPDATE' and old.doc = new.doc then return null; end if;
  delete from public.sync_history where day < current_date - 30;
  select * into acc from public.sync_accounts where account = public.sync_account_of(new.sync_key);
  if not found or not public.sync_paid_now(acc) then return null; end if;
  select * into s from public.sync_settings where id;
  select public.sync_doc_size(doc) into old_copy from public.sync_history where sync_key = new.sync_key and day = current_date;
  if acc.used_bytes + acc.history_bytes - coalesce(old_copy, 0) + public.sync_doc_size(new.doc) > public.sync_quota_of(acc, s) then return null; end if;
  insert into public.sync_history as h (sync_key, day, doc) values (new.sync_key, current_date, new.doc)
    on conflict (sync_key, day) do update set doc = excluded.doc;
  return null;
end $$;
drop trigger if exists tasks_sync_history on public.tasks_sync;
create trigger tasks_sync_history after insert or update or delete on public.tasks_sync
  for each row execute function public.tasks_sync_history();

-- the days a list has a copy of, newest first (the key is the list's row key, as sync_get takes it)
create or replace function public.sync_history_days(p_sync_key text)
returns table(day date)
language sql stable security definer
set search_path = public
as $$ select h.day from public.sync_history h
       where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}$' and h.sync_key = p_sync_key and h.day >= current_date - 30
       order by h.day desc $$;

create or replace function public.sync_history_get(p_sync_key text, p_day date)
returns jsonb
language sql stable security definer
set search_path = public
as $$ select h.doc from public.sync_history h
       where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}$' and h.sync_key = p_sync_key and h.day = p_day $$;

-- ── supporters ──
create table if not exists public.sync_supporters (
  account  text primary key references public.sync_accounts (account) on delete cascade,
  name     text not null,
  since    timestamptz not null default now()
);
alter table public.sync_supporters enable row level security; -- no policies: only the functions below reach it

-- the Stripe webhook, when the payer typed a name for the list (service role only)
create or replace function public.sync_mark_supporter(p_account text, p_name text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]<>]', '', 'g')), 40);
begin
  if p_account is null or p_account !~ '^[0-9a-f]{64}$' or n = '' then return false; end if;
  if not exists (select 1 from public.sync_accounts where account = p_account) then return false; end if;
  insert into public.sync_supporters (account, name) values (p_account, n)
    on conflict (account) do update set name = excluded.name;
  return true;
end $$;

-- everyone paying right now who gave a name, earliest first (anyone may read it: it's the thank-you list)
create or replace function public.sync_supporters_list()
returns table(name text)
language sql stable security definer
set search_path = public
as $$ select s.name from public.sync_supporters s join public.sync_accounts a on a.account = s.account
       where a.paid_until > now() order by s.since limit 200 $$;

revoke all on function public.sync_paid_now(public.sync_accounts), public.sync_paid_until(public.sync_accounts),
  public.sync_quota_of(public.sync_accounts, public.sync_settings), public.sync_server_cap(public.sync_settings),
  public.sync_mark_supporter(text, text), public.sync_history_count_bytes(), public.tasks_sync_history() from public;
revoke execute on function public.sync_paid_now(public.sync_accounts), public.sync_paid_until(public.sync_accounts),
  public.sync_quota_of(public.sync_accounts, public.sync_settings), public.sync_server_cap(public.sync_settings),
  public.sync_mark_supporter(text, text), public.sync_history_count_bytes(), public.tasks_sync_history() from anon, authenticated;
grant execute on function public.sync_mark_supporter(text, text) to service_role;
revoke all on function public.sync_family_invite(text), public.sync_family_join(text, text), public.sync_family_list(text),
  public.sync_family_remove(text, text), public.sync_history_days(text), public.sync_history_get(text, date),
  public.sync_supporters_list(), public.sync_usage(text) from public;
grant execute on function public.sync_family_invite(text), public.sync_family_join(text, text), public.sync_family_list(text),
  public.sync_family_remove(text, text), public.sync_history_days(text), public.sync_history_get(text, date),
  public.sync_supporters_list(), public.sync_usage(text) to anon, authenticated, service_role;
