"""SeededRng and FaultDecider (docs/testbed/external-core-protocol.md §9).
That they match Bun value for value is checked from `bun test`
(src/server/testbed/external/python-parity.integration.test.ts)."""

from __future__ import annotations

import unittest

from tests import helpers  # noqa: F401 — puts testbed_core on the path
from testbed_core import FaultDecider, SeededRng


class SeededRngTest(unittest.TestCase):
    def test_same_seed_same_sequence(self) -> None:
        a, b = SeededRng("seed"), SeededRng("seed")
        self.assertEqual([a.next() for _ in range(50)], [b.next() for _ in range(50)])
        self.assertNotEqual(SeededRng("seed").next(), SeededRng("other").next())

    def test_ranges(self) -> None:
        rng = SeededRng("ranges")
        for _ in range(2000):
            value = rng.next()
            self.assertGreaterEqual(value, 0)
            self.assertLess(value, 1)
            self.assertIn(rng.int(3, 5), (3, 4, 5))


class FaultDeciderTest(unittest.TestCase):
    def decider(self, seed: str = "f") -> tuple[FaultDecider, list[tuple[str, dict, str | None]]]:
        rng = SeededRng(seed)
        seen: list[tuple[str, dict, str | None]] = []
        decider = FaultDecider(lambda: rng, lambda decision, selector, cid: seen.append((decision["ruleId"], selector, cid)))
        return decider, seen

    def test_first_matching_rule_and_times(self) -> None:
        decider, seen = self.decider()
        decider.set_rules(
            [
                {"id": "only-c2", "match": {"connId": "c-2"}, "disconnect": True},
                {"id": "twice", "times": 2, "corrupt": True},
            ]
        )
        self.assertEqual(decider.decide({"connId": "c-2"}, "c-2"), {"ruleId": "only-c2", "disconnect": True})
        self.assertEqual(decider.decide({"connId": "c-1"}), {"ruleId": "twice", "corrupt": True})
        self.assertEqual(decider.decide({"connId": "c-1"}), {"ruleId": "twice", "corrupt": True})
        self.assertIsNone(decider.decide({"connId": "c-1"}))
        self.assertEqual(seen[0], ("only-c2", {"connId": "c-2"}, "c-2"))
        decider.reset()
        self.assertEqual(decider.decide({"connId": "c-1"}), {"ruleId": "twice", "corrupt": True})

    def test_set_rules_restarts_counts(self) -> None:
        decider, _ = self.decider()
        rules = [{"id": "once", "times": 1, "error": "e"}]
        decider.set_rules(rules)
        self.assertIsNotNone(decider.decide({}))
        self.assertIsNone(decider.decide({}))
        decider.set_rules(rules)
        self.assertIsNotNone(decider.decide({}))

    def test_probability_and_delay_range(self) -> None:
        decider, _ = self.decider("p")
        decider.set_rules([{"id": "half", "probability": 0.5, "delayMs": {"min": 10, "max": 20}}])
        decisions = [decider.decide({}) for _ in range(400)]
        applied = [decision for decision in decisions if decision]
        self.assertTrue(120 < len(applied) < 280)
        self.assertTrue(all(10 <= decision["delayMs"] <= 20 for decision in applied))

    def test_probability_zero_never_and_fixed_delay(self) -> None:
        decider, _ = self.decider()
        decider.set_rules([{"id": "never", "probability": 0, "error": "x"}, {"id": "fixed", "delayMs": 5}])
        self.assertEqual(decider.decide({}), {"ruleId": "fixed", "delayMs": 5})


if __name__ == "__main__":
    unittest.main()
