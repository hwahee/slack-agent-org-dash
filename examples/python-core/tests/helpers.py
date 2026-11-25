"""An adapter driven in-process: requests in, answers and notifications out."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from testbed_core import Adapter, Core  # noqa: E402


class Harness:
    def __init__(self, core: Core, env: dict[str, str] | None = None) -> None:
        self.lines: list[dict[str, Any]] = []
        self.adapter = Adapter(core, env=env or {}, write=lambda line: self.lines.append(json.loads(line)))
        self.next_id = 1

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """The answer (`result` or `error`) to one request."""
        request_id = self.next_id
        self.next_id += 1
        await self.adapter.respond({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        return next(line for line in self.lines if line.get("id") == request_id)

    async def boot(self, config: dict[str, Any] | None = None, seed: str = "s", replica: int = 0) -> dict[str, Any]:
        init = await self.call(
            "initialize",
            {
                "protocolVersion": "1",
                "coreId": "py-echo",
                "replicaId": f"r{replica}",
                "replicaIndex": replica,
                "replicas": replica + 1,
                "seed": seed,
                "runId": None,
            },
        )
        defaults = init["result"]["defaultConfig"]
        await self.call("applyConfig", {"config": {**defaults, **(config or {})}})
        return init

    def notifications(self, method: str) -> list[dict[str, Any]]:
        return [line["params"] for line in self.lines if line.get("method") == method]

    def events(self, kind: str) -> list[dict[str, Any]]:
        return [params for params in self.notifications("event") if params["kind"] == kind]
