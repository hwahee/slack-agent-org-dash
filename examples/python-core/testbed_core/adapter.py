"""The Python adapter for external testbed cores
(docs/testbed/external-core-protocol.md).

A core subclasses `Core` and calls `run(MyCore())`; the adapter speaks the
protocol: NDJSON JSON-RPC 2.0 over stdin/stdout, every request method, the
notifications (`event`, `fault`, `state`, `log`), the common config fields
(`autoStart`, `eventLevel`, `faults`), the seeded randomness and the fault
decisions. stdout is the protocol's alone — write logs with `ctx.log` (or to
stderr).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

from .faults import FaultDecider, FaultDecision
from .rng import SeededRng

PROTOCOL_VERSION = "1"
MAX_LINE_BYTES = 1024 * 1024

#: The control-plane codes the glue keeps as they are; anything else becomes CORE_ERROR.
JsonObject = dict[str, Any]


class CoreError(Exception):
    """A failure with a code of the core's own (`error.data.code`).

    `VALIDATION_ERROR`, `CORE_NOT_RUNNING` and the other control-plane codes
    keep their meaning on the control plane; other codes become `CORE_ERROR`.
    """

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


ActionHandler = Callable[["Context", JsonObject, JsonObject], Awaitable[Any]]


@dataclass
class Action:
    """One action the core offers (shown on REST, MCP and the dashboard)."""

    title: str
    description: str
    input_schema: JsonObject
    output_schema: JsonObject
    handler: ActionHandler
    mutating: bool = True
    surfaces: Optional[list[str]] = None


COMMON_SCHEMA: JsonObject = {
    "autoStart": {"type": "boolean"},
    "eventLevel": {"type": "string", "enum": ["debug", "info"]},
    "faults": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "match": {"type": "object"},
                "probability": {"type": "number", "minimum": 0, "maximum": 1},
                "delayMs": {
                    "anyOf": [
                        {"type": "integer", "minimum": 0},
                        {
                            "type": "object",
                            "properties": {
                                "min": {"type": "integer", "minimum": 0},
                                "max": {"type": "integer", "minimum": 0},
                            },
                            "required": ["min", "max"],
                        },
                    ]
                },
                "error": {"type": "string", "minLength": 1},
                "disconnect": {"type": "boolean"},
                "corrupt": {"type": "boolean"},
                "times": {"type": "integer", "minimum": 1},
            },
            "required": ["id"],
        },
    },
}


class Core:
    """What a core defines; the adapter does the rest.

    Class attributes: `kind`, `title`, `faults` (the kinds it applies),
    `config_schema` (JSON Schema of its own fields — the common ones are
    added), `actions`. Methods: `default_config(env)`, `start`, `stop`,
    `reset`, `apply_config`, `status`. `self.ctx` is set before any is called.
    """

    kind: str = "passive"
    title: str = "core"
    faults: list[str] = []
    config_schema: JsonObject = {"type": "object", "properties": {}}
    actions: dict[str, Action] = {}
    ctx: "Context"

    def default_config(self, env: dict[str, str]) -> JsonObject:
        """Boot defaults of its own fields, from `<CORE_ID>_*` variables."""
        return {}

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def reset(self) -> None:
        """Clear counters and state; the adapter resets the fault counts."""

    async def apply_config(self, config: JsonObject) -> str:
        """`'applied'`, or `'restart-required'` when it takes effect on the next start."""
        return "applied"

    def status(self) -> JsonObject:
        """`{ endpoints: [{ name, protocol, url }], counters: { … } }`."""
        return {"endpoints": [], "counters": {}}


@dataclass
class Context:
    """What the adapter gives the core."""

    core_id: str = ""
    replica_id: str = "r0"
    replica_index: int = 0
    replicas: int = 1
    run_id: Optional[str] = None
    env: dict[str, str] = field(default_factory=dict)
    config: JsonObject = field(default_factory=dict)
    running: bool = False
    rng: SeededRng = field(default_factory=lambda: SeededRng(""))
    faults: FaultDecider = field(default_factory=lambda: FaultDecider(lambda: SeededRng("")))
    _send: Callable[[JsonObject], None] = lambda message: None

    def emit(
        self,
        kind: str,
        summary: str,
        payload: Optional[JsonObject] = None,
        *,
        level: str = "info",
        correlation_id: Optional[str] = None,
        latency_ms: Optional[float] = None,
        actor: Optional[str] = None,
    ) -> None:
        """An event. `kind` starts with `<core id>.`; `debug` is dropped unless `eventLevel: debug`."""
        if level == "debug" and self.config.get("eventLevel") != "debug":
            return
        params: JsonObject = {"kind": kind, "level": level, "summary": summary, "payload": payload or {}}
        if correlation_id is not None:
            params["correlationId"] = correlation_id
        if latency_ms is not None:
            params["latencyMs"] = latency_ms
        if actor is not None:
            params["actor"] = actor
        self._send({"jsonrpc": "2.0", "method": "event", "params": params})

    def state(self, state: str, detail: Optional[str] = None) -> None:
        params: JsonObject = {"state": state}
        if detail is not None:
            params["detail"] = detail
        self._send({"jsonrpc": "2.0", "method": "state", "params": params})

    def log(self, msg: str, level: str = "info") -> None:
        """A log line (not an event)."""
        self._send({"jsonrpc": "2.0", "method": "log", "params": {"level": level, "msg": msg}})

    def decide(self, selector: JsonObject, correlation_id: Optional[str] = None) -> Optional[FaultDecision]:
        """The fault to apply to this request, if any (the glue hears about it as `fault`)."""
        return self.faults.decide(selector, correlation_id)


def _with_common_fields(schema: JsonObject) -> JsonObject:
    properties = {**COMMON_SCHEMA, **schema.get("properties", {})}
    required = sorted(set(schema.get("required", [])) | {"autoStart", "eventLevel", "faults"})
    return {**schema, "type": "object", "properties": properties, "required": required}


class Adapter:
    """Reads requests, runs them against the core, writes answers and notifications."""

    def __init__(
        self,
        core: Core,
        env: Optional[dict[str, str]] = None,
        write: Optional[Callable[[str], None]] = None,
        stderr: Optional[Any] = None,
    ) -> None:
        self.core = core
        self._stderr = stderr
        self.env = dict(os.environ if env is None else env)
        self._write = write or self._stdout
        self.ctx = Context(env=self.env, _send=self.send)
        self.ctx.faults = FaultDecider(lambda: self.ctx.rng, self._on_fault)
        core.ctx = self.ctx
        self.closing = False

    # ── Output ──────────────────────────────────────────────────────────────

    @staticmethod
    def _stdout(line: str) -> None:
        sys.stdout.write(line)
        sys.stdout.flush()

    def send(self, message: JsonObject) -> None:
        self._write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")

    def _on_fault(self, decision: FaultDecision, selector: JsonObject, correlation_id: Optional[str]) -> None:
        effects = {key: value for key, value in decision.items() if key != "ruleId"}
        params: JsonObject = {"ruleId": decision["ruleId"], "effects": effects, "selector": selector}
        if correlation_id is not None:
            params["correlationId"] = correlation_id
        self.send({"jsonrpc": "2.0", "method": "fault", "params": params})

    # ── Requests ────────────────────────────────────────────────────────────

    def _reseed(self, seed: str) -> None:
        """A new seed: a new PRNG and the fault counts from 0 (protocol §4.3)."""
        self.ctx.rng = SeededRng(seed)
        self.ctx.faults.reset()

    def _initialize(self, params: JsonObject) -> JsonObject:
        ctx = self.ctx
        ctx.core_id = params["coreId"]
        ctx.replica_id = params["replicaId"]
        ctx.replica_index = int(params["replicaIndex"])
        ctx.replicas = int(params["replicas"])
        ctx.run_id = params.get("runId")
        self._reseed(params["seed"])
        version = ".".join(str(part) for part in sys.version_info[:3])
        print(
            f"testbed_core: {ctx.core_id} {ctx.replica_id} initialized (Python {version}, protocol {PROTOCOL_VERSION})",
            file=self._stderr or sys.stderr,
            flush=True,
        )
        core = self.core
        prefix = ctx.core_id.upper().replace("-", "_")
        auto_start = self.env.get(f"{prefix}_AUTO_START")
        defaults = {
            "autoStart": core.kind == "passive" if auto_start in (None, "") else auto_start != "false",
            "eventLevel": "info",
            "faults": [],
            **core.default_config(self.env),
        }
        actions: JsonObject = {}
        for name, action in core.actions.items():
            actions[name] = {
                "title": action.title,
                "description": action.description,
                "inputSchema": action.input_schema,
                "outputSchema": action.output_schema,
                "mutating": action.mutating,
                **({"surfaces": action.surfaces} if action.surfaces is not None else {}),
            }
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "kind": core.kind,
            "title": core.title,
            "configSchema": _with_common_fields(core.config_schema),
            "defaultConfig": defaults,
            "actions": actions,
            "faults": list(core.faults),
        }

    async def handle(self, method: str, params: JsonObject) -> Any:
        core, ctx = self.core, self.ctx
        if method == "initialize":
            if params.get("protocolVersion") != PROTOCOL_VERSION:
                raise CoreError("PROTOCOL", f"protocolVersion {params.get('protocolVersion')!r} is not {PROTOCOL_VERSION!r}")
            return self._initialize(params)
        if method == "applyConfig":
            config = params["config"]
            ctx.config = config
            ctx.faults.set_rules(config.get("faults", []))
            if not ctx.running:
                return {"result": "applied"}
            return {"result": await core.apply_config(config)}
        if method == "start":
            await core.start()
            ctx.running = True
            return {}
        if method == "stop":
            ctx.running = False
            await core.stop()
            return {}
        if method == "reset":
            ctx.faults.reset()
            await core.reset()
            return {}
        if method == "status":
            status = core.status()
            return {"state": "running" if ctx.running else "stopped", **status}
        if method == "action":
            name = params["name"]
            action = core.actions.get(name)
            if action is None:
                raise CoreError("NOT_FOUND", f"no action {name}")
            return await action.handler(ctx, params.get("input") or {}, params.get("caller") or {})
        if method == "runChanged":
            ctx.run_id = params.get("runId")
            self._reseed(params["seed"])
            return {}
        if method == "shutdown":
            if ctx.running:
                ctx.running = False
                await core.stop()
            self.closing = True
            return {}
        raise CoreError("NO_METHOD", f"unknown method {method}")

    async def respond(self, message: JsonObject) -> None:
        """Answers one request; an exception becomes a JSON-RPC error (never ends the process)."""
        request_id = message.get("id")
        try:
            result = await self.handle(message.get("method", ""), message.get("params") or {})
            self.send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except CoreError as error:
            data: JsonObject = {"code": error.code}
            if error.details is not None:
                data["details"] = error.details
            self.send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(error), "data": data}})
        except Exception as error:  # noqa: BLE001 — any failure is an answer, not a crash
            traceback.print_exc(file=sys.stderr)
            self.send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32603, "message": f"{type(error).__name__}: {error}", "data": {"code": "INTERNAL"}},
                }
            )

    async def serve(self, reader: asyncio.StreamReader) -> None:
        """Until stdin closes or `shutdown`: one task per request, so a slow action never blocks a ping."""
        tasks: set[asyncio.Task[None]] = set()
        while not self.closing:
            try:
                line = await reader.readline()
            except ValueError:  # over the limit
                print("testbed_core: dropped a request line over 1 MiB", file=sys.stderr)
                continue
            if not line:
                break
            text = line.decode("utf-8").strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                print(f"testbed_core: not JSON: {text[:80]}", file=sys.stderr)
                continue
            if not isinstance(message, dict) or "method" not in message:
                continue
            task = asyncio.create_task(self.respond(message))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
            if message["method"] == "shutdown":
                await task
        for task in list(tasks):
            task.cancel()


async def _main(core: Core) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES + 1)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    await Adapter(core).serve(reader)


def run(core: Core) -> None:
    """Serves `core` over stdin/stdout until the glue says `shutdown`."""
    asyncio.run(_main(core))
