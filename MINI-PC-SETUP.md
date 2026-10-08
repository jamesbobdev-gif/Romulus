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
- **Ask Claude (to build on the mini PC).** When the local model lacks context (how a site works,
  what a term means, how to approach a task), it gets an `ask_claude` tool:
  - The mini PC runs Claude Code itself (signed in to your subscription) with web search only. No
    files, no connectors, and never your locked profile.
  - **Privacy wall in code:** the question is checked before it leaves. If it contains anything from
    the locked profile (lines, email, phone, address, ID-like numbers), it is refused and the model
    has to rephrase without it.
  - **It builds its own context:** each answer is saved as a note in `~/agent-share/learned/`
    (topic, date, the question). Notes are loaded like skills next time, so it doesn't ask twice. The
    weekly tidy merges them and drops outdated ones.
  - **Shown to you:** the task's conversation gets a line like "Mini PC asked Claude: how does
    Handshake's apply flow work?"
  - **Budget:** a few questions per task and a daily cap, so it stays cheap.

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
