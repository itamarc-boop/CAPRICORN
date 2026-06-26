"""Regression tests for the deterministic ICP scorer (tools/score_company.py).

score_company() is pure (no API calls, same input -> same output) and is the
qualify-or-drop decision the whole pipeline hinges on, so a silent regression
here changes who gets emailed. These tests lock its behaviour against the
module's own worked examples and exercise the gate / tier-cap / judge-override
branches. No API keys required — safe to run in CI.

Run:  pytest tools/test_score_company.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402
from score_company import score_company, sort_companies, _SAMPLES, _ev  # noqa: E402

# Expected (gate_passed, tier) per worked example, locked to current behaviour.
EXPECTED = {
    "Iberian Pet Supplies S.L.": (True, "Tier 1"),
    "Greenfield Supplies Ltd": (True, "Tier 2"),
    "Plasticos del Sur S.A.": (True, "Tier 3"),
    "Fabrica Total SL": (False, None),
    "MultiBrand Distributors Ltd": (True, "Tier 3"),
    "Ghost Membranes Srl": (False, None),
    "PackAll GmbH": (True, "Tier 2"),
    "GlobalCorp Manufacturing": (False, None),
    "BrightReach Marketing": (False, None),
    "Mumbai Cosmetics Pvt Ltd": (False, None),
}

T1 = next(c for c in _SAMPLES if c["name"] == "Iberian Pet Supplies S.L.")


@pytest.mark.parametrize("sample", _SAMPLES, ids=lambda s: s["name"])
def test_worked_example_tier(sample):
    r = score_company(sample)
    exp_gate, exp_tier = EXPECTED[sample["name"]]
    assert r["gate_passed"] is exp_gate
    assert r["tier"] == exp_tier
    assert r["qualified"] is (exp_tier is not None)


def test_deterministic():
    """Same input twice -> identical output (the docstring's core promise)."""
    assert [score_company(c) for c in _SAMPLES] == [score_company(c) for c in _SAMPLES]


def test_dropped_have_no_tier():
    for c in _SAMPLES:
        r = score_company(c)
        if not r["gate_passed"]:
            assert r["tier"] is None and r["qualified"] is False


def test_total_score_within_bounds():
    for c in _SAMPLES:
        score = score_company(c).get("total_score")
        if score is not None:
            assert 0 <= score <= 100


def test_tier1_requires_own_brand_evidence():
    """The only Tier 1 path is quoted imports + own-brand + core fit. Strip the
    own-brand evidence from the clean Tier-1 sample and the cap must demote it."""
    weakened = {**T1, "evidence": _ev(
        imports="yes", own_brand="unknown", fit="core", vertical="pet-food",
        model="importer", iq="importamos desde Asia contenedores")}
    assert score_company(weakened)["tier"] != "Tier 1"


def test_bdr_judge_reject_overrides_qualified():
    rejected = {**T1, "bdr_judgment": {
        "verdict": "reject", "matched_pattern": "known-reject",
        "reason": "client confirmed not a buyer"}}
    r = score_company(rejected)
    assert r["gate_passed"] is False and r["qualified"] is False


def test_bdr_judge_downgrade_to_t3():
    downgraded = {**T1, "bdr_judgment": {
        "verdict": "t3", "matched_pattern": "weak-fit", "reason": "smaller than it looks"}}
    assert score_company(downgraded)["tier"] == "Tier 3"


def test_sort_orders_best_tier_first():
    ordered = sort_companies([score_company(c) for c in _SAMPLES])
    rank = {"Tier 1": 0, "Tier 2": 1, "Tier 3": 2}
    ranks = [rank[r["tier"]] for r in ordered if r.get("tier") in rank]
    assert ranks == sorted(ranks)
