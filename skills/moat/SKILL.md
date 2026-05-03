---
name: moat
description: Control a remote Chromium browser through moat-browser. Use when the user needs browser automation with navigation, forms, clicks, screenshots, extraction, web app testing, or logged-in SaaS flows through a remote browser.
allowed-tools: Bash(moat:*), Bash(*/moat:*)
---

# moat remote browser

moat is a remote-browser CLI. The Controller starts one agent Chrome container per session; the CLI registers the session, stores its ID in `~/.moat/session`, and sends later commands to that active session.

## Setup

Install the CLI from a checkout of this repository:

```bash
bash scripts/install.sh
```

Or download the installer through the authenticated GitHub CLI:

```bash
gh api repos/Mouriya-Emma/moat-browser/contents/scripts/install.sh --jq .content | base64 -d | bash
```

Configure the Controller URL:

```bash
export MOAT_CONTROLLER="ws://<controller-host>:3000"
```

## Session lifecycle

Start a session before issuing browser commands:

```bash
moat connect
moat connect --profile default
moat status
```

Always disconnect when done:

```bash
moat disconnect
```

`moat init` is an alias for `moat connect`, and `moat destroy` is an alias for `moat disconnect`.

## Interaction model

Prefer semantic locators over snapshots:

```bash
moat find role button --name "Submit" click
moat find label "Email" fill "user@example.com"
moat find text "Login" click
```

Use snapshots only when exploring an unfamiliar page or when a semantic locator fails:

```bash
moat snapshot
moat click @e1
moat fill @e2 "value"
```

Refs such as `@e1` come from the latest snapshot. Re-run `moat snapshot` after navigation or major DOM changes before reusing refs.

## Core commands

```bash
moat open https://example.com
moat back
moat forward
moat reload
moat snapshot
moat click @e1
moat fill @e1 "text"
moat type @e1 "text"
moat hover @e1
moat press Enter
moat screenshot
moat eval "document.title"
moat batch
```

## Logged-in SaaS flows

Humans log in through the neko WebRTC user browser. Agent sessions then load that profile by name:

```bash
moat connect --profile default
moat open https://app.example.com/dashboard
moat snapshot
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Command failed |
| 69 | Session creation failed |
| 77 | No active session |
| 78 | `MOAT_CONTROLLER` missing |
