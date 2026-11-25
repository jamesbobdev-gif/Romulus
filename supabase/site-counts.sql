-- What people did on the website, the last 30 days (site_counts, supabase/migrations/20261116_site_counts.sql).
-- Not public: this runs with the project's own key. Either
--   npx supabase db query --remote --yes --file supabase/site-counts.sql
-- or paste it in the SQL editor. First the totals per button, then each day.
select event, sum(n) as total
  from public.site_counts
 where day >= current_date - 30
 group by event
 order by total desc;

select day, event, n
  from public.site_counts
 where day >= current_date - 30
 order by day desc, n desc;
