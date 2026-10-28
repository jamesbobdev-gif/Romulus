# Open-source roadmap

What remains after the public launch, in rough order of effect on a new user. Done so far: AI onboarding (Claude install/sign-in/API key, OpenRouter one-click, local Ollama), the welcome card, the Agent tab usable without sync, one-project sync, the setup guide, one-paste Supabase SQL, the public releases README and release notes, LICENSE/CONTRIBUTING/SECURITY, a three-platform build workflow.

## Next

1. **Code signing.** Windows: Azure Trusted Signing (needs the maintainer's identity validation; electron-builder 26 supports it directly). macOS: Apple Developer account and notarization, without which the app won't open at all.
2. **Phone pairing by QR.** The desktop shows a code holding the project URL, key and sync key; the phone scans it. Then one published APK for everyone, with no keys baked in (`mobile/prepare-www.js` currently bakes `sync-config.json`).
3. **Gmail for every AI.** Inbox tasks go through Claude's own Gmail connector today. Giving the Agent the app's Google sign-in token (which already has gmail.readonly) would let OpenRouter, Gemini or a local model read mail too; the runner's inbox-safety rules assume Claude's tool names and need the same treatment.
4. **Outlook mail.** Add Mail.Read to the Microsoft sign-in and an Outlook path in `main/gmail-dates.js`, so Outlook users get mail dates and receipts like Gmail users.
5. **Settings text pass.** A few hints still read as the maintainer's notes ("Save Claude for last, so his Claude usage is kept…"); comments say "his" throughout. Cosmetic, but visible.
6. **Linux and macOS testing.** The workflow builds them; nobody has run the desktop app there yet. Known: the location lookup is Windows-only; Linux needs a keyring for encrypted keys.
7. **iOS.** No app; a project of its own.

## Keep in mind

- `oauth-clients.json`, `seed-config.json`, `mobile/sync-config.json` and the `.backup-*` folders stay git-ignored. Git history was checked clean of secrets before launch.
- The "Hey Romulus" wake word stays until the phone's recognizer is retrained on a new phrase.
- Releases live on `romulus-releases` so installed copies keep updating; moving them to the main repo means one re-release and a change to `build.publish`.
