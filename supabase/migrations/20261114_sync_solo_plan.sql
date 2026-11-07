-- The individual plan beside the family/group one (renderer/js/hosted-sync.js, supabase/functions/stripe-webhook):
-- $3 a month or $30 a year for one person: the paid space, 30 days of history and early versions, nothing shared.
-- The family/group plan ($5, up to 5 people) is the same plus the family and the family list, so beside the
-- individual plan it's plainly the better deal. Which plan an account is on comes from the Stripe Payment Link
-- it paid on: the webhook reads the app_secrets row stripe_solo_links (the individual links' plink_ ids, with
-- commas between) and tells sync_mark_paid2. Accounts paid before this stay on the family plan, as they were.
-- Paste it all in the SQL editor and press Run, then deploy stripe-webhook.

alter table public.sync_accounts add column if not exists plan text not null default 'family';
alter table public.sync_accounts drop constraint if exists sync_accounts_plan_check;
alter table public.sync_accounts add constraint sync_accounts_plan_check check (plan in ('solo', 'family'));

-- paying for the family plan right now: only this covers the people who joined
create or replace function public.sync_family_payer(acc public.sync_accounts)
returns boolean
language sql stable security definer
set search_path = public
as $$ select coalesce(acc.paid_until > now(), false) and acc.plan = 'family' $$;

-- covered by a paid plan right now: its own (either plan), or the family plan it joined
create or replace function public.sync_paid_now(acc public.sync_accounts)
returns boolean
language sql stable security definer
set search_path = public
as $$ select coalesce(acc.paid_until > now(), false)
          or (acc.family_of is not null and exists (select 1 from public.sync_accounts p where p.account = acc.family_of and public.sync_family_payer(p))) $$;

create or replace function public.sync_paid_until(acc public.sync_accounts)
returns timestamptz
language sql stable security definer
set search_path = public
as $$ select case when acc.paid_until > now() then acc.paid_until
                  else (select p.paid_until from public.sync_accounts p where p.account = acc.family_of and public.sync_family_payer(p)) end $$;

-- the paying account of the family plan this account is on right now (its own, or the one it joined); null = none.
-- An individual plan has no family, so it heads none.
create or replace function public.sync_family_head(a text)
returns text
language sql stable security definer
set search_path = public
as $$ select case when acc.family_of is not null
                    then (select p.account from public.sync_accounts p where p.account = acc.family_of and public.sync_family_payer(p))
                  when public.sync_family_payer(acc) then acc.account end
       from public.sync_accounts acc where acc.account = a $$;

-- who's on the plan: for the payer, every member; for a member, just that it's covered. role: 'payer' | 'member' | null.
-- An individual plan answers nothing, so the app shows no family box for it.
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
  if public.sync_family_payer(acc) or exists (select 1 from public.sync_accounts where family_of = acc.account) then
    return query select 'payer'::text, m.account, m.family_since from public.sync_accounts m where m.family_of = acc.account order by m.family_since;
    if not found then return query select 'payer'::text, null::text, null::timestamptz; end if;
  end if;
end $$;

-- inviting takes the family plan: an individual plan gets why = 'solo' (the app says to move to the family plan)
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
  if acc.plan <> 'family' then return query select null::text, 'solo'::text; return; end if;
  select count(*) into n from public.sync_accounts where family_of = acc.account;
  if n >= 4 then return query select null::text, 'family_full'::text; return; end if;
  delete from public.sync_family_invites where made_at < now() - interval '2 days';
  delete from public.sync_family_invites where payer = acc.account;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  c := substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4);
  insert into public.sync_family_invites (code, payer) values (c, acc.account);
  return query select c, null::text;
end $$;

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
  if acc.plan <> 'family' then return query select null::text, 'solo'::text; return; end if;
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

-- the family key is for the family plan and the people on it
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
  if p_sealed is not null and not (public.sync_family_payer(acc) or acc.family_of is not null) then return false; end if;
  update public.sync_accounts set family_key = p_sealed where account = acc.account;
  return true;
end $$;

-- sync_usage now also says which plan covers the account: 'solo', 'family' (its own, or one it joined), or null
drop function if exists public.sync_usage(text);
create function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text, paid_until timestamptz, paid_quota_bytes bigint, history_bytes bigint, plan text)
language plpgsql stable security definer
set search_path = public
as $$
declare s public.sync_settings; acc public.sync_accounts; ip text; cnt int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices))?$' then return; end if;
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if found then
    return query select acc.used_bytes + public.sync_files_bytes(acc.account), public.sync_quota_of(acc, s),
      case when acc.refused_at > now() - interval '30 seconds' then acc.refused end,
      public.sync_paid_until(acc), s.paid_quota_bytes, acc.history_bytes,
      case when acc.paid_until > now() then acc.plan when public.sync_paid_now(acc) then 'family' end;
    return;
  end if;
  -- no account yet: say whether making one would be refused right now
  ip := public.sync_caller_ip_hash();
  select x.n into cnt from public.sync_new_accounts x where x.ip_hash = ip and x.hour = date_trunc('hour', now());
  return query select 0::bigint, s.free_quota_bytes,
    case when pg_database_size(current_database()) > public.sync_server_cap(s) then 'server_full'
         when coalesce(cnt, 0) >= s.new_accounts_per_ip_hour then 'new_accounts' end,
    null::timestamptz, s.paid_quota_bytes, 0::bigint, null::text;
end $$;

-- Stripe said an account paid (supabase/functions/stripe-webhook, service role only), now with the plan it paid
-- for: p_plan 'solo' or 'family' on the first payment, null on a renewal (the plan stays). p_account = the account
-- id the app put in the checkout link (sha256 of its key id), or null to find it by the subscription.
-- ok is false when no such account exists. replaced is the subscription the account had before, when it was
-- another one still paid up (someone moved between the plans): the webhook cancels it at Stripe so nobody pays twice.
create or replace function public.sync_mark_paid2(p_account text, p_subscription text, p_customer text, p_until timestamptz, p_plan text)
returns table(ok boolean, replaced text)
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; old text;
begin
  if p_plan is not null and p_plan not in ('solo', 'family') then return query select false, null::text; return; end if;
  if p_account is not null and p_account !~ '^[0-9a-f]{64}$' then return query select false, null::text; return; end if;
  select * into acc from public.sync_accounts
    where (p_account is not null and account = p_account)
       or (p_account is null and p_subscription is not null and stripe_subscription = p_subscription);
  if not found then return query select false, null::text; return; end if;
  if p_subscription is not null and acc.stripe_subscription is not null and acc.stripe_subscription <> p_subscription
     and coalesce(acc.paid_until > now(), false) then old := acc.stripe_subscription; end if;
  update public.sync_accounts set
      paid_until = greatest(coalesce(paid_until, p_until), p_until),
      stripe_subscription = coalesce(p_subscription, stripe_subscription),
      stripe_customer = coalesce(p_customer, stripe_customer),
      plan = coalesce(p_plan, plan)
    where account = acc.account;
  return query select true, old;
end $$;

revoke all on function public.sync_family_payer(public.sync_accounts), public.sync_mark_paid2(text, text, text, timestamptz, text) from public;
revoke execute on function public.sync_family_payer(public.sync_accounts), public.sync_mark_paid2(text, text, text, timestamptz, text) from anon, authenticated;
grant execute on function public.sync_mark_paid2(text, text, text, timestamptz, text) to service_role;
revoke all on function public.sync_usage(text) from public;
grant execute on function public.sync_usage(text) to anon, authenticated, service_role;
