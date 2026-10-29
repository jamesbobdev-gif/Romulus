# Running the Agent on a second machine

Everything runs on one computer by default. Two optional moves put the heavy parts on another box, so your laptop stays light and the Agent keeps working with the lid closed:

1. **A local model on another machine.** Ollama on a mini PC or old desktop with plenty of RAM; the app on your laptop talks to it over the network.
2. **The whole agent on a "hub".** The app itself runs as a service on the second machine: the Agent, its browser, mail dates and calendar sync. Your laptop (and phone) just show the results and sync.

You can do 1 without 2.

## 1. A local model on another machine

Any Linux or Windows box with 16 GB of RAM runs an 8B model; 32 GB runs a 30B mixture-of-experts model (the kind that only uses ~3B parameters per token, so it's quick on a CPU) well enough to fill forms and write. No graphics card needed.

On the box:

```
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:30b-a3b          # or qwen3:8b on 16 GB
```

Keep Ollama listening on that box only (`OLLAMA_HOST=127.0.0.1:11434`, the default) and publish it to your own devices with [Tailscale](https://tailscale.com): `tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434`. Ollama has no password, so don't open it to the whole network with `0.0.0.0`.

`minipc/setup.sh` does all of that on Ubuntu in one go (updates, no sleep, Tailscale, a firewall that lets in only SSH, Ollama published to your tailnet, one model loaded at a time). Read it before running it; edit the `LAN` line for the home network allowed to SSH in.

On your laptop: **⚙ Settings → Local model**, type `http://<the box's Tailscale name or IP>:11434`, **Find models**, pick one, **Use it**. Under **Who does Agent tasks**, "auto" sends writing and forms there and keeps web and shopping on the cloud AIs; private words always go there.

Optional, for browser tasks on that box too: `minipc/qwen-browser.service` runs a Chromium the model can drive, and `minipc/searxng.sh` sets up a private web search for it. Both are Ubuntu-specific.

## 2. The hub

`minipc/hub/README.md` and `minipc/hub/setup.sh` turn an Ubuntu machine into the hub: the app runs as a service, reachable from your laptop over [Tailscale](https://tailscale.com) (free for personal use) at `https://tasks-hub.<your-tailnet>.ts.net`. The laptop app then switches to "client" under **⚙ Settings → Agent & AI → Mini PC server** with the hub's address and the token the setup prints.

What moves to the hub: the Agent and its browser, mail dates, calendar sync, the morning look-ahead, the local-model coordinator and the memory tidy. What stays on the laptop: the window, the Finance vault (never leaves the computer it was made on), and anything you type.

This is the most involved setup in the app and the least tested outside the author's home. Expect to read the scripts.

## What to expect from a local model

- Lookups, comparisons and drafting: seconds to a couple of minutes.
- Browser tasks: about 30 to 60 seconds per click on a CPU, so a long form can take 10 to 20 minutes in the background. Slower and clumsier than a frontier cloud model on tricky sites, but free, private, and it never runs out of credits.
- Final steps (submit, buy, send) are refused in code until you say yes, exactly as for the cloud AIs.
