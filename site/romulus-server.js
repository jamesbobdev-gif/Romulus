// The Romulus server the page reads the supporters list from (the thank-you line at the bottom). The Pages
// workflow (.github/workflows/pages.yml) replaces this line with the repository variables PAIR_URL and PAIR_KEY,
// the same project and publishable key the app's release build uses. Kept null here, the line just doesn't show.
window.ROMULUS_SERVER = null;
