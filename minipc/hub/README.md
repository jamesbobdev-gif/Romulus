# The Tasks hub: a second mini PC for the agent, mail and calendars

**Why (decided 2026-10-16):** the laptop joins public Wi-Fi (CSUwireless). The hub keeps the agent, its browser
with your site logins, mail dates and calendar sync on a box at home that's always on. Nothing on it is open to
the internet: the only way in is over your Tailscale tailnet, with a token.
**the model box stays the local-model box** (Ollama + Holo4). The hub talks to it on the home network, so the hub has to
be at home too, since the model box’s firewall only lets in 192.168.1.0/24.

## What runs where

| | Hub mini PC | Laptop app | Phone |
|---|---|---|---|
| Agent runner (Claude → Gemini → OpenRouter), agent browser + logins | ✅ | – | – |
| the model box’s coordinator (mini PC lane), memory tidy | ✅ | – | – |
| Mail dates, morning look-ahead, calendar ↔ tasks, "Buy this" emails | ✅ | – | – |
| Your lists | syncs with Supabase | syncs with Supabase | syncs with Supabase |
| Watch, Settings → AI connections / calendars / mail | answers | shows, through the hub | – |

Task sync stays on Supabase (option C). That keeps the claude.ai Tasks connector working.

## How it's locked down
- The hub's gateway listens on **127.0.0.1:8790 only**. `tailscale serve` publishes it as
  `https://tasks-hub.<tailnet>.ts.net`, **inside your tailnet only** (the setup turns Funnel off).
- Every call needs the **hub token** (64 hex characters, made on first start, in `~/.config/Tasks/hub-token.txt`).
- **Watch** goes through a relay that lets through only the 8 screen/mouse/keyboard commands Watch uses. A
  stolen token can't read pages or cookies or run code in the agent browser. Each Watch connection needs a
  one-time ticket that expires after 2 minutes. The browser's own debugging port stays on 127.0.0.1.
- Firewall: nothing comes in except SSH and HTTPS **on the Tailscale interface**. SSH is keys only.
- Optional, in the Tailscale admin console → Access controls: only your own devices may reach the hub:
  ```json
  { "acls": [ { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:hub:22,443"] } ],
    "tagOwners": { "tag:hub": ["autogroup:admin"] } }
  ```
  (then tag the hub: `sudo tailscale up --advertise-tags=tag:hub`)

## Setting it up (once)
1. **Install Ubuntu Server 24.04 LTS or AlmaLinux 9/10** (minimal). Tick OpenSSH. Write down the username.
   BIOS: "Power on after AC loss" on.
2. **Tailscale on the laptop and phone**, signed in to the same account. In the admin console → DNS:
   turn on **MagicDNS** and **HTTPS certificates**.
3. **SSH key:** on the laptop: `ssh-copy-id james@<mini PC's home IP>` (or copy `~/.ssh/id_ed25519.pub` to
   `~/.ssh/authorized_keys` there).
4. **On the mini PC:** copy `minipc/hub/setup.sh` over and run `sudo bash setup.sh`. It shows a Tailscale
   sign-in link: open it. Run it once more if it said "No SSH key yet".
5. **From the laptop**, in the repo folder: `.\minipc\hub\deploy.ps1 -Hub james@tasks-hub` (copies the app,
   starts the service). Run it again after every app change.
6. **Sign in to Claude on the hub:** `ssh james@tasks-hub`, then `claude`, then `/login` (paste the code back).
7. **Laptop app → Settings → Agent & AI → Mini PC server:** address `https://tasks-hub.<tailnet>.ts.net`, token
   from `ssh james@tasks-hub cat ~/.config/Tasks/hub-token.txt`. Then **Test**, **Use the mini PC** (Tasks
   restarts), and **Send my settings to it**. That sends your calendar/Gmail sign-ins, AI keys, sync links,
   course feeds and what the agent learned. It goes over Tailscale only.
8. **Log in to sites again in the hub's agent browser:** open a task → ◉ Watch, and log in to Walmart etc.
   there. (Windows encrypts Chrome's saved logins, so they can't move to Linux.) Once that works, delete the
   laptop's old agent browser: `%APPDATA%\Tasks\agent-browser\profile`.

## Day to day
- New calendar account: connect it in the laptop app as usual. The sign-in happens on the laptop, then the
  account goes to the hub by itself.
- ChatGPT (Codex) sign-in can't be done from the laptop: on the hub, run `codex login` over SSH.
- If the hub is off: the lists still work and sync, and agent tasks wait in the queue until it's back.
- To run everything on the laptop again: Settings → Mini PC server → **Run everything here again**, and stop the
  hub first: `ssh james@tasks-hub systemctl --user stop tasks-hub`.
- Logs: `ssh james@tasks-hub journalctl --user -u tasks-hub -f` and `~/.config/Tasks/agent-runner.log`.
