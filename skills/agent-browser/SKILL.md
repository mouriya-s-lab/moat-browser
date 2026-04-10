---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. This skill routes between local (Vercel agent-browser) and remote (moat-browser) modes. Triggers include "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data", "test this web app", "login to a site", "automate browser actions", "browse", or any task requiring programmatic web interaction.
---

# Agent Browser — Setup Router

This skill sets up browser automation for the current project. It detects existing project configuration, or guides first-time setup.

## Step 0: Detect project-level skill

Before anything else, check if the project already has a browser skill configured:

```bash
ls <project>/skills/agent-browser/SKILL.md 2>/dev/null
```

**If the file exists:**

1. Read `<project>/skills/agent-browser/SKILL.md` — this is the authoritative skill for this project.
2. If `<project>/skills/agent-browser/.env` exists, load it to get `MOAT_CONTROLLER` and `MOAT_SESSION`.
3. If `MOAT_SESSION` is empty or the session is dead (command returns exit 77), run `moat init` to create a new session and update `.env`:
   ```bash
   source <project>/skills/agent-browser/.env
   SESSION_ID=$(MOAT_CONTROLLER=$MOAT_CONTROLLER moat init --json | jq -r '.data.sessionId')
   sed -i "s/^MOAT_SESSION=.*/MOAT_SESSION=$SESSION_ID/" <project>/skills/agent-browser/.env
   ```
4. Follow the instructions in the project SKILL.md. **Do not proceed to first-time setup.**

**If the file does not exist:** Continue to Step 1.

## Step 1: Check router .env for saved preferences

Read `~/.agents/skills/agent-browser/.env`. If it contains `MOAT_CONTROLLER=<url>`, offer remote as the default.

## Step 2: Ask the user

> Do you want to use a **local** browser (agent-browser runs on this machine) or a **remote** browser (moat-browser, runs on a server)?
>
> - **Local**: Requires `agent-browser` CLI installed locally.
> - **Remote**: Requires a moat-browser Controller running on a server. You'll need the WebSocket URL (e.g., `ws://192.168.1.211:3000`).

## Step 3a: Local mode

1. Verify `agent-browser` is available:
   ```bash
   which agent-browser || npx agent-browser --version
   ```
2. If not installed, install it:
   ```bash
   npm install -g @anthropic-ai/agent-browser
   ```
3. Download the official skill into the project:
   ```bash
   mkdir -p <project>/skills/agent-browser
   curl -fsSL https://raw.githubusercontent.com/anthropics/agent-browser/main/skills/agent-browser/SKILL.md \
     -o <project>/skills/agent-browser/SKILL.md
   ```
4. If the skill has a `references/` directory, download it too:
   ```bash
   mkdir -p <project>/skills/agent-browser/references
   for f in commands.md snapshot-refs.md session-management.md authentication.md; do
     curl -fsSL "https://raw.githubusercontent.com/anthropics/agent-browser/main/skills/agent-browser/references/$f" \
       -o "<project>/skills/agent-browser/references/$f" 2>/dev/null || true
   done
   ```
5. Follow the instructions in the downloaded SKILL.md.

## Step 3b: Remote mode (moat-browser)

1. Ask for the Controller URL if not already saved:
   ```
   What is your moat-browser Controller URL? (e.g., ws://192.168.1.211:3000)
   ```
2. Save to the router skill's `.env` for future projects:
   ```bash
   echo "MOAT_CONTROLLER=<url>" > ~/.agents/skills/agent-browser/.env
   ```
3. Verify `moat` CLI is available:
   ```bash
   which moat || echo "moat CLI not found — build with: cd <moat-browser-repo>/cli && cargo build --release"
   ```
4. Copy the moat skill into the project. If the moat-browser repo is local:
   ```bash
   mkdir -p <project>/skills/agent-browser
   cp <moat-browser-repo>/skills/moat/SKILL.md <project>/skills/agent-browser/SKILL.md
   ```
   Otherwise, download from GitHub:
   ```bash
   mkdir -p <project>/skills/agent-browser
   curl -fsSL https://raw.githubusercontent.com/Mouriya-Emma/moat-browser/main/skills/moat/SKILL.md \
     -o <project>/skills/agent-browser/SKILL.md
   ```
5. Initialize a session and write `.env`:
   ```bash
   SESSION_ID=$(MOAT_CONTROLLER=<url> moat init --json | jq -r '.data.sessionId')
   cat > <project>/skills/agent-browser/.env <<EOF
   MOAT_CONTROLLER=<url>
   MOAT_SESSION=$SESSION_ID
   EOF
   ```
6. Follow the instructions in the copied SKILL.md.
