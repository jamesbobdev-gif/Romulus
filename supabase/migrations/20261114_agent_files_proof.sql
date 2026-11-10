-- The local model's downloads bucket (agent-files) used to ask for the agent key itself in an x-romulus-key header to
-- prove a request may list, add to or remove its folder. In end-to-end mode that key is also what the lists are sealed
-- under, so the storage server, its request logs and its backups were shown the one secret they must never see.
-- Now the request carries x-romulus-proof = sha256('romulus-files-v1|' || key), which can't be run backwards, and
-- the folder is 'tk_agent_att_' || left(sha256(proof), 40) (agent/worker-files.js proofFor, folderFor). The bucket's
-- policies ("agent files: app can upload / see / remove") call this function, so they need no change.
-- Files published before this live on under the old folder name; the worker puts them up again under the new one on
-- its next pass, and the cleanup function removes the old copies after 30 days.
-- Paste it all in the SQL editor and press Run.

create or replace function public.agent_folder_proved(p_name text)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare k text;
begin
  begin k := (nullif(current_setting('request.headers', true), '')::json)->>'x-romulus-proof'; exception when others then k := null; end;
  if k is null or k !~ '^[0-9a-f]{64}$' then return false; end if;
  return split_part(coalesce(p_name, ''), '/', 1) = 'tk_agent_att_' || left(encode(sha256(convert_to(k, 'UTF8')), 'hex'), 40);
end $$;
revoke all on function public.agent_folder_proved(text) from public;
grant execute on function public.agent_folder_proved(text) to anon, authenticated, service_role;
