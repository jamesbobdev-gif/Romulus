-- Sync keys hardened for a project other people's devices share. The key is still the password to a list
-- (no accounts, no auth.uid()): every table stays closed to the API roles and is reached only through the
-- functions. What changes:
--   - a new account needs a key whose id part is 32+ characters. The app's keys are tk_ + a UUID (36) and the
--     encrypted lists' lookup ids are 32, so every key it makes passes; a short hand-typed key, which someone
--     else on the project could guess, can't start a new account (sync_guard says 'weak_key'). Accounts that
--     already exist keep working whatever their key.
--   - sync_get reads only rows keyed like the app's (tk_<id>, optionally :<side row>), not any 16+ characters.
--   - widget_complete_task and agent_claim_task check the key's shape like the writes do.
--   - sync_doc_size gets a fixed search_path (Supabase's function_search_path_mutable advisor).
-- Same functions otherwise; supabase/setup.sql has the same.

create or replace function public.sync_doc_size(p_doc jsonb)
returns bigint
language sql immutable
set search_path = public
as $$ select coalesce(octet_length(p_doc::text), 0)::bigint $$;

create or replace function public.sync_get(p_sync_key text, p_since timestamptz default null)
returns table(doc jsonb, updated_at timestamptz, topic text, unchanged boolean)
language sql stable security definer
set search_path = public
as $$
  select case when p_since is not null and s.updated_at = p_since then null else s.doc end,
         s.updated_at,
         public.sync_topic_of(p_sync_key),
         (p_since is not null and s.updated_at = p_since)
  from (select 1) x left join public.tasks_sync s on s.sync_key = p_sync_key
  where p_sync_key ~ '^tk_[A-Za-z0-9_-]{13,}(:[a-z]+)?$';
$$;

create or replace function public.sync_guard(p_sync_key text, p_doc jsonb)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  s public.sync_settings;
  a text := public.sync_account_of(p_sync_key);
  acc public.sync_accounts;
  ip text;
  old_size bigint;
  new_size bigint := public.sync_doc_size(p_doc);
  cnt int;
  why text;
begin
  select * into s from public.sync_settings where id;
  select * into acc from public.sync_accounts where account = a for update;
  if not found then
    -- someone new: refused accounts leave no row behind, so a flood of them costs nothing to keep
    if length(regexp_replace(p_sync_key, '^tk_(work_|agent_|school_)?([^:]+)(:.*)?$', '\2')) < 32 then return 'weak_key'; end if;
    if pg_database_size(current_database()) > s.max_total_bytes then return 'server_full'; end if;
    ip := public.sync_caller_ip_hash();
    if ip is not null then
      delete from public.sync_new_accounts where hour < now() - interval '1 day';
      insert into public.sync_new_accounts as x (ip_hash, hour, n) values (ip, date_trunc('hour', now()), 1)
        on conflict (ip_hash, hour) do update set n = x.n + 1
        returning x.n into cnt;
      if cnt > s.new_accounts_per_ip_hour then return 'new_accounts'; end if;
    end if;
    insert into public.sync_accounts (account) values (a) on conflict (account) do nothing;
    select * into acc from public.sync_accounts where account = a for update;
  end if;

  update public.sync_accounts set
      writes_in_window = case when window_start > now() - interval '1 minute' then writes_in_window + 1 else 1 end,
      window_start     = case when window_start > now() - interval '1 minute' then window_start else now() end
    where account = a
    returning writes_in_window into cnt;
  if cnt > s.writes_per_minute then
    why := 'rate';
  else
    select public.sync_doc_size(doc) into old_size from public.tasks_sync where sync_key = p_sync_key;
    if new_size > coalesce(old_size, 0) then -- only growth is checked: a smaller list always saves
      if acc.used_bytes - coalesce(old_size, 0) + new_size > coalesce(acc.quota_bytes, s.free_quota_bytes) then
        why := 'full';
      elsif pg_database_size(current_database()) > s.max_total_bytes then
        why := 'server_full';
      end if;
    end if;
  end if;
  if why is not null then
    update public.sync_accounts set refused = why, refused_at = now() where account = a;
  end if;
  return why;
end $$;

create or replace function public.widget_complete_task(p_sync_key text, p_task_id text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}$' then return false; end if;
  update public.tasks_sync
     set doc = jsonb_set(doc, '{tasks}', (
           select jsonb_agg(case when t->>'id' = p_task_id
             then t || jsonb_build_object('done', true,
                                          'updatedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)
                    || case when p_sync_key like 'tk_agent_%' then '{"status":"done"}'::jsonb else '{}'::jsonb end
             else t end)
           from jsonb_array_elements(doc->'tasks') t)),
         updated_at = now()
   where sync_key = p_sync_key
     and exists (select 1 from jsonb_array_elements(doc->'tasks') t where t->>'id' = p_task_id);
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.agent_claim_task(p_sync_key text, p_task_id text, p_worker text, p_lane text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_agent_[A-Za-z0-9_-]{13,}$' or p_lane not in ('claude', 'local') then return false; end if;
  update public.tasks_sync
     set doc = jsonb_set(doc, '{tasks}', (
           select jsonb_agg(case when t->>'id' = p_task_id
             then t || jsonb_build_object('status', 'working', 'lane', p_lane,
                                          'claimedBy', left(p_worker, 60),
                                          'claimedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint,
                                          'updatedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)
             else t end)
           from jsonb_array_elements(doc->'tasks') t)),
         updated_at = now()
   where sync_key = p_sync_key
     and exists (select 1 from jsonb_array_elements(doc->'tasks') t
                  where t->>'id' = p_task_id
                    and coalesce((t->>'done')::boolean, false) = false
                    and coalesce(t->>'status', 'queued') = 'queued'
                    and coalesce(t->>'lane', p_lane) = p_lane);
  get diagnostics n = row_count;
  return n > 0;
end $$;
