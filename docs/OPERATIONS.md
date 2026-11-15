# Keeping Romulus going, on your own

The things an owner of this project does from time to time, written down so nobody has to be asked:
shipping a version, the website, the sync server, payments, the local model, the TV, and working on the
code without an assistant. [SETUP.md](SETUP.md) is for using the app; [CONTRIBUTING.md](../CONTRIBUTING.md)
and [CLAUDE.md](../CLAUDE.md) are the map of the code; [store-release.md](store-release.md) covers the
app stores. This page sits between them.

Nothing secret is on this page. Keys, tokens and account ids live where [SETUP.md, "Where your keys
live"](SETUP.md#5-where-your-keys-live) says, in GitHub's repository secrets, and in the Supabase and
Stripe dashboards.

Contents: [Shipping a version](#shipping-a-version) · [The website](#the-website) ·
[The sync server](#the-sync-server) · [Payments](#payments) · [The local model and its computer](#the-local-model-and-its-computer) ·
[The TV](#the-tv) · [Working on the code without an assistant](#working-on-the-code-without-an-assistant) ·
[Owner's to-do list](#owners-to-do-list)

## Shipping a version

1. Every change worth telling people about gets one plain-English line under the top entry (version
   `next`) in `renderer/js/whats-new.js`. The release refuses to go out with none.
2. `npm test` and `npm run lint` pass. CI runs both on every push (`.github/workflows/ci.yml`).
3. `npm run release` (`scripts/release.js`): puts the version into the what's-new entry and
   `package.json`, tags, and pushes. `.github/workflows/release.yml` then builds Windows, Mac, Linux and
   the Android APK and publishes them; the phone and the desktop app pick the new version up on their own.
4. After the release, `node scripts/releases-readme.js` refreshes the installers list in the releases
   README; see `scripts/releases-readme.md` for what it writes.
5. Installers are unsigned until the signing secrets exist (see the to-do list); the stores are a
   separate path in [store-release.md](store-release.md).

The main checkout usually sits on a feature branch shared by several people or sessions. Work meant
for `main` is done from a git worktree checked out from `origin/main`, so a release never sweeps in
half-finished changes.

## The website

`site/index.html` is one static page, published to GitHub Pages by `.github/workflows/pages.yml`,
which runs only on pushes to `main` that touch `site/`. A feature branch never changes the site.

* The demo figure is `site/img/demo.mp4` with `site/img/demo-poster.jpg`; `npm run demo` records
  both and the README's GIF (see `scripts/demo/record.js`; the MP4 needs an ffmpeg with an H.264
  encoder, which the script finds or you install with `winget install Gyan.FFmpeg`).
* The Plans section lists Free first; the paid cards send people into the app, since a Stripe link
  needs the account id the app holds.
* A private counter of what visitors do is read with `supabase/site-counts.sql` (below); it is never
  shown on the page.
* `site/llms.txt` is the plain-text summary search engines and models read; update it with the page.

## The sync server

Sync runs on one Supabase project. The SQL that defines it is in `supabase/setup.sql` (a fresh
project) and `supabase/migrations/` (one file per change, applied in order); the edge functions are in
`supabase/functions/`. The Supabase CLI runs as `npx --yes supabase` and needs a login and a link to
the project once (`npx --yes supabase login`, `npx --yes supabase link --project-ref <ref>`).

| What | How |
|---|---|
| Run one SQL file against the live project | `npx --yes supabase db query --remote --yes --file supabase/<file>.sql` |
| Apply a new migration | The same command with the migration file, one file at a time, after reading it. Never `supabase db push`: the project's migration ledger does not match the files, so push would try to replay old ones. |
| Deploy an edge function | `npx --yes supabase functions deploy <name> --use-api --no-verify-jwt --yes` (the functions check their own tokens; there is no `config.toml`) |
| How many people use sync | `supabase/sync-usage.sql` (counts only, never a row; what it reads is what PRIVACY.md says is kept) |
| What visitors did on the site | `supabase/site-counts.sql` |
| List what is applied | `npx --yes supabase migration list --remote` |

Say what a file does before running it: it is production. The server never sees list contents; they
are encrypted on the devices (SETUP.md, "Encrypt end to end").

## Payments

The sync plans are Stripe Payment Links. The desktop and phone builds get the live links at build time
(`PAY_URL`, and `PAY_SOLO_URL` for the individual tier) from the release workflow's secrets; never
point one at a test link. The webhook that marks an account paid is the `stripe-webhook` edge
function, with its signing secret in the project's secrets. The individual tier is in the code but
goes live only once its payment links exist and the `stripe_solo_links` row is filled in. Refunds,
disputes and payouts are handled in the Stripe dashboard, not in the app.

## The local model and its computer

Any Ollama works, on the PC or on a small machine of its own (Settings → Local model, or "Set it up
for me"). `docs/minipc-checklist.md` is the hardening list for a dedicated machine and
`docs/second-machine.md` how a second computer shares the setup. The lane that runs on it is
`agent/local-lane.js`; its tools are `agent/local-tools.js`; what it may open is the sites list in
Settings → Who does Agent tasks.

## The TV

With a [Media Hub](https://github.com/jamesbobdev-gif/mediahub) on the network, the local model drives
the TVs: Settings → Local model → Media Hub takes the hub's address and control token, and a task
such as "pause the TV" goes to the local model (SETUP.md, "The TV"). The hub's own guides are its
`docs/SETUP.md`, `docs/RUNBOOK.md` for running it, and `docs/CONTROL.md` for the commands. In this
repository the pieces are `agent/media-hub.js`, `agent/skills/media-hub.md` and the routing rule in
`agent/routing.js`.

## Working on the code without an assistant

* **The map:** [CLAUDE.md](../CLAUDE.md) (where every feature lives, the rules for page scripts) and
  the comment at the top of each file. [CONTRIBUTING.md](../CONTRIBUTING.md) has the ground rules.
* **Run and test:** `npm start` runs the app from source; `npm test` runs the unit tests
  (`node --test`); `npm run lint` the linter; `npm run dist` builds the installer.
* **Line endings:** most files are CRLF. Editors keep them; shell one-liners and scripts often do
  not, and a whole-file ending change hides the real edit in review. Check with `git diff --stat`
  before committing: a one-line change that shows hundreds of lines is an endings change.
* **Several people in one checkout:** `git status` and `git log` before committing; stage only your
  own files or hunks (`git add -p`).
* **The Agent's behaviour** is in `agent/skills/*.md` (how-tos the AI reads) and `agent/sites/`
  (notes per site); changing how it handles a kind of task is usually a change to a skill, not to code.
* **Help from a model without paying for one:** an Ollama model on the PC can read these files. Give
  it `CLAUDE.md`, the file you are changing and the failing test's output; keep the changes small and
  run `npm test` after each.

## Owner's to-do list

Open on 2026-11-14, each needing the account owner rather than code:

* Supabase: turn off email sign-ups under Authentication (the app never uses Supabase Auth).
* GitHub: a branch protection rule on `main`; Dependabot alerts, secret scanning and push protection
  on for this repository (the releases repository already has scanning on); replace the classic
  `RELEASES_TOKEN` with a fine-grained one.
* Signing: Azure Trusted Signing and Apple secrets, so installers stop being unsigned
  ([store-release.md](store-release.md)).
* Email: verify the sending domain's SPF, DKIM and DMARC at the mail provider.
* Stripe: confirm the webhook signing secret in the project's secrets and a restricted key for the
  `sync-delete` function; create the individual tier's payment links and its `stripe_solo_links` row
  when that tier should go live.
