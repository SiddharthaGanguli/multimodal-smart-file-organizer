"""Check generated factual relationships and prevent misleading dataset metadata."""

import json
import random
from collections import Counter, defaultdict
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from time import strptime

import pytest

from training.synthetic_documents import (
    CATEGORIES,
    CONTEXT_BUILDERS,
    DISCLAIMER,
    TEMPLATES,
    _base,
    generate_documents,
)


def amount(value: str) -> Decimal:
    return Decimal(value.removeprefix("INR ").replace(",", ""))


def calendar_day(value: str) -> date:
    return date(*strptime(value, "%d %B %Y")[:3])


def contexts(label: str):
    # Probe many amounts and combinations independently of one released seed.
    for seed in range(100):
        rng = random.Random(seed)
        context = _base(rng)
        CONTEXT_BUILDERS[label](rng, context)
        yield context


def test_generated_dataset_is_reproducible_and_expansion_preserves_documents():
    small = list(generate_documents(seed=42, per_template=1))
    assert small == list(generate_documents(seed=42, per_template=1))
    larger = {item["document_id"]: item for item in generate_documents(42, 2)}
    assert all(larger[item["document_id"]] == item for item in small)
    assert {item["document_id"] for item in small}.isdisjoint(
        item["document_id"] for item in generate_documents(43, 1)
    )


def test_default_dataset_has_honest_provenance_and_shared_layout_groups():
    documents = list(generate_documents())
    assert len(documents) == 1600
    assert len({item["document_id"] for item in documents}) == 1600
    assert len({item["text"] for item in documents}) == 1600
    assert Counter(item["label"] for item in documents) == dict.fromkeys(CATEGORIES, 200)
    groups = defaultdict(set)
    for item in documents:
        assert item["text"].startswith(DISCLAIMER)
        assert item["is_synthetic"] is True
        assert item["review_status"] == "synthetic_rule_labeled"
        assert item["source_id"] == "filewise_synthetic_v1"
        assert item["language"] == "en"
        assert item["category"] == CATEGORIES[item["label"]]
        assert len(item["document_id"]) == 24
        assert set(item["document_id"]) <= set("0123456789abcdef")
        groups[item["group_id"]].add(item["label"])
    assert len(groups) == 10
    assert all(labels == set(CATEGORIES) for labels in groups.values())
    assert all(len(templates) == 10 for templates in TEMPLATES.values())


def test_document_categories_match_the_label_guide():
    guide = Path(__file__).resolve().parents[1] / "training" / "categories.json"
    categories = json.loads(guide.read_text(encoding="utf-8"))["categories"]
    assert {entry["label"]: entry["category"] for entry in categories} == CATEGORIES


def test_subject_marks_totals_and_pass_rules_agree():
    for context in contexts("marksheet"):
        rows = [row.split(" | ") for row in context["marks"].splitlines()[1:]]
        marks = [int(row[2]) for row in rows]
        maximum = sum(int(row[1]) for row in rows)
        assert sum(marks) == int(context["total"])
        assert maximum == int(context["maximum"])
        assert all(0 <= mark <= int(row[1]) for mark, row in zip(marks, rows))
        assert Decimal(context["percent"].rstrip("%")) == (
            Decimal(sum(marks)) * 100 / maximum
        ).quantize(Decimal("0.01"))
        assert (context["result"] == "Pass") == all(mark >= 40 for mark in marks)
        assert all((row[3] == "Pass") == (int(row[2]) >= 40) for row in rows)


def test_invoice_line_prices_discounts_tax_rounding_and_total():
    saw_half_paise = False
    for context in contexts("invoice"):
        line_totals = []
        for row in context["items"].splitlines()[1:]:
            _, quantity, price, line_total = row.split(" | ")
            assert int(quantity) * amount(price) == amount(line_total)
            line_totals.append(amount(line_total))
        subtotal = sum(line_totals)
        assert amount(context["subtotal"]) == subtotal
        discount = subtotal * Decimal(context["discount_percent"]) / 100
        assert amount(context["discount"]) == discount
        net = subtotal - discount
        assert amount(context["net"]) == net
        raw_tax = net * Decimal("0.10")
        saw_half_paise |= raw_tax % Decimal("0.01") == Decimal("0.005")
        tax = raw_tax.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        assert amount(context["tax"]) == tax
        assert amount(context["total"]) == net + tax
    assert saw_half_paise, "The probe must exercise a half-paise rounding case."


def test_utility_meter_usage_and_amount_due_reconcile():
    for context in contexts("utility_bill"):
        usage = int(context["current"]) - int(context["previous"])
        assert usage == int(context["usage"]) > 0
        usage_charge = usage * amount(context["rate"])
        assert amount(context["usage_charge"]) == usage_charge
        total = (
            usage_charge + amount(context["fixed_charge"])
            + amount(context["arrears"]) - amount(context["credit"])
        )
        assert amount(context["total"]) == total > 0


def test_receipts_record_completed_payment_and_valid_change():
    for context in contexts("receipt"):
        received = amount(context["tendered"]) - amount(context["change"])
        assert amount(context["amount"]) == received > 0
        assert amount(context["outstanding"]) == 0
        assert amount(context["change"]) >= 0
        if context["method"] != "cash":
            assert amount(context["change"]) == 0


def test_bank_running_balances_totals_and_statement_dates_reconcile():
    for context in contexts("bank_statement"):
        balance = amount(context["opening"])
        credits = Decimal(0)
        debits = Decimal(0)
        start = calendar_day(context["start"])
        end = calendar_day(context["end"])
        previous_date = start
        for row in context["transactions"].splitlines()[1:]:
            posted, _, debit, credit, running = row.split(" | ")
            posted_date = calendar_day(posted)
            assert previous_date <= posted_date <= end
            previous_date = posted_date
            credits += amount(credit)
            debits += amount(debit)
            balance += amount(credit) - amount(debit)
            assert amount(running) == balance >= 0
        assert credits == amount(context["deposits"])
        assert debits == amount(context["withdrawals"])
        assert balance == amount(context["closing"])
        assert end < calendar_day(context["date"])


def test_land_area_matches_dimensions_and_records_are_unambiguously_mock():
    for context in contexts("land_record"):
        assert int(context["area"].replace(",", "")) == (
            int(context["width"]) * int(context["depth"])
        )
        assert context["parcel"].startswith("EXAMPLE-VOID-")
        assert context["person"].startswith("Sample Person ")


def test_educational_completion_dates_and_prescription_placeholder_counts():
    for context in contexts("educational_certificate"):
        start, end, issued = (
            calendar_day(context[key]) for key in ("start", "end", "date")
        )
        assert start < end < issued
        assert int(context["hours"]) > 0
    for context in contexts("prescription"):
        entries = context["medicines"].splitlines()
        assert len(entries) == int(context["count"])
        assert all("Fictional Medicine" in entry for entry in entries)
        assert all("dose, route, frequency and duration omitted" in entry for entry in entries)


@pytest.mark.parametrize("seed,per_template", [(True, 1), ("42", 1), (42, False), (42, 1.5)])
def test_invalid_argument_types_fail_explicitly(seed, per_template):
    with pytest.raises(TypeError):
        list(generate_documents(seed, per_template))


@pytest.mark.parametrize("per_template", [0, -1])
def test_nonpositive_template_counts_fail_explicitly(per_template):
    with pytest.raises(ValueError):
        list(generate_documents(per_template=per_template))
