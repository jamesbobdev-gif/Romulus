# Putting Romulus in the stores

What is built, what each store still needs from you, and the text to paste into each listing. The release
workflow (`.github/workflows/release.yml`) builds everything from one `v<version>` tag; each store piece
switches on once its secrets or variables are set, and does nothing until then.

| Where | Build | Status |
|---|---|---|
| Releases page (Windows, Mac, Linux, Android APK) | every tag | live; unsigned until the signing secrets below are set |
| Google Play | `Romulus-<version>-play.aab`, a run artifact | ready to upload once the Play account exists |
| Microsoft Store | `.appx`, a run artifact | builds once the three `MS_STORE_*` variables are set |
| Mac, signed and notarized | the normal `.dmg` / `.zip` (Apple chip and Intel) | signs once the Apple secrets are set |
| Windows, signed | the normal installer | signs once the Azure secrets and variables are set |
| iPhone App Store | uploaded to App Store Connect (TestFlight) by the `ios` job | builds once the four `APPLE_API_*` / `APPLE_TEAM_ID` secrets are set; see the iPhone section for what it has |

## Google Play

1. **Create a developer account** at play.google.com/console ($25 once, ID check). As a new personal
   account, Play requires a **closed test with at least 12 testers for 14 days** before production.
2. **Create the app**: name Romulus, app (not game), free. Package name is `com.jartro.tasks`; it can never
   change.
3. **App signing**: choose *Use Google-generated key* (Play App Signing). The keystore in `signing/` becomes
   the **upload key**, so keep it safe as before. Phones with the APK from the releases page are signed with
   that key, not Play's, so they can't update from Play over it: switching means uninstalling once.
4. **First upload is by hand**: push a tag, download `google-play-aab` from the run's artifacts, and upload it
   to the closed testing track.
5. Fill the Policy sections with the answers below, then the store listing.

What makes the Play build different (`mobile/android/app/build.gradle`, `productFlavors`): no update banner
(Play forbids an app updating itself from elsewhere) and no draw-over-other-apps permission, so a wake
word heard while another app is in front shows a notification to tap instead of opening Romulus. The speech
library is Vosk 0.3.75, the first built for the 16 KB memory pages Play requires.

### Policy answers

- **Privacy policy URL**: `https://github.com/jamesbobdev-gif/Romulus/blob/main/PRIVACY.md`
- **Ads**: no.
- **App access**: all of it works without signing in to anything of ours. Give reviewers this note:
  "Romulus has no accounts. Tasks work offline. AI features need the reviewer's own AI key or sign-in
  (for example a free Gemini key from aistudio.google.com), entered in Settings → AI."
- **Content rating**: questionnaire as a productivity / utility app; no violence, sexual content,
  gambling or user-to-user chat. Expect Everyone / PEGI 3.
- **Target audience**: 18 and over (the Agent can shop and fill forms for you), so no Families policy.
- **Data safety**:
  - Data collected *by the developer*: sync goes through the Romulus server by default
    (renderer/js/hosted-sync.js), but lists are end-to-end encrypted on the device, and Play doesn't count
    end-to-end encrypted data as collected. What the server does see: photos on Agent tasks and the files the
    Agent downloads (not end-to-end encrypted; declare **Photos** and **Files and docs** as collected, for app
    functionality, deletable), plus a hashed key id, usage counts and a day-old IP hash (abuse limits, which
    Play counts as **Device or other IDs** for fraud prevention/security). Data shared with third parties:
    none by us; the app sends data to services the user connects themselves, which Play counts as
    user-initiated transfer, not sharing.
  - Still declare what the app processes and sends on the user's behalf, marked "processed ephemerally" /
    "not collected" as appropriate: personal info (name, email, address in the Locked profile), financial
    info (Finance), messages (Gmail), calendar events, audio (voice input), app activity (tasks), health and
    fitness (Health Connect daily totals: on the phone, or end-to-end encrypted between his own devices).
  - Encrypted in transit: yes. Users can request deletion: yes, in the app (Settings → Device sync →
    Delete my synced data, which needs the `sync-delete` function deployed; see below). Play's
    account-deletion rule covers apps that create accounts; Romulus makes an anonymous sync account, so give
    the privacy policy's "Deleting your data" section as the deletion web link when Play asks for one.
  - **Payments**: the sync plans ($3 alone, $5 for a family) are Stripe links, and Play requires Play Billing for subscriptions bought
    inside the app, so the Play build never shows it (`hostedInStore` in hosted-sync.js, keyed on
    `window.ROMULUS_STORE`). Someone who pays on a computer gets the space on their phone too. The same goes
    for an iPhone build: give it its own `ROMULUS_STORE` value and the button stays hidden.
- **Foreground service: microphone** (`WakeWordService`). Declare it as *user-initiated, ongoing*: "Hey
  Romulus" is a wake word the user turns on in Settings; it listens only while the screen is on and shows
  a persistent notification. Play asks for a short video: turn it on in Settings, show the notification,
  say "Hey Romulus", show the app opening to listen.
- **Exact alarms** (`SCHEDULE_EXACT_ALARM`, from the reminders plugin): declare that reminders at the
  time the user set are a core feature of a task and calendar app.
- **Financial features**: Finance is a personal budget view, not a financial service: answer no to
  loans, banking and crypto.
- **Health**: the app reads Health Connect (steps, exercise, sleep; read only) so tasks with a goal like
  "Walk #steps 8000" tick themselves off. Health apps: Yes, Fitness. Health Connect declaration: read Steps,
  Exercise, Sleep, used only to tick off those tasks, not shared, not for ads, not sent to AI; privacy policy
  link `.../PRIVACY.md#health`. Data safety: Fitness info, not collected by the developer (on the phone, or
  synced end-to-end encrypted). Google can take a week or more to review the declaration.
- **AI-generated content**: Romulus shows replies from AI services the user connects. Every AI reply has a
  **Report** link (renderer/js/ai-report.js) that sends that one reply, which AI wrote it and a reason to the
  Romulus server's `ai_reports` table, after the user confirms. Read reports in the Supabase dashboard
  (Table editor, ai_reports). Needs `supabase/migrations/20261114_ai_reports.sql` pasted in the SQL editor first.

### Store listing

- **App name**: Romulus
- **Short description** (80 characters): `Your tasks, calendar and an AI agent that does the errands, with your yes.`
- **Full description**:

  > Romulus is a task list with an AI agent built in. Write down what needs doing; Romulus plans your day,
  > reminds you on time, and takes the errands off your hands: it searches, compares, fills forms and
  > builds shopping carts, and it stops and asks before anything that can't be undone. No order, booking,
  > form or email goes out without your yes.
  >
  > • Lists for personal, work and school, with reminders and home-screen widgets
  > • Your Google and Microsoft calendars beside your tasks
  > • An agent that works with the AI you choose: Claude, ChatGPT, Gemini, OpenRouter, or a model on your
  >   own computer
  > • Private words: tasks that mention your bank, health or passwords stay with your own model
  > • Finance, locked by your fingerprint and never shown to a cloud AI
  > • "Hey Romulus": an offline wake word, listening only while your screen is on
  > • Sync between your phone and computers through your own free Supabase project
  >
  > Romulus has no accounts, no ads and no tracking. It's open source.

- **Category**: Productivity. **Tags**: to-do list, planner, AI assistant.
- **Graphics**: 512×512 icon (from `build/icon.png`), a 1024×500 feature graphic, and at least two phone
  screenshots (1080×1920 or larger). Screenshots from a fresh install are best, so no personal tasks show.

## Microsoft Store (Windows, free signing)

1. Register at partner.microsoft.com as an individual developer (free since 2024).
2. Reserve the name Romulus, open **Product identity**, and copy its three values into repository
   **variables** (Settings → Secrets and variables → Actions → Variables):
   `MS_STORE_IDENTITY_NAME` (Package/Identity/Name), `MS_STORE_PUBLISHER` (Package/Identity/Publisher,
   starting `CN=`), `MS_STORE_PUBLISHER_NAME` (Package/Properties/PublisherDisplayName).
3. Push a tag; download `microsoft-store-appx` from the run and upload it as a submission. The Store signs it,
   so Store installs have no SmartScreen warning. Use the same privacy URL and listing text as above.
4. The Store tiles (StoreLogo, Square44x44, Small/Square150/Wide310x150/Large, each at 100% and 200%) are in
   `build/appx/`, made from `build/icon.png`. Remake them the same way if the icon changes.

## Signing the Windows installer (Azure Trusted Signing)

For the installer on the releases page. About $10 a month; individuals in the US and Canada can sign up.
Make a Trusted Signing account and a public-trust certificate profile in the Azure portal, an app
registration with the *Trusted Signing Certificate Profile Signer* role, then set:

- secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
- variables `AZURE_SIGNING_ENDPOINT` (for example `https://eus.codesigning.azure.net`),
  `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`

## Mac: signed and notarized download

1. Join the Apple Developer Program ($99 a year). This same account is needed for the iPhone app.
2. In Xcode or developer.apple.com, make a **Developer ID Application** certificate, export it as a `.p12`
   with a password, and base64 it (`base64 -i cert.p12`).
3. Make an app-specific password at account.apple.com, and note your Team ID.
4. Set secrets `MAC_CSC_LINK` (the base64), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. The next tag builds signed, notarized Mac apps for both
   Apple-chip and Intel Macs, and Macs can then install updates on their own.

The Mac App Store is not planned: its sandbox would block the Agent's browser and the local files it uses.

## iPhone (App Store)

The iPhone app is Capacitor's iOS project in `mobile/ios`, wrapping the same web UI as Android. The release
workflow's `ios` job builds it on a GitHub Mac and uploads it to App Store Connect, so no Mac of your own is
needed for releases (one with Xcode is still the way to run it on a test iPhone: `cd mobile && node
prepare-www.js --store appstore && npx cap sync ios && npx cap open ios`).

1. **Apple Developer Program** ($99 a year), the account from the Mac section above.
2. **Register the app**: in App Store Connect, My Apps → + → New App, platform iOS, name Romulus, bundle ID
   `com.jartro.tasks` (register the bundle ID first at developer.apple.com → Identifiers if it isn't offered).
   The bundle ID can never change.
3. **API key**: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys →
   generate one with the **Admin** role (Admin is what lets Xcode make the signing certificate and
   provisioning profile itself; a Developer-role key fails at the signing step). Download the `.p8` (only
   offered once) and note its Key ID and the Issuer ID shown on that page. Your Team ID is at
   developer.apple.com → Membership.
4. Set four secrets: `APPLE_API_KEY_P8` (`base64 -i AuthKey_XXXX.p8`), `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER_ID`, `APPLE_TEAM_ID` (the Mac section's `APPLE_TEAM_ID` is the same value).
5. Push a tag. The build appears under TestFlight in App Store Connect once Apple has processed it (ten
   minutes or so). The first time, Apple emails about **export compliance**; the app already declares it uses
   no non-exempt encryption (`ITSAppUsesNonExemptEncryption` in `Info.plist`), so there is nothing to answer.
6. **Release**: App Store Connect → the app → + Version, pick the TestFlight build, fill the listing with
   the Google Play text above (promotional text is optional; the Play "full description" fits the
   description field), add screenshots for the 6.7" and 6.5" iPhone sizes, the privacy policy URL, and
   submit for review. Set **Age rating** from the questionnaire (expect 4+ or 12+ depending on how you answer
   "unrestricted web access", which the Agent's browser is not on iPhone) and the same answers as Play's Data
   safety for **App Privacy** ("data not collected" by us; data the user sends to services they connect
   themselves is not collection).
7. **Reviewer note** (App Review Information): the same as Play's: no accounts of ours, tasks work offline,
   AI features need the reviewer's own key, entered in Settings → AI. Apple's reviewers do ask for a demo
   path; say which free key to use (a Gemini key from aistudio.google.com).
8. **HealthKit** (the Health tab, `HealthPlugin.swift`): the App ID needs the HealthKit capability. With
   automatic signing and the Admin key the first build turns it on itself; if the archive fails on
   "entitlement not supported", switch it on by hand at developer.apple.com → Identifiers →
   `com.jartro.tasks` → HealthKit. Review checks three things: a privacy policy with a HealthKit section (the
   Health section of `PRIVACY.md`), the purpose string in `Info.plist`
   (`NSHealthShareUsageDescription`), and that health data is used for the feature alone. Add to the
   reviewer note: "The Health tab reads steps, sleep and workouts from Apple Health, read-only, to tick off
   the user's own goal to-dos such as 'Walk 8,000 steps'. Nothing is stored, synced or shared." App Privacy:
   Health & Fitness, not collected (it never leaves the phone).

**Before paying Apple**: Actions → *iPhone build check* → Run workflow compiles the project unsigned on a GitHub
Mac (`.github/workflows/ios-check.yml`), so a broken project shows up before the $99 and before any secret
exists. The task-photo picker offers the camera on iPhone, so `Info.plist` carries the camera and photo
library purpose strings; without them iOS closes the app the moment someone taps *Take Photo*.

**What the iPhone app has** (Swift in `mobile/ios/App`, each the counterpart of an Android file in
`mobile/android/app/src/main/java/com/jartro/tasks/`):

| iPhone | Android | Notes |
|---|---|---|
| `HealthPlugin.swift` | `HealthPlugin.kt` | Apple Health in place of Health Connect, the same goal to-dos |
| `VoicePlugin.swift` | `VoicePlugin.java` | Apple's speech recognition, on the phone when the iPhone supports it |
| `WakeWordPlugin.swift` | `WakeWordPlugin.java` / `WakeWordService.java` | "Hey Romulus" only while Romulus is open (iOS allows no background listening), on-device only, so no speech model download |
| `FinanceVaultPlugin.swift` | `FinanceVaultPlugin.java` | key in the Keychain behind Face ID / Touch ID; adding a face or finger means pairing again. iOS can't block screenshots, so `secure` only hides Finance in the app switcher and while the screen is recorded |
| `CalAccountsPlugin.swift` | `CalAccountsPlugin.java` | Apple's sign-in sheet; tokens in the Keychain |
| `ShareLinkPlugin.swift` | `ShareLinkPlugin.java` | |
| `RomulusWidgets/` + `WidgetDataPlugin.swift` | the `*WidgetProvider.java` files | the same five: Today, List (Personal or Groceries, picked in the widget's settings), School, Agent (one board: needs you, working, queued, done, parked), Quick add. The page feeds them (`mobile/widgets-phone.js`), since only it can read the encrypted lists. Checking off on a widget needs iOS 17; the app itself runs on iOS 15 and up |
| `RomulusViewController.swift` | `MainActivity.java` | registers the plugins and turns widget taps (`romulus://hook?...`) into `window.__tasksHook` |

Still Android-only: sharing *into* Romulus from other apps (it needs a Share extension of its own). The
Finance wording still says "fingerprint" in places. There is no update banner (`ROMULUS_STORE` is
`appstore`): the App Store updates the app.

**Extra setup for these parts**:
- **App Group** for the widgets: developer.apple.com → Identifiers → App Groups → `group.com.jartro.tasks`,
  then turn on App Groups with that group for both `com.jartro.tasks` and `com.jartro.tasks.widgets` (the
  widget extension's App ID). Automatic signing may do this itself; doing it first avoids a failed archive.
- **Calendar sign-in on the iPhone** (optional; without it the iPhone has calendar links only): a Google
  OAuth client of type **iOS**, bundle ID `com.jartro.tasks`, stored as `"googleIos": {"clientId": "..."}` in
  `oauth-clients.json` and the `OAUTH_CLIENTS_JSON` secret; and in the Entra app registration, Authentication
  → Add a platform → iOS / macOS with bundle ID `com.jartro.tasks` (redirect `msauth.com.jartro.tasks://auth`).
- **Reviewer note** additions: "Hey Romulus is off by default (Settings > Hey Romulus) and listens only while
  the app is open, on the phone itself. Face ID opens the Finance tab. Every order, booking, form and email
  the Agent prepares waits for the user's yes."
- **App Privacy** additions: Photos or Videos and Other User Content (photos on Agent tasks and files the
  Agent downloads, kept on the Romulus server for sync), and Identifiers → Device ID (the hashed key id, for
  abuse limits), all for App Functionality, not tracking. `App/PrivacyInfo.xcprivacy` declares no tracking.
- **Check on a real iPhone** before submitting (none of it could be tried from Windows): voice and Hey
  Romulus (the chime, then Voice listening), Face ID and the Finance pairing scan, Google / Microsoft sign-in
  coming back to the app, the widgets filling in after the app is opened once, and a widget check-off being
  saved the next time the app opens.

**Version numbers**: the app's version is the root `package.json` one; its build number is the same figure
Android uses for `versionCode` (1.0.27 → 1000027), so every tag uploads a build Apple accepts as newer.

## Before any store goes public

- **Data deletion on the server**: paste `supabase/migrations/20261106_sync_delete_account.sql` into the SQL
  editor (after `20261106_sync_paid_plan.sql`), deploy `supabase/functions/sync-delete` with JWT
  verification off, and add an `app_secrets` row `stripe_api_key` (a Stripe restricted key with
  Subscriptions: write) so deleting also cancels a paid plan. Until the function is deployed the button
  says it couldn't delete.

- **Gmail access**: the Gmail scope is *restricted*. While the Google sign-in client is in testing mode only
  listed test users can use it; publishing it to everyone needs Google's verification and a yearly security
  assessment. Calendar (read-only) needs the lighter *sensitive*-scope verification. Until then, keep those
  sign-ins as bring-your-own-client (docs/SETUP.md).
- **Build check**: install the Play build from the closed test on a phone and try the wake word with another
  app in front (you should get the tap-to-talk notification).
