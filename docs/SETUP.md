# Setting up Romulus

Romulus works the moment you install it: a to-do list on your computer, nothing to sign up for. Everything else is optional and switched on from **⚙ Settings**. This guide walks through each piece, in the order most people want them.

1. [Install](#1-install)
2. [Connect an AI](#2-connect-an-ai) (for the Agent tab)
3. [Sync with your phone](#3-sync-with-your-phone)
4. [Calendars](#4-calendars)
5. [Where your keys live](#5-where-your-keys-live)
6. [If something doesn't work](#6-if-something-doesnt-work)

## 1. Install

**Windows:** download `Romulus-Setup-<version>.exe` from the [releases page](https://github.com/jamesbobdev-gif/romulus-releases/releases) and run it. The installer is not code-signed yet, so Windows shows an "unrecognized app" warning: click **More info → Run anyway**. Romulus starts when you log in and lives in the tray; closing the window hides it there. Windows keeps a new tray icon under the ^ by the clock until you drag it onto the taskbar (the first time the window hides, a notice says so). To pin it: Start menu → right-click **Romulus** → Pin to taskbar.

**Mac:** download the `.dmg` from the same page and drag Romulus to Applications. It isn't signed by Apple yet, so the first open needs **System Settings → Privacy & Security → Open Anyway**, and updates have to be downloaded by hand until it is.

**Linux:** download the `.AppImage`, `chmod +x` it and run it. Encrypted keys need a keyring (GNOME Keyring or KWallet).

**From source:** `npm install` then `npm start` (Node 22 or newer).

Updates ask first: the app checks every few hours, and when a new version is out it shows **Update** / **Not now** (the tray menu offers it too). Once downloaded it installs when you quit or when the computer has been idle, or right away with **Restart now**. Your answer reaches your other devices through sync: say **Update** on one and the computers update too (the phone shows its banner, since Android needs your tap), and **Not now** holds for all of them. Settings → Updates can switch it to **Automatically**. The phone shows an **Update** banner too.

## 2. Connect an AI

The **Agent** tab hands tasks to an AI that can search the web, read your inbox, fill forms and shop for you. It needs at least one AI connected. The Agent tab says so until you do, with a **Connect an AI** button; or open **⚙ Settings → Agent & AI → AI connections**. Each AI is a card; switch it on, follow the button on the card, and it's connected. When several are on, the app tries them top to bottom.

Pick whichever of these you already have.

### Claude (recommended if you have a Claude Pro or Max plan)

Claude runs through **Claude Code**, a small program from Anthropic that signs in with your Claude account.

1. On the Claude card press **Install Claude Code**. It runs Anthropic's installer; a minute or two.
2. Press **Sign in to Claude**. A terminal window opens and your browser asks you to sign in to claude.ai. Come back when it says you're signed in; the card updates on its own.
3. Press **Check**. Claude answers one word to prove it works.

No Claude plan? Paste an **Anthropic API key** instead (button on the card takes you to console.anthropic.com). Runs are then billed to that key, pay as you go.

Claude is the only AI that can read your Gmail and open your photos, so inbox tasks always go to Claude.

### OpenRouter (easiest; one account, hundreds of models, some free)

Press **Connect with OpenRouter**. Your browser opens openrouter.ai; sign in or make a free account and approve. OpenRouter hands the app a key, nothing to paste. Turn on **Try free models first** to spend nothing until the free ones are busy.

### ChatGPT

Two ways: **your ChatGPT plan** (press Install Codex, then Sign in with ChatGPT) or an **OpenAI API key** (paste it from platform.openai.com/api-keys).

### Gemini

Gemini needs a free API key: press **Open Google AI Studio**, click Create API key, paste it, Save key. Use a key with billing turned on if you don't want Google using your tasks to improve its models.

### Grok, Groq, Cloudflare, NVIDIA (free tiers)

Each card has a **Get a free key** button to the right page and a **Test key** button. They answer questions and write, but don't browse unless you switch the browser on for them.

### A local model (private; nothing leaves your machines)

Install [Ollama](https://ollama.com/download) on this computer (or any computer on your network), pull a model (`ollama pull qwen3:8b` is a reasonable start; bigger is smarter), then in **⚙ Settings → Local model**:

1. Leave the address as `http://localhost:11434`, or type the other computer's address.
2. Press **Find models**, pick one, press **Use it**.

**Model on a different computer (a mini PC, a gaming PC)?** You don't need to connect them over the network. Install Romulus on the computer that runs Ollama too, connect it to sync (step 3, the same way as a phone), set up the local model there with `http://localhost:11434`, and switch on **Run local tasks here for all my devices**. Leave the app open on that computer. It picks up local tasks from your phone and other computers through sync. Your other computers then show it as answering, with nothing to set up on them. Money questions stay with the computer that has your Finance tab.

If Ollama is already running on this computer the panel notices and says so. Tasks that contain private words (bank, medical, password…) only ever go to the local model; see **Who does Agent tasks** to tune the words and rules.

### Link wallet (pay at any store)

The Agent orders by itself at Amazon, Walmart, Target, Best Buy and Shopify stores with Shop Pay, where your card is already on file. For any other store, connect a [Link](https://link.com) wallet (Stripe's; US and Canada): **⚙ Settings → Agent & AI → Link wallet → Connect Link**. The app installs Link's small command-line tool, opens its sign-in page and shows a phrase to enter in the Link app. From then on, when you say yes to an order at such a store, the Agent asks Link for a one-time card for that exact amount, Link asks you to approve it in the Link app, and the Agent's browser types the card into the checkout itself. The AI is told the last four digits only, the number is blanked out of every page it reads afterwards, and the card is dead after that one purchase. The store stays the merchant: returns and refunds go through it as usual. **Test mode** (under Advanced) uses fake cards and charges nothing, for trying it out.

## 3. Sync with your phone

Your lists can be shared between your computer and your phone through a free [Supabase](https://supabase.com) project of your own. Your data lives in your project, under a sync key only your devices know. About ten minutes, once.

### Make the project

1. Sign up at supabase.com and press **New project**. Any name, any region; write down the database password it asks for (you won't need it again, but keep it).
2. When the project is ready, open **SQL Editor → New query**, paste the whole of [`supabase/setup.sql`](../supabase/setup.sql), press **Run**. It makes the one table the app uses and the functions that guard it. Run it again any time; it only adds what's missing.
3. Open **Project Settings → API**. Copy the **Project URL** (`https://xxxx.supabase.co`) and the **anon / publishable** key. (Never use the secret or service_role key in the app.)

### Connect the computer

In **⚙ Settings → Device sync**:

1. Paste the Project URL and the anon key.
2. Press **Generate key** to make a sync key. This is the password to your list: anyone with it can read and change the list, so treat it like one. (If it ever gets out, **Rotate sync key** in the same panel makes a new one, moves every list over and blanks the old rows; you then pair the other devices again with the new sync code.)
3. Press **Save & sync**.

That's every list: Work, Agent and School sync through the same project under keys made from your sync key, so the three values are all a second device needs. (Settings → Per-list keys lets you give one list a different key, for example a Work list shared with a colleague.)

### Encrypt end to end (recommended)

As set up above, the project holds your lists as readable JSON, closed to anyone without the sync key but open to whoever can log in to the project itself (you, Supabase staff, a backup). **Encrypt my lists end to end** in the same panel changes that: every list is uploaded again encrypted on your device, under ids that give nothing away, and the old rows are replaced by a marker. From then on the project, its backups and its logs hold only ciphertext, and the sync key never leaves your devices.

- Your other devices follow on their own at their next sync, with nothing to paste again. They need Romulus 1.0.10 or newer; an older copy shows a sync error until it updates. The Android widgets follow too.
- The claude.ai connector, the Work calendar feed and the School feed (the optional edge functions in `supabase/functions`) run on the project and can no longer read the lists, so they stop. Keep the lists plain if you use them.
- Run `supabase/setup.sql` again first if your project was set up before November 2026, so the database knows to refuse a plain write over the marker.
- There is no way back from Settings, and no recovery without the sync key: the project can't restore a list for you. Keep the sync code somewhere safe.

### Connect the phone

On the computer press **Copy sync code** in the same panel; it holds all three values. Send it to yourself through something you trust (a password-manager note, not a group chat), then on the phone open **⚙ Settings → Device sync**, paste it into the first box and press **Save & sync**.

The Android app is `Romulus-<version>.apk` on the [releases page](https://github.com/jamesbobdev-gif/romulus-releases/releases/latest): download it on the phone and open it. It updates itself from then on (an **Update** banner appears when a new version is out). To build it yourself instead, see the README.

## 4. Calendars

**⚙ Settings → Calendars** connects Google or Microsoft calendars (events become to-dos, tasks can go onto the calendar) or any calendar link (Blackboard, D2L, iCloud…).

- Press **+ Google** or **+ Microsoft** and sign in. The official installer has its own sign-in built in.
- If your copy says it has no Google sign-in of its own (a build from source), make a free Google Cloud OAuth credential of type **Desktop app** and paste its Client ID and Secret where the panel asks. Developers: see `oauth-clients.example.json` for shipping your own.
- For a link, press **+ Calendar link** and paste the subscribe link (`.ics` or `webcal://`). Read-only.

Then choose, per calendar, whether its events become to-dos and whether your tasks appear on it.

**Agent tasks that start on their own.** Open an Agent task and set **Starts when**: *an email arrives about…* (needs Gmail ticked on the Google sign-in), *hours before a calendar event…*, or *a web page says…* (a public page the app can fetch; shops that block plain fetches won't work). The task shows as *watching* and runs when it happens, with what set it off in its conversation. The computer that runs the Agent does the looking, every few minutes; a page is fetched every six hours.

**Steps it stops asking about.** Reply “always” or “don’t ask next time” when the Agent checks before an ordinary step (logging in, building a cart, opening a seat map) and it offers to remember that; press **Allow**. The list is in **⚙ Settings → The Agent → Doesn’t ask again**, where you can add or remove lines. Buying, paying, sending, submitting and booking can’t go on it: those always wait for your yes.

**Goals.** Title an Agent task “Goal: …” (or add `#goal`) for something that takes weeks: getting an internship, planning a move. The first run only plans it: steps in order, with an estimate of the Agent’s time, and what it would need from you. Reply with changes to get a new plan, or press **Start these steps**: each step becomes its own Agent task, run one after another on the computer that runs the Agent, and the goal shows how far along it is. Anything final inside a step (applying, sending, booking) still waits for your yes there. The goal task’s instructions go to every step.

**The local model’s sites.** The list in **⚙ Settings → Routing → Sites the local model may open** fills itself: every site the local model reaches in a run is added, so it's allowed next time. When its browser refuses a site it needed, a to-do appears on your Human list (“Allow the local model on linkedin.com? …”). Check it off to allow the site and run the task again; delete it to say no.

### Health goals (phone)

On the phone, the **Health** tab → **Connect** lets Romulus read your steps, sleep and workouts (read-only)
from the phone's health store. On an iPhone that is **Apple Health**, which the phone, an Apple Watch and most
health apps write to; if a number stays blank, allow it in the Health app under Sharing → Apps → Romulus. On
Android it is **Health Connect**, which Samsung Health, Fitbit, Google Fit, Oura, Garmin and most other health
apps write to; on Android 13 or older the button first installs Health Connect from Play.

Then write goals as ordinary to-dos, due today or with no date, and they tick themselves off once you've
done them: **Walk 8,000 steps** (or 10k steps), **Sleep 7 hours** (or 8h of sleep), **Work out 30 min**
(or 45 minutes of yoga, run 1 hour). A repeating one comes back the next day as usual. If you untick one,
it stays unticked for the day. The numbers stay on the phone; only the tick syncs.

## 5. Where your keys live

Everything you connect stays on the computer where you connected it, in the app's config file (`%APPDATA%\Romulus\config.json` on Windows). API keys, sign-in tokens, sync keys and private calendar links are stored encrypted with your operating system's own encryption, so the file is useless if copied to another account or machine. The Settings page only ever shows a key's first and last characters.

The sync key is a bearer secret: whoever has it can read and change the lists it opens, with nothing else to prove. On the computer it lives only in that encrypted config file (nothing is kept in the page's browser storage); on the phone it lives in the app's own storage, which is excluded from Google backups and device transfers, so a restored phone is paired again by hand. The Locked profile is encrypted on your device with a key made from the agent sync key before it is uploaded, so the sync project only ever holds ciphertext for it.

Keys are never synced between devices and never leave the app except to the service they belong to. The one thing you do share by hand is the sync key, which is meant to be the same on every device.

A Link wallet's sign-in lives in `link-wallet\auth.json` in the same folder, kept by Link's own tool, which rotates it. It can only ask Link for a one-time card that you then approve in the Link app, so on its own it buys nothing.

## 6. If something doesn't work

- **The Claude card says "not installed" after installing.** Press **I already have it**: the app looks again. If `claude` works in a terminal but not here, restart Romulus so it sees the new PATH.
- **Sign in to Claude never finishes.** Close the terminal window it opened, run `claude auth login` yourself in any terminal, then press Sign in again (or just restart Romulus: it checks on start).
- **"not reachable" on the Local model panel.** Ollama isn't running on this computer (`ollama serve` should be up). For a model on another machine, don't point this computer at it over the network: install Romulus there, switch on **Run local tasks here for all my devices**, and this computer picks it up through sync ([docs/second-machine.md](second-machine.md)).
- **Device sync says "fill in the three personal fields".** All three are needed: URL, anon key, sync key.
- **The phone and computer show different lists.** Check the sync key matches exactly on both; one character off is a different (empty) list.
- **Something else.** The app keeps a short diary at `%APPDATA%\Romulus\agent-runner.log`; it usually names the problem. Open an issue with the relevant lines (strip anything personal).
