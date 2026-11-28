-- Romulus cloud, scheduled runs: a repeating Agent task that still runs when every one of a person's devices is off
-- (renderer/js/cloud-agent.js cloudSched*, supabase/functions/cloud-agent "tick"). For accounts on a paid plan (and
-- the project's owner), one task at a time, after they switch it on for that task.
-- What this keeps:
--   cloud_agent_schedules  one row per scheduled task: when it runs next, its repeat rule, and a copy of the task
--                          sealed to a key only the cloud-agent function has (its CLOUD_SCHEDULE_KEY secret), so this
--                          table holds ciphertext. The task is named by a hash of its id.
--   cloud_agent_results    an answer waiting for one of the person's devices, sealed to a key that lives on the task
--                          inside their own (encrypted) list. Deleted when taken, or after 14 days.
-- A clock (pg_cron) calls the function every five minutes; the function asks for what is due, runs it and saves the
-- answer. A schedule that is more than a few minutes late means no computer of theirs ran it, since a computer that
-- does moves the time forward. Each run counts against the account's monthly allowance like any cloud task.
-- Only the function (service role) can call these. Deleting the account removes its rows here with it.
-- Needs 20261120, 20261121 and 20261122 (cloud agent) first. Paste it all in the SQL editor and press Run; running
-- it twice changes nothing. Then follow the three steps at the bottom.

alter table public.cloud_agent_settings add column if not exists schedules_free  int not null default 0;  -- scheduled tasks an account may keep
alter table public.cloud_agent_settings add column if not exists schedules_paid  int not null default 20;
alter table public.cloud_agent_settings add column if not exists schedules_owner int not null default 50;
alter table public.cloud_agent_settings add column if not exists schedule_grace_min  int not null default 5;  -- this late = no device ran it
alter table public.cloud_agent_settings add column if not exists schedule_stale_days int not null default 14; -- no device has refreshed it in this long: dropped
alter table public.cloud_agent_settings add column if not exists schedule_unread     int not null default 3;  -- this many answers nobody picked up: it pauses

create table if not exists public.cloud_agent_schedules (
  account    text not null references public.sync_accounts(account) on delete cascade,
  task       text not null,                 -- a hash of the task's id, made on the device
  next_run   timestamptz not null,
  rule       jsonb not null,                -- {every: 'day'|'weekday'|'week', at: 'HH:MM', day: 0-6|null, tz}
  sealed     jsonb not null,                -- the task and their notes about themselves: {v, epk, iv, ct}
  pub        jsonb not null,                -- the public half of the task's own key: answers are sealed to it
  paused     boolean not null default false, -- waiting for the person (a question, the allowance, unread answers)
  fails      int not null default 0,
  claimed_at timestamptz,                   -- a run is going
  updated_at timestamptz not null default now(),
  primary key (account, task)
);
create index if not exists cloud_agent_schedules_due on public.cloud_agent_schedules (next_run) where not paused;
create table if not exists public.cloud_agent_results (
  id       bigint generated always as identity primary key,
  account  text not null references public.sync_accounts(account) on delete cascade,
  task     text not null,
  sealed   jsonb,                           -- the answer, or null when it didn't run
  why      text,                            -- why not, in plain words
  next_run timestamptz,                     -- when it runs next, for the device to show
  ran_at   timestamptz not null default now()
);
create index if not exists cloud_agent_results_account on public.cloud_agent_results (account);
alter table public.cloud_agent_schedules enable row level security;
alter table public.cloud_agent_results enable row level security;

-- the next time a rule comes round, strictly after p_from, at its hour in the person's own time zone
-- (the same days renderer/js/agent-chat.js nextRepeatAt picks; 0 = Sunday)
create or replace function public.cloud_schedule_next(p_rule jsonb, p_from timestamptz)
returns timestamptz
language plpgsql stable
set search_path = public
as $$
declare
  tz text := coalesce(p_rule->>'tz', 'UTC');
  at_time time := '08:00';
  every text := coalesce(p_rule->>'every', 'day');
  want int := case when p_rule->>'day' ~ '^[0-6]$' then (p_rule->>'day')::int else null end;
  d date;
  c timestamptz;
begin
  if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'UTC'; end if;
  if p_rule->>'at' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then at_time := (p_rule->>'at')::time; end if;
  for i in 0..8 loop
    d := (p_from at time zone tz)::date + i;
    c := (d + at_time) at time zone tz;
    continue when c <= p_from;
    continue when every = 'weekday' and extract(dow from d) in (0, 6);
    continue when every = 'week' and want is not null and extract(dow from d) <> want;
    return c;
  end loop;
  return p_from + interval '1 day';
end $$;

-- how many scheduled tasks this account may keep
create or replace function public.cloud_schedule_limit(p_account text)
returns int
language plpgsql stable security definer
set search_path = public
as $$
declare
  s public.cloud_agent_settings;
  acc public.sync_accounts;
begin
  select * into s from public.cloud_agent_settings where id;
  select * into acc from public.sync_accounts where account = p_account;
  if not found then return 0; end if;
  return case when acc.owner then s.schedules_owner when public.sync_paid_now(acc) then s.schedules_paid else s.schedules_free end;
end $$;

-- a device hands over (or refreshes) one scheduled task → {ok, next} | {ok: false, why: 'off'|'no_account'|'plan'|'limit'}
create or replace function public.cloud_schedule_put(p_key text, p_task text, p_next timestamptz, p_rule jsonb, p_sealed jsonb, p_pub jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.cloud_agent_account_of(p_key);
  s public.cloud_agent_settings;
  lim int;
  n int;
  nxt timestamptz;
begin
  select * into s from public.cloud_agent_settings where id;
  if not s.enabled then return jsonb_build_object('ok', false, 'why', 'off'); end if;
  perform 1 from public.sync_accounts where account = a for update; -- one at a time per account, so the count below holds
  if not found then return jsonb_build_object('ok', false, 'why', 'no_account'); end if;
  lim := public.cloud_schedule_limit(a);
  if lim <= 0 then return jsonb_build_object('ok', false, 'why', 'plan'); end if;
  select count(*) into n from public.cloud_agent_schedules where account = a and task <> p_task;
  if n >= lim then return jsonb_build_object('ok', false, 'why', 'limit', 'limit', lim); end if;
  -- a time that has already gone would run at once: it runs at the rule's next turn instead
  nxt := case when p_next is null or p_next < now() - interval '1 hour' then public.cloud_schedule_next(p_rule, now()) else p_next end;
  insert into public.cloud_agent_schedules as x (account, task, next_run, rule, sealed, pub)
    values (a, p_task, nxt, p_rule, p_sealed, p_pub)
    on conflict (account, task) do update set next_run = excluded.next_run, rule = excluded.rule, sealed = excluded.sealed,
      pub = excluded.pub, paused = false, fails = 0, updated_at = now();
  return jsonb_build_object('ok', true, 'next', nxt);
end $$;

-- a device takes one back (p_task null: all of the account's)
create or replace function public.cloud_schedule_drop(p_key text, p_task text)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.cloud_agent_account_of(p_key);
  n int;
begin
  delete from public.cloud_agent_schedules where account = a and (p_task is null or task = p_task);
  get diagnostics n = row_count;
  delete from public.cloud_agent_results where account = a and (p_task is null or task = p_task);
  return n;
end $$;

-- a device collects what ran while it was away: each answer is handed over once and deleted.
-- → {results: [{task, sealed, why, next, ran}], kept: [{task, next, paused}]}
create or replace function public.cloud_schedule_take(p_key text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  a text := public.cloud_agent_account_of(p_key);
  out jsonb;
begin
  with gone as (delete from public.cloud_agent_results where account = a returning *)
  select coalesce(jsonb_agg(jsonb_build_object('task', task, 'sealed', sealed, 'why', why,
      'next', (extract(epoch from next_run) * 1000)::bigint, 'ran', (extract(epoch from ran_at) * 1000)::bigint) order by ran_at), '[]'::jsonb)
    into out from gone;
  return jsonb_build_object('results', out, 'kept', coalesce((select jsonb_agg(jsonb_build_object('task', task,
      'next', (extract(epoch from next_run) * 1000)::bigint, 'paused', paused)) from public.cloud_agent_schedules where account = a), '[]'::jsonb));
end $$;

-- the clock: up to p_max scheduled tasks that are due, each with a job taken from its account's allowance.
-- → [{account, task, job, rule, sealed, pub, model, effort, task_cents}]
create or replace function public.cloud_schedule_claim(p_max int)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  s public.cloud_agent_settings;
  r public.cloud_agent_schedules;
  st jsonb;
  unread int;
  out jsonb := '[]'::jsonb;
begin
  select * into s from public.cloud_agent_settings where id;
  if not s.enabled then return out; end if;
  delete from public.cloud_agent_schedules where updated_at < now() - make_interval(days => s.schedule_stale_days);
  delete from public.cloud_agent_results where ran_at < now() - interval '14 days';
  for r in
    select * from public.cloud_agent_schedules
      where not paused and next_run < now() - make_interval(mins => s.schedule_grace_min)
        and (claimed_at is null or claimed_at < now() - interval '15 minutes')
      order by next_run limit greatest(p_max, 0) * 4 for update skip locked
  loop
    exit when jsonb_array_length(out) >= p_max;
    -- nobody has opened the app to read the last few: it waits for them rather than running into the void
    select count(*) into unread from public.cloud_agent_results where account = r.account and task = r.task;
    if unread >= s.schedule_unread then
      update public.cloud_agent_schedules set paused = true where account = r.account and task = r.task;
      continue;
    end if;
    st := public.cloud_agent_start('tk_acct_' || r.account, null);
    if (st->>'ok')::boolean then
      update public.cloud_agent_schedules set claimed_at = now() where account = r.account and task = r.task;
      out := out || jsonb_build_object('account', r.account, 'task', r.task, 'job', st->>'job', 'rule', r.rule,
        'sealed', r.sealed, 'pub', r.pub, 'model', st->>'model', 'effort', st->>'effort', 'task_cents', st->'task_cents');
    elsif st->>'why' in ('busy', 'server', 'off') then
      null; -- full for the moment: the next tick tries again
    else
      -- the month's allowance is used up (or the plan ended): say so once, and wait for a device to hand it over again
      insert into public.cloud_agent_results (account, task, why, next_run)
        values (r.account, r.task, st->>'why', public.cloud_schedule_next(r.rule, now()));
      update public.cloud_agent_schedules set paused = true where account = r.account and task = r.task;
    end if;
  end loop;
  return out;
end $$;

-- a scheduled run is over: count what it cost, keep the answer for the person's devices, set the next time.
-- p_pause: it asked the person something, so it waits for them. Three failures in a row pause it too.
create or replace function public.cloud_schedule_done(p_account text, p_task text, p_job uuid, p_sealed jsonb, p_why text, p_cents numeric, p_pause boolean)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  r public.cloud_agent_schedules;
  nxt timestamptz;
begin
  perform public.cloud_agent_finish(p_job, null, p_why, p_cents); -- the cost; the answer goes in cloud_agent_results, not the job
  delete from public.cloud_agent_jobs where id = p_job;
  select * into r from public.cloud_agent_schedules where account = p_account and task = p_task for update;
  if not found then return false; end if; -- taken back while it ran: the answer is dropped
  nxt := public.cloud_schedule_next(r.rule, now());
  insert into public.cloud_agent_results (account, task, sealed, why, next_run)
    values (p_account, p_task, p_sealed, case when p_sealed is null then left(p_why, 300) end, nxt);
  update public.cloud_agent_schedules set next_run = nxt, claimed_at = null,
    fails = case when p_sealed is null then fails + 1 else 0 end,
    paused = coalesce(p_pause, false) or (p_sealed is null and fails + 1 >= 3)
    where account = p_account and task = p_task;
  return true;
end $$;

-- the clock's password: the function checks what the clock sent against the one kept in app_secrets
create or replace function public.cloud_cron_ok(p_secret text)
returns boolean
language sql stable security definer
set search_path = public
as $$ select coalesce(length(p_secret) >= 32 and exists (select 1 from public.app_secrets where name = 'cloud_cron_secret' and value = p_secret), false) $$;

revoke all on function public.cloud_schedule_next(jsonb, timestamptz), public.cloud_schedule_limit(text),
  public.cloud_schedule_put(text, text, timestamptz, jsonb, jsonb, jsonb), public.cloud_schedule_drop(text, text),
  public.cloud_schedule_take(text), public.cloud_schedule_claim(int),
  public.cloud_schedule_done(text, text, uuid, jsonb, text, numeric, boolean), public.cloud_cron_ok(text)
  from public, anon, authenticated;
grant execute on function public.cloud_schedule_next(jsonb, timestamptz), public.cloud_schedule_limit(text),
  public.cloud_schedule_put(text, text, timestamptz, jsonb, jsonb, jsonb), public.cloud_schedule_drop(text, text),
  public.cloud_schedule_take(text), public.cloud_schedule_claim(int),
  public.cloud_schedule_done(text, text, uuid, jsonb, text, numeric, boolean), public.cloud_cron_ok(text)
  to service_role;

-- ── the clock ──────────────────────────────────────────────────────────────
-- Its password is made here and never leaves the database: the clock reads it to send, the function asks
-- cloud_cron_ok whether what arrived matches.
insert into public.app_secrets (name, value) values ('cloud_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- every five minutes: wake the function, if this project has said where it is (step 2 below)
create or replace function public.cloud_schedule_tick()
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  u text;
  k text;
begin
  select value into u from public.app_secrets where name = 'cloud_agent_url';
  select value into k from public.app_secrets where name = 'cloud_cron_secret';
  if u is null or k is null or u !~ '^https://' then return; end if;
  if not exists (select 1 from public.cloud_agent_schedules where not paused and next_run < now()) then return; end if; -- nothing due: no call
  perform net.http_post(url := u, body := jsonb_build_object('action', 'tick'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), timeout_milliseconds := 10000);
end $$;
revoke all on function public.cloud_schedule_tick() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'cloud-agent-tick';
select cron.schedule('cloud-agent-tick', '*/5 * * * *', 'select public.cloud_schedule_tick()');

-- ── three steps after running this ─────────────────────────────────────────
-- 1. Make the key that opens stored tasks and save it as the cloud-agent function's secret CLOUD_SCHEDULE_KEY
--    (Edge Functions → Secrets). On any computer with Node:
--      node -e "crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify(j)))"
--    Paste the whole line it prints as the secret's value. Keep no other copy: whoever has it can open stored tasks.
-- 2. Tell the clock where the function is (your project's address):
--      insert into public.app_secrets (name, value) values ('cloud_agent_url', 'https://YOUR-PROJECT.supabase.co/functions/v1/cloud-agent')
--        on conflict (name) do update set value = excluded.value;
-- 3. Deploy supabase/functions/cloud-agent again (JWT verification off, as before).
-- To stop every scheduled run: select cron.unschedule('cloud-agent-tick');
