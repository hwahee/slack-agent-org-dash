"""Prints the Python SeededRng and FaultDecider results for the cross-language
check in `bun test` (examples/python-core/parity.integration.test.ts).

stdin: `{ seeds, count, faultSeed, rules, selectors }`; stdout: one JSON object.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from testbed_core import FaultDecider, SeededRng  # noqa: E402


def main() -> None:
    request = json.load(sys.stdin)
    count = request["count"]
    rng: dict[str, dict[str, list[float]]] = {}
    for seed in request["seeds"]:
        floats, ints = SeededRng(seed), SeededRng(seed)
        rng[seed] = {
            "next": [floats.next() for _ in range(count)],
            "int": [ints.int(0, 999) for _ in range(count)],
        }
    shared = SeededRng(request["faultSeed"])
    decider = FaultDecider(lambda: shared)
    decider.set_rules(request["rules"])
    decisions = [decider.decide(selector) for selector in request["selectors"]]
    json.dump({"rng": rng, "decisions": decisions}, sys.stdout)


if __name__ == "__main__":
    main()
