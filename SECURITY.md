# Security

## Reporting a problem

If you find a way to make the Agent act without the user's yes, read data it shouldn't, leak a key, or reach someone else's sync list, please report it privately rather than in a public issue: use GitHub's **Report a vulnerability** button on the Security tab of this repository. You'll get a reply within a few days, and credit in the fix if you want it.

## Threat model

The Agent is an AI that reads your tasks, browses the web and fills forms for you. The things it must not be talked into doing are locked in code, not only in the prompt.

**What the Agent may do by itself**: search the web, read pages, compare, summarize, write and rewrite, build a shopping cart, pick seats, fill a form up to the final button, draft an email, read your Gmail (Claude only, in runs with no internet tools open), add suggestions to your lists each morning, and keep notes of what you've told it.

**What it never does without a "yes" from you, in the task, to the exact thing it described**: placing an order, submitting an application or form, sending mail, booking or paying for anything, deleting anything on a site. The agent browser refuses buy, submit, send, book, delete and the Enter key until that yes exists, no matter what a page or an email says.

**What it never does at all**: type a PIN, a card number or a password (you type those yourself in the live view), sign out of a site, or run with Finance and the web open in the same run.

**What stays on your machines**: Finance (the vault, and the local model's answers from it), the Locked profile (resume, address, IDs: only your local model reads it), API keys and sign-in tokens, the Agent's browser profile.

**What goes to which cloud**: a task's text, its conversation and the pages the Agent reads go to the AI you connected and routed that task to (Claude, ChatGPT, Gemini, OpenRouter, the free tiers). Receipt emails from Gmail go to Claude, which reads them for the Finance receipts feature. Nothing goes to the authors of this app.

**Out of scope**: someone with your computer unlocked, or with your sync key (it is the password to a list), can read what you can. The installers are not code-signed yet; the SHA-256 sums below are the check until they are.

## What the app stores, and where

| What | Where | How it's protected |
|---|---|---|
| Your tasks | `tasks.json` in the app's data folder (`%APPDATA%\Romulus` on Windows) | Plain file on your computer. Synced to your own Supabase project if you set that up. |
| API keys, sign-in tokens, private calendar links | `config.json` in the same folder | On a computer: encrypted with the operating system's own encryption (DPAPI on Windows, Keychain on macOS, the keyring on Linux), so the file is useless copied elsewhere. Never synced. On a headless hub mini PC there is no keyring; the folder is readable by that user only. |
| Sync settings (project URL, anon key, sync key) | Same `config.json` on a computer; the app's private storage on the phone | On a computer, encrypted like the keys above. On the phone, kept in the app's own storage (not readable by other apps) and excluded from Android backups. The sync key is the password to a list: whoever has it can read and change that list, and a phone build you make yourself with `sync-config.json` carries it inside the APK, so keep that build to yourself (the public APK bakes in nothing). |
| The Locked profile (resume, address, IDs for forms) | Its own row in your sync project | Only read by your local model; never given to a cloud AI. |
| Finance (bank data, receipts) | `finance.vault` in the data folder; on a phone you paired by QR code, the app's private storage | AES-256-GCM under a passphrase that is never saved, then the OS encryption again. Locks after 30 minutes, on screen lock and on sleep. On the phone it is encrypted under a key released only by your fingerprint, and receipt emails stay on the computer. Never sent to a cloud AI. Your local model (on this computer or your mini PC) may read it, while unlocked, to answer money tasks routed to it, in runs with no web access. Receipt emails are read by Claude to match purchases; a switch in the Finance tab lets you show Claude one screenshot of the tab, and is off unless you press it. Bill payees found in Finance become reminder tasks, so a payee's name can appear in your task list and, like any task, reach the AI the look-ahead uses. |
| The Agent's memory and site notes | Rows in your sync project and files in the data folder | Preferences you typed; one-line tips with no personal data. |

## What leaves the computer

- A task's text and conversation go to whichever AI you connected and routed it to. Tasks containing your private words (bank, medical, password… editable) only go to a local model.
- Cloud AIs get web search and, for some, the agent browser. Only Claude can read your Gmail, and only in read-only runs that have no internet tools open.
- The sync project receives your lists, encrypted in transit, reachable only through server functions that need the sync key.
- Nothing is sent to the authors of this app. There is no telemetry.

## Design points worth knowing

- **Final actions are locked in code**, not just in the prompt: the agent browser refuses buy, submit, send, book, delete and the Enter key until the user has said yes in the task.
- **Page text is data, not instructions.** The prompts tell every AI so, and inbox runs cannot reach the web, so an email cannot make the Agent send your mail somewhere.
- **The sync table is closed** to the project's anon key. Lists are reached only through `sync_get` / `sync_put` functions that need the row's sync key (`supabase/setup.sql`).
- **The installer is not code-signed yet**, so Windows shows an "unrecognized app" warning. Every release has a `SHA256SUMS-<os>.txt` next to the installers (written by the release workflow on the machine that built them): compare your download's SHA-256 with the line in it (`certutil -hashfile <file> SHA256` on Windows, `shasum -a 256 <file>` on a Mac, `sha256sum <file>` on Linux) if you want to be sure of what you downloaded.
- **The release workflow** pins each GitHub action to a commit, runs with a read-only token and fails on critical `npm audit` findings in what ships; Dependabot opens the update pull requests.
