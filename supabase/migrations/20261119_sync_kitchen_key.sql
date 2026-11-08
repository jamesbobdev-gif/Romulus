-- The ':kitchen' side row next to the personal list (renderer/js/kitchen.js): the Kitchen tab's pantry and recipes.
-- Rather than copying the sync functions again (and risking an older copy of them), this takes the live definitions
-- of every function that checks the side-row names and adds 'kitchen' at the end of them (after 'macros', or after
-- 'devices' on a database that never got the health and macros rows). Running it twice changes nothing.
-- Paste it all in the SQL editor and press Run. Until then the Kitchen tab is kept on each device and says this is needed.

do $$
declare
  f text;
  d text;
begin
  foreach f in array array['public.sync_put(text,jsonb,timestamptz)', 'public.sync_set(text,jsonb)', 'public.sync_usage(text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    d := pg_get_functiondef(to_regprocedure(f));
    if position('kitchen' in d) > 0 then continue; end if;
    if position('|macros))' in d) > 0 then
      execute replace(d, '|macros))', '|macros|kitchen))');
    elsif position('|devices))' in d) > 0 then
      execute replace(d, '|devices))', '|devices|kitchen))');
    end if;
  end loop;
end $$;
