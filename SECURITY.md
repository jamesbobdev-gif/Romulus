# Security

## Reporting a problem

If you find a way to make the Agent act without the user's yes, read data it shouldn't, leak a key, or reach someone else's sync list, please report it privately rather than in a public issue: use GitHub's **Report a vulnerability** button on the Security tab of this repository. You'll get a reply within a few days, and credit in the fix if you want it.

## What the app stores, and where

| What | Where | How it's protected |
|---|---|---|
| Your tasks | `tasks.json` in the app's data folder (`%APPDATA%\Tasks` on Windows) | Plain file on your computer. Synced to your own Supabase project if you set that up. |
| API keys, sign-in tokens, sync keys, private calendar links | `config.json` in the same folder | Encrypted with the operating system's own encryption (DPAPI on Windows, Keychain on macOS, the keyring on Linux). Useless if copied elsewhere. Never synced. |
| The Locked profile (resume, address, IDs for forms) | Its own row in your sync project | Only read by your local model; never given to a cloud AI. |
| Finance (bank data, receipts) | `finance.vault` in the data folder | AES-256-GCM under a passphrase that is never saved, then the OS encryption again. Locks after 30 minutes, on screen lock and on sleep. Never leaves the computer; the Agent cannot read it. |
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
- **The installer is not code-signed yet**, so Windows shows an "unrecognized app" warning. Check the SHA-256 shown on the release page if you want to be sure of what you downloaded.
