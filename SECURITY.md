# Security

## Reporting a problem

If you find a way to make the Agent act without the user's yes, read data it shouldn't, leak a key, or reach someone else's sync list, please report it privately rather than in a public issue: use GitHub's **Report a vulnerability** button on the Security tab of this repository. You'll get a reply within a few days, and credit in the fix if you want it.

## Threat model

The Agent is an AI that reads your tasks, browses the web and fills forms for you. The things it must not be talked into doing are locked in code, not only in the prompt.

**What the Agent may do by itself**: search the web, read pages, compare, summarize, write and rewrite, build a shopping cart, pick seats, fill a form up to the final button, draft an email, read your Gmail or Outlook and save drafts, label, archive or mark mail read there (through the app's own sign-ins, in runs with no internet tools open), add suggestions to your lists each morning, and keep notes of what you've told it.

**What it never does without a "yes" from you, in the task, to the exact thing it described**: placing an order, submitting an application or form, sending mail, booking or paying for anything, deleting anything on a site. The agent browser refuses buy, submit, send, book, delete and the Enter key until that yes exists, no matter what a page or an email says.

**What it never does at all**: type a PIN, a card number or a password (you type those yourself in the live view), sign out of a site, or run with Finance and the web open in the same run. The one card the app itself types is a one-time Link card you approved for that amount in the Link app; the browser launcher types it, and the AI never sees it.

**What stays on your machines**: Finance (the vault, and the local model's answers from it), the Locked profile (resume, address, IDs: only your local model reads it), API keys and sign-in tokens, the Agent's browser profile.

**What goes to which cloud**: a task's text, its conversation and the pages the Agent reads go to the AI you connected and routed that task to (Claude, ChatGPT, Gemini, OpenRouter, the free tiers). Emails the app reads for you (receipts for Finance, dates, the morning look-ahead, email triggers, inbox tasks) go to the first AI in your order that answers, with no web tools in that call. Nothing goes to the authors of this app.

**Out of scope**: someone with your computer unlocked, or with your sync key (it is the password to a list), can read what you can. The installers are not code-signed yet; the SHA-256 sums below are the check until they are.

## What the app stores, and where

| What | Where | How it's protected |
|---|---|---|
| Your tasks | `tasks.json` in the app's data folder (`%APPDATA%\Romulus` on Windows) | Plain file on your computer. Synced to your own Supabase project if you set that up. |
| API keys, sign-in tokens, private calendar links | `config.json` in the same folder; on the phone, the app's private preferences | On a computer: encrypted with the operating system's own encryption (DPAPI on Windows, Keychain on macOS, the keyring on Linux), so the file is useless copied elsewhere. Never synced. On the phone, the calendar sign-in tokens and links are sealed under an Android Keystore key (AES-256-GCM) and left out of backups. On a headless hub mini PC there is no keyring; the folder is readable by that user only. |
| Sync settings (project URL, anon key, sync key) | Same `config.json` on a computer; the app's private storage on the phone | On a computer, encrypted like the keys above. On the phone, kept in the app's own storage (not readable by other apps) and excluded from Android backups. The sync key is the password to a list: whoever has it can read and change that list, and a phone build you make yourself with `sync-config.json` carries it inside the APK, so keep that build to yourself (the public APK bakes in nothing). |
| The Locked profile (resume, address, IDs for forms) | Its own row in your sync project | Only read by your local model; never given to a cloud AI. |
| Finance (bank data, receipts) | `finance.vault` in the data folder; on a phone you paired by QR code, the app's private storage | AES-256-GCM under a passphrase that is never saved, then the OS encryption again. Locks after 30 minutes, on screen lock and on sleep. On the phone it is encrypted under a key that the Android Keystore releases only inside the fingerprint prompt it was handed to (a `CryptoObject`), and receipt emails stay on the computer. Never sent to a cloud AI. Your local model (on this computer or your mini PC) may read it, while unlocked, to answer money tasks routed to it, in runs with no web access. Receipt emails are read by the first AI in your order to match purchases; a switch in the Finance tab lets you show Claude one screenshot of the tab, and is off unless you press it. Bill payees found in Finance become reminder tasks, so a payee's name can appear in your task list and, like any task, reach the AI the look-ahead uses. |
| The Agent's memory and site notes | Rows in your sync project and files in the data folder | Preferences you typed; one-line tips with no personal data. |
| A Link wallet's sign-in | `link-wallet\auth.json` in the data folder, kept by Link's own tool | A plain file readable by this user only, like the Agent's browser profile. On its own it can only ask Link for a one-time card, which you still approve in the Link app. The card itself lives in the browser launcher's memory for that run and is never written down. |
| Files the local model's browser downloaded (worksheets) | The `agent-files` bucket of your sync project, in a folder named by a hash of the agent key; on the mini PC, `Downloads/Romulus` | Only that folder is published, never your own Downloads; no runnable files; 10 MB each, removed after 30 days. Added, listed and removed only by a request that carries a one-way hash of the agent key (the key itself never reaches the server). |

## What leaves the computer

- A task's text and conversation go to whichever AI you connected and routed it to. Tasks containing your private words (bank, medical, password… editable) only go to a local model.
- Cloud AIs get web search and, for some, the agent browser. Any AI in your order can work in your Gmail or Outlook, but only through the app's own mail tools, and only in runs that have no web search, web pages or browser open. On its own it can search and read, save drafts, change labels (Outlook: categories), archive and mark mail read or unread. Sending, replying, forwarding, sending a draft and moving mail to the trash are refused unless the run was started by your yes to that one task's ask, the same rule as placing an order. Nothing deletes mail for good: trash can be undone for 30 days. The access tokens for those tools live in a file of their own for the length of the run, never in an AI's settings.
- With a Link wallet connected, an order you said yes to (the store, the items, the total) goes to Stripe's Link when the Agent asks for a card, so you can approve it in the Link app.
- The sync project receives your lists, encrypted in transit, reachable only through server functions that need the sync key. After **Encrypt my lists end to end** (Settings → Device sync) it holds only ciphertext under lookup ids: the switch makes a new sync key (the old one was the row id of the plain lists, so the project had it), you pair your other devices again, and from then on nothing on the server, in its logs or in its backups can read a list. Lists that were encrypted by a build before 1.0.28 stayed under the old key: press **Rotate sync key** once to move them under one the project never saw.
- Nothing is sent to the authors of this app. There is no telemetry.

## Known limits (as of the November 2026 review)

Things the review found and left as they are, because the fix changes how lists or networks are set up. Worth knowing if you run a shared sync project or a mini PC:

- **The list keys are related.** The Agent, Work and School keys are the personal key with a different prefix, so anyone holding one of them (the mini PC, a phone build with only the agent key) can work out the others. Making them one-way derived means re-keying every existing list; planned for the next sync version.
- **Ollama traffic is plain HTTP.** When the local model runs on another machine, the Locked profile and Finance answers cross your network unencrypted to a port with no password. Put it behind Tailscale (`minipc/setup.sh` does) or the SSH tunnel, never on open Wi-Fi.
- **A sync peer can say yes to an update.** Anyone with your sync key can answer "Update" on your behalf (the `:updates` row); the installer still comes only from the official release feed and is checked against its `latest.yml`.
- **An inbox run can use other connectors** you have allowed in your own Claude Code settings (Stripe, Linear, …): Romulus denies the ones it knows about, not a list it can't see.
- **The two file buckets are public by address.** A photo or a downloaded worksheet is served to anyone who has its exact address (a 40-character hash folder plus a hashed name), which only the sync rows reveal. Nothing can list a folder: the photo bucket has no listing at all, and the downloads bucket lists, adds and removes only for a request that carries a one-way hash of the agent key (the key itself, which seals the lists end to end, never reaches the server). What stays open is bandwidth: a public address can be fetched in a loop by whoever has it, so a shared project should carry a spend cap or an egress alert in Supabase.
- **The sync key is remote control of the mini PC's browser.** Anyone holding the agent key can watch and click in the local model's browser over the live relay (messages are sealed under the key and expire after 30 s). That is the design: the key is the password to the list and to that browser. A phone build with a baked-in key is a remote control.
- **Keys from before November 2026 can be short.** New lists need a 32-character id, and old lists keep working with whatever they had, including a hand-typed one. Reads are not rate-limited, so a short, guessable key can be searched for. Generate a new key in Settings if yours was typed by hand.
- **Limits are per network.** Uploads (60 an hour), new lists and pairing codes are counted per public address, so a campus behind one address shares one allowance, and one person can use it up for the others for that hour.
- **A re-run of the release workflow** for an existing tag can replace that tag's desktop installers: electron-builder's publisher overwrites an asset that is already there. The checksum files and the APK are uploaded without `--clobber`, so a re-run fails on those instead of replacing them, and an installer swapped by a re-run no longer matches its published `SHA256SUMS` line.

## Design points worth knowing

- **Final actions are locked in code**, not just in the prompt: the agent browser refuses buy, submit, send, book, delete and the Enter key until the user has said yes in the task.
- **A Link card never reaches the AI.** The browser launcher asks Link for it (only after that same yes, and only for the store the yes was about), types it into fields the page labels as card fields, blanks the number out of every page it passes on, and refuses screenshots from then on. The AI is told the brand and the last four digits. Link caps the card at the amount you approved, so a store charging more is declined.
- **Page text is data, not instructions.** The prompts tell every AI so, and inbox runs cannot reach the web, so an email cannot make the Agent send your mail somewhere.
- **The sync table is closed** to the project's anon key. Lists are reached only through `sync_get` / `sync_put` functions that need the row's sync key (`supabase/setup.sql`).
- **The installer is not code-signed yet**, so Windows shows an "unrecognized app" warning. Every release has a `SHA256SUMS-<os>.txt` next to the installers (written by the release workflow on the machine that built them): compare your download's SHA-256 with the line in it (`certutil -hashfile <file> SHA256` on Windows, `shasum -a 256 <file>` on a Mac, `sha256sum <file>` on Linux) if you want to be sure of what you downloaded.
- **The release workflow** pins each GitHub action to a commit, runs with a read-only token and fails on critical `npm audit` findings in what ships; Dependabot opens the update pull requests.
