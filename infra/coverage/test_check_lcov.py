#!/usr/bin/env python3
"""Focused tests for the #313 workspace coverage gate.

Run them with::

    python3 -B -m unittest discover -s infra/coverage -p 'test_check_lcov.py'

or directly with ``python3 -B infra/coverage/test_check_lcov.py``. The tests
use only the Python standard library and never touch a database, a network or
a live credential.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import check_lcov  # noqa: E402  (the module under test lives next to this file)

SPECS = {spec.name: spec for spec in check_lcov.WORKSPACES}
METRICS = check_lcov.METRICS


def metric(covered: int, total: int) -> dict:
    """One coverage-summary metric object."""
    return {
        "total": total,
        "covered": covered,
        "skipped": 0,
        "pct": round(covered * 100.0 / total, 2) if total else 100,
    }


def default_entry(
    lines=(19, 20), branches=(95, 100), functions=(19, 20)
) -> dict:
    """One coverage-summary source entry in the provider's shape."""
    line_hit, line_total = lines
    branch_hit, branch_total = branches
    function_hit, function_total = functions
    return {
        "lines": metric(line_hit, line_total),
        "branches": metric(branch_hit, branch_total),
        "functions": metric(function_hit, function_total),
        "statements": metric(line_hit, line_total),
    }


def lcov_record(
    source: str = "src/example.ts",
    lines=(19, 20),
    branches=(95, 100),
    functions=(19, 20),
    names=None,
) -> str:
    """One source record in the provider's format.

    The ``DA``, ``BRDA``, ``FN`` and ``FNDA`` detail entries are generated so
    that they agree with the six summary counters, exactly like a report the
    coverage provider writes. Function names default to unique values; pass
    ``names`` to exercise legitimate repeated names.
    """
    line_hit, line_total = lines
    branch_hit, branch_total = branches
    function_hit, function_total = functions
    if names is None:
        names = [f"example{index}" for index in range(function_total)]
    if len(names) != function_total:
        raise ValueError("names must cover every declared function")
    parts = ["TN:", f"SF:{source}"]
    for index, name in enumerate(names):
        parts.append(f"FN:{index + 1},{name}")
    parts.append(f"FNF:{function_total}")
    parts.append(f"FNH:{function_hit}")
    for index, name in enumerate(names):
        parts.append(f"FNDA:{1 if index < function_hit else 0},{name}")
    for index in range(line_total):
        parts.append(f"DA:{index + 1},{1 if index < line_hit else 0}")
    parts.append(f"LF:{line_total}")
    parts.append(f"LH:{line_hit}")
    for index in range(branch_total):
        parts.append(f"BRDA:{index + 1},0,0,{1 if index < branch_hit else 0}")
    parts.append(f"BRF:{branch_total}")
    parts.append(f"BRH:{branch_hit}")
    parts.append("end_of_record")
    return "\n".join(parts) + "\n"


def fixture_records(text: str) -> dict:
    """An independent minimal parser used only to build paired JSON fixtures."""
    records = {}
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("SF:"):
            current = line[3:].strip()
            records[current] = {
                "lines": [0, 0],
                "branches": [0, 0],
                "functions": [0, 0],
            }
        elif current is None:
            continue
        elif line.startswith("LF:"):
            records[current]["lines"][1] = int(line.split(":", 1)[1])
        elif line.startswith("LH:"):
            records[current]["lines"][0] = int(line.split(":", 1)[1])
        elif line.startswith("BRF:"):
            records[current]["branches"][1] = int(line.split(":", 1)[1])
        elif line.startswith("BRH:"):
            records[current]["branches"][0] = int(line.split(":", 1)[1])
        elif line.startswith("FNF:"):
            records[current]["functions"][1] = int(line.split(":", 1)[1])
        elif line.startswith("FNH:"):
            records[current]["functions"][0] = int(line.split(":", 1)[1])
    return records


def summary_data(root: str, spec: check_lcov.WorkspaceSpec, records: dict) -> dict:
    """Build the aggregate-plus-per-source object a Vitest summary contains."""
    data = {}
    aggregate = {name: [0, 0] for name in METRICS}
    for source, values in records.items():
        entry = {}
        for name in METRICS:
            covered, total = values[name]
            entry[name] = metric(covered, total)
            aggregate[name][0] += covered
            aggregate[name][1] += total
        entry["statements"] = metric(values["lines"][0], values["lines"][1])
        key = os.path.join(root, spec.directory, *source.split("/"))
        data[key] = entry
    total = {name: metric(*aggregate[name]) for name in METRICS}
    total["statements"] = metric(aggregate["lines"][0], aggregate["lines"][1])
    total["branchesTrue"] = metric(0, 0)
    data["total"] = total
    return data


def summary_text(root: str, spec: check_lcov.WorkspaceSpec, records: dict) -> str:
    return json.dumps(summary_data(root, spec, records), indent=2) + "\n"


def write_report(root: str, relative_path: str, text) -> None:
    path = os.path.join(root, relative_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(text, bytes) else "w"
    with open(path, mode) as handle:
        handle.write(text)


def write_workspace(
    root: str,
    spec: check_lcov.WorkspaceSpec,
    lcov_text: str,
    summary=None,
) -> None:
    """Write a paired workspace artifact below ``root``."""
    write_report(root, spec.lcov_path, lcov_text)
    if summary is None:
        summary = summary_data(root, spec, fixture_records(lcov_text))
    elif isinstance(summary, dict) and "total" not in summary:
        summary = summary_data(root, spec, summary)
    text = summary if isinstance(summary, str) else json.dumps(summary, indent=2) + "\n"
    write_report(root, spec.summary_path, text)


#: A small record in the provider's exact format: two functions, two lines and
#: two branches, each with one covered item.
VALID_SMALL_RECORD = """TN:
SF:src/example.ts
FN:1,alpha
FN:2,beta
FNF:2
FNH:1
FNDA:3,alpha
FNDA:0,beta
DA:1,1
DA:2,0
LF:2
LH:1
BRDA:1,0,0,1
BRDA:1,0,1,0
BRF:2
BRH:1
end_of_record
"""

VALID_SMALL_REPORT = VALID_SMALL_RECORD

#: A record with no instrumented item: no detail entries and zero counters.
VALID_EMPTY_METRIC_RECORD = """TN:
SF:src/vite-env.d.ts
FNF:0
FNH:0
LF:0
LH:0
BRF:0
BRH:0
end_of_record
"""

#: A report that sits exactly on the floor for every metric.
PASSING_REPORT = lcov_record()

#: A generic paired summary for malformed-LCOV cases where the fixture parser
#: cannot derive counters from the report itself.
GENERIC_RECORDS = {
    "src/example.ts": {
        "lines": (1, 1),
        "branches": (0, 0),
        "functions": (0, 0),
    }
}

#: A summary counter before any source record.
ORPHAN_COUNTER_REPORT = """LF:2
LH:1
TN:
SF:src/example.ts
FNF:0
FNH:0
LF:2
LH:1
BRF:0
BRH:0
end_of_record
"""

#: A summary counter after a closed source record.
TRAILING_COUNTER_REPORT = VALID_SMALL_RECORD + "LF:2\n"

#: A detail entry before any source record.
ORPHAN_DETAIL_REPORT = """DA:1,1
TN:
SF:src/example.ts
FNF:0
FNH:0
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: A detail entry after a closed source record.
TRAILING_DETAIL_REPORT = VALID_SMALL_RECORD + "DA:9,1\n"

#: A source record without a source name.
EMPTY_SOURCE_REPORT = """TN:
SF:
FNF:0
FNH:0
LF:0
LH:0
BRF:0
BRH:0
end_of_record
"""

#: One DA entry fewer than the LF total.
MISSING_DA_DETAIL_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
DA:1,1
LF:2
LH:1
BRF:0
BRH:0
end_of_record
"""

#: The DA entries cover fewer lines than the LH total claims.
CONTRADICTORY_DA_HITS_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
DA:1,0
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: One BRDA entry fewer than the BRF total.
MISSING_BRDA_DETAIL_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:0
LH:0
BRDA:1,0,0,1
BRF:2
BRH:1
end_of_record
"""

#: The BRDA entries cover fewer branches than the BRH total claims.
CONTRADICTORY_BRDA_HITS_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:0
LH:0
BRDA:1,0,0,0
BRF:1
BRH:1
end_of_record
"""

#: One FN declaration fewer than the FNF total.
MISSING_FN_DECLARATION_REPORT = """TN:
SF:src/example.ts
FN:1,alpha
FNF:2
FNH:1
FNDA:3,alpha
DA:1,1
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: One FNDA execution fewer than the FNF total.
MISSING_FNDA_EXECUTION_REPORT = """TN:
SF:src/example.ts
FN:1,alpha
FN:2,beta
FNF:2
FNH:1
FNDA:3,alpha
DA:1,1
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: The FNDA executions cover fewer functions than the FNH total claims.
CONTRADICTORY_FN_HITS_REPORT = """TN:
SF:src/example.ts
FN:1,alpha
FNF:1
FNH:1
FNDA:0,alpha
DA:1,1
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: Two function declarations but only one declared name, and the executions
#: cover a different name. Counts and hit totals are otherwise success-shaped.
UNMATCHED_FUNCTION_REPORT = """TN:
SF:src/example.ts
FN:1,alpha
FN:2,alpha
FNF:2
FNH:1
FNDA:3,alpha
FNDA:0,beta
DA:1,1
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: The provider's repeated function names are legitimate. Declarations and
#: executions carry the same two names and the same hit counts. The 19/20
#: ratio also meets the 95% floor so the full CLI can accept it.
REPEATED_FUNCTION_REPORT = lcov_record(
    functions=(19, 20), names=["alpha"] * 20
)

#: Two DA records for one line, with counters shaped to make the old gate pass.
DUPLICATE_DA_LINE_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
DA:1,1
DA:1,1
LF:2
LH:2
BRF:0
BRH:0
end_of_record
"""

#: The same duplicate DA identity with conflicting hit values.
CONFLICTING_DUPLICATE_DA_LINE_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
DA:1,0
DA:1,1
LF:2
LH:1
BRF:0
BRH:0
end_of_record
"""

#: The same BRDA (line, block, branch) identity twice, with success-shaped
#: summary counters.
DUPLICATE_BRDA_IDENTITY_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:0
LH:0
BRDA:1,0,0,1
BRDA:1,0,0,1
BRF:2
BRH:2
end_of_record
"""

#: Two distinct branch numbers on the same line and block are legitimate.
DISTINCT_BRANCHES_ON_ONE_LINE_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:1
LH:1
DA:1,1
BRDA:1,0,0,1
BRDA:1,0,1,0
BRF:2
BRH:1
end_of_record
"""

#: A summary counter that is not an unsigned integer.
MALFORMED_COUNTER_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:abc
LH:1
BRF:0
BRH:0
end_of_record
"""

#: A summary counter with more digits than any real counter carries.
OVERSIZED_COUNTER_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:999999999999999999999999999999
LH:1
BRF:0
BRH:0
end_of_record
"""

#: A detail entry whose shape is not valid.
MALFORMED_DETAIL_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
DA:not-a-line
LF:1
LH:1
BRF:0
BRH:0
end_of_record
"""

#: A record type the parser does not know.
UNSUPPORTED_RECORD_REPORT = """TN:
SF:src/example.ts
ZZ:<script>alert(1)</script>
FNF:0
FNH:0
LF:0
LH:0
BRF:0
BRH:0
end_of_record
"""

#: The same summary counter twice in one record.
DUPLICATE_TOTAL_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:2
LF:2
LH:1
BRF:0
BRH:0
end_of_record
"""

#: The same source twice in one report.
REPEATED_SOURCE_REPORT = VALID_SMALL_RECORD + VALID_SMALL_RECORD

#: More covered items than total items.
HITS_ABOVE_TOTAL_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
DA:1,1
LF:1
LH:2
BRF:0
BRH:0
end_of_record
"""

#: A record without one of its summary counters.
INCOMPLETE_RECORD_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:1
BRF:0
BRH:0
end_of_record
"""

#: A report whose last record is never closed.
UNTERMINATED_RECORD_REPORT = """TN:
SF:src/example.ts
FNF:0
FNH:0
LF:1
LH:1
BRF:0
BRH:0
"""

#: A report without any source record.
NO_SOURCE_RECORD_REPORT = "TN:\n"

#: Bytes that are not valid UTF-8.
INVALID_UTF8_REPORT = b"TN:\nSF:src/example.ts\nLF:\xff\xfe\n"


def run_cli(root: str, report_path: str = None):
    """Run the CLI and return ``(exit code, stdout, stderr)``."""
    argv = [root]
    if report_path is not None:
        argv += ["--report", report_path]
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = check_lcov.main(argv)
    return code, stdout.getvalue(), stderr.getvalue()


def build_tree(root: str, overrides=None) -> str:
    """Create the six workspace artifact pairs below ``root``.

    ``overrides`` maps a workspace name to either the LCOV text or a
    ``(lcov_text, summary)`` pair, where ``summary`` may be an object, JSON
    text or ``None`` to derive it from the LCOV counters. A value of ``None``
    leaves that workspace without any artifact.
    """
    overrides = overrides or {}
    for spec in check_lcov.WORKSPACES:
        value = overrides.get(spec.name, PASSING_REPORT)
        if value is None:
            continue
        if isinstance(value, tuple):
            lcov_text, summary = value
        else:
            lcov_text, summary = value, None
        write_workspace(root, spec, lcov_text, summary)
    return root


class ParserTests(unittest.TestCase):
    """The LCOV parser and its rejection rules."""

    def test_parses_a_valid_record_in_the_provider_format(self):
        records = check_lcov.parse_lcov(VALID_SMALL_REPORT, "sample")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].source, "src/example.ts")
        self.assertEqual(records[0].lines, (1, 2))
        self.assertEqual(records[0].branches, (1, 2))
        self.assertEqual(records[0].functions, (1, 2))

    def test_parses_a_record_without_any_instrumented_item(self):
        records = check_lcov.parse_lcov(VALID_EMPTY_METRIC_RECORD, "sample")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].lines, (0, 0))
        self.assertEqual(records[0].branches, (0, 0))
        self.assertEqual(records[0].functions, (0, 0))

    def test_accepts_genuinely_repeated_function_names(self):
        records = check_lcov.parse_lcov(REPEATED_FUNCTION_REPORT, "sample")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].functions, (19, 20))

    def test_rejects_unmatched_function_names(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(UNMATCHED_FUNCTION_REPORT, "s")
        self.assertIn(
            "FNDA executions that do not match its FN declarations",
            str(caught.exception),
        )

    def test_rejects_a_duplicate_da_line_identity(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(DUPLICATE_DA_LINE_REPORT, "s")
        self.assertIn("repeats its DA line 1", str(caught.exception))

    def test_rejects_a_duplicate_da_line_with_conflicting_hits(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(CONFLICTING_DUPLICATE_DA_LINE_REPORT, "s")
        self.assertIn("repeats its DA line 1", str(caught.exception))

    def test_rejects_a_duplicate_brda_identity(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(DUPLICATE_BRDA_IDENTITY_REPORT, "s")
        self.assertIn("repeats its BRDA branch (1,0,0)", str(caught.exception))

    def test_accepts_distinct_branch_numbers_on_one_line(self):
        records = check_lcov.parse_lcov(DISTINCT_BRANCHES_ON_ONE_LINE_REPORT, "s")
        self.assertEqual(records[0].branches, (1, 2))

    def test_rejects_a_counter_outside_a_source_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(ORPHAN_COUNTER_REPORT, "s")
        self.assertIn("LF record outside a source record", str(caught.exception))

    def test_rejects_a_detail_entry_outside_a_source_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(ORPHAN_DETAIL_REPORT, "s")
        self.assertIn("DA record outside a source record", str(caught.exception))

    def test_rejects_a_counter_after_a_closed_source_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(TRAILING_COUNTER_REPORT, "s")
        self.assertIn("LF record after a closed source record", str(caught.exception))

    def test_rejects_a_detail_entry_after_a_closed_source_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(TRAILING_DETAIL_REPORT, "s")
        self.assertIn("DA record after a closed source record", str(caught.exception))

    def test_rejects_an_empty_source(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(EMPTY_SOURCE_REPORT, "s")
        self.assertIn("empty source path", str(caught.exception))

    def test_rejects_an_absolute_source(self):
        report = VALID_SMALL_RECORD.replace("SF:src/example.ts", "SF:/tmp/example.ts")
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(report, "s")
        self.assertIn("must be relative", str(caught.exception))

    def test_rejects_an_ambiguous_source_path(self):
        report = VALID_SMALL_RECORD.replace("SF:src/example.ts", "SF:src/./example.ts")
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(report, "s")
        self.assertIn("ambiguous", str(caught.exception))

    def test_rejects_missing_line_details(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(MISSING_DA_DETAIL_REPORT, "s")
        self.assertIn("disagrees with its LF/LH summary counters", str(caught.exception))

    def test_rejects_contradictory_line_hits(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(CONTRADICTORY_DA_HITS_REPORT, "s")
        self.assertIn("disagrees with its LF/LH summary counters", str(caught.exception))

    def test_rejects_missing_branch_details(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(MISSING_BRDA_DETAIL_REPORT, "s")
        self.assertIn("disagrees with its BRF/BRH summary counters", str(caught.exception))

    def test_rejects_contradictory_branch_hits(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(CONTRADICTORY_BRDA_HITS_REPORT, "s")
        self.assertIn("disagrees with its BRF/BRH summary counters", str(caught.exception))

    def test_rejects_missing_function_declarations(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(MISSING_FN_DECLARATION_REPORT, "s")
        self.assertIn("disagrees with its FNF/FNH summary counters", str(caught.exception))

    def test_rejects_missing_function_executions(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(MISSING_FNDA_EXECUTION_REPORT, "s")
        self.assertIn("disagrees with its FNF/FNH summary counters", str(caught.exception))

    def test_rejects_contradictory_function_hits(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(CONTRADICTORY_FN_HITS_REPORT, "s")
        self.assertIn("disagrees with its FNF/FNH summary counters", str(caught.exception))

    def test_rejects_a_malformed_counter_value(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(MALFORMED_COUNTER_REPORT, "s")
        self.assertIn("malformed LF value", str(caught.exception))

    def test_rejects_an_oversized_counter_value(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(OVERSIZED_COUNTER_REPORT, "s")
        self.assertIn("malformed LF value", str(caught.exception))

    def test_rejects_a_malformed_detail_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(MALFORMED_DETAIL_REPORT, "s")
        self.assertIn("malformed 'DA' record", str(caught.exception))

    def test_rejects_an_unsupported_record_without_echoing_its_tag(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(UNSUPPORTED_RECORD_REPORT, "s")
        message = str(caught.exception)
        self.assertIn("unsupported record type", message)
        self.assertNotIn("ZZ", message)
        self.assertNotIn("script", message)

    def test_rejects_duplicate_totals(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(DUPLICATE_TOTAL_REPORT, "s")
        self.assertIn("repeats its LF total", str(caught.exception))

    def test_rejects_a_repeated_source(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(REPEATED_SOURCE_REPORT, "s")
        self.assertIn("repeated source 'src/example.ts'", str(caught.exception))

    def test_rejects_hits_above_the_total(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(HITS_ABOVE_TOTAL_REPORT, "s")
        self.assertIn("reports 2 covered lines but only 1 total", str(caught.exception))

    def test_rejects_an_incomplete_record_missing_a_total(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(INCOMPLETE_RECORD_REPORT, "s")
        self.assertIn("missing its LH total", str(caught.exception))

    def test_rejects_a_record_without_end_of_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(UNTERMINATED_RECORD_REPORT, "s")
        self.assertIn("not terminated by end_of_record", str(caught.exception))

    def test_rejects_a_report_without_any_source_record(self):
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(NO_SOURCE_RECORD_REPORT, "s")
        self.assertIn("contains no source record", str(caught.exception))

    def test_preserves_the_raw_source_identity(self):
        source = "src/a|b](evil<script>.ts"
        records = check_lcov.parse_lcov(lcov_record(source), "s")
        self.assertEqual(records[0].source, source)

    def test_sanitizes_a_source_path_only_in_diagnostics(self):
        source = "src/a|b](evil<script>.ts"
        report = lcov_record(source) + lcov_record(source)
        with self.assertRaises(check_lcov.LcovError) as caught:
            check_lcov.parse_lcov(report, "s")
        message = str(caught.exception)
        self.assertIn("src/a_b__evil_script_.ts", message)
        self.assertNotIn("|", message)
        self.assertNotIn("<", message)
        self.assertNotIn(">", message)


class WorkspaceLoadingTests(unittest.TestCase):
    """Report discovery, path normalization and the paired-artifact checks."""

    def test_aggregates_every_record_of_a_workspace(self):
        report = lcov_record("src/a.ts", lines=(9, 10)) + lcov_record(
            "src/b.ts", lines=(9, 10)
        )
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], report)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertTrue(workspace.valid, workspace.error)
        self.assertEqual(workspace.totals["lines"], (18, 20))

    def test_rejects_a_missing_lcov_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_report(
                tmp,
                SPECS["mcp"].summary_path,
                summary_text(tmp, SPECS["mcp"], fixture_records(PASSING_REPORT)),
            )
            workspace = check_lcov.load_workspace(tmp, SPECS["mcp"])
        self.assertFalse(workspace.valid)
        self.assertEqual(workspace.kind, "missing")
        self.assertIn("report file is missing", workspace.error)

    def test_rejects_a_missing_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_report(tmp, SPECS["mcp"].lcov_path, PASSING_REPORT)
            workspace = check_lcov.load_workspace(tmp, SPECS["mcp"])
        self.assertFalse(workspace.valid)
        self.assertEqual(workspace.kind, "missing")
        self.assertIn("summary file is missing", workspace.error)

    def test_rejects_an_empty_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], "\n\n")
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertEqual(workspace.kind, "empty")
        self.assertIn("report file is empty", workspace.error)

    def test_rejects_an_empty_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, "\n")
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertEqual(workspace.kind, "empty")
        self.assertIn("summary file is empty", workspace.error)

    def test_rejects_a_report_that_is_not_valid_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_report(tmp, SPECS["cli"].lcov_path, INVALID_UTF8_REPORT)
            write_report(
                tmp,
                SPECS["cli"].summary_path,
                summary_text(tmp, SPECS["cli"], fixture_records(PASSING_REPORT)),
            )
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertEqual(workspace.kind, "invalid")
        self.assertIn("not valid UTF-8", workspace.error)
        self.assertIn("cli/coverage/lcov.info", workspace.error)

    def test_rejects_a_summary_that_is_not_valid_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_report(tmp, SPECS["cli"].lcov_path, PASSING_REPORT)
            write_report(tmp, SPECS["cli"].summary_path, b"\xff\xfe")
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("summary file is not valid UTF-8", workspace.error)

    def test_rejects_malformed_summary_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, "{")
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("summary file is not valid JSON", workspace.error)

    def test_rejects_a_summary_that_is_not_an_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, "[]")
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("summary JSON is not an object", workspace.error)

    def test_rejects_duplicate_summary_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_report(tmp, SPECS["cli"].lcov_path, PASSING_REPORT)
            write_report(
                tmp,
                SPECS["cli"].summary_path,
                '{"total": {}, "total": {}}',
            )
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("summary JSON repeats the 'total' key", workspace.error)

    def test_rejects_duplicate_nested_summary_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = fixture_records(PASSING_REPORT)
            data = summary_data(tmp, SPECS["cli"], records)
            raw = json.dumps(data)
            raw = raw.replace(
                '"lines": ',
                '"lines": {"total": 0, "covered": 0}, "lines": ',
                1,
            )
            write_report(tmp, SPECS["cli"].lcov_path, PASSING_REPORT)
            write_report(tmp, SPECS["cli"].summary_path, raw)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("summary JSON repeats the 'lines' key", workspace.error)

    def test_rejects_a_summary_without_a_total_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            data.pop("total")
            write_workspace(
                tmp, SPECS["cli"], PASSING_REPORT, json.dumps(data)
            )
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("missing its total entry", workspace.error)

    def test_rejects_a_zero_workspace_denominator(self):
        report = lcov_record(
            "src/empty.ts", lines=(0, 0), branches=(0, 0), functions=(0, 0)
        )
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], report)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("the lines denominator is zero", workspace.error)

    def test_accepts_a_zero_metric_in_one_file_of_a_workspace(self):
        report = VALID_EMPTY_METRIC_RECORD + lcov_record("src/a.ts")
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], report)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertTrue(workspace.valid, workspace.error)
        self.assertEqual(workspace.totals["lines"], (19, 20))
        self.assertEqual(workspace.totals["branches"], (95, 100))

    def test_rejects_a_per_source_counter_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = fixture_records(PASSING_REPORT)
            records["src/example.ts"]["lines"] = [18, 20]
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, records)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("lines counters disagree with the LCOV record", workspace.error)

    def test_rejects_an_aggregate_total_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            data["total"]["lines"]["covered"] = 20
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn(
            "summary total lines counters disagree with its per-source entries",
            workspace.error,
        )

    def test_rejects_a_summary_missing_a_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            lcov = lcov_record("src/a.ts") + lcov_record("src/b.ts")
            data = summary_data(tmp, SPECS["cli"], fixture_records(lcov))
            source = os.path.join(tmp, SPECS["cli"].directory, "src", "b.ts")
            data.pop(source)
            write_workspace(tmp, SPECS["cli"], lcov, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("summary is missing source record(s)", workspace.error)

    def test_rejects_a_summary_with_an_extra_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = fixture_records(PASSING_REPORT)
            records["src/extra.ts"] = {
                "lines": (1, 1),
                "branches": (0, 0),
                "functions": (0, 0),
            }
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, records)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("is not present in the LCOV report", workspace.error)

    def test_rejects_a_relative_summary_source_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            source = next(key for key in data if key != "total")
            data["src/example.ts"] = data.pop(source)
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("is not an absolute path", workspace.error)

    def test_accepts_a_hosted_absolute_summary_source_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            source = next(key for key in data if key != "total")
            data[
                "/home/runner/work/pto-calendar/pto-calendar/cli/src/example.ts"
            ] = data.pop(source)
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertTrue(workspace.valid, workspace.error)
        self.assertEqual(workspace.totals["lines"], (19, 20))

    def test_rejects_a_summary_source_outside_the_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            source = next(key for key in data if key != "total")
            data["/elsewhere/src/example.ts"] = data.pop(source)
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("is not anchored under 'cli'", workspace.error)

    def test_rejects_an_ambiguous_summary_source_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            source = next(key for key in data if key != "total")
            data["/tmp/checkout/cli/src/./example.ts"] = data.pop(source)
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("is ambiguous", workspace.error)

    def test_rejects_an_ambiguous_normalization_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            lcov = lcov_record("src/a.ts") + lcov_record("cli/src/a.ts")
            data = {
                "/tmp/checkout/cli/cli/src/a.ts": default_entry(),
                "total": {
                    name: metric(*(120, 120) if name == "branches" else (19, 20))
                    for name in METRICS
                },
            }
            data["total"]["statements"] = metric(19, 20)
            write_workspace(tmp, SPECS["cli"], lcov, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("is ambiguous after normalization", workspace.error)

    def test_rejects_two_summary_keys_colliding_on_one_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            source = next(key for key in data if key != "total")
            data["/hosted/checkout/cli/src/example.ts"] = data[source]
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("collides after normalization", workspace.error)

    def test_rejects_invalid_counters_in_the_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = summary_data(
                tmp, SPECS["cli"], fixture_records(PASSING_REPORT)
            )
            source = next(key for key in data if key != "total")
            data[source]["lines"]["total"] = True
            write_workspace(tmp, SPECS["cli"], PASSING_REPORT, data)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
        self.assertFalse(workspace.valid)
        self.assertIn("malformed lines covered/total counter", workspace.error)

    def test_accepts_long_distinct_source_paths(self):
        first = "src/" + "a" * 160 + "1.ts"
        second = "src/" + "a" * 160 + "2.ts"
        report = lcov_record(first) + lcov_record(second)
        with tempfile.TemporaryDirectory() as tmp:
            write_workspace(tmp, SPECS["cli"], report)
            workspace = check_lcov.load_workspace(tmp, SPECS["cli"])
            records = check_lcov.parse_lcov(report, "s")
        self.assertTrue(workspace.valid, workspace.error)
        self.assertEqual([record.source for record in records], [first, second])
        self.assertNotEqual(
            check_lcov.safe_source(first), check_lcov.safe_source(second)
        )


class GateTests(unittest.TestCase):
    """The per-workspace floor and the paired-artifact rejection regressions."""

    def test_accepts_exactly_ninety_five_percent(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp)
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 0, out)
        self.assertIn("PASSED", out)
        self.assertIn("95.00% (19/20)", out)
        self.assertIn("95.00% (95/100)", out)

    def test_rejects_a_value_just_below_the_floor_that_would_round_up(self):
        # 94.9% is displayed as 94.90% and rounds to 95% at zero decimals.
        report = lcov_record("src/example.ts", lines=(949, 1000))
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"backend": report})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertIn("FAILED", out)
        self.assertNotIn("PASSED", out)
        self.assertIn("`backend` lines: 949/1000 covered (94.90%)", out)

    def test_rejects_a_value_that_is_displayed_as_exactly_ninety_five(self):
        # 94.995% is displayed as 95.00% but is below the floor.
        report = lcov_record("src/example.ts", branches=(18999, 20000))
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"frontend": report})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertIn("95.00%", out)
        self.assertIn("`frontend` branches: 18999/20000 covered (95.00%)", out)

    def test_each_metric_fails_independently(self):
        cases = {
            "lines": lcov_record("src/example.ts", lines=(94, 100)),
            "branches": lcov_record("src/example.ts", branches=(94, 100)),
            "functions": lcov_record("src/example.ts", functions=(94, 100)),
        }
        for metric_name, report in cases.items():
            with self.subTest(metric=metric_name):
                with tempfile.TemporaryDirectory() as tmp:
                    build_tree(tmp, {"mcp": report})
                    code, out, _ = run_cli(tmp)
                self.assertEqual(code, 1)
                self.assertIn(f"`mcp` {metric_name}", out)
                self.assertIn("FAILED", out)

    def test_each_workspace_fails_independently(self):
        for name in SPECS:
            with self.subTest(workspace=name):
                report = lcov_record("src/example.ts", lines=(94, 100))
                with tempfile.TemporaryDirectory() as tmp:
                    build_tree(tmp, {name: report})
                    code, out, _ = run_cli(tmp)
                self.assertEqual(code, 1)
                self.assertIn(f"`{name}` lines", out)

    def test_a_missing_report_fails_the_gate_without_claiming_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"cli": None})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertIn("FAILED", out)
        self.assertNotIn("PASSED", out)
        self.assertIn("`cli` report is invalid", out)
        self.assertIn("report missing", out)
        self.assertNotIn("100.00%", out)

    def test_a_missing_summary_fails_the_gate_without_claiming_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp)
            os.remove(os.path.join(tmp, SPECS["cli"].summary_path))
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`cli` report is invalid", out)
        self.assertIn("summary file is missing", out)
        self.assertNotIn("100.00%", out)

    def test_a_malformed_report_fails_the_gate_without_claiming_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(
                tmp, {"api-client": (MALFORMED_COUNTER_REPORT, GENERIC_RECORDS)}
            )
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`api-client` report is invalid", out)
        self.assertIn("invalid report", out)
        self.assertNotIn("100.00%", out)

    def test_a_malformed_summary_fails_the_gate_without_claiming_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"frontend": (PASSING_REPORT, "{")})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`frontend` report is invalid", out)
        self.assertIn("not valid JSON", out)
        self.assertNotIn("100.00%", out)

    def test_duplicate_summary_keys_fail_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp)
            write_report(
                tmp,
                SPECS["agent-auth"].summary_path,
                '{"total": {}, "total": {}}',
            )
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`agent-auth` report is invalid", out)
        self.assertIn("repeats the 'total' key", out)

    def test_duplicate_da_rows_fail_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"backend": DUPLICATE_DA_LINE_REPORT})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`backend` report is invalid", out)
        self.assertIn("repeats its DA line 1", out)

    def test_duplicate_brda_rows_fail_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"backend": DUPLICATE_BRDA_IDENTITY_REPORT})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`backend` report is invalid", out)
        self.assertIn("repeats its BRDA branch (1,0,0)", out)

    def test_unmatched_function_names_fail_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"frontend": UNMATCHED_FUNCTION_REPORT})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`frontend` report is invalid", out)
        self.assertIn("do not match its FN declarations", out)

    def test_genuinely_repeated_function_names_pass_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"frontend": REPEATED_FUNCTION_REPORT})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 0, out)
        self.assertIn("PASSED", out)

    def test_a_dropped_undercovered_lcov_record_fails_the_gate(self):
        kept = lcov_record("src/a.ts", lines=(20, 20))
        dropped = lcov_record(
            "src/b.ts",
            lines=(1, 20),
            branches=(0, 1),
            functions=(0, 1),
        )
        full_summary = fixture_records(kept + dropped)
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"backend": (kept, full_summary)})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`backend` report is invalid", out)
        self.assertIn("is not present in the LCOV report", out)
        self.assertIn("src/b.ts", out)

    def test_a_summary_missing_a_source_fails_the_gate(self):
        kept = lcov_record("src/a.ts", lines=(20, 20))
        dropped = lcov_record(
            "src/b.ts",
            lines=(1, 20),
            branches=(0, 1),
            functions=(0, 1),
        )
        kept_summary = fixture_records(kept)
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"frontend": (kept + dropped, kept_summary)})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`frontend` report is invalid", out)
        self.assertIn("summary is missing source record(s)", out)
        self.assertIn("src/b.ts", out)

    def test_a_substituted_summary_source_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = fixture_records(PASSING_REPORT)
            records["src/substituted.ts"] = records.pop("src/example.ts")
            build_tree(tmp, {"cli": (PASSING_REPORT, records)})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`cli` report is invalid", out)
        self.assertIn("is not present in the LCOV report", out)

    def test_an_extra_summary_source_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = fixture_records(PASSING_REPORT)
            records["src/extra.ts"] = {
                "lines": (1, 1),
                "branches": (0, 0),
                "functions": (0, 0),
            }
            build_tree(tmp, {"mcp": (PASSING_REPORT, records)})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`mcp` report is invalid", out)
        self.assertIn("is not present in the LCOV report", out)

    def test_a_per_source_counter_mismatch_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = fixture_records(PASSING_REPORT)
            records["src/example.ts"]["branches"] = [94, 100]
            build_tree(tmp, {"api-client": (PASSING_REPORT, records)})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`api-client` report is invalid", out)
        self.assertIn("branches counters disagree with the LCOV record", out)

    def test_an_aggregate_total_mismatch_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = SPECS["agent-auth"]
            data = summary_data(tmp, spec, fixture_records(PASSING_REPORT))
            data["total"]["branches"]["covered"] = 100
            build_tree(tmp, {"agent-auth": (PASSING_REPORT, data)})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`agent-auth` report is invalid", out)
        self.assertIn("summary total branches counters disagree", out)

    def test_long_distinct_valid_paths_do_not_collide(self):
        first = "src/" + "a" * 160 + "1.ts"
        second = "src/" + "a" * 160 + "2.ts"
        report = lcov_record(first) + lcov_record(second)
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"cli": report})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 0, out)
        self.assertIn("PASSED", out)

    def test_source_diagnostics_are_sanitized(self):
        source = "src/a|b](evil<script>.ts"
        report = lcov_record(source)
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"mcp": (report, {})})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        line = next(
            line
            for line in out.splitlines()
            if line.startswith("- `mcp` report is invalid")
        )
        self.assertNotIn("|", line)
        self.assertNotIn("<", line)
        self.assertNotIn(">", line)
        self.assertIn("src/a_b__evil_script_.ts", line)

    def test_a_report_with_invalid_bytes_fails_the_gate_without_claiming_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp)
            write_report(tmp, SPECS["agent-auth"].lcov_path, INVALID_UTF8_REPORT)
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertNotIn("PASSED", out)
        self.assertIn("`agent-auth` report is invalid", out)
        self.assertIn("not valid UTF-8", out)
        self.assertNotIn("100.00%", out)

    def test_the_summary_diagnostic_never_echoes_an_untrusted_record_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"frontend": UNSUPPORTED_RECORD_REPORT})
            code, out, _ = run_cli(tmp)
        self.assertEqual(code, 1)
        self.assertIn("`frontend` report is invalid", out)
        self.assertNotIn("ZZ", out)
        self.assertNotIn("script", out)

    def test_the_summary_table_has_one_row_per_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp)
            _, out, _ = run_cli(tmp)
        rows = [line for line in out.splitlines() if line.startswith("| ")]
        # The header row is not a workspace row.
        self.assertEqual(len(rows), len(check_lcov.WORKSPACES) + 1)
        for name in SPECS:
            self.assertTrue(
                any(row.startswith(f"| {name} |") for row in rows),
                f"missing table row for {name}",
            )

    def test_the_diagnostics_name_the_workspace_metric_and_counters(self):
        report = lcov_record("src/example.ts", branches=(10, 100))
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"agent-auth": report})
            _, out, _ = run_cli(tmp)
        self.assertIn("`agent-auth` branches: 10/100 covered (10.00%)", out)
        self.assertIn("95% floor", out)


class CliTests(unittest.TestCase):
    """The command line contract."""

    def test_writes_the_report_file_and_keeps_the_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp)
            report_path = os.path.join(tmp, "coverage-summary.md")
            code, out, _ = run_cli(tmp, report_path)
            self.assertEqual(code, 0, out)
            with open(report_path, encoding="utf-8") as handle:
                written = handle.read()
        self.assertIn("### Coverage summary", written)
        self.assertIn("PASSED", written)
        self.assertEqual(written.strip(), out.strip())

    def test_writes_the_report_file_even_when_the_gate_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_tree(tmp, {"cli": None})
            report_path = os.path.join(tmp, "coverage-summary.md")
            code, _, _ = run_cli(tmp, report_path)
            self.assertEqual(code, 1)
            self.assertTrue(os.path.isfile(report_path))
            with open(report_path, encoding="utf-8") as handle:
                written = handle.read()
        self.assertIn("FAILED", written)

    def test_rejects_a_missing_root_directory(self):
        code, _, err = run_cli(os.path.join(os.sep, "definitely", "missing", "root"))
        self.assertEqual(code, 1)
        self.assertIn("root directory does not exist", err)

    def test_the_floor_is_ninety_five_percent(self):
        self.assertEqual(check_lcov.FLOOR_PERCENT, 95)

    def test_the_gate_reads_the_six_documented_artifact_pairs(self):
        self.assertEqual(
            [
                (spec.name, spec.lcov_path, spec.summary_path)
                for spec in check_lcov.WORKSPACES
            ],
            [
                (
                    "backend",
                    "backend/coverage/lcov.info",
                    "backend/coverage/coverage-summary.json",
                ),
                (
                    "frontend",
                    "frontend/coverage/lcov.info",
                    "frontend/coverage/coverage-summary.json",
                ),
                (
                    "api-client",
                    "packages/api-client/coverage/lcov.info",
                    "packages/api-client/coverage/coverage-summary.json",
                ),
                (
                    "agent-auth",
                    "packages/agent-auth/coverage/lcov.info",
                    "packages/agent-auth/coverage/coverage-summary.json",
                ),
                (
                    "cli",
                    "cli/coverage/lcov.info",
                    "cli/coverage/coverage-summary.json",
                ),
                (
                    "mcp",
                    "mcp/coverage/lcov.info",
                    "mcp/coverage/coverage-summary.json",
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main()
