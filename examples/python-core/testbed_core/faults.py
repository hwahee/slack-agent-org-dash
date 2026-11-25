"""Fault decisions, in the same order as the common runtime's `FaultDecider`
(docs/testbed/external-core-protocol.md §9, docs/testbed/faults-and-seed.md §1).

Rules are checked in order: skip a rule whose `times` are used up, skip one
whose `match` does not fit the selector, roll `next()` once only when
`probability < 1` (skip on `>= probability`); the first rule left applies,
with one `int()` roll only when `delayMs` is a range.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from .rng import SeededRng

FaultDecision = dict[str, Any]
#: Called for every decision that applies a rule: (decision, selector, correlation_id).
InjectedHandler = Callable[[FaultDecision, dict[str, Any], Optional[str]], None]


def _matches(rule: dict[str, Any], selector: dict[str, Any]) -> bool:
    match = rule.get("match")
    if not match:
        return True
    return all(selector.get(key) == value for key, value in match.items())


class FaultDecider:
    def __init__(
        self,
        rng: Callable[[], SeededRng],
        on_injected: Optional[InjectedHandler] = None,
    ) -> None:
        self._rng = rng
        self._on_injected = on_injected
        self._rules: list[dict[str, Any]] = []
        self._applied: dict[str, int] = {}

    def set_rules(self, rules: list[dict[str, Any]]) -> None:
        self._rules = list(rules)
        self._applied.clear()

    def reset(self) -> None:
        """Forgets how often each rule was applied (`times` starts over)."""
        self._applied.clear()

    def decide(
        self, selector: dict[str, Any], correlation_id: Optional[str] = None
    ) -> Optional[FaultDecision]:
        for rule in self._rules:
            rule_id = rule["id"]
            count = self._applied.get(rule_id, 0)
            times = rule.get("times")
            if times is not None and count >= times:
                continue
            if not _matches(rule, selector):
                continue
            probability = rule.get("probability", 1)
            if probability < 1 and self._rng().next() >= probability:
                continue

            self._applied[rule_id] = count + 1
            decision: FaultDecision = {"ruleId": rule_id}
            delay = rule.get("delayMs")
            if delay is not None:
                decision["delayMs"] = (
                    delay if isinstance(delay, int) else self._rng().int(delay["min"], delay["max"])
                )
            if rule.get("error") is not None:
                decision["error"] = rule["error"]
            if rule.get("disconnect"):
                decision["disconnect"] = True
            if rule.get("corrupt"):
                decision["corrupt"] = True
            if self._on_injected:
                self._on_injected(decision, selector, correlation_id)
            return decision
        return None
