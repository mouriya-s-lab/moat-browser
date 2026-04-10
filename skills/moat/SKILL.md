---
name: moat
description: Remote browser automation for AI agents via moat-browser. Use when the user needs to interact with websites through a remote Chromium instance, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Each session gets an isolated Docker container with its own Chrome, cookies, and state. Triggers include "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data", "test this web app", "login to a site", "automate browser actions", "browse", or any task requiring programmatic web interaction through the moat system.
allowed-tools: Bash(moat:*), Bash(*/moat:*)
---

# Remote Browser Automation with moat

moat operates remote Chromium instances via a Controller server. Each session gets an isolated Docker container — separate Chrome process, cookies, localStorage, and navigation history.

## Setup

Set environment variables (typically in the project's `.env`):

```bash
MOAT_CONTROLLER="ws://<controller-host>:3000"
```

The CLI binary is at `cli/target/release/moat` (or `moat` if installed to PATH).

After `moat init`, capture the session ID and set `MOAT_SESSION` for subsequent commands:

```bash
export MOAT_SESSION=$(moat init --json 2>&1 | jq -r '.data.sessionId')
```

## Session Lifecycle

Sessions must be explicitly created before any commands. Each session provisions its own container.

```bash
moat init                         # Create session + container, prints session ID
moat init --profile myprofile     # Create with a named browser profile
moat status                       # Show MOAT_SESSION + MOAT_CONTROLLER
moat destroy                      # Destroy current session + container
```

Multiple sessions run concurrently via separate `MOAT_SESSION` env vars:

```bash
export MOAT_SESSION=$(moat init --json | jq -r '.data.sessionId')  # Session A
# In another shell/agent:
export MOAT_SESSION=$(moat init --json | jq -r '.data.sessionId')  # Session B
```

## Core Workflow

Every browser automation follows this pattern:

1. **Init**: `moat init` (once per session)
2. **Navigate**: `moat open <url>`
3. **Snapshot**: `moat snapshot` (get element refs like `@e1`, `@e2`)
4. **Interact**: Use refs to click, fill, select
5. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
moat init
moat open https://example.com/form
moat snapshot
# Output: @e1 textbox, @e2 textbox, @e3 button "Submit"

moat fill @e1 "user@example.com"
moat fill @e2 "password123"
moat click @e3
moat wait 2000
moat snapshot  # Check result
```

## Command Chaining

Commands can be chained with `&&`. Each command is a separate process that opens a short-lived WebSocket to the Controller — session state lives server-side, so chaining is safe.

```bash
moat open https://example.com && moat snapshot
moat fill @e1 "text" && moat fill @e2 "text" && moat click @e3
```

**When to chain:** Use `&&` when you don't need intermediate output. Run commands separately when you need to read snapshot output to discover refs before interacting.

## Essential Commands

```bash
# Navigation
moat open <url>                   # Navigate to URL
moat back                         # Go back
moat forward                      # Go forward
moat reload                       # Reload page

# Snapshot (accessibility tree with @refs)
moat snapshot                     # Full ARIA tree with @eN refs

# Interaction (use @refs from snapshot, or CSS selectors)
moat click @e1                    # Click element by ref
moat click "#submit"              # Click by CSS selector
moat fill @e1 "text"              # Clear and fill text
moat type @e1 "text"              # Type without clearing
moat hover @e1                    # Hover over element
moat press Enter                  # Press key (Enter, Tab, Escape, etc.)
moat scroll down                  # Scroll page down
moat scroll up 500                # Scroll up by amount

# Semantic locators (alternative to @refs)
moat find role button --name "Submit" click
moat find role link --name "Login" --exact click
moat find label "Email" fill "user@example.com"
moat find text "Sign In" click

# Get information
moat get text "#selector"         # Get element text
moat get value "input[name=q]"    # Get form element value
moat is visible "#selector"       # Check element visibility
moat eval "document.title"        # Run JavaScript

# Wait
moat wait 2000                    # Wait milliseconds
moat wait text "Success"          # Wait for text to appear
moat wait url "**/dashboard"      # Wait for URL pattern

# Tabs
moat tab list                     # List all tabs
moat tab new <url>                # Open new tab
moat tab switch <index>           # Switch to tab by index
moat tab close <index>            # Close tab

# Capture
moat screenshot                   # Take screenshot
moat screenshot --json            # Screenshot as base64 JSON

# Cookies
moat cookies                      # List cookies
moat cookies --json               # Cookies as JSON
moat cookies clear                # Clear all cookies

# Batch (execute multiple commands from stdin)
echo '[["eval","1+1"],["eval","document.title"]]' | moat batch
echo '[["open","https://a.com"],["snapshot"]]' | moat batch --bail
```

## Common Patterns

### Form Submission

```bash
moat open https://example.com/signup
moat snapshot
moat fill @e1 "Jane Doe"
moat fill @e2 "jane@example.com"
moat click @e3
moat wait 2000
moat snapshot  # Verify result
```

### Authentication (Human logs in via neko, Agent operates)

moat-browser uses a split model: humans log in through the neko WebRTC interface (user-chrome container), creating a persistent browser profile with cookies/sessions. The Agent then uses that profile:

```bash
moat init --profile myapp         # Load profile with existing auth state
moat open https://app.example.com/dashboard
moat snapshot                     # Already logged in
```

### Data Extraction

```bash
moat open https://example.com/products
moat snapshot
moat get text "#price"
moat eval "JSON.stringify(Array.from(document.querySelectorAll('.item')).map(e => e.textContent))"
```

### Multi-Session Parallel Scraping

```bash
# Create two isolated sessions
SA=$(MOAT_CONTROLLER=ws://host:3000 moat init --json | jq -r '.data.sessionId')
SB=$(MOAT_CONTROLLER=ws://host:3000 moat init --json | jq -r '.data.sessionId')

# Operate independently via MOAT_SESSION
MOAT_SESSION=$SA moat open https://site-a.com
MOAT_SESSION=$SB moat open https://site-b.com

# Each session has its own cookies, history, tabs
MOAT_SESSION=$SA moat eval "document.title"
MOAT_SESSION=$SB moat eval "document.title"

# Cleanup
MOAT_SESSION=$SA moat destroy
MOAT_SESSION=$SB moat destroy
```

### JavaScript Evaluation

```bash
# Simple expressions
moat eval "document.title"
moat eval "document.querySelectorAll('a').length"

# Complex JS: use heredoc to avoid shell quoting issues
moat eval --stdin <<'EOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src, width: i.width }))
)
EOF
```

## Ref Lifecycle

Refs (`@e1`, `@e2`, etc.) are assigned per-snapshot and per-session. They become invalid when:

- The page navigates (click a link, form submit)
- DOM changes significantly (modal opens, dynamic content loads)
- A new `snapshot` command is run (refs are reassigned)

Always re-snapshot after navigation or significant DOM changes before using refs.

```bash
moat click @e5                    # Navigates to new page
moat snapshot                     # MUST re-snapshot — old refs are gone
moat click @e1                    # Use new refs
```

For pages with multiple same-role elements without accessible names (e.g., multiple textboxes without labels), refs are disambiguated with `.nth()` internally — each `@eN` points to exactly one element.

## Session Isolation

Each session is a fully isolated Docker container:

- Separate Chrome process and CDP connection
- Separate cookies, localStorage, sessionStorage
- Separate navigation history
- Separate tab state (activeTabIndex is per-session)
- Separate @ref store

Destroying one session does not affect others. Sessions expire after 10 minutes of inactivity (no commands).

## Error Handling

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | Command failed (element not found, timeout, etc.) |
| 77 | No active session — run `moat init` first |
| 78 | MOAT_CONTROLLER not set or empty |
| 69 | Session creation (init) failed |

When a command returns exit code 1, the error message describes the issue (e.g., "Element not found", "strict mode violation"). Re-snapshot and retry with correct refs.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOAT_CONTROLLER` | (required) | WebSocket URL of the Controller (e.g., `ws://192.168.1.211:3000`) |
| `MOAT_SESSION` | (required for commands) | Session ID returned by `moat init` |

Both are typically set in the project's `.env` file. No local config files or state directories are used — the CLI is fully stateless.

## Architecture Notes

- **Controller** runs on a remote server, managing Docker containers and CDP connections
- **CLI** (`moat`) is a local Rust binary; each command opens a short WebSocket, sends one command, closes
- **Session state** (CDP connection, browser context) lives server-side in the Controller's memory
- **Containers** are created on `init`, destroyed on `destroy` or idle timeout (10 min)
- WebSocket close does **not** affect session state — sessions are durable between commands
