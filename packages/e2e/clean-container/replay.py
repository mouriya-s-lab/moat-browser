#!/usr/bin/env python3
"""Repeatable row-7 CLI acceptance for a clean Linux client.

The driver deliberately knows nothing about Docker, Chrome, CDP, or the host
checkout.  It starts only the installed ``moat`` executable supplied by the
clean-container harness and observes the resulting JSON/text output and
browser-visible effects through the CLI.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence, TypeAlias
from urllib.parse import urljoin, urlparse


JSONScalar: TypeAlias = None | bool | int | float | str
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]


class ReplayFailure(RuntimeError):
    """An expected browser/CLI assertion did not hold."""


@dataclass(frozen=True)
class ReplayConfig:
    moat: Path
    controller: str
    fixture_url: str
    evidence_dir: Path
    mode: str
    profile: str | None
    idle_timeout_seconds: int
    idle_wait_seconds: int


@dataclass
class CommandResult:
    sequence: int
    row: str
    home: Path
    argv: list[str]
    child_env: dict[str, str]
    stdin: str | None
    stdin_held_open: bool
    started_at: float
    duration_seconds: float
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    parsed: JSONValue | None

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def record(self) -> dict[str, JSONValue]:
        return {
            "type": "command",
            "sequence": self.sequence,
            "row": self.row,
            "home": str(self.home),
            "argv": self.argv,
            "childEnv": self.child_env,
            "stdin": self.stdin,
            "stdinHeldOpen": self.stdin_held_open,
            "startedAt": self.started_at,
            "durationSeconds": self.duration_seconds,
            "exit": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "timedOut": self.timed_out,
            "parsed": self.parsed,
        }


@dataclass
class RowOutcome:
    name: str
    passed: bool
    started_at: float
    duration_seconds: float
    details: dict[str, JSONValue] = field(default_factory=dict)
    error: str | None = None
    traceback_text: str | None = None
    command_sequences: list[int] = field(default_factory=list)
    cleanup_errors: list[str] = field(default_factory=list)

    def record(self) -> dict[str, JSONValue]:
        result: dict[str, JSONValue] = {
            "name": self.name,
            "passed": self.passed,
            "startedAt": self.started_at,
            "durationSeconds": self.duration_seconds,
            "details": self.details,
            "commandSequences": self.command_sequences,
            "cleanupErrors": self.cleanup_errors,
        }
        if self.error is not None:
            result["error"] = self.error
        if self.traceback_text is not None:
            result["traceback"] = self.traceback_text
        return result


class DeadControllerObserver:
    """A client-local TCP observer for #229 wrong-destination assertions."""

    def __init__(self) -> None:
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(8)
        self._server.settimeout(0.2)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.connections: list[dict[str, JSONValue]] = []

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self._server.getsockname()[1]}"

    def start(self) -> None:
        self._thread = threading.Thread(target=self._serve, name="row7-dead-controller", daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                connection, address = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                self.connections.append(
                    {"time": time.time(), "address": list(address), "bytes": self._read_probe(connection)}
                )

    @staticmethod
    def _read_probe(connection: socket.socket) -> int:
        connection.settimeout(0.2)
        try:
            return len(connection.recv(4096))
        except (socket.timeout, OSError):
            return 0

    def stop(self) -> None:
        self._stop.set()
        try:
            self._server.close()
        finally:
            if self._thread is not None:
                self._thread.join(timeout=2)

    def record(self) -> dict[str, JSONValue]:
        return {"url": self.url, "connections": list(self.connections)}


class ReplayTranscript:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.sequence = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("", encoding="utf-8")

    def append(self, record: Mapping[str, JSONValue]) -> None:
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(dict(record), ensure_ascii=False, sort_keys=True) + "\n")
            stream.flush()

    def next_sequence(self) -> int:
        self.sequence += 1
        return self.sequence


class ScenarioContext:
    """One isolated scenario and all of its independently-owned HOME dirs."""

    def __init__(self, runner: "ReplayRunner", row: str) -> None:
        self.runner = runner
        self.row = row
        self.homes: dict[str, Path] = {}
        self.sessions: dict[str, str] = {}
        self.command_sequences: list[int] = []
        self.details: dict[str, JSONValue] = {}

    def home(self, name: str = "main") -> Path:
        existing = self.homes.get(name)
        if existing is not None:
            return existing
        path = self.runner.home_root / self.runner.safe_name(self.row) / name
        path.mkdir(parents=True, exist_ok=True)
        (path / ".moat").mkdir(parents=True, exist_ok=True)
        (path / "tmp").mkdir(parents=True, exist_ok=True)
        (path / "xdg-config").mkdir(parents=True, exist_ok=True)
        (path / "xdg-cache").mkdir(parents=True, exist_ok=True)
        self.homes[name] = path
        return path

    def config_path(self, name: str = "main") -> Path:
        return self.home(name) / ".moat" / "config.json"

    def session_path(self, name: str = "main") -> Path:
        return self.home(name) / ".moat" / "session"

    def write_config(self, name: str, controller: str) -> None:
        self.config_path(name).write_text(json.dumps({"controller": controller}) + "\n", encoding="utf-8")

    def state(self, name: str = "main") -> dict[str, str | None]:
        home = self.home(name)
        return {
            "config": self.config_path(name).read_text(encoding="utf-8")
            if self.config_path(name).exists()
            else None,
            "session": self.session_path(name).read_text(encoding="utf-8")
            if self.session_path(name).exists()
            else None,
        }

    def _child_env(
        self,
        name: str,
        controller: str | None,
        extra: Mapping[str, str] | None,
    ) -> dict[str, str]:
        home = self.home(name)
        # Keep only process basics needed to launch an already-installed binary.
        # In particular, do not inherit proxy, profile, cache, or production
        # endpoint variables from the host client.
        path = os.environ.get("PATH", "")
        environment = {
            "PATH": path,
            "HOME": str(home),
            "TMPDIR": str(home / "tmp"),
            "XDG_CONFIG_HOME": str(home / "xdg-config"),
            "XDG_CACHE_HOME": str(home / "xdg-cache"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "NO_COLOR": "1",
        }
        if controller is not None:
            environment["MOAT_CONTROLLER"] = controller
        if extra:
            environment.update(extra)
        for key in (
            "AGENT_BROWSER_DEFAULT_TIMEOUT",
            "AGENT_BROWSER_INIT_SCRIPTS",
            "AGENT_BROWSER_PROFILE",
            "AGENT_BROWSER_STATE",
            "MOAT_PROFILE",
            "MOAT_TEST_PROFILE",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            if key not in (extra or {}):
                environment.pop(key, None)
        return environment

    def command(
        self,
        name: str,
        args: Sequence[str],
        *,
        json_output: bool = True,
        expected_success: bool = True,
        stdin: str | None = None,
        held_stdin: bool = False,
        controller: str | None = None,
        omit_controller_env: bool = False,
        extra_env: Mapping[str, str] | None = None,
        timeout: float = 90,
        before_json: Sequence[str] = (),
    ) -> CommandResult:
        if held_stdin and stdin is not None:
            raise ReplayFailure("held stdin cannot also have a finite stdin payload")
        selected_controller = None if omit_controller_env else (
            controller if controller is not None else self.runner.config.controller
        )
        environment = self._child_env(name, selected_controller, extra_env)
        argv = [str(self.runner.config.moat), *(str(value) for value in before_json)]
        if json_output:
            argv.append("--json")
        argv.extend(str(value) for value in args)
        started_at = time.time()
        monotonic_start = time.monotonic()
        timed_out = False
        exit_code: int | None
        stdout: str
        stderr: str
        if held_stdin:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=environment,
            )
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                process.kill()
                process.wait()
            stdout, stderr = process.communicate()
            exit_code = process.returncode
        else:
            try:
                completed = subprocess.run(
                    argv,
                    input=stdin,
                    capture_output=True,
                    text=True,
                    env=environment,
                    timeout=timeout,
                )
                exit_code = completed.returncode
                stdout, stderr = completed.stdout, completed.stderr
            except subprocess.TimeoutExpired as error:
                timed_out = True
                exit_code = None
                stdout = self._text_output(error.stdout)
                stderr = self._text_output(error.stderr)
        duration_seconds = time.monotonic() - monotonic_start
        parsed: JSONValue | None = None
        if json_output and stdout.strip():
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError:
                parsed = None
        sequence = self.runner.transcript.next_sequence()
        result = CommandResult(
            sequence=sequence,
            row=self.row,
            home=self.home(name),
            argv=argv,
            child_env={
                key: value
                for key, value in environment.items()
                if key in {"HOME", "MOAT_CONTROLLER", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "NO_COLOR"}
            },
            stdin=stdin,
            stdin_held_open=held_stdin,
            started_at=started_at,
            duration_seconds=duration_seconds,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            timed_out=timed_out,
            parsed=parsed,
        )
        self.runner.transcript.append(result.record())
        self.command_sequences.append(sequence)
        if expected_success:
            if not result.succeeded:
                raise ReplayFailure(self._command_failure(result, "successful command"))
            if json_output and (not isinstance(parsed, dict) or parsed.get("success") is not True):
                raise ReplayFailure(self._command_failure(result, "success=true JSON envelope"))
        else:
            if result.timed_out or result.exit_code is None:
                raise ReplayFailure(self._command_failure(result, "completed nonzero failed command"))
            if result.exit_code == 0:
                raise ReplayFailure(self._command_failure(result, "nonzero failed command"))
            if json_output and (
                not isinstance(parsed, dict) or parsed.get("success") is not False
            ):
                raise ReplayFailure(self._command_failure(result, "success=false JSON envelope"))
        return result

    @staticmethod
    def _text_output(value: str | bytes | None) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return value

    @staticmethod
    def _command_failure(result: CommandResult, context: str) -> str:
        return (
            f"{context}: sequence={result.sequence} argv={result.argv} "
            f"exit_code={result.exit_code} timed_out={result.timed_out} "
            f"stdout={result.stdout[-500:]!r} stderr={result.stderr[-500:]!r}"
        )

    def data(self, result: CommandResult) -> dict[str, JSONValue]:
        if not isinstance(result.parsed, dict):
            raise ReplayFailure(f"command {result.sequence} did not return a JSON object: {result.stdout!r}")
        value = result.parsed.get("data")
        if not isinstance(value, dict):
            raise ReplayFailure(f"command {result.sequence} has no object data field: {result.parsed!r}")
        return value

    def failure(self, result: CommandResult) -> dict[str, JSONValue]:
        if not isinstance(result.parsed, dict):
            raise ReplayFailure(f"command {result.sequence} did not return a JSON failure object: {result.stdout!r}")
        return result.parsed

    def cli(
        self,
        name: str,
        args: Sequence[str],
        *,
        expected_success: bool = True,
        stdin: str | None = None,
        held_stdin: bool = False,
        controller: str | None = None,
        omit_controller_env: bool = False,
        extra_env: Mapping[str, str] | None = None,
        timeout: float = 90,
        before_json: Sequence[str] = (),
    ) -> CommandResult:
        return self.command(
            name,
            args,
            json_output=True,
            expected_success=expected_success,
            stdin=stdin,
            held_stdin=held_stdin,
            controller=controller,
            omit_controller_env=omit_controller_env,
            extra_env=extra_env,
            timeout=timeout,
            before_json=before_json,
        )

    def text(self, name: str, args: Sequence[str], *, expected_success: bool = True) -> CommandResult:
        return self.command(name, args, json_output=False, expected_success=expected_success)

    def init(
        self,
        name: str = "main",
        *,
        controller: str | None = None,
        controller_env: str | None = None,
        omit_controller_env: bool = False,
        extra_env: Mapping[str, str] | None = None,
        before_command: bool = False,
    ) -> str:
        args: list[str] = ["init"]
        before_json: list[str] = []
        if before_command and controller is not None:
            before_json.extend(["--controller", controller])
        elif controller is not None:
            args.extend(["--controller", controller])
        if self.runner.config.profile is not None:
            args.extend(["--profile", self.runner.config.profile])
        result = self.cli(
            name,
            args,
            controller=controller_env,
            omit_controller_env=omit_controller_env and controller_env is None,
            extra_env=extra_env,
            before_json=before_json,
        )
        data = self.data(result)
        session_id = data.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise ReplayFailure(f"init did not return nonempty sessionId: {result.parsed!r}")
        self.sessions[name] = session_id
        session_file = self.session_path(name)
        if not session_file.exists() or session_file.read_text(encoding="utf-8") != session_id:
            raise ReplayFailure(f"init did not persist expected session for {name}")
        return session_id

    def disconnect(self, name: str = "main", *, controller: str | None = None, expected_success: bool = True) -> CommandResult:
        result = self.cli(name, ["disconnect"], expected_success=expected_success, controller=controller)
        if expected_success:
            self.sessions.pop(name, None)
            if self.session_path(name).exists():
                raise ReplayFailure(f"disconnect left session file for {name}")
        return result

    def open(self, url: str, name: str = "main", *, controller: str | None = None) -> dict[str, JSONValue]:
        return self.data(self.cli(name, ["open", url], controller=controller))

    def eval(self, expression: str, name: str = "main") -> JSONValue:
        data = self.data(self.cli(name, ["eval", expression]))
        if "result" not in data:
            raise ReplayFailure(f"eval returned no result: {data!r}")
        encoded = data["result"]
        if isinstance(encoded, str):
            try:
                return json.loads(encoded)
            except json.JSONDecodeError:
                return encoded
        return encoded

    def value(self, selector: str, name: str = "main") -> JSONValue:
        return self.data(self.cli(name, ["get", "value", selector]))["value"]

    def text_value(self, selector: str, name: str = "main") -> JSONValue:
        return self.data(self.cli(name, ["get", "text", selector]))["text"]

    def attr(self, selector: str, attribute: str, name: str = "main") -> JSONValue:
        return self.data(self.cli(name, ["get", "attr", selector, attribute]))["value"]

    def url(self, name: str = "main") -> str:
        value = self.data(self.cli(name, ["get", "url"]))["url"]
        if not isinstance(value, str):
            raise ReplayFailure(f"get url returned non-string value: {value!r}")
        return value

    def title(self, name: str = "main") -> str:
        value = self.data(self.cli(name, ["get", "title"]))["title"]
        if not isinstance(value, str):
            raise ReplayFailure(f"get title returned non-string value: {value!r}")
        return value

    def profile_args(self) -> list[str]:
        return [] if self.runner.config.profile is None else ["--profile", self.runner.config.profile]

    def cleanup(self) -> list[str]:
        errors: list[str] = []
        for name in list(self.homes):
            session = self.session_path(name)
            if not session.exists():
                continue
            try:
                self.disconnect(name)
            except Exception as error:  # cleanup is evidence, not a silent fallback
                errors.append(f"{name}: {error}")
        return errors

    @staticmethod
    def _json_string(value: JSONValue) -> JSONValue:
        if not isinstance(value, str):
            return value
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value

    @staticmethod
    def expect(condition: bool, message: str, observed: JSONValue | None = None) -> None:
        if not condition:
            if observed is None:
                raise ReplayFailure(message)
            raise ReplayFailure(f"{message}; observed={observed!r}")


class ReplayRunner:
    def __init__(self, config: ReplayConfig) -> None:
        self.config = config
        self.config.evidence_dir.mkdir(parents=True, exist_ok=True)
        self.home_root = self.config.evidence_dir / "homes" / str(time.time_ns())
        self.home_root.mkdir(parents=True, exist_ok=True)
        prefix = f"row7-replay-{config.mode}"
        self.transcript = ReplayTranscript(self.config.evidence_dir / f"{prefix}.jsonl")
        self.rows: list[RowOutcome] = []
        self.events: list[dict[str, JSONValue]] = []
        self.failure_count = 0

    @staticmethod
    def safe_name(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "row"

    def event(self, kind: str, **values: JSONValue) -> None:
        record: dict[str, JSONValue] = {"type": "event", "time": time.time(), "event": kind, **values}
        self.events.append(record)
        self.transcript.append(record)

    def row(self, name: str, function: Callable[[ScenarioContext], None]) -> RowOutcome:
        started_at = time.time()
        context = ScenarioContext(self, name)
        outcome = RowOutcome(name=name, passed=False, started_at=started_at, duration_seconds=0)
        try:
            function(context)
            outcome.passed = True
            outcome.details = context.details
        except Exception as error:
            outcome.error = str(error)
            outcome.traceback_text = traceback.format_exc()
            outcome.details = context.details
            self.failure_count += 1
        finally:
            cleanup_errors = context.cleanup()
            outcome.cleanup_errors.extend(cleanup_errors)
            if cleanup_errors:
                outcome.passed = False
                if outcome.error is None:
                    outcome.error = "cleanup failed"
                self.failure_count += 1
            outcome.command_sequences = list(context.command_sequences)
            outcome.duration_seconds = time.time() - started_at
            self.rows.append(outcome)
            self.event(
                "row-finished",
                row=name,
                passed=outcome.passed,
                durationSeconds=outcome.duration_seconds,
                cleanupErrors=cleanup_errors,
            )
        return outcome

    def fixture_root(self) -> str:
        # The clean fixture keeps `/` as the real login entry.  `/probe` is
        # the non-authenticated browser probe used by rows 225/227.
        return self.fixture_path("probe")

    def probe_url(self) -> str:
        return self.fixture_path("probe")
    def fixture_path(self, path: str) -> str:
        base = self.config.fixture_url if self.config.fixture_url.endswith("/") else self.config.fixture_url + "/"
        return urljoin(base, path.lstrip("/"))

    def target_url(self) -> str:
        return self.fixture_path("target")

    def run(self) -> dict[str, JSONValue]:
        self.event("replay-start", mode=self.config.mode, controller=self.config.controller, fixtureUrl=self.config.fixture_url)
        if self.config.mode == "normal":
            self.run_normal()
        else:
            self.run_idle()
        passed = bool(self.rows) and all(row.passed for row in self.rows) and self.failure_count == 0
        report: dict[str, JSONValue] = {
            "schemaVersion": 1,
            "kind": "clean-container-row7-replay",
            "mode": self.config.mode,
            "passed": passed,
            "status": "passed" if passed else "failed",
            "config": {
                "moat": str(self.config.moat),
                "controller": self.config.controller,
                "fixtureUrl": self.config.fixture_url,
                "evidenceDir": str(self.config.evidence_dir),
                "profile": self.config.profile,
                "idleTimeoutSeconds": self.config.idle_timeout_seconds,
                "idleWaitSeconds": self.config.idle_wait_seconds,
            },
            "rows": [row.record() for row in self.rows],
            "events": self.events,
            "transcript": str(self.transcript.path),
        }
        if not passed:
            report["failures"] = [row.record() for row in self.rows if not row.passed]
        return report

    def run_normal(self) -> None:
        self.row("225-numeric-tabs-label-no-mutation", self.row_225_tabs)
        self.row("225-batch-inline-stdin-held-stdin-success", self.row_225_batch_success)
        self.row("225-batch-failure-continue-and-bail", self.row_225_batch_failure)
        self.row("225-timeout-default-and-explicit", self.row_225_timeout)
        self.row("226-snapshot-roots-duplicates-depth", self.row_226_snapshot_roots)
        self.row("225-capability-limitations-classified", self.row_225_limitations)
        self.row("225-extended-local-unsupported-batch", self.row_225_extended)
        self.row("225-known-flags-and-old-local-flags", self.row_225_flags)
        self.row("225-startup-init-script-options", self.row_225_startup_scripts)
        self.row("226-type-snapshot-route-har", self.row_226_route_and_har)
        self.row("226-semantic-locators-and-actions", self.row_226_locators)
        self.row("227-pushstate-events-same-url-cross-origin", self.row_227_pushstate)
        self.row("227-router-main-world-no-fallback-events", self.row_227_router)
        self.row("227-init-script-nonretroactive-reload-navigation", self.row_227_init_script)
        self.row("227-tab-local-exact-remove", self.row_227_tab_scope)
        self.row("227-cross-session-isolation", self.row_227_session_scope)
        self.row("227-disconnect-recreate-deregister", self.row_227_recreate)
        self.row("227-tab-collision-close-replacement", self.row_227_tab_collision)
        self.row("228-documentation-cli-path", self.row_228_documentation)
        self.row("229-controller-override-positions-profile", self.row_229_positions)
        self.row("229-controller-env-config-fallback", self.row_229_fallbacks)
        self.row("229-controller-remote-command-batch-disconnect", self.row_229_remote_paths)
        self.row("229-use-help-and-no-persistence", self.row_229_use_and_persistence)
        self.row("229-controller-missing-empty-values", self.row_229_invalid_values)
        self.row("229-destroy-close-session-aliases", self.row_229_aliases)

    def run_idle(self) -> None:
        self.row("227-real-idle-expiry-new-session-no-old-script", self.row_227_idle)

    # ------------------------------------------------------------------
    # Issue 225: CLI synchronization and batch/timeout behavior
    # ------------------------------------------------------------------

    def row_225_tabs(self, context: ScenarioContext) -> None:
        context.init()
        initial_title = ""
        try:
            context.open(self.fixture_root())
            initial_title = context.title()
            listing = context.data(context.cli("main", ["tab", "list"]))["tabs"]
            context.expect(isinstance(listing, list) and [tab.get("index") for tab in listing] == [0], "initial tab list must contain numeric tab 0", listing)
            context.cli("main", ["tab", "new", self.fixture_root()])
            listing = context.data(context.cli("main", ["tab", "list"]))["tabs"]
            context.expect([tab.get("index") for tab in listing] == [0, 1], "tab new must create numeric tab 1", listing)
            text = context.text("main", ["tab", "list"])
            context.expect("0" in text.stdout and "1" in text.stdout, "text tab list must expose both numeric indices", text.stdout)
            context.cli("main", ["eval", 'document.title="tab one"'])
            context.cli("main", ["tab", "switch", "0"])
            context.expect(context.title() == initial_title, "switch 0 must return to original tab", context.title())
            context.cli("main", ["tab", "close", "1"])
            before_label = context.data(context.cli("main", ["tab", "list"]))["tabs"]
            rejected = context.cli("main", ["tab", "new", "--label", "docs"], expected_success=False)
            failure = context.failure(rejected)
            error = failure.get("error")
            context.expect(isinstance(error, str) and "label" in error.lower(), "tab label must fail with an explicit label error", failure)
            context.expect(context.data(context.cli("main", ["tab", "list"]))["tabs"] == before_label, "label failure must not create a tab")
            context.details.update({"initialTitle": initial_title, "tabsAfterLabelFailure": before_label})
        finally:
            pass

    def _batch_items(self, context: ScenarioContext, result: CommandResult, expected_count: int, expected_success: bool) -> list[dict[str, JSONValue]]:
        payload = result.parsed
        context.expect(isinstance(payload, dict) and payload.get("success") is expected_success, "batch envelope success flag mismatch", payload)
        data = payload.get("data") if isinstance(payload, dict) else None
        context.expect(isinstance(data, dict), "batch envelope missing data object", payload)
        items = data.get("results") if isinstance(data, dict) else None
        context.expect(isinstance(items, list) and len(items) == expected_count, "batch result count/order envelope mismatch", payload)
        return [item for item in items if isinstance(item, dict)]

    def row_225_batch_success(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        expected_title = context.title()
        inline = context.cli("main", ["batch", "get title", "get url"], stdin="")
        piped = context.cli("main", ["batch"], stdin=json.dumps([["get", "title"], ["get", "url"]]))
        held = context.cli("main", ["batch", "get title", "get url"], held_stdin=True, timeout=30)
        for result in (inline, piped, held):
            items = self._batch_items(context, result, 2, True)
            context.expect(all(item.get("success") is True for item in items), "successful batch items must be successful", items)
            context.expect(expected_title in json.dumps(items[0]) and self.fixture_root() in json.dumps(items[1]), "batch title/url order must be preserved", items)
        context.details["transports"] = ["inline", "stdin", "held-stdin"]

    def row_225_batch_failure(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        commands = [["get", "url"], ["not-a-moat-command"], ["eval", 'document.title="continued"']]
        rows: list[dict[str, JSONValue]] = []
        for transport in ("inline", "stdin"):
            for bail in (False, True):
                context.cli("main", ["eval", 'document.title="before"'])
                if transport == "inline":
                    args = [
                        "batch",
                        *(["--bail"] if bail else []),
                        "get url",
                        "not-a-moat-command",
                        "eval 'document.title=\"continued\"'",
                    ]
                    result = context.cli("main", args, expected_success=False)
                else:
                    result = context.cli(
                        "main",
                        ["batch", *(["--bail"] if bail else [])],
                        stdin=json.dumps(commands),
                        expected_success=False,
                    )
                items = self._batch_items(context, result, 2 if bail else 3, False)
                statuses = [item.get("success") for item in items]
                context.expect(statuses == ([True, False] if bail else [True, False, True]), "batch failure continuation/bail statuses mismatch", items)
                context.expect(isinstance(items[1].get("error"), str) and bool(items[1]["error"]), "batch failure item must preserve readable error", items)
                title = context.title()
                context.expect(title == ("before" if bail else "continued"), "batch bail/continue final browser effect mismatch", title)
                rows.append({"transport": transport, "bail": bail, "resultCount": len(items), "title": title})
        context.details["cases"] = rows

    def row_225_timeout(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        durations: list[float] = []
        for explicit in (False, True):
            args = ["wait", "--fn", "false"]
            if explicit:
                args.extend(["--timeout", "2000"])
            result = context.cli(
                "main",
                args,
                expected_success=False,
                extra_env={"AGENT_BROWSER_DEFAULT_TIMEOUT": "100"},
                timeout=15,
            )
            failure = context.failure(result)
            error = failure.get("error")
            context.expect(isinstance(error, str) and "timeout" in error.lower(), "wait must report a timeout failure", failure)
            durations.append(result.duration_seconds)
        context.expect(durations[1] >= 1.8 and durations[1] > durations[0] + 1.0, "explicit 2000ms timeout must outlive default 100ms timeout", durations)
        context.details["durationsSeconds"] = durations

    def row_225_limitations(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        commands = [
            ["read", "https://example.com/"],
            ["react", "tree"],
            ["react", "renders", "start"],
            ["react", "renders", "stop"],
            ["webmcp", "list"],
            ["vitals"],
            ["a11y"],
        ]
        errors: list[str] = []
        for args in commands:
            result = context.cli("main", args, expected_success=False)
            failure = context.failure(result)
            error = failure.get("error")
            context.expect(isinstance(error, str), "unsupported capability must return a structured error", failure)
            lowered = error.lower()
            context.expect("unknown command" not in lowered and any(word in lowered for word in ("unsupported", "not support", "not yet", "not available", "not implemented")), "unsupported capability must not be reported as unknown command", error)
            errors.append(error)
        help_result = context.text("main", ["tab", "--help"])
        help_text = help_result.stdout.lower()
        context.expect("index" in help_text and "label" in help_text, "tab help must describe index and label behavior", help_result.stdout)
        context.details["errors"] = errors

    def row_225_extended(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        unsupported = ["mcp", "doctor", "skills", "plugin", "plugins", "chat", "web-vitals"]
        for command in unsupported:
            result = context.cli("main", [command], expected_success=False)
            error = context.failure(result).get("error")
            context.expect(isinstance(error, str) and "unsupported_in_moat" in error, "local unsupported root must be classified", result.parsed)
        for transport in ("inline", "stdin"):
            if transport == "inline":
                result = context.cli("main", ["batch", "react tree", "get title"], expected_success=False)
            else:
                result = context.cli("main", ["batch"], stdin='[["react","tree"],["get","title"]]', expected_success=False)
            items = self._batch_items(context, result, 2, False)
            context.expect(isinstance(items[0].get("error"), str) and "unsupported_in_moat" in items[0]["error"], "batch unsupported item must preserve classified error", items)
            context.expect(items[1].get("success") is True and "Unknown command" not in json.dumps(result.parsed), "batch must continue with supported item", items)
        context.details["unsupportedCommands"] = unsupported

    def row_225_flags(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        before = context.data(context.cli("main", ["tab", "list"]))["tabs"]
        known = [["--restore=acceptance"], ["-v"], ["-q"]]
        results: list[dict[str, JSONValue]] = []
        for flags in known:
            result = context.cli("main", ["open", self.fixture_root(), *flags], expected_success=False)
            error = context.failure(result).get("error")
            context.expect(isinstance(error, str) and "unsupported_in_moat" in error, "known target flag must fail explicitly", result.parsed)
            results.append({"flags": flags, "error": error})
        old_flags = [
            ["--session", "ignored"],
            ["--session-name", "ignored"],
            ["--state", str(context.home() / "state.json")],
            ["--download-path", str(context.runner.config.evidence_dir)],
            ["--allowed-domains", "example.com"],
            ["--action-policy", str(context.home() / "policy.json")],
            ["--confirm-actions", "click"],
            ["--confirm-interactive"],
            ["--idle-timeout", "10s"],
            ["--no-auto-dialog"],
            ["--config", str(context.home() / "unsupported-config.json")],
            ["--debug"],
            ["--color-scheme", "dark"],
        ]
        for flags in old_flags:
            result = context.cli("main", ["open", self.fixture_root() + "must-not-navigate", *flags], expected_success=False)
            error = context.failure(result).get("error")
            context.expect(isinstance(error, str) and "unsupported_in_moat" in error, "old local flag must fail explicitly", result.parsed)
        after = context.data(context.cli("main", ["tab", "list"]))["tabs"]
        context.expect(after == before, "rejected local flags must not navigate or mutate tabs", {"before": before, "after": after})
        context.details["knownFlags"] = results
        context.details["oldFlagCount"] = len(old_flags)

    def row_225_startup_scripts(self, context: ScenarioContext) -> None:
        context.init()
        script = context.runner.config.evidence_dir / "startup-script.js"
        script.write_text("window.__row7_startup = true;\n", encoding="utf-8")
        context.open(self.fixture_root())
        before = context.data(context.cli("main", ["tab", "list"]))["tabs"]
        for args, extra in (
            (["--init-script", str(script), "open", self.fixture_root()], {}),
            (["open", self.fixture_root()], {"AGENT_BROWSER_INIT_SCRIPTS": str(script)}),
        ):
            result = context.cli("main", args, expected_success=False, extra_env=extra)
            error = context.failure(result).get("error")
            context.expect(isinstance(error, str) and "init" in error.lower(), "startup init-script option must be explicitly rejected", result.parsed)
        after = context.data(context.cli("main", ["tab", "list"]))["tabs"]
        context.expect(after == before, "startup init-script rejection must not navigate", {"before": before, "after": after})
        context.details["script"] = str(script)

    # ------------------------------------------------------------------
    # Issue 226: parameter and remote browser behavior
    # ------------------------------------------------------------------

    def _eval_json(self, context: ScenarioContext, expression: str, name: str = "main") -> JSONValue:
        value = context.eval(expression, name)
        return context._json_string(value)
    def _install_226_dom(self, context: ScenarioContext) -> None:
        html = (
            "<!doctype html><title>Probe</title><body>"
            "<h1>Probe</h1><label for='input'>Name</label><input id='input' value='old'>"
            "<div id='editable' contenteditable='true'>Editable</div>"
            "<input id='alt' alt='Alt'><input id='title' title='Title'>"
            "<label for='notes'>Notes</label><textarea id='notes' placeholder='Notes' data-testid='notes'>Body</textarea>"
            "<label for='check'>Check</label><input id='check' type='checkbox' data-testid='check'>"
            "<a href='/target'>Target</a></body>"
        )
        expression = (
            "document.open();document.write("
            + json.dumps(html)
            + ");document.close();"
            "document.body.dataset.inputTimes='[]';"
            "document.querySelector('#input').addEventListener('input',e=>{"
            "const events=JSON.parse(document.body.dataset.inputTimes);"
            "events.push({time:performance.now(),value:e.target.value});"
            "document.body.dataset.inputTimes=JSON.stringify(events);});"
            "document.querySelector('#notes').addEventListener('mouseenter',()=>document.body.dataset.hovered='yes');"
            "true"
        )
        context.expect(context.eval(expression) is True, "226 DOM probe installation must complete")

    def _type_and_check_delay(self, context: ScenarioContext, target: str, value: str, *, check_selector: str | None = None) -> list[dict[str, JSONValue]]:
        check = check_selector or target
        context.cli("main", ["type", target, value, "--clear", "--delay", "300"])
        context.expect(context.value(check) == value, "type clear/delay must produce requested final value", context.value(check))
        events = self._eval_json(context, "document.body.dataset.inputTimes")
        context.expect(isinstance(events, list), "fixture inputTimes must be JSON event list", events)
        recent = [event for event in events if isinstance(event, dict) and event.get("value")]
        context.expect(len(recent) >= 2, "typing must produce at least two nonempty input events", recent)
        delta = float(recent[-1].get("time", 0)) - float(recent[-2].get("time", 0))
        context.expect(delta >= 300, "delay must be at least 300ms between input events", {"events": recent, "deltaMs": delta})
        return recent[-2:]

    def _eval_text(self, context: ScenarioContext, expression: str, name: str = "main") -> str:
        value = context.eval(expression, name)
        context.expect(isinstance(value, str), "eval must return text", value)
        return value

    def row_226_route_and_har(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        self._install_226_dom(context)
        selector_events = self._type_and_check_delay(context, "#input", "ab")
        snapshot = context.data(context.cli("main", ["snapshot", "-i", "--urls"]))["snapshot"]
        context.expect(isinstance(snapshot, str), "snapshot must return text", snapshot)
        ref_match = re.search(r"(@e\d+)\s+textbox\s+\"Name\"", snapshot)
        context.expect(ref_match is not None, "snapshot must expose Name textbox reference", snapshot)
        ref = ref_match.group(1) if ref_match else ""
        ref_events = self._type_and_check_delay(context, ref, "xy", check_selector="#input")
        context.expect(self.target_url() in snapshot, "snapshot --urls must show absolute target URL", snapshot)
        rooted = context.data(context.cli("main", ["snapshot", "-i", "--urls", "-s", "body"]))["snapshot"]
        context.expect(self.target_url() in rooted, "rooted snapshot must retain absolute target URL", rooted)

        context.cli("main", ["network", "route", "**/json", "--body", '{"mock":true}', "--resource-type", "XHR, Fetch"])
        mocked_fetch = self._eval_text(context, 'fetch("/json").then(r=>r.text())')
        context.expect(mocked_fetch == '{"mock":true}', "resource-filtered route must mock fetch", mocked_fetch)
        context.open(self.fixture_path("/json"))
        document_body = self._eval_text(context, "document.body.innerText")
        context.expect(document_body == '{"original":true}', "resource-filtered route must not mock document navigation", document_body)
        context.cli("main", ["network", "unroute", "**/json"])
        context.cli("main", ["network", "route", "**/json", "--abort", "--resource-type", "xhr"])
        xhr = 'new Promise(resolve=>{const x=new XMLHttpRequest();x.open("GET","/json");x.onload=()=>resolve(x.responseText);x.onerror=()=>resolve("blocked");x.send();})'
        xhr_blocked = self._eval_text(context, xhr)
        context.expect(xhr_blocked == "blocked", "xhr abort route must block matching XHR", xhr_blocked)
        fetch_unblocked = self._eval_text(context, 'fetch("/json").then(r=>r.text())')
        context.expect(fetch_unblocked == '{"original":true}', "xhr-only abort must not block fetch", fetch_unblocked)
        context.cli("main", ["network", "unroute", "**/json"])
        xhr_restored = self._eval_text(context, xhr)
        context.expect(xhr_restored == '{"original":true}', "unroute must restore XHR", xhr_restored)
        context.cli("main", ["network", "route", "**/json", "--abort", "--body", "ignored", "--resource-type", "XHR"])
        xhr_body_abort = self._eval_text(context, xhr)
        context.expect(xhr_body_abort == "blocked", "abort must take precedence over response body", xhr_body_abort)
        context.cli("main", ["network", "unroute", "**/json"])

        har_results: dict[str, JSONValue] = {}
        for mode in ("text", "all", "none", "default"):
            start_args = ["network", "har", "start"] if mode == "default" else ["network", "har", "start", "--content", mode]
            context.cli("main", start_args)
            probe = self._eval_json(context, 'Promise.all([fetch("/json").then(r=>r.text()),fetch("/binary").then(r=>r.arrayBuffer())]).then(()=>true)')
            context.expect(probe is True, "HAR probe must complete both HTTP responses", probe)
            path = context.runner.config.evidence_dir / "har" / f"{mode}.har"
            path.parent.mkdir(parents=True, exist_ok=True)
            context.cli("main", ["network", "har", "stop", str(path)])
            context.expect(path.exists(), "HAR stop must write requested artifact", str(path))
            har = json.loads(path.read_text(encoding="utf-8"))
            entries = har.get("log", {}).get("entries", [])
            responses: dict[str, dict[str, JSONValue]] = {}
            for entry in entries:
                request = entry.get("request", {}) if isinstance(entry, dict) else {}
                response = entry.get("response", {}) if isinstance(entry, dict) else {}
                request_url = request.get("url") if isinstance(request, dict) else None
                if isinstance(request_url, str) and isinstance(response, dict):
                    responses[request_url.rsplit("/", 1)[-1]] = response
            context.expect({"json", "binary"}.issubset(responses), "HAR must record both JSON and binary requests", responses)
            json_response = responses["json"]
            binary_response = responses["binary"]
            context.expect(json_response.get("status") == binary_response.get("status") == 200, "HAR statuses must be 200", responses)
            json_content = json_response.get("content", {})
            binary_content = binary_response.get("content", {})
            context.expect(isinstance(json_content, dict) and isinstance(binary_content, dict), "HAR responses must contain content objects", responses)
            context.expect(str(json_content.get("mimeType", "")).startswith("application/json") and str(binary_content.get("mimeType", "")).startswith("application/octet-stream"), "HAR MIME types must preserve fixture types", responses)
            context.expect(json_content.get("size") == 17 and binary_content.get("size") == 4, "HAR response sizes must preserve fixture bytes", responses)
            if mode == "none":
                context.expect("text" not in json_content and "text" not in binary_content, "HAR none must omit response bodies", responses)
            else:
                context.expect(json_content.get("text") == '{"original":true}', "HAR text/all must preserve JSON body", responses)
                if mode == "all":
                    encoded = binary_content.get("text")
                    context.expect(binary_content.get("encoding") == "base64" and isinstance(encoded, str) and list(base64.b64decode(encoded)) == [0, 255, 128, 254], "HAR all must preserve binary bytes", responses)
                else:
                    context.expect("text" not in binary_content, "HAR text/default must omit binary body", responses)
            har_results[mode] = {"json": json_response, "binary": binary_response}
        context.details.update({"selectorEvents": selector_events, "refEvents": ref_events, "snapshot": snapshot, "rootedSnapshot": rooted, "har": har_results})

    def row_226_snapshot_roots(self, context: ScenarioContext) -> None:
        context.init()
        # bare sections flatten in the AX tree, so the depth probe nests under a heading.
        duplicate_html = (
            "<!doctype html><title>Snapshot</title><body>"
            "<section id='links'><a href='/protocol/first'>Same</a>"
            "<a href='/protocol/second'>Same</a></section>"
            "<h2>Deep <a href='/protocol/first'>Nested</a></h2>"
            "<a href='/protocol/second'>Outer</a></body>"
        )
        context.open(self.fixture_root())
        context.expect(
            context.eval(
                "document.open();document.write("
                + json.dumps(duplicate_html)
                + ");document.close();true"
            )
            is True,
            "duplicate-link DOM setup must complete",
        )
        duplicate_snapshot = context.data(
            context.cli("main", ["snapshot", "-i", "--urls", "-s", "#links"])
        )["snapshot"]
        first_url = self.fixture_path("protocol/first")
        second_url = self.fixture_path("protocol/second")
        context.expect(
            isinstance(duplicate_snapshot, str)
            and first_url in duplicate_snapshot
            and second_url in duplicate_snapshot,
            "rooted snapshot must expose absolute URLs for duplicate links",
            duplicate_snapshot,
        )
        duplicate_refs = re.findall(r"@e\d+", duplicate_snapshot)
        context.expect(len(duplicate_refs) >= 2, "duplicate link snapshot must preserve both references", duplicate_snapshot)
        context.cli("main", ["click", duplicate_refs[1]])
        context.expect(context.url() == second_url, "duplicate link reference must select the requested target", context.url())

        context.open(self.fixture_root())
        context.expect(
            context.eval(
                "document.open();document.write("
                + json.dumps(duplicate_html)
                + ");document.close();true"
            )
            is True,
            "depth DOM setup must complete",
        )
        depth_snapshot = context.data(
            context.cli("main", ["snapshot", "-i", "--urls", "-d", "0"])
        )["snapshot"]
        context.expect(
            isinstance(depth_snapshot, str)
            and first_url not in depth_snapshot
            and second_url in depth_snapshot,
            "depth-zero snapshot must hide nested URL and retain outer URL",
            depth_snapshot,
        )
        depth_ref = re.search(r"@e\d+", depth_snapshot)
        context.expect(depth_ref is not None, "depth-zero snapshot must expose outer link reference", depth_snapshot)
        context.cli("main", ["click", depth_ref.group(0) if depth_ref else ""])
        context.expect(context.url() == second_url, "depth-zero outer link reference must navigate to outer URL", context.url())

        context.open(self.fixture_root())
        self._install_226_dom(context)
        rooted_link_snapshot = context.data(
            context.cli("main", ["snapshot", "-i", "--urls", "-s", "a"])
        )["snapshot"]
        context.expect(self.target_url() in rooted_link_snapshot, "selector-rooted link snapshot must expose target URL", rooted_link_snapshot)
        link_ref = re.search(r"@e\d+", rooted_link_snapshot)
        context.expect(link_ref is not None, "selector-rooted link snapshot must expose reference", rooted_link_snapshot)
        context.cli("main", ["click", link_ref.group(0) if link_ref else ""])
        context.expect(context.url() == self.target_url(), "selector-rooted link reference must navigate to target", context.url())

        context.open(self.fixture_root())
        self._install_226_dom(context)
        plain_link_snapshot = context.data(
            context.cli("main", ["snapshot", "-i", "-s", "a"])
        )["snapshot"]
        plain_link_ref = re.search(r"@e\d+", plain_link_snapshot if isinstance(plain_link_snapshot, str) else "")
        context.expect(plain_link_ref is not None, "plain selector-rooted snapshot must expose reference", plain_link_snapshot)
        rooted_by_ref = context.data(
            context.cli("main", ["snapshot", "-i", "--urls", "-s", plain_link_ref.group(0) if plain_link_ref else ""])
        )["snapshot"]
        context.expect(self.target_url() in rooted_by_ref, "reference-rooted snapshot must expose target URL", rooted_by_ref)

        context.open(self.fixture_root())
        self._install_226_dom(context)
        whole_snapshot = context.data(context.cli("main", ["snapshot", "-i"]))["snapshot"]
        anonymous = re.search(r"(@e\d+)\s+textbox\s*$", whole_snapshot, re.MULTILINE)
        context.expect(anonymous is not None, "whole snapshot must expose anonymous textbox reference", whole_snapshot)
        context.cli("main", ["type", anonymous.group(1) if anonymous else "", "anonymous", "--clear"])
        context.expect(context.value("#alt") == "anonymous" and context.value("#input") == "old", "anonymous reference must target alt input, not Name input", {"alt": context.value("#alt"), "input": context.value("#input")})
        context.details.update(
            {
                "duplicateSnapshot": duplicate_snapshot,
                "depthSnapshot": depth_snapshot,
                "rootedLinkSnapshot": rooted_link_snapshot,
                "plainRootedLinkSnapshot": plain_link_snapshot,
                "referenceRootedLinkSnapshot": rooted_by_ref,
                "wholeSnapshot": whole_snapshot,
            }
        )

    def row_226_locators(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        self._install_226_dom(context)
        context.cli("main", ["find", "text", "Editable", "fill", "hello"])
        context.cli("main", ["find", "alt", "Alt", "fill", "alternate"])
        context.cli("main", ["find", "title", "Title", "fill", "titled"])
        context.expect(context.text_value("#editable") == "hello", "find text fill must update editable text")
        context.expect(context.value("#alt") == "alternate", "find alt fill must update input value")
        context.expect(context.value("#title") == "titled", "find title fill must update input value")
        checks = [
            (["role", "heading"], "Probe"),
            (["text", "Probe", "text", "--exact"], "Probe"),
            (["label", "Notes", "text"], "Body"),
            (["placeholder", "Notes", "text"], "Body"),
            (["testid", "notes", "text"], "Body"),
            (["alt", "Alt", "text"], ""),
            (["title", "Title", "text"], ""),
        ]
        observed: list[dict[str, JSONValue]] = []
        for locator, expected in checks:
            args = ["find", *locator] if "text" in locator[2:] else ["find", *locator, "text"]
            value = context.data(context.cli("main", args)).get("text")
            context.expect(value == expected, "semantic locator text result mismatch", {"args": args, "expected": expected, "actual": value})
            observed.append({"args": args, "value": value})
        context.cli("main", ["find", "testid", "check", "check"])
        context.expect(self._eval_json(context, 'document.querySelector("#check").checked') is True, "find check must check checkbox")
        checked_result = context.data(context.cli("main", ["is", "checked", "#check"]))
        context.expect(checked_result.get("checked") is True, "is checked must report true after check", checked_result)
        context.cli("main", ["find", "label", "Check", "uncheck"])
        context.expect(self._eval_json(context, 'document.querySelector("#check").checked') is False, "find uncheck must clear checkbox")
        unchecked_result = context.data(context.cli("main", ["is", "checked", "#check"]))
        context.expect(unchecked_result.get("checked") is False, "is checked must report false after uncheck", unchecked_result)
        context.cli("main", ["find", "placeholder", "Notes", "hover"])
        context.expect(self._eval_json(context, "document.body.dataset.hovered") == "yes", "find hover must dispatch mouseenter", self._eval_json(context, "document.body.dataset.hovered"))
        context.cli("main", ["fill", "#input", ""])
        context.cli("main", ["find", "label", "Name", "type", "suffix"])
        context.expect(context.value("#input") == "suffix", "find type must preserve existing behavior")
        before_active = self._eval_json(context, "document.activeElement.id")
        query = context.data(context.cli("main", ["find", "role", "heading", "--name", "Probe"]))
        context.expect(query.get("found") is True and query.get("count") == 1, "find no-action query must report one match", query)
        context.expect(self._eval_json(context, "document.activeElement.id") == before_active, "find no-action query must not act", {"before": before_active, "after": self._eval_json(context, "document.activeElement.id")})
        failure = context.cli("main", ["find", "title", "Title", "fill"], expected_success=False)
        context.expect(context.failure(failure).get("success") is False, "missing locator value must be a parameter failure", failure.parsed)
        context.expect(context.value("#title") == "titled", "missing locator value must not partially mutate element")
        screenshot = context.runner.config.evidence_dir / "226-final.png"
        context.cli("main", ["screenshot", str(screenshot)])
        context.expect(screenshot.exists(), "DOM locator row must save final screenshot", str(screenshot))
        context.details.update({"locatorResults": observed, "screenshot": str(screenshot)})

    # ------------------------------------------------------------------
    # Issue 227: pushstate and per-tab/session init scripts
    # ------------------------------------------------------------------

    def row_227_pushstate(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        result = context.data(context.cli("main", ["pushstate", "/changed"]))
        context.expect(context.url() == self.fixture_path("changed"), "pushstate must update URL on same origin", context.url())
        context.expect(context.attr("body", "data-marker") == "kept", "pushstate must preserve document", context.attr("body", "data-marker"))
        context.expect(context.attr("body", "data-events") == "popstate,navigate,", "fallback pushstate must dispatch both events", context.attr("body", "data-events"))
        context.cli("main", ["pushstate", "/changed"])
        context.expect(context.attr("body", "data-events") == "popstate,navigate,", "same URL pushstate must be a no-op", context.attr("body", "data-events"))
        failed = context.cli("main", ["pushstate", "https://example.org/cross-origin-rejected"], expected_success=False)
        context.expect(context.url() == self.fixture_path("changed") and context.attr("body", "data-marker") == "kept", "cross-origin pushstate failure must preserve document", {"url": context.url(), "marker": context.attr("body", "data-marker")})
        context.details.update({"result": result, "crossOriginFailure": failed.parsed})

    def row_227_router(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_path("router"))
        context.cli("main", ["pushstate", "/routed"])
        context.expect(context.text_value("#route") == "router:/routed", "pushstate must call page router in main world", context.text_value("#route"))
        context.expect(context.attr("body", "data-events") == "", "router push must not dispatch fallback events", context.attr("body", "data-events"))
        context.expect(context.attr("body", "data-marker") == "kept", "router push must preserve document", context.attr("body", "data-marker"))
        screenshot = context.runner.config.evidence_dir / "227-router.png"
        context.cli("main", ["screenshot", str(screenshot)])
        context.expect(screenshot.exists(), "router row must save screenshot", str(screenshot))
        context.details["screenshot"] = str(screenshot)

    def row_227_init_script(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        identifier_result = context.data(context.cli("main", ["addinitscript", "window.__moat_init = 42"]))
        identifier = identifier_result.get("identifier")
        context.expect(identifier_result.get("added") is True and isinstance(identifier, str) and bool(identifier), "addinitscript must return nonempty identifier", identifier_result)
        context.expect(context.attr("body", "data-init") == "undefined", "addinitscript must not be retroactive", context.attr("body", "data-init"))
        context.cli("main", ["reload"])
        context.expect(context.attr("body", "data-init") == "42", "addinitscript must run after reload", context.attr("body", "data-init"))
        context.open(self.fixture_root())
        context.expect(context.attr("body", "data-init") == "42", "addinitscript must run after navigation", context.attr("body", "data-init"))
        context.details["identifier"] = identifier

    def row_227_tab_scope(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        identifier = context.data(context.cli("main", ["addinitscript", "window.__moat_init = 42"]))["identifier"]
        context.cli("main", ["reload"])
        context.expect(context.attr("body", "data-init") == "42", "owner tab reload must execute init script", context.attr("body", "data-init"))
        context.cli("main", ["tab", "new", self.fixture_root()])
        context.expect(context.attr("body", "data-init") == "undefined", "new tab must not inherit init script", context.attr("body", "data-init"))
        wrong_tab = context.cli("main", ["removeinitscript", identifier], expected_success=False)
        self._assert_init_scope_rejection(context, wrong_tab, "wrong-tab init-script removal must be rejected by ownership")
        context.cli("main", ["tab", "switch", "0"])
        removed = context.data(context.cli("main", ["removeinitscript", identifier]))
        context.expect(removed.get("removed") is True and removed.get("identifier") == identifier, "owner tab must remove init script", removed)
        context.expect(context.attr("body", "data-init") == "42", "remove must not rollback existing document", context.attr("body", "data-init"))
        context.cli("main", ["reload"])
        context.expect(context.attr("body", "data-init") == "undefined", "removed init script must not run on later reload", context.attr("body", "data-init"))
        removed_again = context.cli("main", ["removeinitscript", identifier], expected_success=False)
        self._assert_init_scope_rejection(context, removed_again, "second init-script removal must be rejected")
        context.cli("main", ["tab", "close", "1"])

    def row_227_session_scope(self, context: ScenarioContext) -> None:
        context.init("a")
        context.init("b")
        context.open(self.fixture_root(), "a")
        context.open(self.fixture_root(), "b")
        a_id = context.data(context.cli("a", ["addinitscript", "window.__moat_init = 41"]))["identifier"]
        b_id = context.data(context.cli("b", ["addinitscript", "window.__moat_init = 42"]))["identifier"]
        context.expect(isinstance(a_id, str) and isinstance(b_id, str) and a_id != b_id, "independent sessions must return distinct script handles", {"a": a_id, "b": b_id})
        context.cli("a", ["reload"])
        context.cli("b", ["reload"])
        context.expect(context.attr("body", "data-init", "a") == "41" and context.attr("body", "data-init", "b") == "42", "session scripts must remain isolated")
        wrong_session = context.cli("b", ["removeinitscript", a_id], expected_success=False)
        self._assert_init_scope_rejection(context, wrong_session, "cross-session init-script removal must be rejected")
        context.cli("a", ["reload"])
        context.cli("b", ["reload"])
        context.expect(context.attr("body", "data-init", "a") == "41" and context.attr("body", "data-init", "b") == "42", "cross-session removal must not affect either owner")
        context.details.update({"aIdentifier": a_id, "bIdentifier": b_id})

    def row_227_recreate(self, context: ScenarioContext) -> None:
        context.init("a")
        context.init("b")
        context.open(self.fixture_root(), "a")
        context.open(self.fixture_root(), "b")
        old_session = context.sessions["a"]
        a_id = context.data(context.cli("a", ["addinitscript", "window.__moat_init = 41"]))["identifier"]
        b_id = context.data(context.cli("b", ["addinitscript", "window.__moat_init = 42"]))["identifier"]
        context.disconnect("a")
        new_session = context.init("a")
        context.expect(new_session != old_session, "recreated session must have a new session id", {"old": old_session, "new": new_session})
        context.open(self.fixture_root(), "a")
        context.expect(context.attr("body", "data-init", "a") == "undefined", "recreated session must not inherit old script", context.attr("body", "data-init", "a"))
        old_handle = context.cli("a", ["removeinitscript", a_id], expected_success=False)
        self._assert_init_scope_rejection(context, old_handle, "deregistered session init-script handle must be rejected")
        context.cli("b", ["reload"])
        context.expect(context.attr("body", "data-init", "b") == "42", "deregistering one session must preserve other session", context.attr("body", "data-init", "b"))
    def row_227_tab_collision(self, context: ScenarioContext) -> None:
        context.init("a")
        context.init("b")
        context.open(self.fixture_root(), "a")
        context.open(self.fixture_root(), "b")
        b_id = context.data(context.cli("b", ["addinitscript", "window.__moat_init = 42"]))["identifier"]
        context.cli("b", ["reload"])
        context.expect(context.attr("body", "data-init", "b") == "42", "session B setup must execute its init script", context.attr("body", "data-init", "b"))
        context.cli("a", ["tab", "new", self.fixture_root()])
        tab_id = context.data(context.cli("a", ["addinitscript", "window.__moat_init = 43"]))["identifier"]
        context.cli("a", ["tab", "switch", "0"])
        other_id = context.data(context.cli("a", ["addinitscript", "window.__moat_init = 44"]))["identifier"]
        context.expect(tab_id != other_id, "same-session tab scripts must have distinct handles", {"tab": tab_id, "other": other_id})
        wrong_tab = context.cli("a", ["removeinitscript", tab_id], expected_success=False)
        self._assert_init_scope_rejection(context, wrong_tab, "same-session wrong-tab init-script removal must be rejected")
        context.cli("a", ["reload"])
        context.expect(context.attr("body", "data-init", "a") == "44", "tab 0 must retain its own script", context.attr("body", "data-init", "a"))
        context.cli("a", ["tab", "switch", "1"])
        context.cli("a", ["reload"])
        context.expect(context.attr("body", "data-init", "a") == "43", "tab 1 must retain its own script", context.attr("body", "data-init", "a"))
        context.cli("a", ["tab", "close"])
        context.cli("a", ["tab", "new", self.fixture_root()])
        context.expect(context.attr("body", "data-init", "a") == "undefined", "replacement tab must not inherit closed tab script", context.attr("body", "data-init", "a"))
        closed_handle = context.cli("a", ["removeinitscript", tab_id], expected_success=False)
        self._assert_init_scope_rejection(context, closed_handle, "closed-tab init-script handle must be rejected")
        invalid_handle = context.cli("a", ["removeinitscript", "acceptance-invalid-identifier"], expected_success=False)
        self._assert_init_scope_rejection(context, invalid_handle, "invalid init-script handle must be rejected")
        context.cli("a", ["tab", "switch", "0"])
        context.cli("a", ["reload"])
        context.expect(context.attr("body", "data-init", "a") == "44", "surviving tab script must remain after close", context.attr("body", "data-init", "a"))
        context.cli("b", ["reload"])
        context.expect(context.attr("body", "data-init", "b") == "42", "other session must remain isolated", context.attr("body", "data-init", "b"))
        context.details.update({"closedIdentifier": tab_id, "survivingIdentifier": other_id, "bIdentifier": b_id})

    def row_227_idle(self, context: ScenarioContext) -> None:
        context.init()
        context.open(self.fixture_root())
        identifier = context.data(context.cli("main", ["addinitscript", "window.__moat_init = 45"]))["identifier"]
        context.cli("main", ["reload"])
        context.expect(context.attr("body", "data-init") == "45", "idle scenario setup must install script before wait", context.attr("body", "data-init"))
        wait_started = time.monotonic()
        self.event("idle-start", row=context.row, session=context.sessions.get("main"), identifier=identifier, waitSeconds=self.config.idle_wait_seconds, expectedIdleTimeoutSeconds=self.config.idle_timeout_seconds)
        time.sleep(self.config.idle_wait_seconds)
        elapsed = time.monotonic() - wait_started
        expired = context.cli("main", ["get", "url"], expected_success=False)
        expired_failure = context.failure(expired)
        expired_error = expired_failure.get("error")
        context.expect(
            isinstance(expired_error, str)
            and (
                expired_failure.get("errorType") in {"session_error", "no_session"}
                or "session expired" in expired_error.lower()
                or "session not found" in expired_error.lower()
            ),
            "idle command must fail with session-expired/not-found domain error",
            expired_failure,
        )
        old_session = context.sessions.get("main")
        context.details.update({"expiredSession": old_session, "identifier": identifier, "waitSeconds": elapsed, "expiryFailure": expired_failure})
        # The harness restarts the controller before invoking this mode.  A
        # successful init now proves that the old handle was not reused.
        replacement = context.init()
        context.expect(replacement != old_session, "idle expiry must force a new session id", {"old": old_session, "new": replacement})
        context.open(self.fixture_root())
        context.expect(context.attr("body", "data-init") == "undefined", "new idle session must not inherit old init script", context.attr("body", "data-init"))
        old_handle = context.cli("main", ["removeinitscript", identifier], expected_success=False)
        self._assert_init_scope_rejection(context, old_handle, "expired-session init-script handle must be rejected")
        context.details["replacementSession"] = replacement

    def _assert_init_scope_rejection(self, context: ScenarioContext, result: CommandResult, description: str) -> None:
        failure = context.failure(result)
        error = failure.get("error")
        error_type = failure.get("errorType")
        context.expect(
            isinstance(error, str)
            and ("owned" in error.lower() or "active tab" in error.lower() or "session" in error.lower())
            and error_type in {"command_failed", "session_error"},
            description,
            failure,
        )

    def row_228_documentation(self, context: ScenarioContext) -> None:
        help_output = context.text("main", ["--help"])
        connect_help = context.text("main", ["connect", "--help"])
        context.expect("moat - remote Chromium" in help_output.stdout, "documentation path must expose moat help output", help_output.stdout)
        context.expect("--controller" in connect_help.stdout, "connect help must expose controller option", connect_help.stdout)
        connect_args = ["connect", *context.profile_args()]
        connected = context.cli("main", connect_args)
        connected_data = context.data(connected)
        connected_session = connected_data.get("sessionId")
        context.expect(isinstance(connected_session, str) and bool(connected_session), "documented connect path must register a session", connected_data)
        context.sessions["main"] = connected_session if isinstance(connected_session, str) else ""
        context.expect(
            context.session_path("main").exists()
            and context.session_path("main").read_text(encoding="utf-8") == context.sessions["main"],
            "documented connect path must persist its session",
        )
        context.open(self.fixture_root())
        context.cli("main", ["eval", 'document.title = "Moat documentation check"'])
        title_text = context.text("main", ["get", "title"])
        url_text = context.text("main", ["get", "url"])
        context.expect("Moat documentation check" in title_text.stdout, "documentation path text gettitle must expose the page title", title_text.stdout)
        context.expect(self.fixture_root() in url_text.stdout, "documentation path text geturl must expose the exact fixture URL", url_text.stdout)
        context.disconnect()
        status = context.cli("main", ["status"], expected_success=False)
        context.expect(status.exit_code == 77, "status after disconnect must use no-session exit", status.record())
        status_failure = context.failure(status)
        context.expect(status_failure.get("success") is False, "status after disconnect must be a structured failure", status_failure)
        context.expect(status_failure.get("errorType") == "no_session", "status after disconnect must report no_session", status_failure)
        context.details.update({
            "titleText": title_text.stdout,
            "urlText": url_text.stdout,
            "status": status_failure,
        })

    # ------------------------------------------------------------------
    # Issue 229: explicit controller override and non-persistence
    # ------------------------------------------------------------------

    def _new_observer(self) -> DeadControllerObserver:
        observer = DeadControllerObserver()
        observer.start()
        self.event("wrong-controller-observer-start", url=observer.url)
        return observer

    def _assert_no_observer_connection(self, observer: DeadControllerObserver, message: str) -> None:
        time.sleep(0.1)
        if observer.connections:
            raise ReplayFailure(f"{message}; observed={observer.record()!r}")

    def _assert_observer_connection(self, observer: DeadControllerObserver, message: str) -> None:
        deadline = time.monotonic() + 2
        while not observer.connections and time.monotonic() < deadline:
            time.sleep(0.05)
        if not observer.connections:
            raise ReplayFailure(f"{message}; observed={observer.record()!r}")


    def row_229_positions(self, context: ScenarioContext) -> None:
        observer = self._new_observer()
        try:
            context.write_config("before", observer.url)
            # The flag before the command must override dead config and env.
            context.init(
                "before",
                controller=self.config.controller,
                controller_env=observer.url,
                before_command=True,
            )
            context.cli("before", ["disconnect", "--controller", self.config.controller], controller=observer.url)
            context.write_config("after", observer.url)
            # The flag after the command must override dead config and env;
            # use the real connect spelling and profile forwarding as well.
            connect_args = ["connect", "--controller", self.config.controller]
            connect_args.extend(context.profile_args())
            connected = context.cli("after", connect_args, controller=observer.url)
            connected_data = context.data(connected)
            connected_session = connected_data.get("sessionId")
            context.expect(isinstance(connected_session, str) and bool(connected_session), "connect override must register a session", connected_data)
            context.sessions["after"] = connected_session if isinstance(connected_session, str) else ""
            session_file = context.session_path("after")
            context.expect(session_file.exists() and session_file.read_text(encoding="utf-8") == connected_session, "connect override must persist selected session")
            context.cli("after", ["disconnect", "--controller", self.config.controller], controller=observer.url)
            context.sessions.pop("after", None)
            context.expect(not session_file.exists(), "connect alias cleanup must clear session")
            self._assert_no_observer_connection(observer, "controller override position used wrong endpoint")
            context.details["observer"] = observer.record()
        finally:
            observer.stop()

    def row_229_fallbacks(self, context: ScenarioContext) -> None:
        observer = self._new_observer()
        try:
            # A nonempty environment endpoint outranks the dead config.
            context.write_config("env", observer.url)
            context.init("env", controller_env=self.config.controller)
            context.cli("env", ["disconnect"], controller=self.config.controller)
            self._assert_no_observer_connection(observer, "nonempty MOAT_CONTROLLER must outrank dead config")

            # With the environment omitted, the configured endpoint is used.
            context.write_config("config", self.config.controller)
            context.init("config", omit_controller_env=True)
            context.cli("config", ["disconnect"], omit_controller_env=True)

            # An explicitly empty environment value falls back to config.
            context.write_config("empty-env", self.config.controller)
            context.init(
                "empty-env",
                omit_controller_env=True,
                extra_env={"MOAT_CONTROLLER": ""},
            )
            context.cli(
                "empty-env",
                ["disconnect"],
                omit_controller_env=True,
                extra_env={"MOAT_CONTROLLER": ""},
            )
            self._assert_no_observer_connection(observer, "env/config fallback contacted wrong observer")
            context.details["observer"] = observer.record()
        finally:
            observer.stop()
    def row_229_remote_paths(self, context: ScenarioContext) -> None:
        observer = self._new_observer()
        try:
            context.write_config("remote", observer.url)
            context.init("remote", controller=self.config.controller, controller_env=observer.url)
            context.cli(
                "remote",
                ["open", "about:blank", "--controller", self.config.controller],
                controller=observer.url,
            )
            batch = context.cli(
                "remote",
                ["batch", "--controller", self.config.controller],
                stdin='[["get","url"]]',
                controller=observer.url,
            )
            items = self._batch_items(context, batch, 1, True)
            context.expect("about:blank" in json.dumps(items), "batch controller override must return remote URL", items)
            context.cli(
                "remote",
                ["disconnect", "--controller", self.config.controller],
                controller=observer.url,
            )
            context.sessions.pop("remote", None)
            context.expect(not context.session_path("remote").exists(), "disconnect override must clear session file")
            self._assert_no_observer_connection(observer, "remote command override contacted wrong endpoint")
            context.details["observer"] = observer.record()
        finally:
            observer.stop()

    def row_229_use_and_persistence(self, context: ScenarioContext) -> None:
        observer = self._new_observer()
        try:
            context.write_config("main", observer.url)
            context.init("main", controller=self.config.controller, controller_env=observer.url)
            before = context.state("main")
            result = context.cli(
                "main",
                ["use", "rejected-session", "--controller", self.config.controller],
                expected_success=False,
                controller=observer.url,
            )
            context.expect(context.failure(result).get("success") is False, "use with controller must fail without mutating session", result.parsed)
            context.expect(context.state("main") == before, "use rejection must preserve session/config", context.state("main"))
            context.expect("--controller" not in context.text("main", ["help", "use"]).stdout, "use help must not advertise controller")
            context.expect("--controller" in context.text("main", ["help", "init"]).stdout, "init help must advertise controller")
            context.expect("--controller" in context.text("main", ["help", "connect"]).stdout, "connect help must advertise controller")
            # A subsequent invocation must not inherit the prior per-call flag;
            # the configured dead observer is now the selected endpoint.
            failed = context.cli(
                "main",
                ["get", "url"],
                expected_success=False,
                omit_controller_env=True,
            )
            context.expect(context.failure(failed).get("success") is False, "controller override must not persist to later calls", failed.parsed)
            self._assert_observer_connection(observer, "non-persisted override did not use configured endpoint")
            context.details["observer"] = observer.record()
        finally:
            observer.stop()
    def row_229_invalid_values(self, context: ScenarioContext) -> None:
        observer = self._new_observer()
        try:
            profile_variant = ["init", "--controller", "--profile"]
            if self.config.profile is not None:
                profile_variant.append(self.config.profile)
            variants = [
                ["init", "--controller"],
                ["init", "--controller", ""],
                profile_variant,
                ["init", "--controller", "-j"],
            ]
            results: list[dict[str, JSONValue]] = []
            for args in variants:
                state_before = context.state("invalid")
                result = context.cli("invalid", args, expected_success=False, controller=observer.url)
                failure = context.failure(result)
                error = failure.get("error")
                context.expect(isinstance(error, str) and "controller" in error.lower(), "missing/empty controller must be a parser error", failure)
                context.expect(context.state("invalid") == state_before, "invalid controller must not create a session", context.state("invalid"))
                results.append({"args": args, "error": error})
            self._assert_no_observer_connection(observer, "invalid controller arguments must not connect")
            context.details.update({"variants": results, "observer": observer.record()})
        finally:
            observer.stop()
    def row_229_aliases(self, context: ScenarioContext) -> None:
        observer = self._new_observer()
        try:
            alias_results: list[dict[str, JSONValue]] = []
            for alias in ("destroy", "close-session"):
                name = alias
                context.write_config(name, observer.url)
                context.init(name, controller=self.config.controller, controller_env=observer.url)
                before = context.state(name)
                context.cli(
                    name,
                    [alias, "--controller", self.config.controller],
                    controller=observer.url,
                )
                context.sessions.pop(name, None)
                context.expect(context.session_path(name).exists() is False, f"{alias} must remove session file", context.state(name))
                alias_results.append({"alias": alias, "before": before, "after": context.state(name)})
            self._assert_no_observer_connection(observer, "controller alias contacted wrong endpoint")
            context.details["aliases"] = alias_results
        finally:
            observer.stop()


def parse_args(argv: Sequence[str]) -> ReplayConfig:
    parser = argparse.ArgumentParser(description="Run clean-container row-7 CLI acceptance")
    parser.add_argument("--mode", choices=("normal", "idle"), required=True)
    parser.add_argument("--moat", required=True, help="absolute path to installed Linux moat CLI")
    parser.add_argument("--controller", required=True, help="explicit candidate Controller websocket URL")
    parser.add_argument("--fixture-url", required=True, help="explicit fixture HTTP(S) root URL")
    parser.add_argument("--evidence-dir", required=True, help="client-local writable evidence directory")
    parser.add_argument(
        "--profile",
        default=os.environ.get("MOAT_TEST_PROFILE"),
        help="configured test profile name/path; omitted uses server test default (or MOAT_TEST_PROFILE)",
    )
    parser.add_argument("--idle-timeout", type=int, default=10000, help="expected Controller idle timeout metadata; does not configure the server")
    parser.add_argument("--idle-seconds", type=int, default=45, help="idle wait duration; normal contract is 45 seconds")
    args = parser.parse_args(argv)
    moat = Path(args.moat)
    if not moat.is_absolute() or not moat.exists() or not os.access(moat, os.X_OK):
        parser.error(f"--moat must be an existing executable absolute path: {moat}")
    parsed_controller = urlparse(args.controller)
    if parsed_controller.scheme not in {"ws", "wss"} or not parsed_controller.netloc:
        parser.error("--controller must be an explicit ws:// or wss:// URL")
    parsed_fixture = urlparse(args.fixture_url)
    if parsed_fixture.scheme not in {"http", "https"} or not parsed_fixture.netloc:
        parser.error("--fixture-url must be an explicit http:// or https:// URL")
    evidence = Path(args.evidence_dir)
    if not evidence.is_absolute():
        parser.error("--evidence-dir must be an absolute client-local path")
    if args.idle_timeout <= 0 or args.idle_seconds <= 0:
        parser.error("idle timeout and wait duration must be positive")
    if args.mode == "idle" and args.idle_seconds != 45:
        parser.error("idle mode requires the exact 45-second expiry wait")
    return ReplayConfig(
        moat=moat,
        controller=args.controller,
        fixture_url=args.fixture_url,
        evidence_dir=evidence,
        mode=args.mode,
        profile=args.profile,
        idle_timeout_seconds=args.idle_timeout,
        idle_wait_seconds=args.idle_seconds,
    )


def main(argv: Sequence[str] | None = None) -> int:
    config = parse_args(sys.argv[1:] if argv is None else argv)
    runner = ReplayRunner(config)
    report: dict[str, JSONValue]
    try:
        report = runner.run()
    except Exception as error:
        runner.event("driver-abort", error=str(error), traceback=traceback.format_exc())
        report = {
            "schemaVersion": 1,
            "kind": "clean-container-row7-replay",
            "mode": config.mode,
            "passed": False,
            "status": "failed",
            "config": {
                "moat": str(config.moat),
                "controller": config.controller,
                "fixtureUrl": config.fixture_url,
                "evidenceDir": str(config.evidence_dir),
                "profile": config.profile,
                "idleTimeoutSeconds": config.idle_timeout_seconds,
                "idleWaitSeconds": config.idle_wait_seconds,
            },
            "rows": [row.record() for row in runner.rows],
            "events": runner.events,
            "failures": [{"error": str(error), "traceback": traceback.format_exc()}],
            "transcript": str(runner.transcript.path),
        }
    report_path = config.evidence_dir / f"row7-replay-{config.mode}.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report.get("passed") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
