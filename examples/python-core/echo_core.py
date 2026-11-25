"""py-echo: the sample core's TCP echo, cut down, as an external Python core
(docs/spec.md §11 M13).

Every chunk received is sent back as it is, one chunk at a time per
connection; a chunk over `maxChunkBytes` closes the connection. Faults
`delay`, `disconnect` and `corrupt` (XOR 0xFF) are decided per chunk.
Replica `rN` listens on `port + N` (`port: 0` → every replica on a random
port). The bind and public hosts come from `PY_ECHO_BIND_HOST` (default
`127.0.0.1`) and `PY_ECHO_PUBLIC_HOST` (default `localhost`).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from testbed_core import Action, Context, Core, run  # noqa: E402

PREVIEW_BYTES = 64
DEFAULT_PORT = 40002


def _seconds(ms: float) -> str:
    return f"{ms / 1000:.1f}s"


@dataclass
class Connection:
    id: str
    remote: str
    remote_address: str
    transport: asyncio.Transport
    opened_at: float
    bytes_in: int = 0
    bytes_out: int = 0
    closed: bool = False
    queue: "asyncio.Queue[tuple[bytes, float]]" = field(default_factory=asyncio.Queue)
    worker: Optional["asyncio.Task[None]"] = None


class _Protocol(asyncio.Protocol):
    def __init__(self, core: "EchoCore") -> None:
        self.core = core
        self.conn: Optional[Connection] = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.conn = self.core.on_open(transport)  # type: ignore[arg-type]

    def data_received(self, data: bytes) -> None:
        if self.conn is not None:
            self.core.on_data(self.conn, data)

    def connection_lost(self, exc: Optional[Exception]) -> None:
        if self.conn is not None and not self.conn.closed:
            self.core.close(self.conn, "client", end=False)


class EchoCore(Core):
    kind = "passive"
    title = "TCP echo (Python example)"
    faults = ["delay", "disconnect", "corrupt"]
    config_schema = {
        "type": "object",
        "properties": {
            "port": {"type": "integer", "minimum": 0, "maximum": 65535},
            "maxChunkBytes": {"type": "integer", "minimum": 1, "maximum": 1048576},
        },
        "required": ["port", "maxChunkBytes"],
    }

    def __init__(self) -> None:
        self.server: Optional[asyncio.Server] = None
        self.started_port: Optional[int] = None
        self.bound_port: Optional[int] = None
        self.open: dict[str, Connection] = {}
        self.next_conn = 1
        self.counters = self._zero()
        self.actions = {
            "broadcast": Action(
                title="Broadcast",
                description=(
                    "열린 TCP 연결 모두에 text(UTF-8, 1–4096자)를 보냄. 결함은 적용하지 않음. "
                    "보낸 연결 수(sent)를 돌려줌. 열린 연결이 없으면 0."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 4096}},
                    "required": ["text"],
                },
                output_schema={
                    "type": "object",
                    "properties": {"sent": {"type": "integer", "minimum": 0}},
                    "required": ["sent"],
                },
                handler=self._broadcast_action,
            )
        }

    async def _broadcast_action(self, ctx: Context, input: dict[str, Any], caller: dict[str, Any]) -> dict[str, int]:
        return {"sent": self.broadcast(input["text"], caller.get("actor", "product"))}

    @staticmethod
    def _zero() -> dict[str, int]:
        return {"connectionsOpen": 0, "connectionsTotal": 0, "bytesIn": 0, "bytesOut": 0}

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def default_config(self, env: dict[str, str]) -> dict[str, Any]:
        port = env.get("PY_ECHO_PORT", "")
        chunk = env.get("PY_ECHO_MAX_CHUNK_BYTES", "")
        return {
            "port": int(port) if port else DEFAULT_PORT,
            "maxChunkBytes": int(chunk) if chunk else 65536,
        }

    def _listen_port(self, port: int) -> int:
        return 0 if port == 0 else port + self.ctx.replica_index

    async def start(self) -> None:
        port = self.ctx.config["port"]
        host = self.ctx.env.get("PY_ECHO_BIND_HOST") or "127.0.0.1"
        loop = asyncio.get_running_loop()
        self.server = await loop.create_server(lambda: _Protocol(self), host, self._listen_port(port))
        self.started_port = port
        self.bound_port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        self._close_all("stop")
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        self.server = None
        self.bound_port = None

    async def reset(self) -> None:
        self._close_all("server")
        self.next_conn = 1
        self.counters = self._zero()

    async def apply_config(self, config: dict[str, Any]) -> str:
        """A new port needs a new listener; the rest is read live."""
        if self.started_port is not None and config["port"] != self.started_port:
            return "restart-required"
        return "applied"

    def status(self) -> dict[str, Any]:
        port = self.bound_port if self.bound_port is not None else self._listen_port(self.ctx.config.get("port", DEFAULT_PORT))
        host = self.ctx.env.get("PY_ECHO_PUBLIC_HOST") or "localhost"
        return {
            "endpoints": [{"name": "echo", "protocol": "tcp", "url": f"tcp://{host}:{port}"}],
            "counters": dict(self.counters),
        }

    # ── Data plane ──────────────────────────────────────────────────────────

    def broadcast(self, text: str, actor: str) -> int:
        data = text.encode("utf-8")
        connections = [conn for conn in self.open.values() if not conn.closed]
        for conn in connections:
            self._write(conn, data)
        self.ctx.emit(
            "py-echo.broadcast.sent",
            f"broadcast {len(data)}B to {len(connections)} conns",
            {"bytes": len(data), "connections": len(connections)},
            actor=actor,
        )
        return len(connections)

    def on_open(self, transport: asyncio.Transport) -> Connection:
        peer = transport.get_extra_info("peername") or ("?", 0)
        remote = f"{peer[0]}:{peer[1]}"
        conn = Connection(
            id=f"c-{self.next_conn}",
            remote=remote,
            remote_address=str(peer[0]),
            transport=transport,
            opened_at=time.monotonic(),
        )
        self.next_conn += 1
        self.open[conn.id] = conn
        self.counters["connectionsOpen"] += 1
        self.counters["connectionsTotal"] += 1
        self.ctx.emit(
            "py-echo.connection.opened",
            f"conn {conn.id} opened from {remote}",
            {"connId": conn.id, "remote": remote},
            correlation_id=conn.id,
            actor="product",
        )
        conn.worker = asyncio.get_running_loop().create_task(self._work(conn))
        return conn

    def on_data(self, conn: Connection, data: bytes) -> None:
        if conn.closed:
            return
        conn.bytes_in += len(data)
        self.counters["bytesIn"] += len(data)
        conn.queue.put_nowait((data, time.monotonic()))

    async def _work(self, conn: Connection) -> None:
        """Chunks one at a time, so a delayed echo never overtakes."""
        while not conn.closed:
            data, received_at = await conn.queue.get()
            await self._echo(conn, data, received_at)

    async def _echo(self, conn: Connection, data: bytes, received_at: float) -> None:
        if conn.closed:
            return
        if len(data) > self.ctx.config["maxChunkBytes"]:
            self.close(conn, "too-large")
            return
        decision = self.ctx.decide({"connId": conn.id, "remoteAddress": conn.remote_address}, conn.id)
        if decision and decision.get("delayMs"):
            await asyncio.sleep(decision["delayMs"] / 1000)
        if conn.closed:
            return
        if decision and decision.get("disconnect"):
            self.close(conn, "fault")
            return
        out = bytes(byte ^ 0xFF for byte in data) if decision and decision.get("corrupt") else data
        self._write(conn, out)
        latency_ms = round((time.monotonic() - received_at) * 1000)
        fault_id = decision["ruleId"] if decision else None
        payload: dict[str, Any] = {
            "connId": conn.id,
            "bytes": len(out),
            "preview": out[:PREVIEW_BYTES].decode("utf-8", errors="replace"),
            "sha256": hashlib.sha256(out).hexdigest(),
        }
        if fault_id is not None:
            payload["faultId"] = fault_id
        suffix = "" if fault_id is None else f" [fault {fault_id}]"
        self.ctx.emit(
            "py-echo.data.echoed",
            f"{conn.id} echoed {len(out)}B in {latency_ms}ms{suffix}",
            payload,
            correlation_id=conn.id,
            latency_ms=latency_ms,
            actor="product",
        )

    def _write(self, conn: Connection, data: bytes) -> None:
        conn.bytes_out += len(data)
        self.counters["bytesOut"] += len(data)
        conn.transport.write(data)

    def close(self, conn: Connection, reason: str, end: bool = True) -> None:
        """Records the close first, then ends the socket."""
        if conn.closed:
            return
        conn.closed = True
        self.open.pop(conn.id, None)
        self.counters["connectionsOpen"] = max(0, self.counters["connectionsOpen"] - 1)
        duration_ms = round((time.monotonic() - conn.opened_at) * 1000)
        self.ctx.emit(
            "py-echo.connection.closed",
            f"conn {conn.id} closed ({reason}) after {_seconds(duration_ms)}, in {conn.bytes_in}B out {conn.bytes_out}B",
            {
                "connId": conn.id,
                "reason": reason,
                "durationMs": duration_ms,
                "bytesIn": conn.bytes_in,
                "bytesOut": conn.bytes_out,
            },
            correlation_id=conn.id,
            actor="product",
        )
        if conn.worker is not None and conn.worker is not asyncio.current_task():
            conn.worker.cancel()
        if end:
            conn.transport.close()

    def _close_all(self, reason: str) -> None:
        for conn in list(self.open.values()):
            self.close(conn, reason)


if __name__ == "__main__":
    run(EchoCore())
