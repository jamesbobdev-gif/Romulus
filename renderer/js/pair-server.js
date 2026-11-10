// The Romulus server: where pairing codes meet (renderer/js/pair.js) and where every install starts syncing,
// on the free space, from the first start (hosted-sync.js). Every build ships it, a build of your own too, so
// nobody has to make a Supabase project first; moving to one of your own stays an option in Settings → Device sync.
// key is a publishable key, made to be public: it reaches only the database functions, every table is closed to
// it (row-level security), and every list still needs its own sync key. pay and payYear are the Stripe Payment
// Links for the Group plan, payPersonal and payPersonalYear for the Personal plan (optional). The release build
// rewrites this line from the repository variables PAIR_URL, PAIR_KEY, PAY_PERSONAL_URL, PAY_PERSONAL_YEAR_URL,
// PAY_URL, PAY_YEAR_URL and PAY_TRIAL_DAYS (.github/workflows/release.yml), so a change there wins.
window.ROMULUS_PAIR={"url":"https://apthdgcemvibwetczsyd.supabase.co","key":"sb_publishable_aV29sh9MEGtHcwDT9iqa7Q_72WPmClX","pay":"https://buy.stripe.com/6oU00b6gb6qW5L642XfIs00","payYear":"https://buy.stripe.com/fZu5kvgUP2aG2yU1UPfIs01"};
