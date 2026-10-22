# Tasks

A clean, minimal to-do app for your computer, with an optional AI agent that does tasks for you and an optional phone app that stays in sync.

This repository holds the **installers**. Download one from the [Releases](../../releases/latest) page on the right.

## Install

**Windows**

1. Download `Tasks-Setup-<version>.exe` from the [latest release](../../releases/latest).
2. Run it. Windows shows an "unrecognized app" warning because the installer isn't code-signed yet: click **More info → Run anyway**.
3. Tasks opens, and from then on starts when you log in. It lives in the tray by the clock; closing the window hides it there.

**Mac and Linux:** no installer yet. Build it from the source (see below), which takes a few minutes.

## First launch

The first time it opens, a welcome card asks what you want:

- **Just tasks.** A to-do list with due dates, tags, subtasks and drag-to-reorder. Nothing to sign up for; your list stays on your computer.
- **Add an AI assistant.** The Agent tab hands tasks to an AI that searches the web, reads pages, fills forms and shops, then comes back when it needs you. Connect your Claude or ChatGPT plan, an OpenRouter account (free tier available), a Gemini key, or your own local model through Ollama. Each one is a card in Settings with a button that walks you through it.
- **Sync with my phone.** Lists shared between your computer and the Android app through a free Supabase project of your own. Your data lives in your project, under a key only your devices know.

The full walkthrough is in the [setup guide](https://github.com/jamesbobdev-gif/tasks-app/blob/main/docs/SETUP.md).

## Updates

Installed copies check this repository every few hours and install the next version in the background, when your computer has been idle for a while. The tray menu has **Restart to update** if you don't want to wait. You never need to come back here for an update.

## What's in a release

| File | What it is |
|---|---|
| `Tasks-Setup-<version>.exe` | The installer. The only file most people need. |
| `latest.yml` | What installed copies read to find out a new version exists. |
| `*.blockmap` | Lets an update download only the parts that changed. |

## Privacy, in short

Everything you connect stays on the computer where you connected it. API keys, sign-in tokens and sync keys are stored encrypted with your operating system's own encryption. Keys never sync between devices and never leave the app except to the service they belong to. Tasks with private words (bank, medical, password…) are only ever given to a local model, never a cloud one.

## Source code and problems

The code lives at [jamesbobdev-gif/tasks-app](https://github.com/jamesbobdev-gif/tasks-app), which is being prepared for an open-source release. Until it is public, report problems in this repository's Issues. The app keeps a short diary at `%APPDATA%\Tasks\agent-runner.log` that usually names the cause; paste the relevant lines (strip anything personal).
