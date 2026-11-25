-- The family list, on the Romulus server (renderer/js/family-list.js): one list the people on a $5 family plan
-- share, sealed end-to-end under a key of its own like every other list. What the server does for it:
--   Codes: someone on a paid family plan makes a 12-character code in the app. The app stretches it (PBKDF2,
--          600,000 rounds) into a lookup id and a key, seals the list's key with that, and stores only the id
--          and the ciphertext here. Anyone on the same paid plan who types the code gets the sealed copy back
--          and opens it in their app. The code itself never comes here, so the server can't open it. A code
--          works for 2 days, for everyone on that plan, and for nobody else.
--   Closing: when someone leaves or is taken off, the payer's app moves the list to a new key and leaves the
--          new key under the old row, sealed to each kept device's own public key. That row is marked
--          {"closed":1} outside the seal, and from then on takes no more writes, so someone who still has the
--          old key can't overwrite the hand-off the others need.
-- Paste it all in the SQL editor and press Run, after 20261107_sync_supporter_perks.sql.

-- ── tries per network ──
-- sync_pair_allow counts tries in sync_pair_tries, whose kind could only be 'put' or 'take'
-- (20261101_sync_pairing.sql). sync_family_join counts 'family' there, so joining a family plan failed on that
-- check; the family list's codes count two kinds more.
alter table public.sync_pair_tries drop constraint if exists sync_pair_tries_kind_check;
alter table public.sync_pair_tries add constraint sync_pair_tries_kind_check
  check (kind in ('put', 'take', 'family', 'family-list', 'family-list-put'));

-- ── codes ──
create table if not exists public.sync_family_shares (
  id       text primary key check (id ~ '^[0-9a-f]{64}$'),
  payer    text not null references public.sync_accounts (account) on delete cascade,
  sealed   text not null check (length(sealed) <= 2048),
  made_at  timestamptz not null default now()
);
create index if not exists sync_family_shares_payer on public.sync_family_shares (payer);
alter table public.sync_family_shares enable row level security; -- no policies: only the functions below reach it

-- the paying account of the plan this account is on right now (its own, or the family's it joined); null = none
create or replace function public.sync_family_head(a text)
returns text
language sql stable security definer
set search_path = public
as $$ select case when acc.family_of is not null
                    then (select p.account from public.sync_accounts p where p.account = acc.family_of and p.paid_until > now())
                  when acc.paid_until > now() then acc.account end
       from public.sync_accounts acc where acc.account = a $$;

-- keep a code for the family list. null = kept; else 'bad' | 'rate' | 'no_account' | 'not_family'
create or replace function public.sync_family_share_put(p_sync_key text, p_id text, p_sealed text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare head text;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_id is null or p_id !~ '^[0-9a-f]{64}$'
     or p_sealed is null or length(p_sealed) > 2048 then return 'bad'; end if;
  if not public.sync_pair_allow('family-list-put', 20) then return 'rate'; end if;
  if not exists (select 1 from public.sync_accounts where account = public.sync_account_of(p_sync_key)) then return 'no_account'; end if;
  head := public.sync_family_head(public.sync_account_of(p_sync_key));
  if head is null then return 'not_family'; end if;
  delete from public.sync_family_shares where made_at < now() - interval '2 days';
  -- a family keeps its 5 newest codes
  delete from public.sync_family_shares where id in
    (select id from public.sync_family_shares where payer = head order by made_at desc offset 4);
  insert into public.sync_family_shares (id, payer, sealed) values (p_id, head, p_sealed)
    on conflict (id) do nothing;
  return null;
end $$;

-- the sealed key for a code, only for someone on the same paid plan. refused: 'bad' | 'rate' | 'no_account' | 'not_family' | 'no_code'
create or replace function public.sync_family_share_take(p_sync_key text, p_id text)
returns table(sealed text, refused text)
language plpgsql security definer
set search_path = public
as $$
declare head text; s public.sync_family_shares;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_id is null or p_id !~ '^[0-9a-f]{64}$' then
    return query select null::text, 'bad'::text; return;
  end if;
  if not public.sync_pair_allow('family-list', 30) then return query select null::text, 'rate'::text; return; end if; -- guessing codes from one network
  if not exists (select 1 from public.sync_accounts where account = public.sync_account_of(p_sync_key)) then
    return query select null::text, 'no_account'::text; return;
  end if;
  select * into s from public.sync_family_shares x where x.id = p_id and x.made_at > now() - interval '2 days';
  if not found then return query select null::text, 'no_code'::text; return; end if;
  head := public.sync_family_head(public.sync_account_of(p_sync_key));
  if head is null or head <> s.payer then return query select null::text, 'not_family'::text; return; end if;
  return query select s.sealed, null::text; -- not used up: everyone on the plan can use the same code
end $$;

-- ── closed rows ──
create or replace function public.sync_is_closed(p_sync_key text)
returns boolean
language sql stable
set search_path = public
as $$ select coalesce((select doc ? 'closed' from public.tasks_sync where sync_key = p_sync_key), false) $$;

-- the two writes, from 20261106_sync_devices_key.sql with one line more each: a closed row takes no write
create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_is_closed(p_sync_key) then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_is_closed(p_sync_key) then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;

revoke all on function public.sync_family_head(text), public.sync_is_closed(text) from public;
revoke execute on function public.sync_family_head(text), public.sync_is_closed(text) from anon, authenticated;
revoke all on function public.sync_family_share_put(text, text, text), public.sync_family_share_take(text, text),
  public.sync_put(text, jsonb, timestamptz), public.sync_set(text, jsonb) from public;
grant execute on function public.sync_family_share_put(text, text, text), public.sync_family_share_take(text, text),
  public.sync_put(text, jsonb, timestamptz), public.sync_set(text, jsonb) to anon, authenticated, service_role;
