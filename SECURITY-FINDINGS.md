# Security findings, third review pass (2026-11-04)

What this pass looked at: the agent browser's guards (`agent/browser-proxy.js`, `agent/web-guard.js`,
`agent/link-wallet.js`), the Electron main process and preload (`main.js`, `preload.js`, `main/`), the
end-to-end sync crypto on all three sides, the Supabase functions, migrations and `setup.sql`, the release
workflow, and a sweep of the renderer for HTML and URL sinks fed by synced or AI-written data. The first two
passes (agent-guard bypasses, sync backend hardening, the storage buckets, coach mode) were not redone.

Severity: **High** = an attacker who controls a web page, a synced row or a token gets something real;
**Medium** = needs an extra condition or only weakens a guard; **Low** = defence in depth or a deployment
assumption worth checking.

## Fixed in this pass (commits on `claude/security-pass-3-1f4ca4`)

| Sev | Where | What |
|---|---|---|
| Medium | `agent/browser-proxy.js`, `agent/web-guard.js`, `agent/helpers.js` | The private-network checks judged an address by its text, so a public-looking name that resolves to this computer or the LAN (`127.0.0.1.nip.io`, a name an attacker points at `192.168.1.1`) got past the browser launcher, the WebFetch hook and `fetchPublic`. Names are now looked up and refused when any address is private; the launcher also refuses actions on a page reached that way. |
| Medium | `agent/browser-proxy.js` | A tainted (mail-seen) run whose tab address could not be read (`here == null`) let typing and clicking through outside mail. Now refused. |
| Medium | `agent/browser-proxy.js` | A PIN or card number could be typed key by key (`browser_press_key`) into a secret field after clicking it; `browser_type` into the same field was refused. The launcher now remembers the last field clicked, typed or filled and refuses single-key presses into a secret one. |
| Low | `agent/browser-proxy.js` | Link's card number and CVC were used as regex source when blanking; now escaped. |
| Low | `renderer/js/grocery-list.js`, `renderer/js/seat-map.js` | The only `href`s set from synced agent data without a scheme check (the phone build has no main-process guard). Now `http(s)` only. |
| Low | `supabase/functions/tasks-mcp/index.ts` | `update_task` took `note` and `tag` unbounded (a 4 MB note would make `sync_put` refuse every save from the apps); `list_tasks` `search` unbounded. Bounded like `add_task`. |
| High | `renderer/js/settings.js` (`syncMoveToV2`) | Turning on end-to-end encryption sealed the lists under the **same** sync key, which the project already held as the plain rows' id. The switch now rotates: a fresh sync key (and a fresh own key per list that has one), rows copied sealed under the new lookup ids, the old rows marked moved, and the other devices paired again. Lists encrypted by an earlier build stay under the old key until **Rotate sync key** is pressed once (`SECURITY.md` says so). See the next section for what that doesn't cover. |
| Medium | `.github/workflows/release.yml` | A re-run for an existing tag replaced the published installers and checksums (electron-builder overwrites same-named assets), so a verified copy stopped matching. The build now stops when the tag's release already carries installers unless started by hand with `overwrite`. The Android and iOS jobs ran even when the desktop job (tests, `npm audit`) failed; they now need it green. `release-gate.patch` was folded in and removed (its `--clobber` removal would have left stale checksums). |

## Not fixed: needs a product decision or a deployment check

### Medium: lists encrypted by a build before this fix are still under a key the server holds

Until this pass, `syncMoveToV2` sealed a list under the **same** sync key that had been the plain rows' id in
`tasks_sync`, and the `{moved:'v2'}` marker still sits under that raw key. The v2 lookup id and the AES-256-GCM
content key are both HKDF-derived from the key alone, so anyone with the database, its backups or its logs from
before the move can read those rows. The switch now rotates the key (fixed above), but a user who encrypted with
an earlier build has to press **Rotate sync key** once; the app does not do it for them, and nothing in the UI
flags it. Worth a one-time notice in Settings for a v2 profile whose key still has a plain-days marker row.
Data that was ever stored plain is in old backups regardless; rotation protects what is written from then on.

### Medium: Electron 33.4.11 is past its support window

`package.json` pins Electron 33 (EOL mid-2025). The app's own window loads only a local file under a strict CSP
and the agent browser is a separate Chrome, so the exposure is the hidden preview windows (`agent/previews.js`,
sandboxed, own partition) that load arbitrary pages. Upgrade to a supported major; the release workflow's
`npm audit --audit-level=critical` comment says the same.

### Low: things that depend on how the Supabase project is deployed (verify, don't assume)

- `sync_caller_ip_hash()` (`20261102_sync_hardening.sql`) trusts `cf-connecting-ip`, else the **last**
  `x-forwarded-for` entry. That is only the client's address if exactly one trusted hop appends to it. Behind
  two hops the last entry is the edge's own address and every user shares one rate bucket (`new_accounts`,
  pairing); with none, a client can still set it. Check what the project's gateway actually sends.
- `agent_folder_proved()` reads `request.headers ->> 'x-romulus-key'` inside Storage policies. This works only
  if the Storage API passes request headers to Postgres as `request.headers` (it does on current storage-api;
  it did not on older ones). If it doesn't, every `agent-files` operation is refused — safe, but the feature
  is dead. Worth a one-line check against the live project.
- `attachments-cleanup` is unauthenticated by design; its cost is listing every folder, throttled to once per
  ten minutes **per instance**. On a shared project that is a cheap way to make it list a lot.
- `tasks-mcp`, `work-ics`, `buy-email` and `school-ingest` still accept `?token=` in the URL (kept for older
  schedulers / Outlook). Query strings land in access logs; prefer the `Authorization` header everywhere a
  caller can send one and retire `?token=` for the MCP server at least.

### Low: in the agent browser's guards, known and accepted limits

- DNS rebinding proper (a name that answers public first and private later) is not caught by the new lookup;
  only Chrome's own network policy could. Chrome's DevTools HTTP endpoint already rejects non-localhost `Host`
  headers, so the debugging port is not reachable that way.
- The label gates (`FINAL`, `BUY`, `SUBMIT`, `SECRET`) see a button only by its accessible name. A control with
  no name and no named child (an icon-only submit) is clicked without a gate. Playwright MCP's vision/coordinate
  tools are not in the allow-list, which keeps this to what a page author would have to build on purpose.
- "One hop" linked hosts: a link shown on an allowed site's page opens its host. A store page that carries a
  link to a third-party site therefore extends a shopping run there (documented in the file).
- `--remote-debugging-port` on `127.0.0.1` means any local process of the same user can drive the agent browser
  and its logins. Same trust boundary as the config file; no fix short of Chrome's `--remote-debugging-pipe`.
- `update:shared` lets whoever can write the `:updates` sync row (anyone with the sync key) make every device
  download and install a *published* version without asking. It cannot install anything unpublished.

### Low: crypto notes (no change needed)

- Sync keys are `tk_` + a v4 UUID (122 random bits): HKDF over them is fine; lookup id and content key are
  independent. AES-GCM with a 96-bit random IV per write is fine at this volume.
- `SyncCrypto.java` splits the suffix at the first `:` while the JS splits on `:[a-z-]+$`; keys never carry a
  colon elsewhere, so they agree for every key the app makes.
- `Sealed.java` (Android Keystore, AES-GCM, random IV): fine. Not device-bound to a biometric by design.

## Already right, checked and left alone

- Every `ipcMain.handle` goes through `guardIpc` (top-frame app page only); no module registers a handler
  outside it, and the overlay window has its own guard on its own `webContents`. Nothing uses `ipcMain.on`.
- `will-navigate`, `will-redirect`, `setWindowOpenHandler` and `will-attach-webview` are all set on the app
  window; `gcal:open-url`, `live:open`, `link:open` check the scheme (and `LINK_SITE`) in main.
- Renderer CSP has no `unsafe-inline` for scripts; the sweep found every `innerHTML` with outside data goes
  through the escaper or is built with `textContent`.
- Secrets in `config.json` are sealed with `safeStorage`; the `basic_text` Linux backend is detected and logged.
- Edge functions compare tokens in constant time through a hash; `buy-email` only mails the configured address;
  `school-ingest` and `work-ics` refuse to write over a `moved:v2` marker.
- Release actions are SHA-pinned, `GITHUB_TOKEN` is read-only, secrets are scoped per OS job.

# Fourth review pass (2026-11-04)

What this pass looked at, which the third only skimmed: how a Claude run is launched (`agent/runner.js`,
`agent/agent-browser.js`, `agent/task-tabs.js`, `agent/run-live.js`) and whether a task or a page can change
any of it; the mini PC lane (`agent/local-lane.js`, `agent/local-tools.js`, `agent/worker.js`,
`agent/worker-files.js`, `agent/qwen-browser.js`, `main/downloads.js`); pairing (`renderer/js/pair*.js`,
`20261101_sync_pairing.sql`, the `sync_pair_*` functions) and the Realtime relay (`renderer/js/live-relay.js`,
`agent/live-view.js`); the IPC handlers in `main/finance*.js`, `main/persistence.js`, `main/triggers.js`,
`main/speak.js`, `main/gmail-dates.js` and `agent/mail-send.js`; and the Android side beyond the crypto
(`MainActivity`, the plugins, the widgets, `AndroidManifest.xml`, `mobile/update-phone.js`). Same severity
scale as above.

## Fixed in this pass (commits on this branch)

| Sev | Where | What |
|---|---|---|
| Medium | `agent/runner.js` | A Claude run works in `Documents/Claude Agent`, where the local lane also saves its Research and Coach reports, "written there so that no cloud AI sees them". The run's allow list (`Read(./attachments/**)`, `Read(./skills/**)`) does not keep Read out of them: Claude Code lets Read open anything under its working folder without asking, so only a deny rule does. `Read(./Research/**)` and `Read(./Coach/**)` are now denied. (Gemini already had `.geminiignore`; Codex runs in an empty temp folder with its shell tool disabled.) |
| Medium | `agent/agent-browser.js` `approvedHostsFor` | His yes unlocked the order button on every host in the task's `cart` and `options` links, which the AI writes: a page could talk the AI into putting its own address in an option, and his yes to "order at Walmart" then unlocked the final click there too (the ask's own links were already left out). A cart or option link now counts only on a site his own words or the page name, or on a store from `STORE_HOSTS`. |
| Low (a regression, not a hole) | `WidgetActionActivity.java`, `WakeWordService.java` | The first pass made `MainActivity` drop any page hook without the install's nonce (so another app can't start the microphone). The widget's "open this task" row tap and the "Hey Romulus" wake intent never carried it, so both have been silently ignored since. They carry it now; a test checks every sender does. |

## Not fixed

### Low: the live relay accepts a replay of an input message for 30 seconds

`renderer/js/live-relay.js` drops a sealed message whose `at` is more than `STALE_MS` (30 s) off, but within
that window the same ciphertext (a click or a key) is accepted again. Only someone who can read the channel
can replay: its name is a hash of the agent sync key, so that is the Realtime server (the operator) or a
device that already has the key. The harm is a repeated click within half a minute. A fix would be a
per-sender counter in the sealed message; not worth the state unless the relay gains more than input.

### Low: the phone's update banner trusts the release's APK as GitHub lists it

`mobile/update-phone.js` hands `browser_download_url` of the newest release to the system browser; nothing
on the phone checks a hash. Android refuses to install an APK over the app unless it is signed with the
same key, so a swapped file on the releases page fails to install rather than running. That is the actual
guard; the desktop updater's checksum step has no counterpart here, and can't short of a signed manifest.

### Low: the pairing and relay limits share the third pass's caveat on `sync_caller_ip_hash()`

`sync_pair_put` (20 an hour) and `sync_pair_take` (30 an hour) bucket by that hash. Behind a gateway that
leaves the last `x-forwarded-for` entry as its own address, every user shares one bucket (one noisy device
stops pairing for all); with none, a client can pick its own. The code space (60 bits, PBKDF2 600,000
rounds, 10-minute life, one use) holds either way; only the rate limit's fairness depends on the deployment.

## Already right, checked and left alone

- A run's settings file (`--settings`, the hooks) and the MCP config are written by the app before the
  spawn, under `userData`; Claude has no Write tool, Gemini only reading tools, Codex no shell. The
  `--strict-mcp-config` flag keeps `.mcp.json` and the account's connectors out of web runs. Nothing a task
  or a page says reaches the argument list: the only strings from outside are the task title (into an env
  value for the actions log, cut to 120 chars) and the prompt on stdin.
- Attachments for a run are only fetched from the app's own `agent-attachments` bucket, by parsed URL.
- `task-tabs.json` holds Chrome tab ids; a tab's address goes back to the task as `page` only when the run
  ended `needs-you` and never saw mail, and ◉ Watch opens `https:` pages only, never a sign-in step.
- Mini PC lane: downloads go to `~/Downloads/Romulus` (set over CDP), runnable file types are never
  published, a link to a file elsewhere is not a download (`lstat`), and the other computers rebuild every
  file's address from its bucket path (`ownPath`) instead of taking it from the row. `read_file`, searches
  and page reads go through the private-words check; `read_page` uses the DNS-checked `fetchPublic`.
  `search_my_data` shows the local model the Locked profile by design, and its notes never leave the mini PC
  (the Claude brief masks them). `gio trash` gets `--` before the paths; paths come from the local listing.
- Pairing: the code never leaves the device; the server holds PBKDF2(code) and a sealed sync code, wiped on
  the first take; the new device shows the project's host and asks before adopting it; the release build
  writes `ROMULUS_PAIR` with `JSON.stringify`, so a repository variable can't inject into the page.
- The relay's channel key and name come from HKDF over the agent sync key in main (`relayKeys`), messages are
  AES-GCM with a random IV, and the renderer only lets `Input.*` CDP methods through to the mini PC's page.
- `mail:send` sends only what `cleanEmail` passes (bare addresses, at most ten, a one-line subject), from a
  connected account, and logs it; the Agent has no tool that sends mail. `voice:listen` and Windows Hello run
  constant PowerShell scripts passed `-EncodedCommand`; the Hello message is quoted and the window handle
  checked as an integer. `triggers:tick` fetches pages through `safeUrl` hop by hop. `finance:setup` only
  claims a token that decodes to a SimpleFIN URL and fetches it with `redirect: 'error'`; a shared box is
  shape-checked before any scrypt runs.
- Android: the launcher activity is exported only as the app icon and the share target; the share intent
  turns into one JSON object for the page (org.json escaping, no HTML); OAuth returns need PKCE and the
  saved `state`; the calendar `api` call is pinned to the provider's base URL; the finance `http` bridge
  allows SimpleFIN and Yahoo over https with no redirects; the wake-word model is hashed before unzipping and
  each entry's canonical path checked; the widgets draw text with `setTextViewText`; backups exclude the
  WebView storage (sync keys), the calendar tokens and the vault.
