# Contributing

Thanks for looking. Small, focused changes land fastest.

## Run it

```
npm install
npm start
```

Node 22 or newer (`npm test` uses Node's built-in test runner with a file glob, which needs 21+; the release workflow builds on 22). `npm test` runs the unit tests (files in `test/`). `npm run dist` builds an installer into `dist/`.

## Where things are

- `main.js` wires the Electron main process; `main/` is the desktop plumbing (window, tray, config and encrypted secrets, calendars, Gmail dates, Finance).
- `agent/` is the Agent: routing, the Claude runner, the other cloud AIs, the local-model lane, the agent browser, skills and site notes.
- `renderer/` is the page: plain scripts with no bundler, loaded in the order `index.html` lists them. They share one global scope, so declare a top-level name in one file only.
- `mobile/` wraps the page in Capacitor for Android.
- `supabase/` holds the sync project's SQL and edge functions.

The [README](README.md) has more on the layout; [docs/SETUP.md](docs/SETUP.md) is the user-facing guide.

## Ground rules for changes

- **The hard rule stays.** The Agent never buys, sends, submits, books or deletes without a yes from the user in that task. Any change to the agent prompts, the browser tools or the form filler must keep that true, in code where it can be.
- **Private things stay private.** Keys are stored through `main/store.js` (encrypted) and never synced; the Locked profile and Finance are never given to a cloud AI. If a change moves data somewhere new, say so in the pull request.
- **No personal details in the repo.** Test fixtures use example names and addresses. Config, keys and seed files are git-ignored; keep them that way.
- **Plain English in the UI.** Settings text and agent messages are written for someone who has never seen the code.
- Add or update a test in `test/` when the change has logic worth protecting. Modules under `agent/` and `main/` are written without Electron so they can be tested on their own.

## Adding a skill or a site note

Skills (`agent/skills/*.md`) are short how-tos the Agent loads when a task's words match. Site notes (`agent/sites/*.md`) are per-website know-how. Both are general knowledge only, never personal facts. New ones are welcome: keep them short, concrete and about what actually works on the site.

## Pull requests

- One change per pull request, with a title that says what changed from the user's point of view.
- Say how you tested it (which platform, which AI connected).
- Screenshots for anything visible.

## Reporting bugs

Open an issue with what you did, what you expected, what happened, and the relevant lines from `%APPDATA%\Romulus\agent-runner.log` (Windows) with anything personal removed. Security problems go to [SECURITY.md](SECURITY.md) instead.
