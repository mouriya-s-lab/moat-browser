---
name: moat
description: Control a remote Chromium browser through moat-browser. Use when the user needs browser automation with navigation, forms, clicks, screenshots, extraction, web app testing, or logged-in SaaS flows through a remote browser.
allowed-tools: Bash(moat:*), Bash(*/moat:*)
---

# moat remote browser

`moat` is a remote-browser CLI. The Controller owns one Chromium session per
active session; the CLI stores the session ID in `~/.moat/session` and sends
subsequent commands over the Controller WebSocket.

## Setup and Controller selection

Install from a checkout:

```bash
bash scripts/install.sh
```

Configure the Controller with an environment variable or config file:

```bash
export MOAT_CONTROLLER="ws://<controller-host>:3000"
# or ~/.moat/config.json
# { "controller": "ws://<controller-host>:3000" }
```

Use `--controller <url>` for a one-command override:

```bash
moat --controller "ws://<other-controller>:3000" connect --profile default
```

The destination priority is `--controller` > non-empty `MOAT_CONTROLLER` >
`~/.moat/config.json` `controller`. A profile is selected on `connect` or
`init` with `--profile`; it is not a Controller destination setting.

## Session lifecycle

Create a session before issuing browser commands:

```bash
moat connect
moat init --profile default
moat status
```

`init` and `connect` are aliases. `disconnect`, `destroy`, and `close-session`
invoke local session destruction. `close` is a wire command whose Controller
handler deregisters the active session; it is not a local parser alias.
Always disconnect when the workflow is complete:

```bash
moat disconnect
```

Commands that need a session fail with exit code `77` when no active session is
registered. `status` reports the active session and Controller information.

## Interaction model

Prefer semantic locators over snapshots:

```bash
moat find role button --name "Submit" click
moat find label "Email" fill "user@example.com"
moat find text "Login" click
```

Use `snapshot` only for an unfamiliar page or after a semantic locator reports
that the element was not found:

```bash
moat snapshot
moat click @e1
moat fill @e2 "value"
```

Snapshot references are page-state dependent. Re-run `moat snapshot` after
navigation or a major DOM change before reusing a reference.

## Core commands

```bash
moat open https://example.com
moat back
moat forward
moat reload
moat click <selector>
moat fill <selector> "text"
moat type <selector> "text" [--clear] [--delay <ms>]
moat press Enter
moat get url
moat get title
moat get text <selector>
moat screenshot
moat eval "document.title"
```

`get url` and `get title` are supported remote commands. Selector-based
`get text`, `get html`, `get value`, `get attr`, `get count`, `get box`, and
`get styles` are also available; the selector or attribute argument is required
where the command form needs one. `--urls` on `snapshot` adds browser-resolved
absolute links.

Capture network traffic as a HAR artifact:

```bash
moat network har start --content text
moat network har stop ./network.har
```

`--content` accepts `text` (the default), `all` (binary responses as base64),
or `none` (metadata only).

## Same-document navigation

Use `pushstate` when the application router should receive a same-document
navigation:

```bash
moat pushstate /settings
```

The Controller evaluates the request in the page main world. If the page
exposes `window.next.router.push`, that page-owned router is used. Otherwise it
uses `history.pushState` and dispatches the page navigation events. The result
is the page URL. A request for the current URL is a no-op.

## Runtime initialization scripts

Register a script for the current page and session:

```bash
moat addinitscript "window.__agentReady = true"
# output contains an opaque identifier
moat removeinitscript <identifier>
```

The registration is scoped to the current tab and session, is applied to future
documents and reloads, and is not retroactively executed in the current
document. Removal rejects an identifier owned by another tab or session and
does not roll back an already-loaded document. The Controller removes the
registration when its page, tab, session, or runtime state is closed.

`--init-script` and `AGENT_BROWSER_INIT_SCRIPTS` are different features: they
belong to the upstream local launcher startup path and are rejected by moat
rather than silently discarded. `AGENT_BROWSER_ENABLE` is likewise an
unsupported upstream plugin/runtime-launcher setting.

## Batch, output, and errors

Batch commands can be passed inline or as JSON on stdin:

```bash
moat --json batch "get title" "get url"
printf '%s\n' '[["get","title"],["get","url"]]' | moat --json batch
moat --json batch --bail "open https://example.com" "get title"
```

With `--json`, inline and stdin batch both emit one moat response envelope:

```json
{"success":true,"data":{"results":[{"success":true}]}}
```

Failures retain their result entry. By default execution continues and the
process exits nonzero if any item failed; `--bail` stops after the first failed
item. Without `--json`, batch prints each successful response or error in
human-readable text and does not emit the JSON envelope. For responses that
reach command execution, `--json` emits exactly one JSON value. Startup config
loading errors occur before command execution, print a warning or error to
stderr, and exit nonzero without guaranteeing JSON stdout.

`AGENT_BROWSER_DEFAULT_TIMEOUT` supplies the default timeout in milliseconds
for wait-family commands when no explicit `--timeout` is present. An explicit
`--timeout` wins.

Relevant exit codes are:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Command, usage, unsupported-capability, element, timeout, or batch-item failure |
| 69 | Controller/session creation failure |
| 77 | No active session |
| 78 | Controller configuration error |

The current moat CLI uses exit code `1` for usage, missing-element, and timeout
failures; upstream sysexits values `2`, `66`, and `75` are not emitted by this
CLI.

## Unsupported upstream capabilities

The moat Controller deliberately does not import the upstream local daemon,
launcher, plugin, or native-device backends. These command families return the
stable `unsupported_in_moat` error rather than fake success:

- `read`, `react`, `vitals`, `web-vitals`, `a11y`, and `webmcp`
- `auth`, `confirm`, `deny`, `inspect`, `record`, and `stream`
- `launch`, `install`, `upgrade`, `dashboard`, `profiles`, and `session`
- `device`, `mcp`, `doctor`, `skills`, `plugin`, `plugins`, and `chat`

Tab references remain numeric indexes. `tab --label` and string tab references
are unsupported and fail before creating a tab.

## Neko login URL and logged-in flows

The neko WebRTC UI for a human login is served by the `user-chrome` container
on the Controller host's HTTP port `8080`. With
`MOAT_CONTROLLER=ws://<host>:3000`, open:

```text
http://<host>:8080
```

Log in there, close the neko session, then start an agent session using the
profile that contains the cookies:

```bash
moat connect --profile default
moat open https://app.example.com/dashboard
moat snapshot
```
