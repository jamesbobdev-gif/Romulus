-- A worker (the home PC's Claude runner, or the mini PC's local lane) claims a queued Agent task
-- before starting it. Atomic: the row lock + re-checked WHERE mean only one worker can win.
-- p_lane: the lane the worker serves ('claude' | 'local'). A task with no lane yet is claimable
-- by either and gets stamped with the claimer's lane. (Applied to the live project 2026-10-07.)
create or replace function public.agent_claim_task(p_sync_key text, p_task_id text, p_worker text, p_lane text)
returns boolean
language plpgsql
set search_path to 'public'
as $function$
declare n int;
begin
  if p_sync_key not like 'tk_agent_%' or p_lane not in ('claude', 'local') then return false; end if;
  update tasks_sync
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
end $function$;

revoke all on function public.agent_claim_task(text, text, text, text) from public;
grant execute on function public.agent_claim_task(text, text, text, text) to anon, authenticated, service_role;
