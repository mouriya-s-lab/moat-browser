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

Or, without a local checkout, run the installer through authenticated `gh`:

```bash
gh api repos/moat-lab/moat-browser/contents/scripts/install.sh --jq .content | base64 -d | bash
```

Configure the Controller URL:

```bash
export MOAT_CONTROLLER="ws://<controller-host>:3000"
```

Use `--controller <url>` to override the destination for one invocation. The
override takes precedence over `MOAT_CONTROLLER` and the config file, and is
not written to either the config or session file:

```bash
moat --controller "ws://<other-controller>:3000" connect --profile default
```

Controller selection priority is `--controller` > non-empty
`MOAT_CONTROLLER` > `~/.moat/config.json` `controller`.

## Session lifecycle

Start a session before issuing browser commands. `--profile` accepts only a
profile name registered by the Controller; it never accepts a local or
Controller filesystem path:

```bash
moat connect
moat connect --profile default
moat status
```

Clean up with any documented alias; all four commands share one owner-scoped
cleanup contract:

```bash
moat disconnect
moat destroy
moat close-session
moat close
```

Only a confirmed remote cleanup clears `~/.moat/session` and exits
successfully. A transport, Docker deletion, or unknown terminal state returns
non-zero and retains the local session handle so the command can be retried.
When a handle already exists, a second `connect` is rejected before remote
registration and the existing session remains active.

`moat status` is a local session/configuration view: it shows the session
handle and the Controller URL resolved for this invocation, but does not probe
remote Controller health. An explicit `--controller` is shown for that
invocation only and is not persisted.

The Controller operator registers additional names with its trusted
configuration (not through a client request). Sources must be mounted
directories inside `PROFILE_STORE` (which defaults to `PROFILES_WORK`):

```bash
PROFILE_STORE=/data/profiles
PROFILE_REGISTRY='{"named-fixture":"/data/profiles/named-fixture"}'
```

`default` is reserved for `PROFILE_SOURCE` and cannot be overridden. A
path-shaped, unregistered, unavailable, or out-of-scope profile is rejected
before session creation with `errorType: "invalid_value"`; the Controller
does not infer `/data/<name>` or create missing profiles.

Malformed `PROFILE_REGISTRY` configuration makes the Controller fail at
startup; it is never silently treated as an empty registry.

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
moat window new
moat get cdp-url  # returns unsupported_in_moat; CDP is Controller-private
moat batch
```
For repeated targets, use the getter-level selector options instead of relying
on a strict multi-match locator:

```bash
moat get text "a.column" --all
moat get text "a.column" --nth 0
```

`get text <selector>` is strict and requires exactly one matching element by
default. `--all` returns every text value in locator order as structured data;
`--nth <index>` reads one zero-based match. An out-of-range index is a real
`target_not_found` result, and an unsupported option is a real usage error
rather than a successful response with a missing value.

For repeated interaction targets, select an occurrence explicitly:

```bash
moat find first "input.same-target" fill "first"
moat find last "input.same-target" type "suffix"
moat find nth 1 "input.same-target" focus
```

`find first`, `find last`, and `find nth` support `click`, `fill`, `type`,
`hover`, `dblclick`, `focus`, `select`, `check`, and `uncheck`. `fill ""` is
valid and clears the selected input. An unknown action name, a missing value,
or an out-of-range occurrence returns a non-success result before changing
the page.

`get attr <selector> <name>` reports `attribute missing` for an absent
attribute and `""` for an explicitly present empty attribute, including both
states in `--json` as distinct variants. `get styles` and `get box` preserve
fractional geometry; an element with no layout has a distinct no-layout
variant rather than a fabricated zero-sized box.

`moat get url` and `moat get title` are not in the wire schema — use `moat eval "location.href"` and `moat eval "document.title"` instead. `moat get cdp-url` is intentionally unavailable: the agent-chrome CDP endpoint is private to the Controller's Docker network.

`moat is visible <selector>` reports the browser's layout visibility only.
It deliberately does not prove that pixels are perceptually visible or safe
to click: opacity, occlusion by another element, and interactivity are separate
questions. In particular, transparent and fully covered elements can still
return `true`, while `visibility:hidden` and `display:none` return `false`.

`moat eval` preserves the JavaScript result type after one serialization:
numbers remain numbers, strings remain bare strings in human output, and
objects/arrays remain directly readable JSON values. `undefined` is an
explicit `UndefinedValue` variant in `--json` and prints as `undefined` in
human output; it is distinct from `""`, `{}`, and a void command result.

If an eval script throws a non-`Error` value, the response remains
`errorType: "command_failed"` with `cause: "cdp"` and includes a structured
`ThrownValue` detail. Human output summarizes scalars, arrays, and nested
objects (for example `code=42, detail=bad`); circular values, symbols,
functions, and DOM nodes are shown as present but not serializable. Unknown
detail tags remain visible as raw JSON.

`moat click <selector> --new-tab` opens an element's HTTP(S) link in a new
active tab and leaves the original tab unchanged. An element without a
non-empty link is rejected instead of being clicked in the original tab.

Network routing accepts only `--abort` and `--body <json>`:

```bash
moat network route "**/api" --abort
moat network route "**/api" --body '{"ok":true}'
```

Unsupported route options such as `--status`, `--delay`, and `--headers` are
rejected before a route is installed.

`keydown` and `keyup` are explicit paired low-level operations. While a
modifier remains held, high-level `type`, `fill`, and `click` actions are
rejected before input; release it with `keyup` (or use an explicit `press`
combination). Key-state results show the currently held modifiers.

## JavaScript dialogs

Dialogs are owned by the real Page that opened them. `dialog status`,
`dialog accept`, and `dialog dismiss` operate on the active Page and report
`pageId`, tab index, `dialogId`, type, message, and prompt default. A modal in
another tab remains independently visible until that Page is selected.

When `eval` opens a dialog, the Controller waits up to a 3s handler grace.
Explicit `accept`/`dismiss` during that grace lets the original eval command
return its script result. If the grace expires first, the eval returns a
pending `operationId` rather than an empty success; resolve it with
`dialog accept [text]` or `dialog dismiss`, then retrieve the original result
with `dialog result <operation-id>` if it was not included in the handler
response. If the command deadline wins first, `dialog result <operation-id>`
returns `state: "operation"` with `TimedOutOperation` fields for `phase`,
`budget`, possible `sideEffects`, `sessionId`, `operationId`, `dialogId`, and
Page identity. The modal remains explicitly handleable and the session stays
usable. No dialog is accepted or dismissed automatically. Prompt text is
passed to the page unchanged.

`moat get url` and `moat get title` are not in the wire schema — use `moat eval "location.href"` and `moat eval "document.title"` instead. `moat get text|html|value|attr <selector>` do work but require a selector. `moat get cdp-url` is intentionally unavailable: the agent-chrome CDP endpoint is private to the Controller's Docker network.

## Remote Chromium environment

Use the runtime's own descriptor discovery before selecting a device:

```bash
moat device list
moat set device "<name from moat device list>"
moat set viewport 390 664 3
moat set offline OFF
```

`device list` reports the non-empty remote Chromium descriptor set, including
the names and metrics accepted by `set device`; it is not a local
Xcode/Appium inventory. `set device` applies the descriptor's dimensions,
device scale factor, user agent/metadata, and touch emulation together.
`set viewport` applies width, height, and the optional scale as the page's
`devicePixelRatio`. Do not infer a mobile device from a narrow width alone.
Pages without a viewport meta tag can intentionally expose Chromium's
approximately 980 CSS-pixel mobile layout viewport; use a page declaring
`width=device-width` when checking the descriptor CSS width.

Device/viewport, headers, media, and offline settings are session-scoped:
already-open tabs and tabs created later in that session inherit them. A
navigation-level `moat open --headers <json>` value is an explicit one-call
override. `set offline` accepts only `on`, `off`, `true`, or `false`,
case-insensitively. Unknown values, unknown descriptor names, and missing
arguments are rejected before changing browser state.

For machine-readable failures, inspect `errorType` and, for
`command_failed`, its structured `cause` rather than matching `error`:
`unsupported_in_moat`, `missing_arguments`, `invalid_value`, `target_not_found`,
`capacity_exceeded`, and `timeout` are stable classes. `command_failed` carries
a required cause; `dialog_pending` means a command was rejected before page
side effects because the active Page still has a modal, and includes the
original `operationId`, `dialogId`, and `page` identity.
For machine-readable failures, inspect `errorType` rather than matching
`error`: `unsupported_in_moat`, `missing_arguments`, `invalid_value`,
`target_not_found`, `capacity_exceeded`, and `timeout` are stable classes.
`command_failed` is reserved for infrastructure failures and always carries a
structured `cause`.

When choosing a wait budget, agents should omit `--timeout` for the normal
25s command budget. Use `--timeout <ms>` when the expected condition has a
known shorter or longer bound; it accepts integer values from `1` through
`120000`ms and applies to `wait`, `wait --url`, `wait --load`, `wait --fn`,
and `wait --download`. Session registration has a separate 45s budget and
does not use this flag. A `timeout` response has no `cause`; treat the result
as potentially partially applied and inspect state before deciding whether to
retry.

## Diagnostics and network details

`moat console` and `moat errors` expose browser diagnostics with `_tag`,
`sessionId`, stable `pageId`/`frameId`, event-time `pageUrl`/`frameUrl`, and a
Unix-millisecond `timestamp`. `ResourceFailureDiagnostic` identifies failed
resource loads with their URL, resource type, and available status or failure
reason. `PolicyBlockedDiagnostic` identifies CSP/security-policy blocks with
the blocked URL and policy text. Records remain attributable across
navigation and iframes; they do not depend on DOM markers.

`moat network request <id>` prints the same request detail represented by
`--json`: URL, method, resource type, status, request/response headers, request
body, and response body or an explicit `pending`/`absent`/controller-provided
completeness state. Human output never replaces detail with only `Done`.

The wire `code` is a Controller/SDK internal number. The CLI deliberately does
not expose it in the agent-browser-compatible `Response` shape or use it as
the process exit code. Agents must branch on `errorType` (and `cause` for
`command_failed`); `error` is display text.

## Neko login URL

The neko WebRTC UI (for humans to log in interactively) is served by the `user-chrome` container on the Controller host's HTTP port `8080`. Given `MOAT_CONTROLLER=ws://<host>:3000`, the neko URL is:

```
http://<host>:8080
```

Open it in a normal browser, log in to the target SaaS. Cookies land in the shared profile at `/data/profile`. Close the neko session before starting an agent session that reads that profile.

## Logged-in SaaS flows

Humans log in through the neko WebRTC user browser (see above). Agent sessions then load that profile by name:

```bash
moat connect --profile default
moat open https://app.example.com/dashboard
moat snapshot
```

## State and cookie fidelity

State files preserve cookies, origin localStorage/IndexedDB, and sessionStorage
for each open tab keyed by its exact URL. `state load` never guesses between
duplicate or missing tabs: it returns an explicit `status` of `complete`,
`incomplete`, or `unsupported`; only `complete` includes `loaded: true`.

Bare state names use the shared `$HOME/.moat/states/` namespace:

```bash
moat state save alpha
moat state list
moat state show alpha
moat state load alpha
```

Absolute and multi-component paths remain explicit paths and are not included in
the default `state list` or `state clear --all` set. `state clear --all` only
removes direct `.json` files in the default directory and requires explicit
confirmation:

```bash
moat state clear --all --confirm
```

Without `--confirm` (or its `--yes` alias), the command fails immediately with
`errorType: "missing_arguments"` without reading stdin or changing files. Cookie
scope is mutually exclusive: use either `--url <url>` or
`--domain <domain>`/`--path <path>`. A conflicting combination is rejected with
`errorType: "invalid_value"` before any cookie is written.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Command failed |
| 69 | Session creation failed |
| 77 | No active session |
| 78 | `MOAT_CONTROLLER` missing |
