#!/usr/bin/env node
// npm dependency audit policy for the release pipeline.
//
// The production graph and the development graph are audited separately so a
// development-only advisory is reported without being able to block a
// production release, and the other way around. High and critical findings
// block in both graphs; lower severities are reported.
//
// A scanner failure (registry unreachable, unreadable lockfile, malformed
// report) is treated as a failure, never as a clean result.

import { spawnSync } from 'node:child_process';

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const EXIT_FAILURE = 1;

function runAudit({ omitDev }) {
  const args = ['audit', '--json', '--package-lock-only'];
  if (omitDev) args.push('--omit=dev');

  const result = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }

  if (!report || typeof report !== 'object' || !report.metadata) {
    console.error(`error: npm audit did not return a report (exit status ${result.status})`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(EXIT_FAILURE);
  }

  if (report.error) {
    const detail = report.error.summary ?? report.error.detail ?? JSON.stringify(report.error);
    console.error(`error: npm audit could not complete: ${detail}`);
    process.exit(EXIT_FAILURE);
  }

  return report;
}

function describe(report) {
  const counts = report.metadata.vulnerabilities ?? {};
  const findings = Object.entries(report.vulnerabilities ?? {}).map(([name, entry]) => ({
    name,
    severity: entry.severity,
    direct: entry.isDirect === true,
    range: entry.range,
    fixAvailable: entry.fixAvailable,
  }));
  return { counts, findings };
}

function report(label, report) {
  const { counts, findings } = describe(report);
  const summary = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${severity}=${count}`)
    .join(' ');

  console.log(`[audit] ${label}: ${summary === '' ? 'no findings' : summary}`);

  for (const finding of findings.sort((a, b) => a.name.localeCompare(b.name))) {
    const fix =
      finding.fixAvailable === true
        ? 'fix available'
        : finding.fixAvailable && typeof finding.fixAvailable === 'object'
          ? `fix: ${finding.fixAvailable.name}@${finding.fixAvailable.version}${
              finding.fixAvailable.isSemVerMajor ? ' (major)' : ''
            }`
          : 'no fix published';
    console.log(
      `[audit] ${label}: ${finding.severity} ${finding.name} (${finding.range}) — ${
        finding.direct ? 'direct' : 'transitive'
      }, ${fix}`,
    );
  }

  return findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
}

const production = runAudit({ omitDev: true });
const development = runAudit({ omitDev: false });

const blocking = [
  ...report('production', production).map((finding) => ({ graph: 'production', ...finding })),
  ...report('development', development).map((finding) => ({ graph: 'development', ...finding })),
];

if (blocking.length > 0) {
  console.error(`\n[audit] ${blocking.length} high or critical finding(s) must be fixed.`);
  for (const finding of blocking) {
    console.error(`[audit] ${finding.graph}: ${finding.severity} ${finding.name}`);
  }
  process.exit(EXIT_FAILURE);
}

console.log('\n[audit] no high or critical findings in the production or development graph.');
