#!/usr/bin/env python3
"""Enforce the per-workspace coverage floor from the six CI coverage artifacts.

The CI ``Coverage gate`` job downloads the backend integration, frontend,
api-client, agent-auth, CLI and MCP coverage artifacts and runs this script
against the checkout root. Every workspace must independently reach the
95% floor on lines, branches *and* functions; a strong result in one
workspace never offsets a miss in another.

Each workspace must provide *both* files from the same coverage artifact:
the provider's ``lcov.info`` and its ``coverage-summary.json``. The two files
are cross-checked before the floor is measured:

* the recognized source sets must be exactly equal,
* every per-source lines/branches/functions ``covered``/``total`` pair must
  agree, and
* the summary's aggregate ``total`` entry must equal both the sum of its
  per-source entries and the LCOV aggregate.

The LCOV parser also rejects duplicate ``DA`` line identities, duplicate
``BRDA`` (line, block, branch) identities, and ``FN``/``FNDA`` name
multisets that do not match. A report that is missing, empty, malformed,
incomplete or internally inconsistent is rejected instead of being reported
as covered. A workspace whose metric denominator is zero is rejected rather
than being counted as 100%.

The decision uses integer arithmetic on the raw LCOV counters
(``covered * 100 >= floor * total``), so a miss is never rounded up into a
pass.

Usage::

    python3 infra/coverage/check_lcov.py <root> [--report <markdown file>]

``<root>`` is the checkout root, or any directory that contains the six
workspace artifact pairs below. The script only uses the Python standard
library, so it runs on the CI runner without extra dependencies.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

#: The floor every workspace must reach on every metric, in percent.
FLOOR_PERCENT = 95

#: The largest counter accepted. A real coverage counter never carries more
#: digits than this, so an oversized value is rejected instead of being parsed
#: into an arbitrary-precision integer.
MAX_DIGITS = 18
MAX_COUNT = 10**MAX_DIGITS - 1

#: The longest source path accepted. Legitimate report paths are far shorter,
#: and the bound keeps a hostile report from forcing an unbounded comparison.
MAX_SOURCE_LENGTH = 4096

#: The gated metrics, in report order.
METRICS: Tuple[str, ...] = ("lines", "branches", "functions")

#: LCOV summary counters per metric as ``(total tag, hit tag)``.
COUNTER_TAGS: Dict[str, Tuple[str, str]] = {
    "lines": ("LF", "LH"),
    "branches": ("BRF", "BRH"),
    "functions": ("FNF", "FNH"),
}


@dataclass(frozen=True)
class WorkspaceSpec:
    """The report pair one workspace is expected to publish."""

    name: str
    #: Workspace directory below the checkout root, e.g. ``packages/api-client``.
    directory: str
    lcov_path: str
    summary_path: str


#: The six reports the CI ``Coverage gate`` job downloads. The backend row is
#: the integration report only; the backend unit report keeps its own gate.
WORKSPACES: Tuple[WorkspaceSpec, ...] = (
    WorkspaceSpec(
        "backend",
        "backend",
        "backend/coverage/lcov.info",
        "backend/coverage/coverage-summary.json",
    ),
    WorkspaceSpec(
        "frontend",
        "frontend",
        "frontend/coverage/lcov.info",
        "frontend/coverage/coverage-summary.json",
    ),
    WorkspaceSpec(
        "api-client",
        "packages/api-client",
        "packages/api-client/coverage/lcov.info",
        "packages/api-client/coverage/coverage-summary.json",
    ),
    WorkspaceSpec(
        "agent-auth",
        "packages/agent-auth",
        "packages/agent-auth/coverage/lcov.info",
        "packages/agent-auth/coverage/coverage-summary.json",
    ),
    WorkspaceSpec(
        "cli",
        "cli",
        "cli/coverage/lcov.info",
        "cli/coverage/coverage-summary.json",
    ),
    WorkspaceSpec(
        "mcp",
        "mcp",
        "mcp/coverage/lcov.info",
        "mcp/coverage/coverage-summary.json",
    ),
)

_MAX_NUM = rf"[0-9]{{1,{MAX_DIGITS}}}"
_UINT = re.compile(rf"^{_MAX_NUM}$")

# Informational LCOV records. Their shape is checked, but their counts are
# never used for the gate: a source with no instrumented item legitimately
# carries no DA/FN/BRDA record at all.
_DETAIL_PATTERNS: Dict[str, "re.Pattern[str]"] = {
    "TN": re.compile(r"^TN:.*$"),
    "FN": re.compile(rf"^FN:{_MAX_NUM},.*$"),
    "FNDA": re.compile(rf"^FNDA:{_MAX_NUM},.*$"),
    "DA": re.compile(rf"^DA:{_MAX_NUM},{_MAX_NUM}(,[0-9a-fA-F]+)?$"),
    "BRDA": re.compile(
        rf"^BRDA:{_MAX_NUM},{_MAX_NUM},{_MAX_NUM},({_MAX_NUM}|-)(,[0-9a-fA-F]+)?$"
    ),
}


class LcovError(Exception):
    """A report is missing, empty, malformed or incomplete."""


@dataclass(frozen=True)
class FileRecord:
    """One ``SF:`` source record of an LCOV report."""

    #: The validated source path exactly as the LCOV report gives it. It is
    #: the cross-artifact identity; it is never sanitized or truncated.
    source: str
    lines: Tuple[int, int]
    branches: Tuple[int, int]
    functions: Tuple[int, int]


@dataclass
class Workspace:
    """The aggregated result of one workspace report pair."""

    name: str
    relative_path: str
    totals: Dict[str, Tuple[int, int]] = field(default_factory=dict)
    error: Optional[str] = None
    kind: str = "ok"

    @property
    def valid(self) -> bool:
        return self.error is None

    @property
    def cell(self) -> str:
        """The table cell used when the report cannot be measured."""
        return {
            "missing": "report missing",
            "empty": "report empty",
            "invalid": "invalid report",
        }.get(self.kind, "invalid report")


@dataclass(frozen=True)
class Failure:
    """One reason the gate rejects the run."""

    workspace: str
    metric: Optional[str]
    detail: str


@dataclass
class _Record:
    """The state of the source record that is currently open."""

    source: str
    totals: Dict[str, int] = field(default_factory=dict)
    details: Dict[str, int] = field(default_factory=dict)
    hits: Dict[str, int] = field(default_factory=dict)
    da_lines: Set[int] = field(default_factory=set)
    brda_keys: Set[Tuple[int, int, int]] = field(default_factory=set)
    function_names: List[str] = field(default_factory=list)
    execution_names: List[str] = field(default_factory=list)


def _has_control_characters(value: str) -> bool:
    return any(
        ord(character) < 32
        or ord(character) == 127
        or 0xD800 <= ord(character) <= 0xDFFF
        for character in value
    )


def _validate_relative_source(value: str) -> str:
    """Return a valid LCOV source identity or raise :class:`LcovError`.

    LCOV sources are workspace-relative on every real provider report. Dot
    segments and empty segments are rejected as ambiguous rather than being
    normalized: two different raw strings must never collapse to one identity.
    The value is returned unchanged, so the raw validated path is the identity.
    """
    if not value:
        raise LcovError("a source record has an empty source path")
    if len(value) > MAX_SOURCE_LENGTH:
        raise LcovError("a source path is longer than the supported maximum")
    if value.startswith("/"):
        raise LcovError("an LCOV source path must be relative")
    if "\\" in value:
        raise LcovError("a source path uses an unsupported separator")
    if _has_control_characters(value):
        raise LcovError("a source path contains a control character")
    if any(part in ("", ".", "..") for part in value.split("/")):
        raise LcovError("a source path is ambiguous")
    return value


def _validate_absolute_source(value: str) -> None:
    """Check the shape of an absolute JSON source key without touching disk."""
    if not value.startswith("/"):
        raise LcovError("is not an absolute path")
    if len(value) > MAX_SOURCE_LENGTH:
        raise LcovError("is longer than the supported maximum")
    if "\\" in value:
        raise LcovError("uses an unsupported separator")
    if _has_control_characters(value):
        raise LcovError("contains a control character")
    parts = value.split("/")
    if parts[0] != "" or any(part in ("", ".", "..") for part in parts[1:]):
        raise LcovError("is ambiguous")


def safe_source(value: str) -> str:
    """Reduce a report-provided path to an inert, printable diagnostic token.

    Identity comparisons always use the raw validated path. This helper is
    used only when a path is placed in Markdown text. Long distinct paths are
    kept distinguishable with a short hash suffix after truncation.
    """
    cleaned = re.sub(r"[^A-Za-z0-9._/-]", "_", value.strip())
    if len(cleaned) > 120:
        digest = hashlib.sha256(
            value.encode("utf-8", "backslashreplace")
        ).hexdigest()[:8]
        cleaned = cleaned[:110] + "..." + digest
    return cleaned


def _source_list(values: Sequence[str]) -> str:
    """A short sanitized list of sources for a diagnostic."""
    shown = ", ".join(f"'{safe_source(value)}'" for value in values[:3])
    if len(values) > 3:
        shown += f" and {len(values) - 3} more"
    return shown


def _detail_name(payload: str) -> str:
    """The function name of an ``FN`` or ``FNDA`` payload."""
    return payload.split(",", 1)[1]


def _valid_count(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= MAX_COUNT
    )


def parse_lcov(text: str, label: str) -> List[FileRecord]:
    """Parse an LCOV report into its source records.

    Raises :class:`LcovError` for a malformed or incomplete report.
    """
    records: List[FileRecord] = []
    current: Optional[_Record] = None
    seen_sources: Set[str] = set()
    closed_records = 0

    def close_record() -> None:
        nonlocal current
        assert current is not None
        for metric, (total_tag, hit_tag) in COUNTER_TAGS.items():
            if total_tag not in current.totals:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' is missing its "
                    f"{total_tag} total"
                )
            if hit_tag not in current.totals:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' is missing its "
                    f"{hit_tag} total"
                )
            found = current.totals[total_tag]
            hit = current.totals[hit_tag]
            if hit > found:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' reports {hit} "
                    f"covered {metric} but only {found} total"
                )
        # The detail entries have to agree with the summary counters, so a
        # truncated or contradictory record cannot pass as covered.
        for metric, (total_tag, hit_tag), detail_tag in (
            ("lines", ("LF", "LH"), "DA"),
            ("branches", ("BRF", "BRH"), "BRDA"),
        ):
            entries = current.details.get(detail_tag, 0)
            hits = current.hits.get(detail_tag, 0)
            if entries != current.totals[total_tag] or hits != current.totals[hit_tag]:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' disagrees with "
                    f"its {total_tag}/{hit_tag} summary counters"
                )
        declarations = current.details.get("FN", 0)
        executions = current.details.get("FNDA", 0)
        executed_hits = current.hits.get("FNDA", 0)
        if (
            declarations != current.totals["FNF"]
            or executions != current.totals["FNF"]
            or executed_hits != current.totals["FNH"]
        ):
            raise LcovError(
                f"{label}: source '{safe_source(current.source)}' disagrees with its "
                "FNF/FNH summary counters"
            )
        if Counter(current.function_names) != Counter(current.execution_names):
            raise LcovError(
                f"{label}: source '{safe_source(current.source)}' has FNDA "
                "executions that do not match its FN declarations"
            )
        records.append(
            FileRecord(
                source=current.source,
                lines=(current.totals["LH"], current.totals["LF"]),
                branches=(current.totals["BRH"], current.totals["BRF"]),
                functions=(current.totals["FNH"], current.totals["FNF"]),
            )
        )
        current = None

    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        if line == "end_of_record":
            if current is None:
                raise LcovError(f"{label}: a source record is missing its SF: entry")
            close_record()
            closed_records += 1
            continue
        if line.startswith("SF:"):
            if current is not None:
                raise LcovError(
                    f"{label}: a source record is not terminated by end_of_record "
                    f"before line {number}"
                )
            value = line[3:].strip()
            try:
                source = _validate_relative_source(value)
            except LcovError as exc:
                raise LcovError(
                    f"{label}: source '{safe_source(value)}' {exc}"
                ) from None
            if source in seen_sources:
                raise LcovError(
                    f"{label}: repeated source '{safe_source(source)}'"
                )
            seen_sources.add(source)
            current = _Record(source=source)
            continue
        counter = None
        for total_tag, hit_tag in COUNTER_TAGS.values():
            for tag in (total_tag, hit_tag):
                if line.startswith(tag + ":"):
                    counter = tag
                    break
            if counter is not None:
                break
        if counter is not None:
            if current is None:
                raise LcovError(_outside_record(label, number, counter, closed_records))
            value = line[len(counter) + 1 :].strip()
            if not _UINT.match(value):
                raise LcovError(
                    f"{label}: line {number} has a malformed {counter} value"
                )
            if counter in current.totals:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' repeats its "
                    f"{counter} total"
                )
            current.totals[counter] = int(value)
            continue
        tag = line.split(":", 1)[0]
        pattern = _DETAIL_PATTERNS.get(tag)
        if pattern is None:
            # The tag comes from the report, so it is never echoed back.
            raise LcovError(f"{label}: line {number} has an unsupported record type")
        if not pattern.match(line):
            raise LcovError(f"{label}: line {number} has a malformed '{tag}' record")
        if tag == "TN":
            # The test name is informational and may precede its source.
            continue
        if current is None:
            raise LcovError(_outside_record(label, number, tag, closed_records))
        payload = line.split(":", 1)[1]
        fields = payload.split(",")
        if tag == "FN":
            current.details["FN"] = current.details.get("FN", 0) + 1
            current.function_names.append(_detail_name(payload))
        elif tag == "FNDA":
            current.details["FNDA"] = current.details.get("FNDA", 0) + 1
            if int(fields[0]) > 0:
                current.hits["FNDA"] = current.hits.get("FNDA", 0) + 1
            current.execution_names.append(_detail_name(payload))
        elif tag == "DA":
            line_number = int(fields[0])
            if line_number in current.da_lines:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' repeats its "
                    f"DA line {line_number}"
                )
            current.da_lines.add(line_number)
            current.details["DA"] = current.details.get("DA", 0) + 1
            if int(fields[1]) > 0:
                current.hits["DA"] = current.hits.get("DA", 0) + 1
        else:
            # BRDA: a trailing "-" marks a branch that was never evaluated.
            key = (int(fields[0]), int(fields[1]), int(fields[2]))
            if key in current.brda_keys:
                raise LcovError(
                    f"{label}: source '{safe_source(current.source)}' repeats its "
                    f"BRDA branch ({key[0]},{key[1]},{key[2]})"
                )
            current.brda_keys.add(key)
            current.details["BRDA"] = current.details.get("BRDA", 0) + 1
            if fields[3] != "-" and int(fields[3]) > 0:
                current.hits["BRDA"] = current.hits.get("BRDA", 0) + 1

    if current is not None:
        raise LcovError(
            f"{label}: the last source record is not terminated by end_of_record"
        )
    if not records:
        raise LcovError(f"{label}: the report contains no source record")
    return records


def _outside_record(label: str, number: int, tag: str, closed_records: int) -> str:
    """The diagnostic for a counter or detail entry outside a source record."""
    if closed_records:
        return (
            f"{label}: line {number} has a {tag} record after a closed source record"
        )
    return f"{label}: line {number} has a {tag} record outside a source record"


def _unique_object(pairs: Sequence[Tuple[str, object]]) -> Dict[str, object]:
    """A JSON object hook that rejects a repeated key instead of keeping last."""
    result: Dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise LcovError(f"summary JSON repeats the '{safe_source(key)}' key")
        result[key] = value
    return result


def _normalize_json_source(
    value: str, directory: str, known_sources: Set[str], label: str
) -> str:
    """Map an absolute coverage-summary key to its workspace-relative identity.

    Vitest writes absolute keys anchored under the workspace
    (``<checkout>/<workspace>/src/...``), while LCOV uses ``src/...``. The
    checkout prefix is intentionally not assumed: the key is matched against
    the exact recognized LCOV inventory with the workspace directory as the
    anchor, so a local snapshot and a hosted-run artifact both work. Nothing
    is resolved against the current working directory and no source file is
    opened.
    """
    display = safe_source(value)
    try:
        _validate_absolute_source(value)
    except LcovError as exc:
        raise LcovError(f"{label}: summary source '{display}' {exc}") from None
    marker = "/" + directory + "/"
    matches = [
        source for source in known_sources if value.endswith(marker + source)
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise LcovError(
            f"{label}: summary source '{display}' is ambiguous after normalization"
        )
    if marker in value:
        raise LcovError(
            f"{label}: summary source '{display}' is not present in the LCOV report"
        )
    raise LcovError(
        f"{label}: summary source '{display}' is not anchored under '{directory}'"
    )


def _metric_values(
    entry: object, display: str, label: str
) -> Dict[str, Tuple[int, int]]:
    """Validate the three gated ``covered``/``total`` pairs of a JSON entry."""
    if not isinstance(entry, dict):
        raise LcovError(f"{label}: summary entry '{display}' is not an object")
    values: Dict[str, Tuple[int, int]] = {}
    for metric in METRICS:
        node = entry.get(metric)
        if not isinstance(node, dict):
            raise LcovError(
                f"{label}: summary entry '{display}' is missing its {metric} object"
            )
        covered = node.get("covered")
        total = node.get("total")
        if not _valid_count(covered) or not _valid_count(total):
            raise LcovError(
                f"{label}: summary entry '{display}' has a malformed {metric} "
                "covered/total counter"
            )
        assert isinstance(covered, int) and isinstance(total, int)
        if covered > total:
            raise LcovError(
                f"{label}: summary entry '{display}' reports {covered} covered "
                f"{metric} but only {total} total"
            )
        values[metric] = (covered, total)
    return values


def parse_summary(
    text: str, spec: WorkspaceSpec, records: Sequence[FileRecord], label: str
) -> None:
    """Validate a coverage-summary.json against the parsed LCOV records."""
    try:
        data = json.loads(text, object_pairs_hook=_unique_object)
    except LcovError as exc:
        raise LcovError(f"{label}: {exc}") from None
    except json.JSONDecodeError as exc:
        raise LcovError(
            f"{label}: summary file is not valid JSON "
            f"(line {exc.lineno}, column {exc.colno})"
        ) from None
    if not isinstance(data, dict):
        raise LcovError(f"{label}: summary JSON is not an object")

    total_entry = data.get("total")
    if total_entry is None:
        raise LcovError(f"{label}: summary file is missing its total entry")

    known_sources = {record.source for record in records}
    summary_sources: Dict[str, object] = {}
    for key, entry in data.items():
        if key == "total":
            continue
        source = _normalize_json_source(key, spec.directory, known_sources, label)
        if source in summary_sources:
            raise LcovError(
                f"{label}: summary source '{safe_source(key)}' collides after "
                "normalization"
            )
        summary_sources[source] = entry

    missing = sorted(known_sources - summary_sources.keys())
    if missing:
        raise LcovError(
            f"{label}: summary is missing source record(s) present in the LCOV "
            f"report: {_source_list(missing)}"
        )

    records_by_source = {record.source: record for record in records}
    aggregate = {metric: [0, 0] for metric in METRICS}
    for source, entry in summary_sources.items():
        values = _metric_values(entry, safe_source(source), label)
        record = records_by_source[source]
        for metric in METRICS:
            expected = getattr(record, metric)
            if values[metric] != expected:
                raise LcovError(
                    f"{label}: summary source '{safe_source(source)}' {metric} "
                    "counters disagree with the LCOV record"
                )
            aggregate[metric][0] += values[metric][0]
            aggregate[metric][1] += values[metric][1]

    total_values = _metric_values(total_entry, "total", label)
    for metric in METRICS:
        if total_values[metric] != (
            aggregate[metric][0],
            aggregate[metric][1],
        ):
            raise LcovError(
                f"{label}: summary total {metric} counters disagree with its "
                "per-source entries"
            )


def _read_text(
    root: str, relative_path: str, what: str
) -> Tuple[Optional[str], Optional[str], str]:
    """Read one report file as UTF-8, returning ``(text, error, kind)``."""
    path = os.path.join(root, relative_path)
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return None, f"{what} file is missing: {relative_path}", "missing"
    except IsADirectoryError:
        return None, f"{what} path is a directory: {relative_path}", "invalid"
    except OSError as exc:
        return (
            None,
            f"{what} file cannot be read: {relative_path} ({exc.strerror})",
            "invalid",
        )
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None, f"{what} file is not valid UTF-8: {relative_path}", "invalid"
    if not text.strip():
        return None, f"{what} file is empty: {relative_path}", "empty"
    return text, None, "ok"


def load_workspace(root: str, spec: WorkspaceSpec) -> Workspace:
    """Read, cross-check and aggregate one workspace report pair below ``root``."""
    workspace = Workspace(name=spec.name, relative_path=spec.lcov_path)
    text, error, kind = _read_text(root, spec.lcov_path, "report")
    if error is not None:
        workspace.error = error
        workspace.kind = kind
        return workspace
    assert text is not None
    try:
        records = parse_lcov(text, spec.lcov_path)
    except LcovError as exc:
        workspace.error = str(exc)
        workspace.kind = "invalid"
        return workspace

    summary_text, error, kind = _read_text(root, spec.summary_path, "summary")
    if error is not None:
        workspace.error = error
        workspace.kind = kind
        return workspace
    assert summary_text is not None
    try:
        parse_summary(summary_text, spec, records, spec.summary_path)
    except LcovError as exc:
        workspace.error = str(exc)
        workspace.kind = "invalid"
        return workspace

    aggregated: Dict[str, List[int]] = {metric: [0, 0] for metric in METRICS}
    for record in records:
        for metric in METRICS:
            hit, total = getattr(record, metric)
            aggregated[metric][0] += hit
            aggregated[metric][1] += total
    for metric in METRICS:
        hit, total = aggregated[metric]
        if total == 0:
            workspace.error = (
                f"report measures no {metric}: the {metric} denominator is zero "
                f"in {spec.lcov_path}"
            )
            workspace.kind = "invalid"
            return workspace
        if hit > total:
            workspace.error = (
                f"report reports {hit} covered {metric} but only {total} total "
                f"in {spec.lcov_path}"
            )
            workspace.kind = "invalid"
            return workspace
    workspace.totals = {
        metric: (aggregated[metric][0], aggregated[metric][1]) for metric in METRICS
    }
    return workspace


def evaluate(workspaces: Sequence[Workspace]) -> List[Failure]:
    """Return every reason the gate rejects the run."""
    failures: List[Failure] = []
    for workspace in workspaces:
        if not workspace.valid:
            failures.append(
                Failure(workspace=workspace.name, metric=None, detail=workspace.error or "")
            )
            continue
        for metric in METRICS:
            hit, total = workspace.totals[metric]
            # Integer comparison on the raw counters: no rounding, no tolerance.
            if hit * 100 < FLOOR_PERCENT * total:
                failures.append(
                    Failure(
                        workspace=workspace.name,
                        metric=metric,
                        detail=(
                            f"{hit}/{total} covered ({percent(hit, total):.2f}%) is below "
                            f"the {FLOOR_PERCENT}% floor"
                        ),
                    )
                )
    return failures


def percent(hit: int, total: int) -> float:
    """The covered percentage of a metric, for display only."""
    return hit * 100.0 / total


def format_metric(metric: Tuple[int, int]) -> str:
    hit, total = metric
    return f"{percent(hit, total):.2f}% ({hit}/{total})"


def render_table(workspaces: Sequence[Workspace]) -> List[str]:
    """The six-row Markdown summary table."""
    lines = [
        "### Coverage summary",
        "",
        "| Workspace | Lines | Branches | Functions |",
        "|---|---|---|---|",
    ]
    for workspace in workspaces:
        if workspace.valid:
            cells = [format_metric(workspace.totals[metric]) for metric in METRICS]
        else:
            cells = [workspace.cell for _ in METRICS]
        lines.append(f"| {workspace.name} | " + " | ".join(cells) + " |")
    return lines


def render_report(workspaces: Sequence[Workspace], failures: Sequence[Failure]) -> str:
    """The complete Markdown report published to the job summary and comment."""
    lines = render_table(workspaces)
    lines.append("")
    lines.append("### Coverage gate")
    lines.append("")
    invalid = [workspace for workspace in workspaces if not workspace.valid]
    metric_failures = [failure for failure in failures if failure.metric is not None]
    if failures:
        summary = (
            f"Result: **FAILED** — {len(metric_failures)} workspace/metric "
            f"combination(s) below the {FLOOR_PERCENT}% floor"
        )
        if invalid:
            summary += f" and {len(invalid)} report(s) invalid"
        summary += "."
    else:
        measured = len(workspaces) - len(invalid)
        summary = (
            f"Result: **PASSED** — all {measured * len(METRICS)} measured workspace "
            f"metrics are at or above the {FLOOR_PERCENT}% floor."
        )
    lines.append(summary)
    lines.append("")
    for failure in failures:
        if failure.metric is None:
            lines.append(f"- `{failure.workspace}` report is invalid: {failure.detail}")
        else:
            lines.append(
                f"- `{failure.workspace}` {failure.metric}: {failure.detail}"
            )
    if failures:
        lines.append("")
    lines.append(
        "The backend row is the integration report (`backend/coverage`), not the "
        "backend unit report. Each workspace's `lcov.info` and "
        "`coverage-summary.json` must come from the same coverage artifact and "
        "cross-check exactly. Per-path thresholds inside each workspace's "
        "`vitest.config.ts` stay in force; this gate additionally enforces the "
        "workspace totals above."
    )
    return "\n".join(lines)


def build_report(root: str) -> Tuple[str, List[Failure]]:
    """Measure every workspace below ``root`` and render the Markdown report."""
    workspaces = [load_workspace(root, spec) for spec in WORKSPACES]
    failures = evaluate(workspaces)
    return render_report(workspaces, failures), failures


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="check_lcov.py",
        description=(
            "Enforce the per-workspace coverage floor on the six CI coverage "
            "artifact pairs."
        ),
    )
    parser.add_argument(
        "root",
        help=(
            "checkout root (or coverage root) that contains the six workspace "
            "artifact pairs below"
        ),
    )
    parser.add_argument(
        "--report",
        metavar="PATH",
        help="write the Markdown coverage summary to this file",
    )
    args = parser.parse_args(argv)

    if not os.path.isdir(args.root):
        print(f"coverage gate: root directory does not exist: {args.root}", file=sys.stderr)
        return 1

    report, failures = build_report(args.root)
    sys.stdout.write(report + "\n")
    if args.report:
        with open(args.report, "w", encoding="utf-8") as handle:
            handle.write(report + "\n")
    if failures:
        print(
            f"coverage gate: FAILED — {len(failures)} workspace/metric rejection(s) "
            f"against the {FLOOR_PERCENT}% floor.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
