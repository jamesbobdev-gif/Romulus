-- The name on the supporters list, set from the app (Settings -> Device sync -> Your plan), not only from the
-- optional field on the Stripe checkout page: someone who skipped that field, or paid through a link without it,
-- had nowhere to add or change their name. Only an account paying for its own plan can be listed (a family
-- member's thanks go to whoever pays). An empty name takes them off the list.
-- Paste it all in the SQL editor and press Run, after 20261111_sync_read_limits.sql.

-- the name this account is listed under, or null (for the box in the app)
create or replace function public.sync_supporter_name_get(p_sync_key text)
returns text
language sql stable security definer
set search_path = public
as $$ select s.name from public.sync_supporters s
       where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}$' and s.account = public.sync_account_of(p_sync_key) $$;

-- set it, or clear it with ''. null = done; else 'bad' | 'not_paid'
create or replace function public.sync_supporter_name_set(p_sync_key text, p_name text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare acc public.sync_accounts; n text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]<>]', '', 'g')), 40);
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return 'bad'; end if;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return 'not_paid'; end if;
  if n = '' then delete from public.sync_supporters where account = acc.account; return null; end if;
  if not coalesce(acc.paid_until > now(), false) then return 'not_paid'; end if;
  insert into public.sync_supporters (account, name) values (acc.account, n)
    on conflict (account) do update set name = excluded.name;
  return null;
end $$;

revoke all on function public.sync_supporter_name_get(text), public.sync_supporter_name_set(text, text) from public;
grant execute on function public.sync_supporter_name_get(text), public.sync_supporter_name_set(text, text)
  to anon, authenticated, service_role;
