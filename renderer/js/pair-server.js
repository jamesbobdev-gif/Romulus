// The project pairing codes meet in (renderer/js/pair.js). The official release build replaces this line with
// the project in the repository variables PAIR_URL and PAIR_KEY (.github/workflows/release.yml). PAIR_KEY is a
// publishable key, made to be public: it reaches only the database functions, and every list still needs its
// own sync key. A build of your own keeps null here, and pairing uses the device's own sync project.
window.ROMULUS_PAIR=null;
