// #273 is explicit temporary risk acceptance, not vulnerability remediation.
import assert from 'node:assert/strict';
import { IMAGE_PATTERN } from './production-images.mjs';

export const EXPIRY = '2026-12-15';
const severities = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const blocking = (finding) =>
  ['HIGH', 'CRITICAL'].includes(finding.severity) && Boolean(finding.fixedVersion);

export function validatePolicy(policy, today = new Date().toISOString().slice(0, 10)) {
  assert.equal(policy.approvedOn, '2026-11-15');
  assert.equal(policy.expiresOn, EXPIRY, 'no silent renewal of the owner-approved first deadline');
  assert.equal(policy.owner, 'Repository maintainers');
  assert.equal(policy.issue, 273);
  assert.equal(policy.remediationIssue, 247);
  assert.match(policy.legacyIgnoreSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    today >= policy.approvedOn && today < policy.expiresOn,
    'temporary acceptance expired or not yet authorized',
  );
  assert.ok(Array.isArray(policy.images) && policy.images.length > 0);
  const images = new Set();
  for (const entry of policy.images) {
    assert.ok(IMAGE_PATTERN.test(entry.image), 'acceptance must name an immutable image');
    assert.ok(!images.has(entry.image), 'duplicate image acceptance');
    images.add(entry.image);
    assert.ok(Array.isArray(entry.targets) && entry.targets.length > 0);
    assert.ok(entry.targets.every((target) => typeof target === 'string' && target.length > 0));
    assert.equal(new Set(entry.targets).size, entry.targets.length, 'duplicate target');
    assert.ok(Array.isArray(entry.packages));
    const keys = new Set();
    for (const pkg of entry.packages) {
      for (const key of ['name', 'path', 'target', 'installedVersion']) {
        assert.ok(typeof pkg[key] === 'string' && pkg[key].length > 0, `missing ${key}`);
      }
      assert.ok(!/[*?]/.test(pkg.path), 'paths are literal, not globs');
      assert.ok(entry.targets.includes(pkg.target));
      assert.ok(['HIGH', 'CRITICAL'].includes(pkg.severity));
      assert.ok(Array.isArray(pkg.advisories) && pkg.advisories.length > 0);
      for (const id of pkg.advisories) {
        assert.match(id, /^CVE-\d{4}-\d+$/);
        const key = JSON.stringify([
          pkg.target,
          pkg.path,
          pkg.name,
          pkg.installedVersion,
          pkg.severity,
          id,
        ]);
        assert.ok(!keys.has(key), 'duplicate accepted finding');
        keys.add(key);
      }
    }
  }
}

function validateReport(image, report, entry) {
  assert.equal(report.SchemaVersion, 2, 'unsupported Trivy report schema');
  assert.equal(report.ArtifactType, 'container_image');
  assert.equal(report.ArtifactName, image, 'report/image mismatch');
  assert.equal(
    report.Metadata?.ImageConfig?.architecture,
    'arm64',
    'wrong or missing architecture',
  );
  assert.equal(report.Metadata?.ImageConfig?.os, 'linux', 'wrong or missing OS');
  assert.ok(Array.isArray(report.Results) && report.Results.length > 0, 'missing scan results');
  const targets = new Set();
  for (const result of report.Results) {
    assert.ok(typeof result.Target === 'string' && result.Target.length > 0, 'missing target');
    assert.ok(!targets.has(result.Target), 'duplicate report target');
    targets.add(result.Target);
    for (const key of ['Packages', 'Vulnerabilities', 'Secrets', 'ExperimentalModifiedFindings']) {
      if (Object.hasOwn(result, key)) assert.ok(Array.isArray(result[key]), `malformed ${key}`);
    }
  }
  for (const target of entry.targets) {
    const result = report.Results.find((candidate) => candidate.Target === target);
    assert.ok(
      result && Array.isArray(result.Packages) && result.Packages.length > 0,
      `missing package coverage: ${target}`,
    );
  }
  for (const pkg of entry.packages) {
    const result = report.Results.find((candidate) => candidate.Target === pkg.target);
    assert.ok(
      result.Packages.some(
        (candidate) =>
          candidate.Name === pkg.name &&
          candidate.Version === pkg.installedVersion &&
          (candidate.FilePath || result.Target) === pkg.path,
      ),
      `missing package coverage: ${pkg.name}`,
    );
  }
}

function findings(report, suppressed = false, legacySource) {
  const entries = [];
  for (const result of report.Results) {
    const vulnerabilities = suppressed
      ? (result.ExperimentalModifiedFindings ?? []).map((item) => {
          assert.equal(item.Status, 'ignored');
          assert.equal(item.Type, 'vulnerability');
          assert.equal(item.Source, legacySource, 'unexpected suppression source');
          return item.Finding;
        })
      : (result.Vulnerabilities ?? []);
    assert.ok(Array.isArray(vulnerabilities));
    for (const vulnerability of vulnerabilities) {
      assert.ok(vulnerability && typeof vulnerability.VulnerabilityID === 'string');
      assert.ok(vulnerability.VulnerabilityID.length > 0);
      assert.ok(typeof vulnerability.PkgName === 'string' && vulnerability.PkgName.length > 0);
      assert.ok(
        typeof vulnerability.InstalledVersion === 'string' &&
          vulnerability.InstalledVersion.length > 0,
      );
      assert.ok(severities.includes(vulnerability.Severity), 'unknown severity');
      assert.ok(
        vulnerability.FixedVersion === undefined || typeof vulnerability.FixedVersion === 'string',
      );
      assert.ok(vulnerability.PkgPath === undefined || typeof vulnerability.PkgPath === 'string');
      entries.push({
        id: vulnerability.VulnerabilityID,
        package: vulnerability.PkgName,
        target: result.Target,
        path: vulnerability.PkgPath || result.Target,
        installedVersion: vulnerability.InstalledVersion,
        severity: vulnerability.Severity,
        fixedVersion: vulnerability.FixedVersion ?? '',
      });
    }
  }
  return entries;
}

export function evaluateImage(image, raw, legacy, policy, legacySource, today) {
  validatePolicy(policy, today);
  const entry = policy.images.find((candidate) => candidate.image === image);
  assert.ok(entry, `image/digest has no explicit review: ${image}`);
  validateReport(image, raw, entry);
  validateReport(image, legacy, entry);
  assert.ok(
    raw.Results.every((result) => !result.ExperimentalModifiedFindings?.length),
    'raw report must not suppress findings',
  );
  const all = findings(raw);
  const remaining = findings(legacy);
  const ignored = findings(legacy, true, legacySource);
  const keys = (list) => list.map((finding) => JSON.stringify(finding)).sort();
  assert.deepEqual(
    keys(all),
    keys([...remaining, ...ignored]),
    'legacy filtering lost or changed raw findings',
  );
  const coverage = (report) =>
    report.Results.map((result) => [
      result.Target,
      result.Class,
      result.Type,
      result.Packages ?? [],
      result.Secrets ?? [],
    ]);
  assert.deepEqual(
    coverage(raw),
    coverage(legacy),
    'legacy filtering must not change coverage or hide secrets',
  );
  const accepted = [];
  const rejected = [];
  for (const finding of remaining.filter(blocking)) {
    const matches = entry.packages.some(
      (pkg) =>
        pkg.advisories.includes(finding.id) &&
        pkg.name === finding.package &&
        pkg.target === finding.target &&
        pkg.path === finding.path &&
        pkg.installedVersion === finding.installedVersion &&
        pkg.severity === finding.severity,
    );
    (matches ? accepted : rejected).push(finding);
  }
  for (const result of raw.Results) {
    for (const secret of result.Secrets ?? []) {
      assert.ok(severities.includes(secret.Severity), 'unknown secret severity');
      if (['HIGH', 'CRITICAL'].includes(secret.Severity)) {
        rejected.push({
          id: secret.RuleID,
          target: result.Target,
          severity: secret.Severity,
          kind: 'secret',
        });
      }
    }
  }
  return {
    image,
    rawBlocking: all.filter(blocking).length,
    accepted,
    legacyAccepted: ignored.filter(blocking),
    rejected,
  };
}
