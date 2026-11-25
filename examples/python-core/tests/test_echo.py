"""py-echo's own behaviour, the core driven through the adapter in-process."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import unittest
from typing import Any

from tests.helpers import Harness

_spec = importlib.util.spec_from_file_location(
    "echo_core", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "echo_core.py")
)
assert _spec and _spec.loader
echo_core = importlib.util.module_from_spec(_spec)
sys.modules["echo_core"] = echo_core
_spec.loader.exec_module(echo_core)


async def started(config: dict[str, Any] | None = None, replica: int = 0) -> tuple[Harness, Any, int]:
    core = echo_core.EchoCore()
    harness = Harness(core)
    await harness.boot({"port": 0, **(config or {})}, replica=replica)
    await harness.call("start")
    return harness, core, core.bound_port


async def until(check: Any, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.01)


class EchoTest(unittest.TestCase):
    def test_defaults_and_port_per_replica(self) -> None:
        core = echo_core.EchoCore()
        self.assertEqual(core.default_config({}), {"port": 40002, "maxChunkBytes": 65536})
        self.assertEqual(core.default_config({"PY_ECHO_PORT": "41000"})["port"], 41000)

        async def go() -> None:
            harness = Harness(echo_core.EchoCore())
            await harness.boot({"port": 41000}, replica=2)
            status = (await harness.call("status"))["result"]
            self.assertEqual(status["endpoints"], [{"name": "echo", "protocol": "tcp", "url": "tcp://localhost:41002"}])

        asyncio.run(go())

    def test_echoes_and_reports(self) -> None:
        async def go() -> None:
            harness, core, port = await started()
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"hello")
            self.assertEqual(await reader.readexactly(5), b"hello")
            await until(lambda: harness.events("py-echo.data.echoed"))
            opened = harness.events("py-echo.connection.opened")[0]
            self.assertRegex(opened["summary"], r"^conn c-1 opened from 127\.0\.0\.1:\d+$")
            echoed = harness.events("py-echo.data.echoed")[0]
            self.assertRegex(echoed["summary"], r"^c-1 echoed 5B in \d+ms$")
            self.assertEqual(echoed["correlationId"], "c-1")
            self.assertIn("latencyMs", echoed)
            self.assertEqual(echoed["payload"]["preview"], "hello")
            writer.close()
            await until(lambda: harness.events("py-echo.connection.closed"))
            closed = harness.events("py-echo.connection.closed")[0]
            self.assertRegex(closed["summary"], r"^conn c-1 closed \(client\) after \d+\.\ds, in 5B out 5B$")
            counters = (await harness.call("status"))["result"]["counters"]
            self.assertEqual(counters, {"connectionsOpen": 0, "connectionsTotal": 1, "bytesIn": 5, "bytesOut": 5})
            await harness.call("stop")

        asyncio.run(go())

    def test_faults_corrupt_and_disconnect(self) -> None:
        async def go() -> None:
            rules = [{"id": "x", "corrupt": True, "times": 1}, {"id": "cut", "disconnect": True}]
            harness, _, port = await started({"faults": rules})
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"\x00\x0f")
            self.assertEqual(await reader.readexactly(2), b"\xff\xf0")
            await until(lambda: harness.events("py-echo.data.echoed"))
            self.assertTrue(harness.events("py-echo.data.echoed")[0]["summary"].endswith(" [fault x]"))
            writer.write(b"bye")
            self.assertEqual(await reader.read(), b"")
            await until(lambda: harness.events("py-echo.connection.closed"))
            self.assertEqual(harness.events("py-echo.connection.closed")[0]["payload"]["reason"], "fault")
            self.assertEqual([fault["ruleId"] for fault in harness.notifications("fault")], ["x", "cut"])
            writer.close()
            await harness.call("stop")

        asyncio.run(go())

    def test_delay(self) -> None:
        async def go() -> None:
            harness, _, port = await started({"faults": [{"id": "slow", "delayMs": 150}]})
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"a")
            self.assertEqual(await reader.readexactly(1), b"a")
            await until(lambda: harness.events("py-echo.data.echoed"))
            self.assertGreaterEqual(harness.events("py-echo.data.echoed")[0]["latencyMs"], 140)
            writer.close()
            await harness.call("stop")

        asyncio.run(go())

    def test_too_large_closes(self) -> None:
        async def go() -> None:
            harness, _, port = await started({"maxChunkBytes": 4})
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"0123456789")
            self.assertEqual(await reader.read(), b"")
            await until(lambda: harness.events("py-echo.connection.closed"))
            self.assertEqual(harness.events("py-echo.connection.closed")[0]["payload"]["reason"], "too-large")
            writer.close()
            await harness.call("stop")

        asyncio.run(go())

    def test_broadcast_and_stop(self) -> None:
        async def go() -> None:
            harness, _, port = await started()
            streams = [await asyncio.open_connection("127.0.0.1", port) for _ in range(2)]
            await until(lambda: len(harness.events("py-echo.connection.opened")) == 2)
            answer = await harness.call("action", {"name": "broadcast", "input": {"text": "hi"}, "caller": {"actor": "agent"}})
            self.assertEqual(answer["result"], {"sent": 2})
            for reader, _ in streams:
                self.assertEqual(await reader.readexactly(2), b"hi")
            sent = harness.events("py-echo.broadcast.sent")[0]
            self.assertEqual(sent["summary"], "broadcast 2B to 2 conns")
            self.assertEqual(sent["actor"], "agent")
            await harness.call("stop")
            reasons = [event["payload"]["reason"] for event in harness.events("py-echo.connection.closed")]
            self.assertEqual(reasons, ["stop", "stop"])
            for _, writer in streams:
                writer.close()

        asyncio.run(go())

    def test_port_change_needs_a_restart(self) -> None:
        async def go() -> None:
            harness, _, _ = await started()
            config = harness.adapter.ctx.config
            answer = await harness.call("applyConfig", {"config": {**config, "port": 41999}})
            self.assertEqual(answer["result"], {"result": "restart-required"})
            answer = await harness.call("applyConfig", {"config": {**config, "maxChunkBytes": 10}})
            self.assertEqual(answer["result"], {"result": "applied"})
            await harness.call("stop")

        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
