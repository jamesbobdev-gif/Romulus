# Open-source release plan

What it takes to turn this from "James's app" into something a stranger can install, connect and trust in ten minutes. Ordered by how much it changes the first-run experience.

## 1. First-run flow (the biggest win)

Today a new install opens on an empty list with no hint that sync, calendars or the Agent exist, and each needs Settings fields filled by hand. Replace that with a one-time welcome that asks what the person wants and hides what they don't:

1. **Just tasks** — nothing to set up. The app must be fully usable offline with no Supabase at all (today the "Connect your list" card appears for Agent/School; Personal should never need it).
2. **Phone sync** — see §3.
3. **An AI assistant** — see §2.
4. **Calendars** — Google / Microsoft one-click (ships with the official build's OAuth client) or a pasted link.

Tabs appear only once their feature is set up: Agent after an AI connects, School/Work after the person turns them on, Finance stays opt-in. Every connection step ends with a green check and a "what this lets the app do" line, so the person knows what they just granted.

## 2. Getting AI tokens in

Each provider should be one card: **what it costs / free tier · Get a key (opens the right page) · paste · auto-test · done.** Most of this exists in `agent/ai-connections.js`; the gaps:

| Provider | Today | Make it |
|---|---|---|
| Claude | Needs Claude Code CLI already installed and signed in at `~/.local/bin/claude`; no button | Detect `claude` on PATH too. Buttons: **Install Claude Code** (npm, like Gemini/Codex already do) and **Sign in** (opens a terminal running `claude /login`). Also accept an **Anthropic API key** as an alternative (the CLI honors `ANTHROPIC_API_KEY`) for people without a Claude plan. |
| OpenRouter | Paste key | Add **Connect with OpenRouter**: its PKCE flow opens the browser and hands back a key with no copy-paste. Best zero-friction path; one key covers dozens of models. |
| ChatGPT | Install Codex + sign in buttons exist | Keep. Explain the plan-vs-API-key choice in one sentence. |
| Gemini | Paste key, optional CLI | Keep; link straight to AI Studio's key page. |
| Grok / Groq / Cloudflare / NVIDIA | Paste key + Test key | Keep; show "free tier" badge and the limit. |
| Local model | Assumes a mini PC + hub over Tailscale | Accept **any Ollama URL**, default to `http://localhost:11434`, auto-detect it, and pick a model from its list. The hub/Tailscale path becomes "advanced". |

Keys already go through `safeStorage` (OS encryption) and come back masked. Keep that, and say so in the UI: "stored encrypted on this computer, never synced."

## 3. Phone sync without baking secrets into the APK

Today the APK is built with `mobile/sync-config.json` inside it, so there's no publishable phone app. Fix:

- **Desktop generates a pairing QR** (`qrcode` is already a dependency) holding the Supabase URL, anon/publishable key and the sync keys. Phone scans it, or pastes the same text. One published APK for everyone.
- **Supabase setup in-app**: a Setup Sync panel with: link to create a free project → paste URL + key → **Copy setup SQL** (one file combining the three migrations) → "Open SQL editor" link → **Check** button that calls `sync_get` and confirms the functions exist. Generate the sync key automatically.
- Say plainly: the sync key is the password to that list; the anon/publishable key is not secret. Accept Supabase's new `sb_publishable_…` keys as well as JWT anon keys.
- Edge functions (`buy-email`, `tasks-mcp`) are optional extras; document them as such.

## 4. Strip the personal bits

- 114 places in `renderer/` and `agent/` name **Romulus**, **Lupa Au Palatine**, `192.168.1.x` or Tailscale. Make the assistant name and the local machine name settings with neutral defaults ("Agent", "Local model").
- Comments say "his"/"he" ~300 times; replace with "the user's"/"they".
- `MINI-PC-SETUP.md` and `minipc/` are a personal hardware diary. Move to `docs/local-model.md` as a generic "run your own model" guide, or drop.
- `package.json` publish owner/repo (`jamesbobdev-gif/tasks-releases`) and the README's `C:\Users\James\...` paths need to be yours-only or configurable.
- Untracked `cdp.js`, `lupa-post.txt`, `.backup-*` folders: delete or ignore before the repo goes public.

## 5. Repo hygiene for a public project

- Add **LICENSE** (MIT is the usual pick for an Electron app), `CONTRIBUTING.md`, `SECURITY.md` (how to report, what the app stores where).
- Git history is clean: no keys or secret files were ever committed (checked `seed-config`, `oauth-clients.json`, `sync-config`, JWT and `GOCSPX-` patterns).
- **OAuth clients**: keep shipping yours in the official installer (a desktop Google client secret is not a real secret, and Microsoft's is only a client ID), keep `oauth-clients.json` out of git, and keep the "paste your own" fallback for forks. Document it in `oauth-clients.example.json`.
- **Code signing**: the unsigned-installer warning is the first thing a new user sees. Windows: Azure Trusted Signing or an OV cert. Mac: notarization. Budget for it or say in the README exactly what the warning looks like.
- CI: GitHub Actions running `npm test` on PRs and `electron-builder` on tags; publish to the releases repo from CI rather than a laptop.
- README rewrite: screenshots first, then "Install" / "Connect an AI" / "Sync your phone" / "Build it yourself". Move the architecture notes to `docs/`.

## Suggested order

1. First-run welcome + hide unconfigured tabs.
2. Claude install/sign-in buttons and API-key fallback; OpenRouter PKCE; local Ollama at localhost.
3. Pairing QR + in-app Supabase setup; generic APK.
4. Rename personal bits; LICENSE/CONTRIBUTING/SECURITY; README.
5. Code signing and CI.
