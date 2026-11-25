"""The adapter's message handling (docs/testbed/external-core-protocol.md §4–§5)."""

from __future__ import annotations

import asyncio
import io
import json
import unittest
from contextlib import redirect_stderr
from typing import Any

from tests.helpers import Harness
from testbed_core import Action, Context, Core, CoreError


async def _echo(ctx: Context, input: dict[str, Any], caller: dict[str, Any]) -> dict[str, Any]:
    return {"text": input["text"], "replica": ctx.replica_id, "actor": caller.get("actor")}


async def _boom(ctx: Context, input: dict[str, Any], caller: dict[str, Any]) -> Any:
    raise RuntimeError("boom")


async def _refuse(ctx: Context, input: dict[str, Any], caller: dict[str, Any]) -> Any:
    raise CoreError("VALIDATION_ERROR", "no", {"field": "text"})


async def _roll(ctx: Context, input: dict[str, Any], caller: dict[str, Any]) -> Any:
    return {"value": ctx.rng.next(), "fault": ctx.decide({"op": "roll"})}


SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


class Toy(Core):
    kind = "active"
    title = "Toy"
    faults = ["error"]
    config_schema = {"type": "object", "properties": {"speed": {"type": "integer"}}, "required": ["speed"]}

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.actions = {
            "echo": Action("Echo", "echo", SCHEMA, {"type": "object"}, _echo, mutating=False),
            "boom": Action("Boom", "raises", {"type": "object"}, {"type": "object"}, _boom),
            "refuse": Action("Refuse", "refuses", {"type": "object"}, {"type": "object"}, _refuse),
            "roll": Action("Roll", "rolls", {"type": "object"}, {"type": "object"}, _roll),
        }

    def default_config(self, env: dict[str, str]) -> dict[str, Any]:
        return {"speed": int(env.get("TOY_SPEED", "1"))}

    async def start(self) -> None:
        self.calls.append("start")
        self.ctx.state("running")

    async def stop(self) -> None:
        self.calls.append("stop")

    async def reset(self) -> None:
        self.calls.append("reset")

    async def apply_config(self, config: dict[str, Any]) -> str:
        self.calls.append("apply")
        return "restart-required"

    def status(self) -> dict[str, Any]:
        return {"endpoints": [], "counters": {"calls": len(self.calls)}}


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


class InitializeTest(unittest.TestCase):
    def test_answers_the_spec_with_the_common_fields(self) -> None:
        async def go() -> None:
            harness = Harness(Toy(), env={"TOY_SPEED": "7", "TOY_AUTO_START": "true"})
            harness.adapter.ctx.core_id = "toy"
            answer = await harness.call(
                "initialize",
                {"protocolVersion": "1", "coreId": "toy", "replicaId": "r1", "replicaIndex": 1, "replicas": 2, "seed": "x", "runId": None},
            )
            result = answer["result"]
            self.assertEqual(result["protocolVersion"], "1")
            self.assertEqual(result["kind"], "active")
            self.assertEqual(result["faults"], ["error"])
            self.assertEqual(result["defaultConfig"], {"autoStart": True, "eventLevel": "info", "faults": [], "speed": 7})
            properties = result["configSchema"]["properties"]
            for name in ("autoStart", "eventLevel", "faults", "speed"):
                self.assertIn(name, properties)
            self.assertEqual(set(result["configSchema"]["required"]), {"autoStart", "eventLevel", "faults", "speed"})
            self.assertEqual(result["actions"]["echo"]["mutating"], False)
            self.assertEqual(result["actions"]["echo"]["inputSchema"], SCHEMA)
            ctx = harness.adapter.ctx
            self.assertEqual((ctx.core_id, ctx.replica_id, ctx.replica_index, ctx.replicas), ("toy", "r1", 1, 2))

        run(go())

    def test_active_core_defaults_to_no_auto_start(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            answer = await harness.boot()
            self.assertFalse(answer["result"]["defaultConfig"]["autoStart"])

        run(go())

    def test_another_protocol_version_is_an_error(self) -> None:
        async def go() -> None:
            answer = await Harness(Toy()).call("initialize", {"protocolVersion": "2"})
            self.assertEqual(answer["error"]["data"]["code"], "PROTOCOL")

        run(go())


class RequestsTest(unittest.TestCase):
    def test_lifecycle_and_status(self) -> None:
        async def go() -> None:
            core = Toy()
            harness = Harness(core)
            await harness.boot()
            self.assertEqual((await harness.call("status"))["result"]["state"], "stopped")
            self.assertEqual((await harness.call("start"))["result"], {})
            self.assertEqual(harness.notifications("state"), [{"state": "running"}])
            status = (await harness.call("status"))["result"]
            self.assertEqual(status["state"], "running")
            self.assertEqual(status["counters"], {"calls": 1})
            await harness.call("reset")
            await harness.call("stop")
            self.assertEqual(core.calls, ["start", "reset", "stop"])

        run(go())

    def test_apply_config_while_stopped_only_stores_it(self) -> None:
        async def go() -> None:
            core = Toy()
            harness = Harness(core)
            await harness.boot()
            config = {"autoStart": False, "eventLevel": "info", "faults": [], "speed": 3}
            self.assertEqual((await harness.call("applyConfig", {"config": config}))["result"], {"result": "applied"})
            self.assertEqual(harness.adapter.ctx.config["speed"], 3)
            await harness.call("start")
            answer = await harness.call("applyConfig", {"config": {**config, "speed": 4}})
            self.assertEqual(answer["result"], {"result": "restart-required"})
            self.assertEqual(core.calls, ["start", "apply"])

        run(go())

    def test_action_gets_input_caller_and_replica(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            await harness.boot(replica=2)
            answer = await harness.call("action", {"name": "echo", "input": {"text": "hi"}, "caller": {"actor": "agent"}})
            self.assertEqual(answer["result"], {"text": "hi", "replica": "r2", "actor": "agent"})

        run(go())

    def test_core_error_keeps_its_code(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            await harness.boot()
            answer = await harness.call("action", {"name": "refuse", "input": {}, "caller": {}})
            self.assertEqual(answer["error"]["message"], "no")
            self.assertEqual(answer["error"]["data"], {"code": "VALIDATION_ERROR", "details": {"field": "text"}})

        run(go())

    def test_unhandled_exception_is_internal_with_a_traceback_and_the_adapter_lives_on(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            await harness.boot()
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                answer = await harness.call("action", {"name": "boom", "input": {}, "caller": {}})
            self.assertEqual(answer["error"]["data"], {"code": "INTERNAL"})
            self.assertIn("RuntimeError: boom", answer["error"]["message"])
            self.assertIn("Traceback", stderr.getvalue())
            self.assertIn("RuntimeError: boom", stderr.getvalue())
            self.assertIn("result", await harness.call("status"))

        run(go())

    def test_unknown_method_and_action(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            await harness.boot()
            self.assertEqual((await harness.call("nope"))["error"]["data"]["code"], "NO_METHOD")
            answer = await harness.call("action", {"name": "nope", "input": {}, "caller": {}})
            self.assertEqual(answer["error"]["data"]["code"], "NOT_FOUND")

        run(go())

    def test_run_changed_reseeds_and_restarts_fault_counts(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            rules = [{"id": "once", "error": "x", "times": 1}]
            await harness.boot({"faults": rules}, seed="a:r0")
            first = (await harness.call("action", {"name": "roll", "input": {}, "caller": {}}))["result"]
            second = (await harness.call("action", {"name": "roll", "input": {}, "caller": {}}))["result"]
            self.assertEqual(first["fault"], {"ruleId": "once", "error": "x"})
            self.assertIsNone(second["fault"])
            await harness.call("runChanged", {"runId": "run-1", "seed": "a:r0"})
            again = (await harness.call("action", {"name": "roll", "input": {}, "caller": {}}))["result"]
            self.assertEqual(again, first)
            self.assertEqual(harness.adapter.ctx.run_id, "run-1")
            faults = harness.notifications("fault")
            self.assertEqual(len(faults), 2)
            self.assertEqual(faults[0], {"ruleId": "once", "effects": {"error": "x"}, "selector": {"op": "roll"}})

        run(go())

    def test_shutdown_stops_a_running_core(self) -> None:
        async def go() -> None:
            core = Toy()
            harness = Harness(core)
            await harness.boot()
            await harness.call("start")
            self.assertEqual((await harness.call("shutdown"))["result"], {})
            self.assertTrue(harness.adapter.closing)
            self.assertEqual(core.calls, ["start", "stop"])

        run(go())


class NotificationsTest(unittest.TestCase):
    def test_emit_drops_debug_unless_event_level_debug(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            await harness.boot()
            ctx = harness.adapter.ctx
            ctx.emit("toy.a", "a", {"n": 1}, correlation_id="c-1", latency_ms=3, actor="product")
            ctx.emit("toy.b", "b", level="debug")
            await harness.call("applyConfig", {"config": {**ctx.config, "eventLevel": "debug"}})
            ctx.emit("toy.c", "c", level="debug")
            ctx.log("hello", "warn")
            events = harness.notifications("event")
            self.assertEqual([event["kind"] for event in events], ["toy.a", "toy.c"])
            self.assertEqual(
                events[0],
                {"kind": "toy.a", "level": "info", "summary": "a", "payload": {"n": 1}, "correlationId": "c-1", "latencyMs": 3, "actor": "product"},
            )
            self.assertEqual(harness.notifications("log"), [{"level": "warn", "msg": "hello"}])

        run(go())


class ServeTest(unittest.TestCase):
    def test_reads_ndjson_skips_bad_lines_and_ends_on_shutdown(self) -> None:
        async def go() -> None:
            harness = Harness(Toy())
            reader = asyncio.StreamReader()
            init = {"protocolVersion": "1", "coreId": "toy", "replicaId": "r0", "replicaIndex": 0, "replicas": 1, "seed": "s", "runId": None}
            for message in (
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": init},
                "not json",
                {"jsonrpc": "2.0", "id": 2, "method": "status", "params": {}},
                {"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": {}},
                {"jsonrpc": "2.0", "id": 4, "method": "status", "params": {}},
            ):
                reader.feed_data(((message if isinstance(message, str) else json.dumps(message)) + "\n").encode())
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                await asyncio.wait_for(harness.adapter.serve(reader), 5)
            self.assertEqual([line.get("id") for line in harness.lines if "id" in line], [1, 2, 3])
            self.assertIn("not JSON", stderr.getvalue())

        run(go())


if __name__ == "__main__":
    unittest.main()
