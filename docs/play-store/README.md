# Google Play: step by step

Everything Play asks for, in the order it asks. The policy answers and listing text are in
[../store-release.md](../store-release.md#google-play); the pictures are in this folder.

| File | Where it goes in Play Console |
|---|---|
| `icon-512.png` | Store listing → App icon (512×512) |
| `feature-graphic.png` | Store listing → Feature graphic (1024×500) |
| `phone-list.png`, `phone-agent.png`, `phone-calendar.png`, `phone-agent-dark.png` | Store listing → Phone screenshots (1080×1920) |

The screenshots show made-up sample tasks, not anyone's real list. They were taken from the app's own page at
phone size (360×640 at 3×) with headless Edge; the sample data is `dist/play-capture/setup.js` (not committed).

## 1. Make the developer account (you, about 15 minutes, then a few days of checks)

1. Go to **play.google.com/console** and sign in with the Google account that should own Romulus.
2. Choose **Yourself** (a personal account). Pay the **$25** one-time fee.
3. Verify your identity (a photo of your ID) and your phone. New personal accounts also have to install the
   **Play Console** app on an Android phone and confirm the device there.
4. Wait for "Your identity has been verified". It usually takes one to a few days.

## 2. Create the app

**Home → Create app**: App name **Romulus**, default language **English (United States)**, **App**, **Free**,
tick the two declarations, **Create app**. Free can't be changed to paid later, which is fine: the $5 sync plan
is never sold inside the Play build.

## 3. Find 12 testers now (this is the long part)

New personal accounts must run a **closed test with at least 12 testers for 14 days in a row** before Play
allows a public release. Ask family and friends with Android phones for the Gmail address they use on Play.
They only need to install the app from the test link and keep it installed for the 14 days; opening it now and
then helps.

## 4. Fill in "App content" (Policy → App content)

Answer each section with the text in [store-release.md → Policy answers](../store-release.md#policy-answers):

- **Privacy policy**: `https://github.com/jamesbobdev-gif/Romulus/blob/main/PRIVACY.md` (public, checked 2026-11-07)
- **App access**: "All or some functionality is restricted" → add the reviewer note from store-release.md
  (no accounts; AI needs the reviewer's own key, for example a free Gemini key).
- **Ads**: No.
- **Content rating**: fill the questionnaire (category: Utility / Productivity). Expect Everyone / PEGI 3.
- **Target audience**: 18 and over only.
- **Data safety**: as written in store-release.md.
- **Government app**: No. **Financial features**: none of the listed ones. **Health**: No.
- **Foreground service permissions**: Microphone, for "Hey Romulus". Play asks for a short screen recording:
  turn on Hey Romulus in Settings, show the notification, say "Hey Romulus", show the app opening to listen.

## 5. Store listing (Grow → Store presence → Main store listing)

- App name **Romulus**; short and full description from store-release.md → Store listing.
- Upload the icon, feature graphic and screenshots from this folder.
- Category **Productivity**, contact email: the address you want shown publicly.

## 6. Upload the build to the closed test

1. Push the next `v` tag (the v1.2.2 bundle predates the Report link under AI replies; use a newer one).
2. When the Release run finishes, open it on GitHub → **Artifacts** → download **google-play-aab** and unzip it:
   `Romulus-<version>-play.aab`.
3. Play Console → **Test and release → Testing → Closed testing → Create track** (or use "Alpha").
4. **Testers**: create an email list with the 12+ addresses.
5. **Create new release**. When asked about app signing, choose **Use Google-generated key** (Play App Signing).
   Your `signing/` keystore becomes the upload key: keep it as safe as before.
6. Upload the `.aab`, name the release (the version), add a line of release notes, **Review release → Start
   rollout**. Google reviews the first test release (a few hours to a few days).
7. Copy the **opt-in link** from the track's Testers tab and send it to your testers.

Phones that have the APK from the releases page can't update from Play over it (different signing key): those
people uninstall the APK once, then install from Play. Their lists come back through sync.

## 7. After 14 days: production

**Dashboard → Apply for production**. Play asks a few questions about the test (how many testers, what you
changed from their feedback). After approval: **Production → Create new release**, upload the newest `.aab`,
roll out. Later releases: upload each new tag's `google-play-aab` to Production (versionCode grows by itself).
