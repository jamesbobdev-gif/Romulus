-- Pairing codes (renderer/js/pair.js). A device that already syncs shows a 12-character code (60 random
-- bits) and leaves its sync code here, sealed; the new device types the code and takes it. The code itself
-- never reaches the server: both devices stretch it (PBKDF2-SHA256, 600,000 rounds) into a lookup id and an
-- AES-256-GCM key, and only the id and the sealed sync code are stored. So the database, its logs and
-- whoever runs it can't open one, and a guess costs the stretching every time.
-- A code lasts 10 minutes and works once (the sealed text is wiped as it's handed out). Guesses and new
-- codes are limited per network, so a code can't be searched for from outside in the time it lives. The
-- device that made a code can see whether it was taken, and withdraw it, with a watch token only it has.
-- Everything is reached only through the functions below; the tables are closed to the API roles.

create table if not exists public.sync_pairs (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  sealed text check (sealed is null or length(sealed) <= 8192),
  watch_hash text not null,
  created_at timestamptz not null default now(),
  taken_at timestamptz
);
alter table public.sync_pairs enable row level security;

create table if not exists public.sync_pair_tries (
  ip_hash text not null,
  kind text not null check (kind in ('put', 'take')),
  hour timestamptz not null,
  n int not null default 0,
  primary key (ip_hash, kind, hour)
);
alter table public.sync_pair_tries enable row level security;

revoke all on table public.sync_pairs, public.sync_pair_tries from anon, authenticated;

-- counts one more p_kind from the caller's network this hour; true while it's within p_max
create or replace function public.sync_pair_allow(p_kind text, p_max int)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare cnt int;
begin
  delete from public.sync_pair_tries where hour < now() - interval '1 day';
  insert into public.sync_pair_tries as t (ip_hash, kind, hour, n)
    values (coalesce(public.sync_caller_ip_hash(), 'none'), p_kind, date_trunc('hour', now()), 1)
    on conflict (ip_hash, kind, hour) do update set n = t.n + 1
    returning n into cnt;
  return cnt <= p_max;
end $$;

-- a new code: null when it's stored, else why not ('bad' | 'rate' | 'busy')
create or replace function public.sync_pair_put(p_id text, p_sealed text, p_watch text)
returns text
language plpgsql security definer
set search_path = public
as $$
begin
  if p_id is null or p_id !~ '^[0-9a-f]{64}$' or p_watch is null or p_watch !~ '^[0-9a-f]{64}$'
     or p_sealed is null or length(p_sealed) > 8192 then return 'bad'; end if;
  if not public.sync_pair_allow('put', 20) then return 'rate'; end if;
  delete from public.sync_pairs where created_at < now() - interval '1 hour';
  if (select count(*) from public.sync_pairs where created_at > now() - interval '10 minutes') >= 500 then return 'busy'; end if;
  insert into public.sync_pairs (id, sealed, watch_hash) values (p_id, p_sealed, encode(sha256(convert_to(p_watch, 'UTF8')), 'hex'))
    on conflict (id) do nothing;
  return case when found then null else 'bad' end;
end $$;

-- the new device takes a code: the sealed sync code once, while it's fresh; refused = 'rate' when this
-- network has guessed too often. A wrong, used or run-out code all look the same (nothing).
create or replace function public.sync_pair_take(p_id text)
returns table(sealed text, refused text)
language plpgsql security definer
set search_path = public
as $$
declare s text;
begin
  if not public.sync_pair_allow('take', 30) then return query select null::text, 'rate'::text; return; end if;
  if p_id is null or p_id !~ '^[0-9a-f]{64}$' then return; end if;
  select p.sealed into s from public.sync_pairs p
   where p.id = p_id and p.taken_at is null and p.sealed is not null and p.created_at > now() - interval '10 minutes'
   for update;
  if s is null then return; end if;
  update public.sync_pairs set sealed = null, taken_at = now() where id = p_id;
  return query select s, null::text;
end $$;

-- the device that made the code: 'waiting' | 'taken' | 'expired' | 'gone' (wrong watch token looks like gone)
create or replace function public.sync_pair_state(p_id text, p_watch text)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare r public.sync_pairs;
begin
  select * into r from public.sync_pairs
   where id = p_id and watch_hash = encode(sha256(convert_to(coalesce(p_watch, ''), 'UTF8')), 'hex');
  if not found then return 'gone'; end if;
  if r.taken_at is not null then return 'taken'; end if;
  if r.created_at <= now() - interval '10 minutes' then return 'expired'; end if;
  return 'waiting';
end $$;

-- the device that made the code withdraws it (hidden, closed, or a new one made)
create or replace function public.sync_pair_cancel(p_id text, p_watch text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  delete from public.sync_pairs
   where id = p_id and watch_hash = encode(sha256(convert_to(coalesce(p_watch, ''), 'UTF8')), 'hex');
  return found;
end $$;

revoke all on function public.sync_pair_allow(text, int), public.sync_pair_put(text, text, text), public.sync_pair_take(text),
  public.sync_pair_state(text, text), public.sync_pair_cancel(text, text) from public;
revoke execute on function public.sync_pair_allow(text, int) from anon, authenticated;
grant execute on function public.sync_pair_put(text, text, text), public.sync_pair_take(text),
  public.sync_pair_state(text, text), public.sync_pair_cancel(text, text) to anon, authenticated, service_role;
