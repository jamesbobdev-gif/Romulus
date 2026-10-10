# Mini PC: running your own AI model for the Tasks app

Goal: the Tasks app's Agent tab can use **your own model** on the Lenovo mini PC instead of Claude,
including driving Claude's browser, so you get more done with fewer Claude credits.

## The mini PC

| | |
|---|---|
| Processor | Intel Core i7-13620H (no separate graphics card, so models run on the processor) |
| Memory now | 16 GB DDR4-3200 (Lenovo stick), 1 of 2 slots used |
| Memory ordered | Crucial 16 GB DDR4-3200 SODIMM, https://www.amazon.com/dp/B08C511GQH (ordered 2026-10-07) |
| Memory after | **32 GB, both slots**: about twice as fast for AI, and room for the 30B model |
| Operating system | Windows now, switching to **Ubuntu Server 24.04 LTS** |
| Network | Same home network as the main PC |

## Steps

### 1. Install the memory stick (about 5 minutes)
1. Shut down and unplug.
2. Remove the screw at the back and slide the cover off.
3. Touch something metal to get rid of static.
4. Slide the new stick into the empty slot at an angle, then press it flat until the side clips click.
5. Turn it on. Task Manager → Performance → Memory should show **32 GB, Slots used 2 of 2**.

### 2. Make the Ubuntu USB (on the main PC)
1. Download **Ubuntu Server 24.04 LTS** from https://ubuntu.com/download/server (about 3 GB).
2. Download **Rufus** from https://rufus.ie. Plug in a USB stick of 8 GB or more (it gets erased).
3. In Rufus, pick the USB stick and the Ubuntu file, then press **Start**.

### 3. Install Ubuntu on the mini PC
- **Copy off anything you want to keep first.** This erases the drive.
- Boot from the USB. On Lenovo, press F12 at power-on for the boot menu.
- Write down the **username and password** you choose.
- Check **"Install OpenSSH server"** (so you can control it from the main PC).
- Skip the optional extras (Docker, Nextcloud, …).
- Optional: in the BIOS (F1 at power-on), turn on **"Power on after AC loss"** so it restarts after a power cut.

### 4. Ollama + the model (ask Claude for the exact commands)
- Install Ollama, the program that runs the model.
- Download **Qwen 3 30B-A3B** (the main model, smart and quick on this hardware) and **Qwen 3 8B** (a faster backup).
- Make Ollama reachable **only from your home network**.
- In your router, give the mini PC a **fixed address** so the Tasks app always finds it.

### Status (2026-10-08): ✅ mini PC is up
- Ubuntu **26.04.1 LTS** Desktop, user `lupa`, address **192.168.1.192** (reserve it in the router!),
  16 threads, 937 GB drive, **30 GB memory (both sticks in)**.
- This PC logs in with an SSH key (`~/.ssh/id_ed25519`, "tasks-desktop").
- `minipc/setup.sh` ran: updates, sleep/suspend disabled, firewall on (only 192.168.1.0/24 may use SSH
  and port 11434), Ollama listening on the home network (keep-alive 24h, 16k context).
- Model now (2026-10-10): **Holo4-35B-A3B**, H Company's official Q4_K_M GGUF
  (`hf.co/Hcompany/Holo4-35B-A3B-GGUF:Q4_K_M`, 22 GB, Apache 2.0). A computer-use agent model built on
  Qwen3.6-35B-A3B: only ~3B of it works per word, so it writes ~13.5 tokens/s and reads ~118 tokens/s on
  this CPU (qwen3.5:9b: 7.4 and 43). Thinking stays off. Loaded, lupa still has ~6 GB free.
- Chosen with `minipc/bench/bench-agent.py` (the app's real agent loop on fake sites and data). Official
  Holo4: 14/23, with a 30-page / 60-question questionnaire finished in 32 min (quiz 19/20, survey 20/20,
  screener 17/20, stopped before Submit), web lookup, own data, multi-step lookup, prompt-injection,
  booking form and receipt screenshot all 2/2. Its two weak spots, now handled in the app: it invented
  product links (options now keep only links it was shown, `linkSeen`; repeat searches get "nothing
  new, open a link"), and read "find a gym slot" as a web search (free-time words now bring in his
  calendar). After the fixes: calendar 3/3, shopping 2/3 (was 0/2). Notes aren't always bullet points.
  qwen3.5:9b got sums wrong; gemma4:26b broke its JSON and ran out of memory. Only Holo4 is on lupa now.
- **One model in memory at a time** (`/etc/systemd/system/ollama.service.d/one-model.conf`,
  `OLLAMA_MAX_LOADED_MODELS=1`): two big models loaded together ran lupa out of memory and Ollama was killed.
- Claude Code is installed on the mini PC (for "ask Claude"); sign-in still to check.

### Decisions (2026-10-07, from your plan doc "Personal AI Agent How It Works")
- **Two lanes.** *Claude* = the Tasks app on the home PC, on your Claude subscription (no paid API).
  *Local* = your own model on the mini PC.
- **Standard Qwen**, not an uncensored version (better at careful tool use; harder for a web page to trick).
- **Two levels of memory.**
  - ⚙ "What Claude knows about you, everyday": preferences. Both lanes see it.
  - ⚙ "Locked, only your mini PC sees this": resume, contact details for forms. Claude never sees it.
- **Lanes are assigned before anyone starts a task**, and each worker must *claim* a task first.
  Only one can win. ✅ Built.
- **Switch button** on every Agent task ("Switch to mini PC" / "Switch to Claude"). The whole
  conversation goes with it, and a late answer from the old model is thrown away. ✅ Built.
- **The mini PC browser is locked in code.** It only opens the links in the task, and Submit, Send,
  Buy, Book, Apply, Delete and Enter are refused until you've said yes. ✅ Built (switched on by the
  dispatcher's lock file).
- **Connector tools for the mini PC:** get_task, set_lane, claim_task, finish_task. ✅ Live.
- Once the dispatcher runs, set `agentRunner.waitForLane: true` in the home PC's config, so the home PC
  only takes tasks routed to Claude.

### Skills, and asking Claude for missing context (decided 2026-10-08)
- **Skills ✅ built (Claude side).** Short how-to files in `agent/skills/`: shopping, 3d-printing,
  jobs-internships, email, bookings-services. Each run loads the ones matching your words in the task,
  and the agent can open any other one itself. The mini PC's worker will use **the same files**.
  Skills hold general know-how only; personal facts stay in your preferences or the locked profile.
  New skills are easy to add, which is also how open-source contributors can help.
- **No asking Claude (changed 2026-10-09).** You want to move off Claude, so the local model never
  asks it anything. Instead it has `search_my_data`: a keyword search over what the Tasks app already
  knows (all your tasks and their conversations, including what Claude found on earlier tasks, plus
  notes, preferences, the locked profile, your calendar and the skills). It runs on this computer and
  sends nothing anywhere.

### Working web pages (built 2026-10-09)
A small model gets lost in raw page outlines, so `agent/page-reader.js` does the bookkeeping for it:
- **It sees the page after every click or entry**, without spending a step on looking: popups first,
  then any error the page shows ("Please enter a valid email"), then which fields are still empty
  (required ones marked ⚠), then the page with each field's current value. Menus and footers are
  folded into one line; long pages are cut, and `browser_find` reaches the rest.
- **Its slips are fixed before they reach the browser:** a label instead of a ref ("Email" →
  [f1e19]), a ref without its prefix, a dropdown choice in the wrong case, a radio "filled" with the
  choice's text, fields given as {label: value}, addresses without https://.
- **Forms are filled one field at a time**, so one wrong field doesn't lose the others, and it's told
  which one failed.
- **It's told when it repeats itself**, and when it has 4 steps left, so it reports instead of
  running out.
- New skill `agent/skills/web-forms.md`: popups, date and phone formats, fields that suggest as you
  type, multi-page forms, job portals, and when to stop and ask.

### Form mode, site notes, form answers (built 2026-10-09)
- **Form mode** (`agent/form-mode.js`): on a form page the model calls `fill_form`; it gets one short
  question (just the fields + his details) and must answer in a fixed JSON shape (dropdowns can only be
  their real choices). The app fills every field, rewrites times/dates the page refuses, and never
  fills passwords, SSN, card or bank fields. A browser action repeated 3 times in a row isn't run.
- **Site notes** (`agent/sites/*.md`): know-how per website (Oracle job portals, WayUp, Fresha, 3D
  model sites, Amazon, ticket sites). Both Claude and the mini PC get the notes for the sites in a
  task; the mini PC also gets one when it reaches a new site. After a browser run it may leave a
  one-line tip, kept in `%APPDATA%\Tasks\site-notes\` (newest 10 per site, marked unchecked; tips
  with an email or phone number are dropped). Edit or delete those files freely.
- **Form answers:** ⚙ Settings → Locked → **+ Form answers** adds the questions forms keep asking.
  Answer them once; blank ones stay empty on forms.
- **Lupa's screen must not lock:** a locked GNOME screen stops Chromium drawing, so clicks time out
  (typing still works). Turn off auto-lock/blanking on lupa.

### 5. Hook it up to the Tasks app (Claude builds this)
- ⚙ Settings → **Model for Agent tasks**: Claude / My model / Auto.
  - **Auto:** your model handles tasks, including the browser. Claude takes over if your model gets
    stuck, and your model covers for Claude when Claude's usage runs out.
- Same agent browser and same rules as Claude: look, fill in, then **ask you before anything final**
  (buy, submit, pay, send, book, delete). For your model this stop is enforced in code: the browser
  refuses those clicks until you've said yes in the Agent tab.
- Tested on the same practice form Claude passed before it's switched on.

## What to expect
- Everyday tasks (lookups, comparisons, drafting): seconds to a minute or two.
- Browser tasks: about **30–60 seconds per click**, so a long form might take 10–20 minutes in the
  background. It's slower than Claude and makes more mistakes on tricky sites, but it costs no Claude credits.

## Where things live on the main PC
- App code: `C:\Users\James\Downloads\tasks-app`
- Your tasks, settings and Claude's browser: `C:\Users\James\AppData\Roaming\Tasks`
  - `tasks.json`: your tasks (backups in `backups\`)
  - `agent-runner.log`: what the background Claude did and when
  - `agent-browser\`: Claude's browser (its own Chrome profile, the tool, and its launcher)
