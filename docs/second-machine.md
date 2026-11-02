# Running the local model on a second machine

Everything runs on one computer by default. One optional move puts the heavy part on another box, so your laptop stays light and local tasks keep going with the lid closed: **the local model and its browser on a mini PC or old desktop**, with the app on that box doing the local tasks for every device.

Your devices never connect to that box. It only reaches out, to the same sync project your phone uses (Supabase), so there is nothing to open on your network, no VPN or Tailscale, and no address to type anywhere else. The box can sit behind any router.

## Setting it up

Any Linux or Windows box with 16 GB of RAM runs an 8B model; 32 GB runs a 30B mixture-of-experts model (the kind that only uses ~3B parameters per token, so it's quick on a CPU) well enough to fill forms and write. No graphics card needed.

On the box:

```
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:30b-a3b          # or qwen3:8b on 16 GB
```

Keep Ollama listening on that box only (`OLLAMA_HOST=127.0.0.1:11434`, the default). Ollama has no password, so don't open it to the network with `0.0.0.0`; nothing needs to reach it from outside.

`minipc/setup.sh` does that on Ubuntu in one go (updates, no sleep, a firewall that lets in only SSH from home, Ollama on localhost, one model loaded at a time). Read it before running it; edit the `LAN` line for the home network allowed to SSH in.

Then install Romulus on the box too, and in its app:

1. **⚙ Settings → Device sync → Add a device** on a computer that already has sync, and enter the code on the box (the same way as a phone).
2. **⚙ Settings → Local model:** leave the address as `http://localhost:11434`, **Find models**, pick one, **Use it**.
3. Switch on **Run local tasks here for all my devices**, and leave the app open there.

Your other computers show "<the box> is taking local tasks for all your devices" under Local model, with nothing to set up on them. Under **Who does Agent tasks**, "auto" sends writing and forms there and keeps web and shopping on the cloud AIs; private words always go there. Money questions stay with the computer that has your Finance tab.

Optional, for browser tasks on that box too: `minipc/qwen-browser.service` runs a Chromium the model can drive, and `minipc/searxng.sh` sets up a private web search for it. Both are Ubuntu-specific. When it stops on a sign-in or a robot check, its browser appears live at the top of your Agent tab on any of your computers, streamed over sync, so you can log in for it. Files it downloads (a worksheet off a course site) are listed on the Agent tab too, with a Download button.

## What to expect from a local model

- Lookups, comparisons and drafting: seconds to a couple of minutes.
- Browser tasks: about 30 to 60 seconds per click on a CPU, so a long form can take 10 to 20 minutes in the background. Slower and clumsier than a frontier cloud model on tricky sites, but free, private, and it never runs out of credits.
- Final steps (submit, buy, send) are refused in code until you say yes, exactly as for the cloud AIs.
- If the box is off or asleep, local tasks wait for it (the app tells you when it goes quiet and when it's back); anything the cloud AIs may do can be switched to them from the task.
