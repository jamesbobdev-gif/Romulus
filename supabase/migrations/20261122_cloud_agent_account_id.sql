-- Romulus cloud: the app names the account by a hash, so no sync key is sent to the cloud-agent function.
-- It sends 'tk_acct_' + the 64-character hex that sync_account_of makes from its key (renderer/js/cloud-agent.js
-- cloudAgAccount); a sync key or lookup id still works, for app versions before this one.
-- Needs 20261120_cloud_agent.sql and 20261121_cloud_agent_limits.sql first. Paste it all in the SQL editor and press Run.
-- It changes nothing but how the account is found, so running it twice is fine.

create or replace function public.cloud_agent_account_of(p_key text)
returns text
language sql immutable
set search_path = public
as $$ select case when p_key ~ '^tk_acct_[0-9a-f]{64}$' then substring(p_key from 9) else public.sync_account_of(p_key) end $$;

-- the live definitions, with sync_account_of( swapped for cloud_agent_account_of( (same idea as 20261119_sync_kitchen_key.sql)
do $$
declare
  f text;
  d text;
begin
  foreach f in array array['public.cloud_agent_status(text)', 'public.cloud_agent_start(text,text)', 'public.cloud_agent_take(text,uuid)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if position('cloud_agent_account_of(' in d) = 0 then
      execute replace(d, 'public.sync_account_of(', 'public.cloud_agent_account_of(');
    end if;
  end loop;
end $$;

revoke all on function public.cloud_agent_account_of(text) from public, anon, authenticated;
grant execute on function public.cloud_agent_account_of(text) to service_role;
