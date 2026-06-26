"""Guards the eval de-contamination (tools/eval_against_labels.py).

The BDR judge embeds up to FEW_SHOT_COUNT labelled companies (name + correct
verdict) in its prompt, so the must-not-regress T1 metric must be measured on
HELD-OUT labels only. These tests assert the few-shot companies are excluded
from the scored set. No API call — judged={} skips the live judge.

Run:  pytest tools/test_eval_holdout.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_against_labels import load_all_labels, run_eval  # noqa: E402


def test_few_shot_companies_excluded_from_scoring():
    labels = load_all_labels()
    assert len(labels) > 0, "label fixtures (feedback/iteration_*_labels.json) missing"
    rep = run_eval(labels, {}, judged={})  # judged={} -> no live judge call
    assert rep["few_shot_excluded"] > 0, "few-shot block should overlap the labels"
    assert rep["held_out_labels"] == rep["total_labels"] - rep["few_shot_excluded"]
    assert rep["held_out_labels"] > 0, "must score a non-empty held-out set"


def test_disabling_exclusion_scores_all_labels():
    labels = load_all_labels()
    rep = run_eval(labels, {}, judged={}, exclude_few_shot=False)
    assert rep["few_shot_excluded"] == 0
    assert rep["held_out_labels"] == rep["total_labels"]
