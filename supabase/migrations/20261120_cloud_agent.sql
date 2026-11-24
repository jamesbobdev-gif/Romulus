-- Romulus cloud: Agent tasks answered on this project when none of a person's own computers is on to take them
-- (supabase/functions/cloud-agent, renderer/js/cloud-agent.js). Only for accounts that sync here; each person opts in
-- on their device. The AI key is the function's own secret (ANTHROPIC_API_KEY, set in the dashboard), never in a table.
-- What this keeps:
--   cloud_agent_settings  one row: on/off, the model, and the limits (change them here any time)
--   cloud_agent_usage     per account per month: how many tasks and roughly what they cost
--   cloud_agent_ips       per caller (hashed address) per day: a brake on people making accounts to farm free tasks
--   cloud_agent_jobs      an answer waiting to be picked up, sealed so only the device that asked can open it.
--                         The task itself is never stored; a picked-up or 2-day-old answer is deleted.
-- Only the function (service role) can call these; the app's key can't. Paste it all in the SQL editor and press Run.

create table if not exists public.cloud_agent_settings (
  id                   boolean primary key default true check (id),
  enabled              boolean not null default false, -- off until the function has its key
  model                text not null default 'claude-opus-5-5',
  effort               text not null default 'medium',
  free_tasks           int not null default 20,    -- a month, accounts on the free space
  paid_tasks           int not null default 300,   -- a month, accounts on a paid plan (or a paid group)
  owner_tasks          int not null default 3000,  -- a month, the project's owner accounts
  free_cents           int not null default 100,   -- the most a free account may cost a month, whatever the count
  paid_cents           int not null default 1500,  -- the same for a paid account
  task_cents           int not null default 60,    -- one task stops near this
  server_cents         int not null default 10000, -- the whole project a month: past it, nobody gets cloud tasks
  free_per_ip_day      int not null default 15     -- free-account tasks one address may start a day
);
insert into public.cloud_agent_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.cloud_agent_usage (
  account text not null,
  month   date not null,
  tasks   int not null default 0,
  cents   numeric not null default 0,
  primary key (account, month)
);
create table if not exists public.cloud_agent_ips (
  ip_hash text not null,
  day     date not null,
  n       int not null default 0,
  primary key (ip_hash, day)
);
create table if not exists public.cloud_agent_jobs (
  id         uuid primary key default gen_random_uuid(),
  account    text not null,
  state      text not null default 'working', -- 'working' | 'done' | 'failed'
  sealed     jsonb,                            -- {epk, iv, ct}: only the asking device's key opens it
  why        text,                             -- why it failed, in plain words
  cents      numeric,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists cloud_agent_jobs_account on public.cloud_agent_jobs (account);
alter table public.cloud_agent_settings enable row level security;
alter table public.cloud_agent_usage enable row level security;
alter table public.cloud_agent_ips enable row level security;
alter table public.cloud_agent_jobs enable row level security;

-- this account's month so far and its allowance → {enabled, plan, used, limit, cents, cent_limit}
create or replace function public.cloud_agent_status(p_sync_key text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  s public.cloud_agent_settings;
  acc public.sync_accounts;
  u public.cloud_agent_usage;
  plan text;
begin
  select * into s from public.cloud_agent_settings where id;
  select * into acc from public.sync_accounts where account = public.sync_account_of(p_sync_key);
  if not found then return jsonb_build_object('enabled', false, 'why', 'no_account'); end if;
  plan := case when acc.owner then 'owner' when public.sync_paid_now(acc) then 'paid' else 'free' end;
  select * into u from public.cloud_agent_usage where account = acc.account and month = date_trunc('month', now())::date;
  return jsonb_build_object('enabled', s.enabled, 'plan', plan,
    'used', coalesce(u.tasks, 0), 'cents', coalesce(u.cents, 0),
    'limit', case plan when 'owner' then s.owner_tasks when 'paid' then s.paid_tasks else s.free_tasks end,
    'cent_limit', case plan when 'owner' then null when 'paid' then s.paid_cents else s.free_cents end,
    'task_cents', s.task_cents, 'model', s.model, 'effort', s.effort);
end $$;

-- take one task from the allowance and open a job for its answer → {ok, job, used, limit, model, effort, task_cents}
-- or {ok: false, why: 'off' | 'no_account' | 'limit' | 'spend' | 'server' | 'ip'}
create or replace function public.cloud_agent_start(p_sync_key text, p_ip_hash text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  st jsonb := public.cloud_agent_status(p_sync_key);
  a text := public.sync_account_of(p_sync_key);
  m date := date_trunc('month', now())::date;
  s public.cloud_agent_settings;
  spent numeric;
  n int;
  j uuid;
begin
  if st->>'why' = 'no_account' then return jsonb_build_object('ok', false, 'why', 'no_account'); end if;
  if not (st->>'enabled')::boolean then return jsonb_build_object('ok', false, 'why', 'off'); end if;
  select * into s from public.cloud_agent_settings where id;
  if (st->>'used')::int >= (st->>'limit')::int then return jsonb_build_object('ok', false, 'why', 'limit') || st; end if;
  if st->>'cent_limit' is not null and (st->>'cents')::numeric >= (st->>'cent_limit')::numeric then
    return jsonb_build_object('ok', false, 'why', 'spend') || st; end if;
  select coalesce(sum(cents), 0) into spent from public.cloud_agent_usage where month = m;
  if spent >= s.server_cents then return jsonb_build_object('ok', false, 'why', 'server'); end if;
  if st->>'plan' = 'free' and p_ip_hash is not null then
    delete from public.cloud_agent_ips where day < current_date - 2;
    insert into public.cloud_agent_ips as x (ip_hash, day, n) values (p_ip_hash, current_date, 1)
      on conflict (ip_hash, day) do update set n = x.n + 1 returning x.n into n;
    if n > s.free_per_ip_day then return jsonb_build_object('ok', false, 'why', 'ip'); end if;
  end if;
  insert into public.cloud_agent_usage as u (account, month, tasks) values (a, m, 1)
    on conflict (account, month) do update set tasks = u.tasks + 1;
  delete from public.cloud_agent_jobs where created_at < now() - interval '2 days';
  insert into public.cloud_agent_jobs (account) values (a) returning id into j;
  return jsonb_build_object('ok', true, 'job', j, 'used', (st->>'used')::int + 1) || (st - 'used');
end $$;

-- the answer is in (or it failed): keep it sealed for the device, and count what it cost
create or replace function public.cloud_agent_finish(p_job uuid, p_sealed jsonb, p_why text, p_cents numeric)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  a text;
begin
  update public.cloud_agent_jobs set state = case when p_sealed is not null then 'done' else 'failed' end,
    sealed = p_sealed, why = left(p_why, 300), cents = p_cents, done_at = now()
    where id = p_job and state = 'working' returning account into a;
  if a is null then return false; end if;
  update public.cloud_agent_usage set cents = cents + greatest(coalesce(p_cents, 0), 0)
    where account = a and month = date_trunc('month', now())::date;
  return true;
end $$;

-- the device asks for its answer: {state, sealed, why}; a finished one is handed over once and deleted
create or replace function public.cloud_agent_take(p_sync_key text, p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r public.cloud_agent_jobs;
begin
  select * into r from public.cloud_agent_jobs where id = p_job and account = public.sync_account_of(p_sync_key);
  if not found then return jsonb_build_object('state', 'gone'); end if;
  if r.state = 'working' then
    -- the function stops by itself well before this: a job still "working" after 15 minutes was lost
    if r.created_at < now() - interval '15 minutes' then
      delete from public.cloud_agent_jobs where id = r.id;
      return jsonb_build_object('state', 'failed', 'why', 'The answer was lost on the way. Try again.');
    end if;
    return jsonb_build_object('state', 'working');
  end if;
  delete from public.cloud_agent_jobs where id = r.id;
  return jsonb_build_object('state', r.state, 'sealed', r.sealed, 'why', r.why);
end $$;

revoke all on function public.cloud_agent_status(text), public.cloud_agent_start(text, text),
  public.cloud_agent_finish(uuid, jsonb, text, numeric), public.cloud_agent_take(text, uuid) from public, anon, authenticated;
grant execute on function public.cloud_agent_status(text), public.cloud_agent_start(text, text),
  public.cloud_agent_finish(uuid, jsonb, text, numeric), public.cloud_agent_take(text, uuid) to service_role;
