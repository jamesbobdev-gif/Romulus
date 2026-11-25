-- Romulus cloud, tighter limits (after the security review of 2026-11-18). Paste it all in the SQL editor and press Run.
-- Needs 20261120_cloud_agent.sql first. Running it twice changes nothing.
--   max_running        an account may have this many tasks being answered at once (more wait for one to finish)
--   reserve_cents      counted against the account and the server the moment a task starts, and corrected to the
--                      real cost when it finishes, so starting many at once can't run past the spending caps
--   new_account_tasks  free accounts younger than a day get only this many, so making accounts to farm free tasks
--                      doesn't pay (the per-address limit also uses an address callers can't fake now)

alter table public.cloud_agent_settings add column if not exists max_running int not null default 2;
alter table public.cloud_agent_settings add column if not exists reserve_cents int not null default 15;
alter table public.cloud_agent_settings add column if not exists new_account_tasks int not null default 3;
alter table public.cloud_agent_jobs add column if not exists reserved numeric not null default 0;

create or replace function public.cloud_agent_start(p_sync_key text, p_ip_hash text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  st jsonb;
  a text := public.sync_account_of(p_sync_key);
  m date := date_trunc('month', now())::date;
  s public.cloud_agent_settings;
  acc public.sync_accounts;
  spent numeric;
  running int;
  n int;
  j uuid;
begin
  -- one start at a time per account, so two at the same moment can't both pass the checks below: the lock comes
  -- first, then the month's numbers are read
  select * into acc from public.sync_accounts where account = a for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'no_account'); end if;
  st := public.cloud_agent_status(p_sync_key);
  if not (st->>'enabled')::boolean then return jsonb_build_object('ok', false, 'why', 'off'); end if;
  select * into s from public.cloud_agent_settings where id;
  if (st->>'used')::int >= (st->>'limit')::int then return jsonb_build_object('ok', false, 'why', 'limit') || st; end if;
  if st->>'cent_limit' is not null and (st->>'cents')::numeric + s.reserve_cents > (st->>'cent_limit')::numeric then
    return jsonb_build_object('ok', false, 'why', 'spend') || st; end if;
  select count(*) into running from public.cloud_agent_jobs
    where account = a and state = 'working' and created_at > now() - interval '15 minutes';
  if running >= s.max_running then return jsonb_build_object('ok', false, 'why', 'busy') || st; end if;
  if st->>'plan' = 'free' and acc.created_at > now() - interval '1 day' and (st->>'used')::int >= s.new_account_tasks then
    return jsonb_build_object('ok', false, 'why', 'new_account') || st; end if;
  select coalesce(sum(cents), 0) into spent from public.cloud_agent_usage where month = m;
  if spent + s.reserve_cents > s.server_cents then return jsonb_build_object('ok', false, 'why', 'server'); end if;
  if st->>'plan' = 'free' and p_ip_hash is not null then
    delete from public.cloud_agent_ips where day < current_date - 2;
    insert into public.cloud_agent_ips as x (ip_hash, day, n) values (p_ip_hash, current_date, 1)
      on conflict (ip_hash, day) do update set n = x.n + 1 returning x.n into n;
    if n > s.free_per_ip_day then return jsonb_build_object('ok', false, 'why', 'ip'); end if;
  end if;
  insert into public.cloud_agent_usage as u (account, month, tasks, cents) values (a, m, 1, s.reserve_cents)
    on conflict (account, month) do update set tasks = u.tasks + 1, cents = u.cents + s.reserve_cents;
  delete from public.cloud_agent_jobs where created_at < now() - interval '2 days';
  insert into public.cloud_agent_jobs (account, reserved) values (a, s.reserve_cents) returning id into j;
  return jsonb_build_object('ok', true, 'job', j, 'used', (st->>'used')::int + 1) || (st - 'used');
end $$;

-- the answer is in (or it failed): keep it sealed for the device, and swap the reservation for the real cost
create or replace function public.cloud_agent_finish(p_job uuid, p_sealed jsonb, p_why text, p_cents numeric)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  a text;
  r numeric;
begin
  update public.cloud_agent_jobs set state = case when p_sealed is not null then 'done' else 'failed' end,
    sealed = p_sealed, why = left(p_why, 300), cents = p_cents, done_at = now()
    where id = p_job and state = 'working' returning account, reserved into a, r;
  if a is null then return false; end if;
  update public.cloud_agent_usage set cents = greatest(cents + greatest(coalesce(p_cents, 0), 0) - coalesce(r, 0), 0)
    where account = a and month = date_trunc('month', now())::date;
  return true;
end $$;

revoke all on function public.cloud_agent_start(text, text), public.cloud_agent_finish(uuid, jsonb, text, numeric)
  from public, anon, authenticated;
grant execute on function public.cloud_agent_start(text, text), public.cloud_agent_finish(uuid, jsonb, text, numeric) to service_role;
