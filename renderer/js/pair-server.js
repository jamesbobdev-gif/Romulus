// The project pairing codes meet in (renderer/js/pair.js). The official release build replaces this line with
// the project in the repository variables PAIR_URL and PAIR_KEY (.github/workflows/release.yml). PAIR_KEY is a
// publishable key, made to be public: it reaches only the database functions, and every list still needs its
// own sync key. It is also where a new install syncs from the first start (hosted-sync.js), and pay, when set
// (repository variable PAY_URL), and payYear (PAY_YEAR_URL), are the Stripe Payment Links for the $5 plan there. A build of your own keeps null
// here: pairing uses the device's own sync project, and nothing syncs until it's set up by hand.
window.ROMULUS_PAIR=null;
