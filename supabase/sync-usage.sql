-- How many people use sync, and do they stay: counts over the rows the Romulus server already keeps to run
-- sync (sync_accounts, tasks_sync, the file buckets). Nothing here reads a list: the docs are ciphertext, and
-- this never selects them. Nothing per person comes out either, only counts, totals and percentiles. It adds
-- no collection; it reads what PRIVACY.md ("The Romulus server") already says is kept.
-- Not public: this runs with the project's own key. Either
--   npx supabase db query --remote --yes --file supabase/sync-usage.sql
-- or paste it in the SQL editor. Six result sets, in this order:
--   1. accounts: how many, how many new
--   2. active: accounts that wrote in the last day / week / month
--   3. new accounts per week, the last 12 weeks
--   4. plans: paid, by plan, and group members
--   5. space: how much, spread, and who hit a limit lately
--   6. files: photos and files in the buckets, by bucket
-- "Account" is the hash the server keeps (sync_account_of), one per sync key family (lists, work, agent...).

-- 1. accounts
select count(*)                                                        as accounts,
       count(*) filter (where created_at >= now() - interval '1 day')   as new_today,
       count(*) filter (where created_at >= now() - interval '7 days')  as new_7d,
       count(*) filter (where created_at >= now() - interval '30 days') as new_30d
  from public.sync_accounts;

-- 2. active: an account counts as active on the newest write of any of its sync keys
with last_write as (
  select public.sync_account_of(sync_key) as account, max(updated_at) as at
    from public.tasks_sync
   group by 1
)
select count(*) filter (where at >= now() - interval '1 day')   as active_1d,
       count(*) filter (where at >= now() - interval '7 days')  as active_7d,
       count(*) filter (where at >= now() - interval '30 days') as active_30d,
       count(*) filter (where at <  now() - interval '90 days') as quiet_90d,
       count(*)                                                 as with_lists
  from last_write;

-- 3. new accounts per week, newest first
select date_trunc('week', created_at)::date as week, count(*) as new_accounts
  from public.sync_accounts
 where created_at >= now() - interval '12 weeks'
 group by 1
 order by 1 desc;

-- 4. plans: a paying account has paid_until in the future; plan null or 'group' is the Group plan,
--    'personal' the Personal one. Members are accounts covered by someone else's Group plan.
select count(*) filter (where paid_until > now())                                           as paying,
       count(*) filter (where paid_until > now() and coalesce(plan, 'group') = 'group')     as paying_group,
       count(*) filter (where paid_until > now() and plan = 'personal')                     as paying_personal,
       count(*) filter (where family_of is not null)                                        as group_members,
       count(*) filter (where paid_until is not null and paid_until <= now())               as lapsed,
       count(*) filter (where paid_until > now() and paid_until <= now() + interval '7 days') as renew_within_7d
  from public.sync_accounts;

-- 5. space: totals, the spread, and limits hit in the last 30 days
select pg_size_pretty(sum(used_bytes))                                                   as lists_total,
       pg_size_pretty(sum(history_bytes))                                                as history_total,
       pg_size_pretty(percentile_cont(0.5) within group (order by used_bytes)::bigint)   as lists_median,
       pg_size_pretty(percentile_cont(0.9) within group (order by used_bytes)::bigint)   as lists_p90,
       pg_size_pretty(max(used_bytes))                                                   as lists_max,
       count(*) filter (where refused = 'full' and refused_at >= now() - interval '30 days')        as hit_full_30d,
       count(*) filter (where refused = 'rate' and refused_at >= now() - interval '30 days')        as hit_rate_30d,
       count(*) filter (where refused = 'server_full' and refused_at >= now() - interval '30 days') as hit_server_full_30d
  from public.sync_accounts;

-- 6. files: task-files (photos and files on tasks, encrypted), agent-files and agent-attachments (what the
--    Agent is shown or downloads). Names and folders are not listed, only how many and how much.
select bucket_id                                                        as bucket,
       count(*)                                                         as files,
       pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0))     as total,
       count(*) filter (where created_at >= now() - interval '7 days')  as added_7d
  from storage.objects
 where bucket_id in ('task-files', 'agent-files', 'agent-attachments')
 group by 1
 order by 1;
