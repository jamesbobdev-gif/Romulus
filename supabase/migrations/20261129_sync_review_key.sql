-- The ':review' side row next to the personal list (renderer/js/year-review-view.js): the done tasks he cleared
-- away, which the Year in review still counts, joined from every device.
-- Like 20261128_sync_learned_key.sql, this takes the live definition of every function that checks the
-- side-row names and adds 'review' after the last name in it. Running it twice changes nothing.
-- Paste it all in the SQL editor and press Run. Until then each device keeps its own log, as before.

do $$
declare
  f text;
  d text;
  last text;
begin
  foreach f in array array['public.sync_put(text,jsonb,timestamptz)', 'public.sync_set(text,jsonb)', 'public.sync_usage(text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    d := pg_get_functiondef(to_regprocedure(f));
    if position('|review))' in d) > 0 then continue; end if;
    foreach last in array array['learned', 'settings', 'kitchen', 'macros', 'health', 'devices'] loop
      if position('|' || last || '))' in d) > 0 then
        execute replace(d, '|' || last || '))', '|' || last || '|review))');
        exit;
      end if;
    end loop;
  end loop;
end $$;
