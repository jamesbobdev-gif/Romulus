-- The ':macros' side row next to the agent list: his Food plan from the Health tab (renderer/js/health.js), the
-- per-day calories, protein, carbs and fat he wants, as JSON text ({v:1, text}). The computer that runs the Agent
-- reads it before a grocery run (agent/runner.js, agent/grocery.js macroBrief) and builds the order to add up to it.
-- Built from 20261108_sync_family_lists.sql (the two writes) and 20261114_sync_solo_plan.sql (sync_usage): every
-- key they accept stays, 'macros' is added. Run those first. Until this is in, the plan stays on the device that
-- set it and the Health tab says so.
-- Paste it all in the SQL editor and press Run.

create or replace function public.sync_put(p_sync_key text, p_doc jsonb, p_prev timestamptz)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices|macros))?$' then return false; end if;
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
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices|macros))?$' then return false; end if;
  if p_doc is null or pg_column_size(p_doc) > 4 * 1024 * 1024 then return false; end if;
  if public.sync_is_moved(p_sync_key) and coalesce(p_doc->>'moved', '') <> 'v2' then return false; end if;
  if public.sync_is_closed(p_sync_key) then return false; end if;
  if public.sync_guard(p_sync_key, p_doc) is not null then return false; end if;
  insert into public.tasks_sync (sync_key, doc, updated_at) values (p_sync_key, p_doc, now())
    on conflict (sync_key) do update set doc = excluded.doc, updated_at = now();
  return true;
end $$;

-- sync_usage, as 20261114_sync_solo_plan.sql left it, so a refused ':macros' write can say why
create or replace function public.sync_usage(p_sync_key text)
returns table(used_bytes bigint, quota_bytes bigint, refused text, paid_until timestamptz, paid_quota_bytes bigint, history_bytes bigint, plan text)
language plpgsql stable security definer
set search_path = public
as $$
declare s public.sync_settings; acc public.sync_accounts; ip text; cnt int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:(prefs|locked|routing|standing|ideas|hours|worker|updates|finance|files|files-gone|devices|macros))?$' then return; end if;
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

revoke all on function public.sync_usage(text) from public;
grant execute on function public.sync_usage(text) to anon, authenticated, service_role;
