# Romulus privacy policy

Last updated: 30 October 2026

Romulus is a task list with an AI agent, for Windows, macOS, Linux and Android. It is open source, and this
policy covers every build of it: the installers on the releases page, the Android app on Google Play, and
the Windows app in the Microsoft Store.

**The short version: the people who make Romulus receive none of your data.** There are no Romulus servers,
no accounts with us, no analytics, no telemetry and no ads. What leaves your device goes only to services
*you* connect, under your own accounts and keys.

## What stays on your device

- Your tasks and lists, settings, API keys and sign-in tokens. On a computer, keys and tokens are encrypted
  with the operating system's own encryption (DPAPI, Keychain or the Linux keyring).
- Finance (bank data and receipts): encrypted with AES-256-GCM under a passphrase that is never saved, and on
  a phone under a key released only by your fingerprint. It is never sent to a cloud AI.
- The Locked profile (resume, address, ID numbers for forms): read only by a local AI model you run yourself.
- "Hey Romulus" on Android listens for its wake word entirely on the phone, only while the screen is on. No
  audio is recorded or sent anywhere. The speech model is downloaded once from alphacephei.com.

## What leaves your device, and where it goes

Only when you turn the feature on:

| Feature | What is sent | Where |
|---|---|---|
| Device sync | Your lists, over an encrypted connection | Your own Supabase project, which you create and control. Only devices with your sync key can read it. |
| AI chat and the Agent | The text of a task, its conversation, and the pages the Agent reads for it | The AI service you connected and chose for that task (Anthropic Claude, Google Gemini, OpenAI ChatGPT, OpenRouter, xAI Grok, Groq or NVIDIA), or a model on your own computer. Tasks containing words you mark private go only to your own model. Each service handles that data under its own privacy policy. |
| Calendars | Read-only access to your calendar list and events | Google or Microsoft, after you sign in. Events are shown in Romulus and are not sent anywhere else. |
| Gmail (receipts and dates) | Read-only access to messages | Google, after you sign in. Receipt emails are read by Claude to match purchases. Romulus never sends mail without your yes. |
| Talking to add a task (Android) | Your speech | Your phone's built-in speech recognition service (usually Google), which may process it online. |
| Stock prices, maps, place search | The ticker or place name | Yahoo Finance, OpenStreetMap Nominatim, Esri. |
| Bank connections | What SimpleFIN needs to fetch your transactions | SimpleFIN Bridge, with the access you grant there. |
| Update check (computers, and the Android app from the releases page) | An ordinary web request, which includes your IP address | GitHub, to see whether a newer version exists. The Google Play and Microsoft Store builds leave updates to their store. |

Romulus's use of information received from Google APIs follows the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements.

## Permissions on Android

- **Microphone**: to add a task by talking, and for "Hey Romulus" when you turn it on.
- **Notifications**: reminders, and the notice that shows while "Hey Romulus" is listening.
- **Biometrics**: to unlock Finance.
- **Camera** (through Google's code scanner): to scan the pairing code from your computer.

## Deleting your data

Everything Romulus keeps is on your devices and in your own sync project. Uninstalling the app removes it
from that device; deleting your Supabase project (or a list's rows in it) removes the synced copy. To stop
an AI service keeping what it received, use that service's own settings. As we hold nothing, there is
nothing to ask us to delete.

## Children

Romulus is not directed at children under 13.

## Changes and contact

Changes to this policy are made in this file, and its history is public. Questions: open an issue on
[the Romulus repository](https://github.com/jamesbobdev-gif/Romulus/issues), or for anything private, use
**Report a vulnerability** on its Security tab.
