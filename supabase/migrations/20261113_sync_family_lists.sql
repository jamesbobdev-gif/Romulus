-- Shared lists and sending to-dos between people on one family plan (renderer/js/family.js).
-- Everything shared lives in one ordinary synced row under a family key the payer's app makes, so it is
-- sealed like every other list and this server can't read it. This migration only moves that key around:
--   - an invite carries it, sealed with a secret that is part of the code the person types but never sent
--     here (the server only ever sees the first 12 characters), so the copy kept with the invite is unreadable;
--   - each account keeps its own copy, sealed with its own lists' key, so all of a person's devices find it.
-- The older sync_family_invite / sync_family_join keep working for older builds: they just carry no key.
-- Paste it all in the SQL editor and press Run, after 20261112_sync_supporter_name.sql.

alter table public.sync_family_invites add column if not exists sealed text;
alter table public.sync_accounts add column if not exists family_key text;

-- a code for one more person, with the family key sealed for them. why: 'not_paid' | 'family_full' | 'bad'
create or replace function public.sync_family_invite2(p_sync_key text, p_sealed text)
returns table(code text, why text)
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; c text; n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return query select null::text, 'bad'::text; return; end if;
  if p_sealed is null or length(p_sealed) > 2000 then return query select null::text, 'bad'::text; return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found or not coalesce(acc.paid_until > now(), false) then return query select null::text, 'not_paid'::text; return; end if;
  select count(*) into n from public.sync_accounts where family_of = acc.account;
  if n >= 4 then return query select null::text, 'family_full'::text; return; end if;
  -- old codes go after 2 days; this payer's earlier unused codes stay good until then
  delete from public.sync_family_invites where made_at < now() - interval '2 days';
  if (select count(*) from public.sync_family_invites where payer = acc.account) >= 8 then
    delete from public.sync_family_invites where code = (select i.code from public.sync_family_invites i where i.payer = acc.account order by i.made_at limit 1);
  end if;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  c := substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4);
  insert into public.sync_family_invites (code, payer, sealed) values (c, acc.account, p_sealed);
  return query select c, null::text;
end $$;

-- join with a code: why null = joined, and sealed is the family key (null for a code from an older build).
-- why: 'bad' | 'rate' | 'no_code' | 'no_account' | 'own' | 'family_full'
create or replace function public.sync_family_join2(p_sync_key text, p_code text)
returns table(why text, sealed text)
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; inv public.sync_family_invites; n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_code is null then return query select 'bad'::text, null::text; return; end if;
  if not public.sync_pair_allow('family', 30) then return query select 'rate'::text, null::text; return; end if;
  select * into inv from public.sync_family_invites
    where replace(code, '-', '') = upper(regexp_replace(trim(p_code), '[^A-Za-z0-9]', '', 'g')) and made_at > now() - interval '2 days';
  if not found then return query select 'no_code'::text, null::text; return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return query select 'no_account'::text, null::text; return; end if;
  if acc.account = inv.payer then return query select 'own'::text, null::text; return; end if;
  select count(*) into n from public.sync_accounts where family_of = inv.payer and account <> acc.account;
  if n >= 4 then return query select 'family_full'::text, null::text; return; end if;
  update public.sync_accounts set family_of = inv.payer, family_since = coalesce(case when family_of = inv.payer then family_since end, now())
    where account = acc.account;
  delete from public.sync_family_invites where code = inv.code; -- one code, one person
  return query select null::text, inv.sealed;
end $$;

-- this account's copy of the family key, sealed with its own lists' key (null = none)
create or replace function public.sync_family_key_get(p_sync_key text)
returns text
language sql stable security definer
set search_path = public
as $$ select a.family_key from public.sync_accounts a
       where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}$' and a.account = public.sync_account_of(p_sync_key) $$;

-- keep it (or forget it with null). Only an account on a family plan, paying or covered, keeps one.
create or replace function public.sync_family_key_set(p_sync_key text, p_sealed text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return false; end if;
  if p_sealed is not null and length(p_sealed) > 2000 then return false; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return false; end if;
  if p_sealed is not null and not (coalesce(acc.paid_until > now(), false) or acc.family_of is not null) then return false; end if;
  update public.sync_accounts set family_key = p_sealed where account = acc.account;
  return true;
end $$;

-- leaving, or being taken off, also drops the account's copy of the family key, so its devices stop
-- showing the shared lists (they still could have kept a copy: renderer/js/family.js says so)
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
    update public.sync_accounts set family_of = null, family_since = null, family_key = null where account = a and family_of is not null;
  else
    update public.sync_accounts set family_of = null, family_since = null, family_key = null where account = p_member and family_of = a;
  end if;
  return found;
end $$;

revoke all on function public.sync_family_invite2(text, text), public.sync_family_join2(text, text),
  public.sync_family_key_get(text), public.sync_family_key_set(text, text) from public;
grant execute on function public.sync_family_invite2(text, text), public.sync_family_join2(text, text),
  public.sync_family_key_get(text), public.sync_family_key_set(text, text) to anon, authenticated, service_role;
