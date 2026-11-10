# Working on Romulus

The map for anyone (or any Claude session) changing this code. Each source file starts with a comment
that says what it does; read that first, then this for how the pieces fit and the rules.

## Layout

| Folder | What it is | Loaded how |
| --- | --- | --- |
| `main.js`, `main/` | Electron main process: window, tray, store, updater, Finance, calendars, Gmail dates, screen helper | `require` |
| `preload.js` | The only bridge from the page to `main/` (IPC). New page-to-main calls go here and in `main/window.js`'s guard | Electron preload |
| `agent/` | The Agent: routing, the Claude runner, other cloud AIs, the local-model lane, the agent browser, skills (`agent/skills/*.md`) | `require`, no Electron, so tests can load it |
| `renderer/` | The page: `index.html`, `styles.css`, `js/*.js`. Also the screen helper page (`overlay.html`, `overlay.js`) | plain `<script>` tags, no bundler |
| `mobile/` | Capacitor wrapper (Android, iOS). `prepare-www.js` copies `renderer/` in; `*-phone.js` back the page with native plugins | |
| `supabase/` | Sync project: `setup.sql`, `migrations/`, edge `functions/` | |
| `minipc/` | Setup for the local model's own computer (Linux) | |
| `test/` | `node --test` unit tests, one file per module | `npm test` |

## Where each feature lives

| Feature | Page (`renderer/js/`) | Behind it |
| --- | --- | --- |
| Lists, task rows, subtasks | `lists.js`, `task-actions.js`, `core.js`, `recur.js`, `quick-add.js`, `swipe.js` | `main/persistence.js`, `main/store.js` |
| Buttons, search, keys | `wiring.js` | |
| Start-up | `init.js` (loads last) | `main.js` |
| Sync, pairing, devices | `sync.js`, `sync-crypto.js`, `hosted-sync.js`, `pair.js`, `devices.js`, `update-sync.js` | `supabase/`, `agent/supabase.js` |
| Agent tab | `agent-*.js`, `busy-line.js`, `goals.js`, `triggers.js`, `standing.js`, `seat-map.js`, `link-email.js`, `same-ask.js` | `agent/routing.js`, `agent/runner.js`, `agent/local-lane.js`, `agent/providers.js`, `agent/task-context.js` |
| Groceries | `grocery-list.js`, `ebt-alerts.js`, `order-match.js` | `agent/grocery.js` |
| Finance | `finance*.js`, `bill-reminders.js` | `main/finance*.js`, `mobile/finance-phone.js` |
| Kitchen | `kitchen.js` | `main/kitchen-ai.js`, `agent/meal-ideas.js` |
| Family / Group | `family.js` | `supabase/migrations` |
| Notes, Hours, Calendar, Year in review | `ideas.js`, `hours.js`, `calendar-view.js`, `year-review*.js` | |
| Calendars and email accounts | `calendars.js`, `connect-accounts.js` | `agent/calendars.js`, `main/calendar-accounts.js`, `main/gcal-sync.js`, `mobile/cal-phone.js` |
| Settings | `settings.js`, `tab-picker.js`, `local-model.js`, `setup-list.js`, `welcome.js` | `main/store.js` |
| Screen helper | `renderer/overlay.*` | `main/overlay.js`, `agent/overlay-ask.js`, `agent/pc-control.js` |
| Updates | `update-desktop.js` | `main/updater.js`, `mobile/update-phone.js`, `scripts/release.js` |

## Rules for the page scripts

- **One global scope.** Every `renderer/js` file shares it, in the order `index.html` lists them. A
  top-level name may be declared in one file only. `test/renderer-globals.test.js` fails on a clash, on a
  file no page loads, and on a file calling another file's function at load time before it is loaded.
- **New page file:** add its `<script>` tag to `index.html` before anything that uses it at load time,
  and give it a header comment like the others.
- **Logic worth testing goes above the DOM code,** exported with
  `if (typeof module !== 'undefined' && module.exports) module.exports = {...}`, so a test can `require`
  it (see `kitchen.js`, `finance-*.js`). Code that touches the page sits below that, often inside
  `if (typeof document !== 'undefined') { ... }`.
- **Prefix names in big feature files** (`kUnit`, `kitchenUI`) so they don't collide with the rest.

## Keeping files workable

- When a file passes about 600 lines, split it by feature the next time you're in it, the way Finance
  is (`finance-core.js`, `finance-csv.js`, `finance-bills.js`...). Move code only; don't change it in
  the same commit. The biggest now: `renderer/js/finance.js`, `renderer/styles.css`, `agent/local-lane.js`,
  `renderer/js/lists.js`, `renderer/js/wiring.js`.
- A change in `agent/` or `main/` gets a test in `test/` when it has logic (no Electron needed there).
- `npm test` runs on every push (`.github/workflows/test.yml`) and again before a release.

## Ground rules (also in CONTRIBUTING.md)

- The Agent never buys, sends, submits, books or deletes without a yes from the user on that task.
- Keys go through `main/store.js` (encrypted) and are never synced. Finance and the Locked profile are
  never sent to a cloud AI.
- No personal details in the repo: this repository is public. Fixtures use example names.
- UI text is plain English for someone who has never seen the code. No emoji in UI text, notes or
  prompts (`no-emoji.js` strips ones that come in from outside).

## Practical notes

- Most source files use CRLF line endings. Keep a file's existing endings; scripted rewrites
  (sed, node) tend to write LF and turn the whole file into a diff.
- Several sessions may work in this folder at once. Check `git status` / `git log` before committing,
  and stage only your own hunks.
- Supabase migrations are applied by hand in the SQL editor; add the file under `supabase/migrations/`
  and keep `setup.sql` in step.
- `npm start` runs the app from source; `npm run dist` builds the installer.
