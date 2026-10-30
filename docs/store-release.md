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
| iPhone App Store | not started | needs the Apple account, a Mac with Xcode, and an iOS port of the Android-only parts |

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
  - Data collected *by the developer*: none. Data shared with third parties: none by us; the app sends data
    to services the user connects themselves, which Play counts as user-initiated transfer, not sharing.
  - Still declare what the app processes and sends on the user's behalf, marked "processed ephemerally" /
    "not collected" as appropriate: personal info (name, email, address in the Locked profile), financial
    info (Finance), messages (Gmail), calendar events, audio (voice input), app activity (tasks).
  - Encrypted in transit: yes. Users can request deletion: data lives on their device and in their own
    sync project; they delete it there (see PRIVACY.md).
- **Foreground service: microphone** (`WakeWordService`). Declare it as *user-initiated, ongoing*: "Hey
  Romulus" is a wake word the user turns on in Settings; it listens only while the screen is on and shows
  a persistent notification. Play asks for a short video: turn it on in Settings, show the notification,
  say "Hey Romulus", show the app opening to listen.
- **Exact alarms** (`SCHEDULE_EXACT_ALARM`, from the reminders plugin): declare that reminders at the
  time the user set are a core feature of a task and calendar app.
- **Health, financial features**: Finance is a personal budget view, not a financial service: answer no to
  loans, banking and crypto.
- **AI-generated content**: Romulus shows replies from AI services the user connects. If review treats it as
  a generative-AI app, it will ask for an in-app way to report offensive output; that isn't built yet.

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
4. Store tiles currently use electron-builder's stock images; for a better look, add the tile images to
   `build/appx/` (StoreLogo 50×50, Square44x44Logo, Square150x150Logo, Wide310x150Logo).

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

Not started. It needs the Apple Developer account above, a Mac with Xcode (or a cloud Mac), and a test
iPhone. The work: add Capacitor's iOS project, then rebuild what is Android-only today (widgets in
WidgetKit, the share menu, calendar sign-in, the Finance fingerprint vault, the update banner left out).
iOS won't let "Hey Romulus" listen in the background, so there it would work only with Romulus open.

## Before any store goes public

- **Gmail access**: the Gmail scope is *restricted*. While the Google sign-in client is in testing mode only
  listed test users can use it; publishing it to everyone needs Google's verification and a yearly security
  assessment. Calendar (read-only) needs the lighter *sensitive*-scope verification. Until then, keep those
  sign-ins as bring-your-own-client (docs/SETUP.md).
- **Build check**: install the Play build from the closed test on a phone and try the wake word with another
  app in front (you should get the tap-to-talk notification).
