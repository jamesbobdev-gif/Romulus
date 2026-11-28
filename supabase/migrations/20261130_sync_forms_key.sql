-- The ':forms' side row next to the agent list (agent/form-files-sync.js): the list of his files for forms (the
-- resume a job site asks for), so every one of his computers has them. The files themselves go through the
-- agent-files bucket, encrypted before they leave the computer; this row only says which exist.
-- Like 20261129_sync_review_key.sql, this takes the live definition of every function that checks the
-- side-row names and adds 'forms' after the last name in it. Running it twice changes nothing.
-- Paste it all in the SQL editor and press Run. Until then the files stay on the computer they were added on, as before.

do $$
declare
  f text;
  d text;
  last text;
begin
  foreach f in array array['public.sync_put(text,jsonb,timestamptz)', 'public.sync_set(text,jsonb)', 'public.sync_usage(text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    d := pg_get_functiondef(to_regprocedure(f));
    if position('|forms))' in d) > 0 then continue; end if;
    foreach last in array array['review', 'learned', 'settings', 'kitchen', 'macros', 'health', 'devices'] loop
      if position('|' || last || '))' in d) > 0 then
        execute replace(d, '|' || last || '))', '|' || last || '|forms))');
        exit;
      end if;
    end loop;
  end loop;
end $$;
