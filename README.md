# Tasks

A clean, minimal to-do app. Simple list with due dates, tags, subtasks, and drag-to-reorder.

## Run it (dev mode)

You need Node.js (v18 or newer). Then, in this folder:

```
npm install
npm start
```

## How the code is laid out

- `main.js` starts the Electron main process. It only wires the pieces together: each module gets what it shares with the others (config, the log, the window…) through its `init(ctx)` and lists its IPC calls in `handlers`.
- `main/` holds the desktop plumbing: the window and tray, saving tasks, config and secrets (`store.js`), calendar sync and accounts, Gmail dates, "Buy this" emails, Speak, and the RSI wiring.
- `agent/` holds the Agent tab: routing between lanes, the Claude runner, the mini PC (local) lane with its tools and browser, AI connections, the usage-limit hold, the weekly memory tidy, and their helpers.
- `preload.js` is the bridge between the two.
- `renderer/` is the UI. `index.html` holds the markup, `styles.css` the look, and `js/*.js` the page scripts. They are plain scripts, with no bundler: they share one global scope and load in the order `index.html` lists them, ending with `init.js`. So declare a top-level name in one file only, and don't use a later file's names in code that runs while the page loads.

Tests run with `npm test` (Node's built-in runner, files in `test/`).

## Install it properly (do this for auto-start + pinning)

```
npm run dist
```

The installer lands in `dist/` — `Tasks Setup.exe` on Windows, `Tasks.dmg` on Mac, an AppImage on Linux. Run it once and you have a real installed app with its own icon. The auto-start and tray behavior below apply to the **installed** app, not dev mode.

## Opens when your screen turns on

Two things handle this, both automatic after install:

1. **Starts when you log in.** Registered on first launch. Toggle it any time via the tray icon menu ("Start when I log in"), or in Task Manager → Startup on Windows.
2. **Reappears when your PC wakes or unlocks.** The app keeps running in the background — closing the window just hides it to the tray (near the clock). When the screen comes back on, the window pops back up.

To fully quit: right-click the tray icon → Quit Tasks.

## Pin it to the taskbar

Windows doesn't let apps pin themselves (deliberately), so it's a one-time manual step after installing: open the Start menu, find **Tasks**, right-click → **Pin to taskbar**. Or while it's running, right-click its taskbar icon → Pin to taskbar.

On a Mac: right-click the Dock icon → Options → **Keep in Dock**.

## Phone app (Android)

The `mobile/` folder wraps the same UI in Capacitor. To rebuild the APK after changing anything in `renderer/`:

```
cd mobile
node prepare-www.js        # copies renderer/ + bakes in sync-config.json
npx cap sync android
cd android && .\gradlew.bat assembleDebug
```

Requires `JAVA_HOME=C:\Users\James\android-dev\jdk21` and `ANDROID_HOME=C:\Users\James\android-dev\sdk`. The APK lands in `mobile/android/app/build/outputs/apk/debug/app-debug.apk` — copy it to the phone and tap to install (it updates in place, data survives).

Desktop and phone stay in sync through the Supabase project configured in `mobile/sync-config.json` (phone) and `%APPDATA%\Tasks\config.json` (desktop).

## Make it yours (custom theme)

Open ⚙ Settings → **Theme** and paste CSS. The whole look is driven by CSS variables, so a full re-skin is just overriding values, e.g. a dark theme:

```css
:root{
  --bg:#16161D; --surface:#1F1F28; --ink:#E6E6EA;
  --muted:#9C9CA8; --faint:#6E6E7A; --hairline:#33333E;
  --chip:#2A2A35; --accent:#8FA3FF;
}
```

Hit **Apply** to see it instantly; **Reset** returns to the default. Your theme persists across restarts (stored per device).

## Sharing the app

Give people `dist/Tasks Setup 1.0.0.exe` — it contains no personal data or credentials. Never add `seed-config.json` to the build: it holds your sync keys, and anyone with them can read and edit your lists. To set up another computer of yours, copy `seed-config.json` into that computer's `%APPDATA%/tasks` folder before first launch instead. They get their own empty task list, and can sign in with Google or Microsoft (or paste any calendar link) under ⚙ Settings → Calendars, then pick per calendar whether tasks go onto it and whether its events become to-dos (repeating events like classes are skipped by default). One-click sign-in needs the app's own OAuth clients in `oauth-clients.json` (see `oauth-clients.example.json`; kept out of git, bundled into the build). Without a Google one, people paste their own Google Cloud credential instead. (Windows may show an "unrecognized app" warning since the installer is unsigned — "More info → Run anyway".)

Do **not** share your built APK from `mobile/` — your private sync credentials are baked into it.

## Where your data lives

Tasks are saved to a `tasks.json` file in the app's user-data folder (e.g. `%APPDATA%/tasks` on Windows, `~/Library/Application Support/tasks` on Mac). They survive restarts and updates, and you can back up that one file.

## Ideas

The **Ideas** tab holds ideas as note cards, as long as you like, that you sort into groups.

- Tap **+ Add an idea** in a group and write. Tap an idea to drop down its description, made of sections: **+ Add a section** gives it a heading and text, and tapping a section changes it. **Edit title** renames the idea; **Delete** (tap twice) removes it. Highlight lines in a section and a bar pops up: **→ To-do** or **→ Agent** turns each line into its own task there and takes it out of the description. Enter starts a new line; click away (or Esc) to save, or Ctrl+Enter to save and start another. New ideas can start in **Unsorted**.
- Long ideas show their first few lines; click (tap) a card to read all of it and edit it. Clear the text or press **Delete** to remove it.
- **+ Group** makes a new group; click its name to rename it, the dot to change its colour, and × to remove it (its ideas go back to Unsorted).
- **Unsorted** is the default group: new ideas can start there and removed groups' ideas land there. You can rename it and change its colour too; it just can't be removed.
- Drag a card into another group, or above/below another card to reorder; the others slide aside. On a phone, press and hold a card to pick it up.
- Drag a group by its ⠿ handle to move the whole group around the board (Unsorted too). With the handle focused, the arrow keys move it one place.

Ideas sync across devices with the personal channel, in their own row (`<personal sync key>:ideas`), so they never show up as tasks or in Claude's task tools.

## RSI — Romulus Self Improvement (experimental)

⚙ Settings → **RSI**: ask for a change to the app in a chat and Claude Code edits its source.

- Desktop only, and only when the app runs from this folder (`npm start`). The installed app's files are packed, so there it needs `"rsi": {"repo": "C:\\path\\to\\tasks-app"}` in `config.json`, and changes only reach the installed copy after `npm run dist`.
- It won't start while the folder has uncommitted changes. Each change is committed as `RSI: <your request>`; **Undo** (in the panel, or the tray menu if a change breaks the window) reverts the latest one.
- Claude can only read and edit files in this folder: no shell, no web, and never `agent/rsi.js` itself. A change that doesn't parse is thrown away instead of committed. Your tasks live in `%APPDATA%`, outside the folder.
- UI changes apply with **Reload to see it**; changes to `main.js`, `main/`, `preload.js` or `agent/` need **Restart to apply**. The phone gets them only after an APK rebuild.

## Quick reference

- Enter — add a task (date, time, and tag are optional and stay sticky for batch entry)
- / — jump to the input
- Ctrl+F (Cmd+F on Mac) — search tasks
- ↑/↓ — select a task · Space completes it · Enter expands it · Delete removes it · Esc deselects
- Drag the dots on the left edge of a row to reorder
- Click a row to expand it: subtasks, change date, time, or tag
- Click a tag chip to filter by it
- Hover a row for edit / expand / delete — overdue and due-today tasks also get a snooze (clock) button that pushes them to today / tomorrow
- The tray icon's tooltip shows how many tasks are overdue or due today
