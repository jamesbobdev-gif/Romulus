-- Group plans (renderer/js/family.js, renderer/js/hosted-sync.js):
--   * Two paid plans. Group (the default, and what everyone paying before this has) covers the payer and up to
--     4 more people. Personal is just the payer. The Stripe Payment Link for Personal carries the metadata
--     plan=personal, and stripe-webhook passes it to sync_set_plan.
--   * Anyone can start a group for free with one other person: shared lists and sent to-dos, no extra space.
--     Only the Group plan makes room for 4 more and gives them the paid space.
--   * Taking someone off (or someone leaving) moves the group's shared lists to a new key the person who left
--     never gets. Each person on a group keeps a P-256 public key here (family_pub); the owner's app seals the
--     new key to each remaining person's public key and leaves it in family_key_next, which their app opens
--     with the private half (kept only inside their own sealed copy of the key, which this server can't read).
-- Paste it all in the SQL editor and press Run, after 20261114_ai_reports.sql.

alter table public.sync_accounts add column if not exists plan text;              -- null or 'group' = Group, 'personal' = Personal
alter table public.sync_accounts add column if not exists family_pub text;        -- this account's public key (a JWK) for a new group key
alter table public.sync_accounts add column if not exists family_key_next text;   -- a new group key sealed to family_pub, waiting to be picked up
alter table public.sync_accounts add column if not exists family_rekey_at timestamptz;

-- how many more people an owner's group can take: 4 on the Group plan, 1 otherwise (free, or Personal)
create or replace function public.sync_group_room(acc public.sync_accounts)
returns int
language sql stable security definer
set search_path = public
as $$ select case when coalesce(acc.paid_until > now(), false) and coalesce(acc.plan, 'group') = 'group' then 4 else 1 end $$;

-- a member gets the paid space only from an owner on the Group plan (not from a free group or a Personal plan)
create or replace function public.sync_paid_now(acc public.sync_accounts)
returns boolean
language sql stable security definer
set search_path = public
as $$ select coalesce(acc.paid_until > now(), false)
          or (acc.family_of is not null and exists (select 1 from public.sync_accounts p where p.account = acc.family_of
                and p.paid_until > now() and coalesce(p.plan, 'group') = 'group')) $$;

create or replace function public.sync_paid_until(acc public.sync_accounts)
returns timestamptz
language sql stable security definer
set search_path = public
as $$ select case when acc.paid_until > now() then acc.paid_until
                  else (select p.paid_until from public.sync_accounts p where p.account = acc.family_of
                          and p.paid_until > now() and coalesce(p.plan, 'group') = 'group') end $$;

-- set by stripe-webhook when a checkout finishes: which plan that payment was for
create or replace function public.sync_set_plan(p_account text, p_subscription text, p_plan text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_plan is null or p_plan not in ('group', 'personal') then return false; end if;
  update public.sync_accounts set plan = p_plan
    where (p_account is not null and p_account ~ '^[0-9a-f]{64}$' and account = p_account)
       or (p_account is null and p_subscription is not null and stripe_subscription = p_subscription);
  return found;
end $$;

-- a code for one more person. Anyone may make one now; the room depends on the plan (sync_group_room).
-- why: 'free_full' (a free or Personal group already has its one other person) | 'family_full' | 'member' | 'bad'
create or replace function public.sync_family_invite2(p_sync_key text, p_sealed text)
returns table(code text, why text)
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; c text; n int; room int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return query select null::text, 'bad'::text; return; end if;
  if p_sealed is null or length(p_sealed) > 2000 then return query select null::text, 'bad'::text; return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return query select null::text, 'bad'::text; return; end if;
  if acc.family_of is not null then return query select null::text, 'member'::text; return; end if;
  room := public.sync_group_room(acc);
  select count(*) into n from public.sync_accounts where family_of = acc.account;
  if n >= room then return query select null::text, (case when room < 4 then 'free_full' else 'family_full' end)::text; return; end if;
  delete from public.sync_family_invites where made_at < now() - interval '2 days';
  if (select count(*) from public.sync_family_invites where payer = acc.account) >= 8 then
    delete from public.sync_family_invites where code = (select i.code from public.sync_family_invites i where i.payer = acc.account order by i.made_at limit 1);
  end if;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  c := substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4);
  insert into public.sync_family_invites (code, payer, sealed) values (c, acc.account, p_sealed);
  return query select c, null::text;
end $$;

-- join with a code. why: 'bad' | 'rate' | 'no_code' | 'no_account' | 'own' | 'family_full' | 'free_full' | 'owner'
create or replace function public.sync_family_join2(p_sync_key text, p_code text)
returns table(why text, sealed text)
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; own_acc public.sync_accounts; inv public.sync_family_invites; n int; room int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_code is null then return query select 'bad'::text, null::text; return; end if;
  if not public.sync_pair_allow('family', 30) then return query select 'rate'::text, null::text; return; end if;
  select * into inv from public.sync_family_invites
    where replace(code, '-', '') = upper(regexp_replace(trim(p_code), '[^A-Za-z0-9]', '', 'g')) and made_at > now() - interval '2 days';
  if not found then return query select 'no_code'::text, null::text; return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return query select 'no_account'::text, null::text; return; end if;
  if acc.account = inv.payer then return query select 'own'::text, null::text; return; end if;
  -- someone who has a group of their own can't be in another one too
  if exists (select 1 from public.sync_accounts where family_of = acc.account) then return query select 'owner'::text, null::text; return; end if;
  select * into own_acc from public.sync_accounts where account = inv.payer;
  room := public.sync_group_room(own_acc);
  select count(*) into n from public.sync_accounts where family_of = inv.payer and account <> acc.account;
  if n >= room then return query select (case when room < 4 then 'free_full' else 'family_full' end)::text, null::text; return; end if;
  update public.sync_accounts set family_of = inv.payer, family_since = coalesce(case when family_of = inv.payer then family_since end, now()),
      family_key_next = null
    where account = acc.account;
  delete from public.sync_family_invites where code = inv.code;
  return query select null::text, inv.sealed;
end $$;

-- who is in the group. For the owner: one row per member (account, since, public key), or one row with a null
-- member when nobody has joined yet; room = how many the plan takes, plan = the owner's plan
-- ('group' | 'personal' | null for free). For a member: one row, role 'member'.
create or replace function public.sync_family_list2(p_sync_key text)
returns table(role text, member text, since timestamptz, pub text, room int, plan text)
language plpgsql stable security definer
set search_path = public
as $$
declare acc public.sync_accounts; pl text;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return; end if;
  if acc.family_of is not null then
    return query select 'member'::text, null::text, acc.family_since, null::text, null::int,
      (select case when p.paid_until > now() then coalesce(p.plan, 'group') end from public.sync_accounts p where p.account = acc.family_of);
    return;
  end if;
  pl := case when acc.paid_until > now() then coalesce(acc.plan, 'group') end;
  return query select 'owner'::text, m.account, m.family_since, m.family_pub, public.sync_group_room(acc), pl
    from public.sync_accounts m where m.family_of = acc.account order by m.family_since;
  if not found then return query select 'owner'::text, null::text, null::timestamptz, null::text, public.sync_group_room(acc), pl; end if;
end $$;

-- this account's sealed copy of the group key, and a new key waiting for it (sealed to its public key)
create or replace function public.sync_family_key_get2(p_sync_key text)
returns table(sealed text, next text)
language sql stable security definer
set search_path = public
as $$ select a.family_key, a.family_key_next from public.sync_accounts a
       where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}$' and a.account = public.sync_account_of(p_sync_key) $$;

-- keep the sealed copy (null forgets it) and the public key; picking up a new key clears it
create or replace function public.sync_family_key_set2(p_sync_key text, p_sealed text, p_pub text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return false; end if;
  if (p_sealed is not null and length(p_sealed) > 4000) or (p_pub is not null and length(p_pub) > 400) then return false; end if;
  update public.sync_accounts set family_key = p_sealed, family_pub = coalesce(p_pub, family_pub), family_key_next = null
    where account = public.sync_account_of(p_sync_key);
  return found;
end $$;

-- the owner starts moving the group to a new key: false when another of their devices started one in the
-- last 2 minutes, so two devices don't make two different keys
create or replace function public.sync_family_rekey_lock(p_sync_key text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return false; end if;
  update public.sync_accounts set family_rekey_at = now()
    where account = public.sync_account_of(p_sync_key) and family_of is null
      and (family_rekey_at is null or family_rekey_at < now() - interval '2 minutes');
  return found;
end $$;

-- the owner leaves the new key, sealed to a member's public key, for that member to pick up
create or replace function public.sync_family_rekey(p_sync_key text, p_member text, p_wrapped text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' or p_wrapped is null or length(p_wrapped) > 2000 then return false; end if;
  update public.sync_accounts set family_key_next = p_wrapped
    where account = p_member and family_of = public.sync_account_of(p_sync_key);
  return found;
end $$;

-- leaving, or being taken off, drops everything group-related from that account
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
    update public.sync_accounts set family_of = null, family_since = null, family_key = null, family_key_next = null
      where account = a and family_of is not null;
  else
    update public.sync_accounts set family_of = null, family_since = null, family_key = null, family_key_next = null
      where account = p_member and family_of = a;
  end if;
  return found;
end $$;

revoke all on function public.sync_group_room(public.sync_accounts), public.sync_set_plan(text, text, text) from public;
revoke execute on function public.sync_group_room(public.sync_accounts), public.sync_set_plan(text, text, text) from anon, authenticated;
grant execute on function public.sync_set_plan(text, text, text) to service_role;
revoke all on function public.sync_family_list2(text), public.sync_family_key_get2(text), public.sync_family_key_set2(text, text, text),
  public.sync_family_rekey_lock(text), public.sync_family_rekey(text, text, text) from public;
grant execute on function public.sync_family_list2(text), public.sync_family_key_get2(text), public.sync_family_key_set2(text, text, text),
  public.sync_family_rekey_lock(text), public.sync_family_rekey(text, text, text) to anon, authenticated, service_role;
