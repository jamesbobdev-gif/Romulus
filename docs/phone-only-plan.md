# Phone-only users: the same app as everyone else

Goal (2026-10-30): someone with only a phone gets everything a laptop user gets: the Agent (including
shopping and forms in a browser), mail dates, calendar sync, look-ahead, triggers, goals, Watch and private routing.

## What's true today

- The phone app is the desktop's screens (`mobile/prepare-www.js` copies `renderer/`) plus phone stand-ins for
  calendars (`mobile/cal-phone.js`), Finance and updates. It syncs lists through Supabase.
- Everything that *does* work lives in Electron's main process (`agent/`, `main/`), reached through
  `window.desktop.*`. On the phone `window.desktop` is missing, so the AI side is dead (`renderer/js/welcome.js:25`).
- **The hub split the app in two, and is gone (2026-11-01).** `main/hub.js` ran the whole app on a server and
  answered an allow-listed set of its IPC calls over Tailscale; it was never deployed, and the worker replaced it:
  the local model's own computer takes local tasks through Supabase (`agent/worker.js`), its browser is watched
  over Supabase Realtime (`renderer/js/live-relay.js`) and its downloads come through a bucket
  (`agent/worker-files.js`). A cloud "agent server" would be built the same way: a worker that claims the cloud
  lane's tasks through sync, not a gateway the phone calls.

The browser Agent can't run on a phone (no headless Chrome, Android kills background work). So phone-only means
**the phone is a hub client, and the hub runs in the cloud.**

## The plan

### 1. A cloud hub that needs no computer to set up
- Package the hub as a container image (Electron + Xvfb + the agent's Chromium), published with each v-tag
  release alongside the APK/installers.
- Nothing listens on the internet: the container is a worker that reaches out to Supabase, like the mini PC
  does for the local lane. Still needed first: the redirect/private-network fixes from
  `docs/audit-2026-10-30.md`, and no route that reaches the container's own network.
- First start shows a **pairing code**. The phone scans or pastes it, the same way the sync code works today.

### 2. The phone as a hub client
- A `mobile/hub-phone.js` stand-in for `window.desktop` that puts the `REMOTE` calls on sync rows for the worker
  to answer, and follows its live run text the way live-relay follows the browser. The renderer code stays the
  same on both platforms.
- A **Settings → Agent server** panel on the phone: pair (a code, like a device), test, send settings.
- Sign-ins that today need the hub's terminal move into the app: Claude/ChatGPT logins as an in-app device-code
  flow, site logins through Watch (already works), calendar OAuth from the phone (`cal-phone.js` already
  signs in; hand the account to the hub like the laptop does).

### 3. Setup with only a phone
- Sync: a phone-side "Set up sync" that makes the sync key on the phone (today only the computer can).
- Hub: one link that deploys the container (see decision A), then pair.
- Private routing without Lupa: see decision B.

### 4. Then
- On-phone AI for quick chats when the hub is unreachable (the person's own API key, called from the phone).
- Push notifications for "needs you" Agent tasks (today the computer's tray does this).

## Security: James's project holds everyone's lists (Pro plan, 2026-10-30)

Goal: a breach of the Supabase project, a leaked service key, Supabase staff, or James himself sees only
ciphertext and random-looking keys. Nobody but the user's own devices can read a list.

### Where it stands (checked 2026-10-30)
- Good: `tasks_sync` is closed to the API roles; every read and write goes through `sync_get`/`sync_put`, which need
  the sync key. Per-account quotas are live. The advisors only flag what's intended (anon may call those
  functions) and one small fix: `sync_doc_size` has no fixed `search_path`.
- **Lists are stored as plain JSON.** Anyone with database access reads every task.
- **The Locked profile isn't truly end-to-end.** Its AES key is made from the agent sync key, and the app sends that
  same sync key to the server on every call (`p_sync_key`). The server, and anything that logs RPC
  arguments, has what it needs to decrypt it.
- Server code reads and edits list contents: `widget_complete_task`, `agent_claim_task`, and the edge functions
  `tasks-mcp` (the claude.ai connector), `buy-email`, `school-ingest`, `work-ics`.

### The design
1. **Two keys from one secret.** Each device keeps a master secret. From it, HKDF makes a *lookup id* (the only
   thing the server ever sees) and a separate *content key*. Neither can be worked out from the other.
2. **Every row encrypted.** All lists use the `{v:2, iv, ct}` AES-256-GCM format the Locked row already uses.
   Quotas still work, since they count bytes, not contents.
3. **Nothing on the server reads a list.**
   - Claiming an Agent task moves to a small `agent_claims` table: (lookup id, hash of the task id, worker).
     Insert-if-absent gives the same "only one worker wins" without seeing the task.
   - The Android widget marks a task done on the phone, which has the key, and syncs.
   - Things that *add* to a list from outside (buy emails, school feeds) drop items into an inbox,
     encrypted to the user's **public** key (X25519 sealed box). The server can write to it but never read it;
     the app opens the inbox and merges.
   - Things that must *read* a list (the claude.ai connector, the work calendar feed) move to the user's own
     cloud hub, which has the key. Without a hub, they're off.
4. **Accounts only for billing.** Supabase Auth (email code or passkey) ties a payment to a person and to their
   lookup ids. It never unlocks content.
5. **Recovery.** True end-to-end means James can't recover a lost list. At setup, show a recovery code to
   save, the same way password managers do. Pairing a new device is the sync code or QR from a device that has it.
6. **Cloud hubs (paid Agent tier).** A hub needs the key to work, so its security is the host's. One isolated
   container per user, encrypted disk, no shared state, and the privacy policy says plainly what the hub can see.
7. **Project hygiene.** MFA on the Supabase and GitHub accounts; service-role key only in edge functions,
   rotated; fix `sync_doc_size`'s search path; point-in-time recovery is fine to turn on (backups hold only
   ciphertext once step 2 is done).

### Where it stands (2026-11-04: done, one button per user)
- `renderer/js/sync-crypto.js` + `agent/sync-crypto.js`: the key split and sealing; `test/sync-crypto.test.js`
  proves the page and Node agree, and holds the vector the phone is tested against.
- `renderer/js/sync.js`: a profile with `v2:true` reads and writes sealed rows under lookup ids; a device that
  meets `{moved:'v2'}` switches itself over (shipped since 1.0.10, so every current build follows). Rotate sync
  key and "one key for every list" keep v2.
- `agent/supabase.js` readRow/writeRow and the Agent claim (`claimSealed` in `agent/task-context.js`,
  compare-and-swap instead of the server reading the task).
- Android widgets: `SyncCrypto.java` (HKDF + AES-GCM, `SyncCryptoTest` on the JVM), `SyncStore.java` opens
  sealed rows (a baked `v2:true`, or the moved marker met once and remembered) and checks a task off on the
  phone with a compare-and-swap `sync_put` instead of `widget_complete_task`.
- `supabase/setup.sql`: a moved row takes no plain write (the 20261031_sync_moved_v2 migration, folded in).
- **Encrypt my lists end to end** in Settings → Device sync runs `syncMoveToV2()`, which now also moves the
  side rows added since (`:updates`, `:finance`, `:worker`, `:files`, `:files-gone`). docs/SETUP.md explains it.
- The edge functions that read lists (`tasks-mcp`, `work-ics`, `school-ingest`) see the moved marker and stop
  with a clear message instead of writing plain over it; they are off for an encrypted account. `buy-email`
  never touched a list. No minimum-version gate was built: an older build meets the marker, can't write and
  shows a sync error, which is safe.

### Open
- `buy-email`, `school-ingest` writing to an inbox sealed to the user's public key, and the connector / Work
  feed moving to a user's hub, so they work for encrypted accounts too.

### Rolling it out
- New app versions read both formats and write only v:2; each list is re-encrypted on its next sync. The
  server refuses plaintext writes from accounts that are already on v:2.
- Old builds (the old phone APK, "Tasks 1.0.0" at home) can't read v:2: set a minimum version before switching.
- The key split changes every lookup id, so it's one move per user, like **Rotate sync key** today (that
  code already re-keys every list and blanks the old rows).

## Decisions for James

**A. Who runs the cloud hub?**
- *Each user rents their own* (one-tap deploy to a host like Fly.io or Railway; about $5–10/month, paid by them).
  Matches today's "your own Supabase project": you never hold anyone's data or logins. Setup is still a few
  steps and a card on file.
- *You run it for them* (a hosted service): easiest for users, but you hold their site logins, mail and AI
  keys, pay per user (each hub keeps a browser in memory), and take on security and support.

**B. Private routing without a home box.** Lupa keeps private words and Finance off cloud AIs. A phone-only user
has no Lupa. Options: a small model inside their cloud hub (needs a bigger server), an on-device model on the phone
(slow, small), or private tasks simply ask before using a cloud AI.

**C. Sync.** Keep "each user's own Supabase project" (consistent with A = rent your own), or move to one shared
project with sign-in (needed if A = you run it).
