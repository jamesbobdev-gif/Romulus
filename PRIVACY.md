# Romulus privacy policy

Last updated: 7 November 2026

Romulus is a task list with an AI agent, for Windows, macOS, Linux and Android. It is open source, and this
policy covers every build of it: the installers on the releases page, the Android app on Google Play, and
the Windows app in the Microsoft Store.

**The short version: the people who make Romulus can't read your data.** There are no accounts, no
analytics, no telemetry and no ads. Sync goes through the Romulus server unless you choose your own, and your
lists are end-to-end encrypted there: only your devices hold the key. Everything else that leaves your device
goes only to services *you* connect, under your own accounts and keys.

## What stays on your device

- Your tasks and lists, settings, API keys and sign-in tokens. On a computer, keys and tokens are encrypted
  with the operating system's own encryption (DPAPI, Keychain or the Linux keyring).
- Finance (bank data and receipts): encrypted with AES-256-GCM under a passphrase that is never saved, and on
  a phone under a key released only by your fingerprint. It is never sent to a cloud AI. When sync is on, the
  SimpleFIN access link alone (no bank data) is kept in your sync storage so your other computers can connect,
  encrypted under that same passphrase, which never leaves the computer you type it on.
- The Locked profile (resume, address, ID numbers for forms): read only by a local AI model you run yourself.
- "Hey Romulus" on Android listens for its wake word entirely on the phone, only while the screen is on. No
  audio is recorded or sent anywhere. The speech model is downloaded once from alphacephei.com.
- Health (a phone, when you turn it on): see "Health" below.

## Health

When you turn on Health on a phone (Settings → Health, or Connect on the Health tab), Romulus reads three things from
the phone's health store, which is Health Connect on Android and Apple Health (HealthKit) on an iPhone: your
**steps**, your **exercise** (workouts; on an iPhone also the watch's exercise minutes) and your **sleep**. It reads
only; it never writes to either. From them it keeps one line per day (total steps, minutes of exercise, minutes of
sleep) for the last 60 days, and uses them for one thing: ticking off tasks you gave a health goal, such as
"Walk #steps 8000" or "Walk 8,000 steps".

- The individual samples (each walk, each night's stages) are not kept or sent anywhere.
- The daily totals are never sent to any AI service, cloud or local, and are not used for ads or sold.
- When your lists are end-to-end encrypted, the daily totals sync to your other devices the same way, so a
  computer can tick those tasks off too. The sync server can't read them. Without end-to-end encryption they
  stay on the phone.
- Turning Health off stops the reading. Health Connect's own settings, or on an iPhone the Health app under
  Sharing → Apps → Romulus, take the permission back, and uninstalling removes what was kept on the phone.

Romulus's use of Health Connect data follows the
[Health Connect Permissions policy](https://support.google.com/googleplay/android-developer/answer/12991134),
including its limited use requirements. Its use of Apple Health data follows Apple's HealthKit rules: never for
advertising or marketing, never sold, never given to a third party.

## What leaves your device, and where it goes

Only when you turn the feature on:

| Feature | What is sent | Where |
|---|---|---|
| Device sync | Your lists, end-to-end encrypted on your device before they are sent | The Romulus server (a Supabase project run by the Romulus developer), or your own Supabase project if you choose one in Settings → Device sync. Only devices with your sync key can read your lists; the Romulus server can't. See "The Romulus server" below. |
| Photos and files you add to a task | The photo or file, encrypted on your device before it is sent | The sync server, under a random name in a folder named by a hash of your key. Only devices that can read the task hold the key to open it. Kept until you remove it or the task, and counted toward your space. |
| Photos sent to the Agent, and files the Agent downloads | The photo or file | The sync server, in a folder named by a hash of your key. These are not end-to-end encrypted, because the AI has to see them: anyone with a file's exact web address can open it. The Agent's photos are deleted after 30 days. |
| Email me links (Settings → Device sync) | Your email address, and for each link you choose on an Agent task its name, web address, price and picture | The Romulus server keeps the address with your account, readable by the Romulus developer, and sends the code and your links through Resend, which delivers them under its own privacy policy. Mail only goes to an address you confirmed with a code. "Stop emailing me" or deleting your account removes the address. |
| The paid plans (computers only) | Payment details, entered on Stripe's own page | Stripe, which handles the payment under its own privacy policy. The Romulus server learns only that your account paid, and Stripe's customer and subscription ids. |
| AI chat and the Agent | The text of a task, its conversation, and the pages the Agent reads for it | The AI service you connected and chose for that task (Anthropic Claude, Google Gemini, OpenAI ChatGPT, OpenRouter, xAI Grok, Groq or NVIDIA), or a model on your own computer. Tasks containing words you mark private go only to your own model. Each service handles that data under its own privacy policy. |
| Calendars | Read-only access to your calendar list and events | Google or Microsoft, after you sign in. Events are shown in Romulus and are not sent anywhere else. |
| Gmail and Outlook (receipts, dates, Agent inbox tasks) | Reading messages; for Agent inbox tasks also drafts, labels, archive and read/unread, and, after your yes, sending and moving to the trash | Google or Microsoft, after you sign in. Receipt emails are read by the first AI in your order (Settings → AI connections) to match purchases. Romulus never sends or trashes mail without your yes. |
| Talking to add a task (Android) | Your speech | Your phone's built-in speech recognition service (usually Google), which may process it online. |
| Stock prices, maps, place search | The ticker or place name | Yahoo Finance, OpenStreetMap Nominatim, Esri. |
| Bank connections | What SimpleFIN needs to fetch your transactions | SimpleFIN Bridge, with the access you grant there. |
| Update check (computers, and the Android app from the releases page) | An ordinary web request, which includes your IP address | GitHub, to see whether a newer version exists. The Google Play and Microsoft Store builds leave updates to their store. |

Romulus's use of information received from Google APIs follows the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements.

## The website

The download page ([jamesbobdev-gif.github.io/Romulus](https://jamesbobdev-gif.github.io/Romulus/)) keeps a
private tally of what visitors do: how many times a day the page was opened and each button used (a download,
a plan, the source link). It is a count per day, not a record per person: no cookies, no IP address is kept with
it (only the same one-day hash of your IP address the Romulus server keeps to limit abuse), and nothing is
counted when your browser sends Do Not Track or Global Privacy Control. The counts are not public.

## The Romulus server

To count space and stop abuse, the Romulus server keeps, for each sync account: the encrypted lists, a hash
of your sync key's id (not the key), how much space you use and how often you write, when you last ran out of
space, and, if you paid, which plan, until when and the Stripe ids above. To limit how many new accounts one network can
make, it keeps a hash of your IP address for a day. Supabase hosts it, and handles that data under its own
privacy policy. None of it is sold or shared, and none of it is used for anything but running sync.

With a paid plan it also keeps:

- **History**: one copy of each list per day for 30 days, so you can restore a day. The copies are as
  encrypted as the lists, so nobody but your devices can read them, and they go when the lists are deleted.
- **Family** (the family/group plan): which accounts share a plan, and when each joined. A family code is kept for at most 2 days.
- **Supporters list**: only if you type a name into the optional field when you pay, that name is shown in
  the app and at the bottom of the Romulus website while you pay. Leave it empty and you are not listed.

### Romulus cloud

If none of your computers is on to take an Agent task, your phone can offer to send it to Romulus cloud. Nothing
goes until you say yes, on that device ("Always", "Just this once" or "No thanks"; Settings, Agent changes it).

- **What is sent**: that one task (its title, your notes and the conversation on it) and your "What Claude knows
  about you" notes, leaving out any line with one of your private words, a card number or an ID number. The app
  won't send your other lists, Finance, the Locked profile, photos, or a task with a private word, a card number or
  an ID number in it. These checks run in the app, before anything leaves your phone. Your account is named by a
  one-way code made from your sync key; the key itself isn't sent.
- **Who sees it**: the Romulus server passes it to Anthropic's Claude, which answers it with web search. Anthropic
  handles it under its commercial terms (API data is not used to train its models). The server keeps the task only in
  memory while it is answered; it is never saved or logged.
- **The answer** is sealed with a one-time key that only the phone that asked has, kept until that phone picks it up,
  then deleted (after 2 days if it never does). Its links come from the web and aren't checked, and the app says so
  under the answer.
- **What is kept**: per account per month, how many cloud tasks you used and roughly what they cost, to apply your
  plan's allowance; and for a day, a hash of your IP address, to stop people making accounts to use free tasks.
- **Repeating tasks while every device is off** (paid plans, off until you switch it on for a task: "Also run it
  when all my devices are off", under the task's Repeat). This is the one case where a copy of a task is kept on the
  Romulus server between runs, so read this before you switch it on:
  - What is kept: that task's title, your notes on it, its last few messages, and your "What Claude knows about you"
    notes, with the same things left out as above. A task with a private word, a card number or an ID number can't
    be switched on, and its copy is removed if it later gains one.
  - How it is kept: locked with a key that only the cloud Agent's program has, not the database. So the stored copy
    is not readable in the database, but it is not end-to-end encrypted the way your lists are: whoever runs the
    server and holds that key could open it. On the Romulus server that is the developer.
  - When it runs: only if none of your devices ran that round within a few minutes of its time. The answer is locked
    with a key that lives on the task inside your own encrypted list, so only your devices can read it; it waits
    until one of them opens the app (14 days at most).
  - Switching it off, deleting the task or deleting your account removes the copy. A copy none of your devices has
    refreshed for 14 days is removed by itself, and after three unread answers it stops running until you are back.
- The code that does this is public: `supabase/functions/cloud-agent` and `renderer/js/cloud-agent.js`.

## Health Connect (Android)

When you tap **Connect Health Connect** on the Health tab and allow it, the Android app reads three things
from Health Connect, read-only: **steps**, **sleep** and **exercise sessions**. It reads them only while the
app is open, to add up today's steps, last night's sleep and today's workout minutes, and uses those totals
for one thing: ticking off a to-do that names a goal, such as "Walk 8,000 steps".

- The totals are kept in the app's memory and dropped when it closes. They are not saved, not synced to your
  other devices, not sent to any AI service, and not sent to us or anyone else. What syncs is the ticked-off
  to-do, as with any to-do you tick off yourself.
- Romulus never writes to Health Connect.
- Romulus's use of data from Health Connect follows Google Play's Health Connect permissions policy,
  including its Limited Use requirements.
- To stop it, tap **Manage** on the Health tab, or take the permissions back in Health Connect's own
  settings.

## Permissions on iPhone

- **Notifications**: reminders.
- **Health** (read only): steps, exercise and sleep, for tasks that tick themselves off, when you turn on
  Health. See "Health" above.

## Permissions on Android

- **Microphone**: to add a task by talking, and for "Hey Romulus" when you turn it on.
- **Notifications**: reminders, and the notice that shows while "Hey Romulus" is listening.
- **Biometrics**: to unlock Finance.
- **Camera** (through Google's code scanner): to scan the pairing code from your computer.
- **Health Connect** (steps, exercise, sleep; read only): for tasks that tick themselves off, when you turn
  on Settings → Health. See "Health" above.

## Deleting your data

- **On a device**: uninstalling the app removes everything it kept there.
- **On the Romulus server**: Settings → Device sync → **Delete my account** (three clicks and a number typed in) deletes your lists, photos,
  files and account record there at once, and cancels a paid plan. Turn sync off on your other devices first,
  or they will upload their copy again. If you no longer have any device with Romulus on it, nobody can read
  what is left there, us included, and without your key we can't tell which encrypted account is yours.
- **On your own Supabase project**: delete the project, or the rows in it.
- **At an AI service**: use that service's own settings.

## Children

Romulus is not directed at children under 13.

## Changes and contact

Changes to this policy are made in this file, and its history is public. Questions: open an issue on
[the Romulus repository](https://github.com/jamesbobdev-gif/Romulus/issues), or for anything private, use
**Report a vulnerability** on its Security tab.
