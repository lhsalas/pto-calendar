// #273 is explicit temporary risk acceptance, not vulnerability remediation.
import assert from 'node:assert/strict';
import { IMAGE_PATTERN } from './production-images.mjs';

export const EXPIRY = '2026-12-15';
const severities = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const blocking = (finding) =>
  ['HIGH', 'CRITICAL'].includes(finding.severity) && Boolean(finding.fixedVersion);

function object(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `malformed ${label}`);
}

function knownFields(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    assert.ok(allowed.includes(key), `unsupported ${label} field: ${key}`);
  }
}

function stringFields(value, names) {
  for (const key of names) {
    if (Object.hasOwn(value, key)) assert.equal(typeof value[key], 'string', `malformed ${key}`);
  }
}

function stringArrays(value, names) {
  for (const key of names) {
    if (Object.hasOwn(value, key)) {
      assert.ok(
        Array.isArray(value[key]) && value[key].every((item) => typeof item === 'string'),
        `malformed ${key}`,
      );
    }
  }
}

function validateVulnerability(value) {
  // Trivy 0.76.2 DetectedVulnerability + advisory detail fields. Unknown keys
  // must not turn a renamed FixedVersion/findings field into "unfixed/clean".
  const strings = [
    'VulnerabilityID',
    'PkgID',
    'PkgName',
    'PkgPath',
    'InstalledVersion',
    'FixedVersion',
    'Status',
    'SeveritySource',
    'PrimaryURL',
    'Fingerprint',
    'Title',
    'Description',
    'Severity',
    'PublishedDate',
    'LastModifiedDate',
  ];
  const arrays = ['VendorIDs', 'CweIDs', 'References'];
  const objects = ['PkgIdentifier', 'Layer', 'DataSource', 'VendorSeverity', 'CVSS'];
  knownFields(value, [...strings, ...arrays, ...objects], 'vulnerability');
  stringFields(value, strings);
  stringArrays(value, arrays);
  for (const key of objects) if (Object.hasOwn(value, key)) object(value[key], key);
}

function validatePackage(value) {
  const strings = [
    'ID',
    'Name',
    'Version',
    'Release',
    'Arch',
    'SrcName',
    'SrcVersion',
    'SrcRelease',
    'Maintainer',
    'Modularitylabel',
    'Relationship',
    'FilePath',
    'Digest',
    'AnalyzedBy',
  ];
  const arrays = ['Licenses', 'DependsOn', 'InstalledFiles'];
  const objects = ['Identifier', 'BuildInfo', 'Repository', 'Layer'];
  knownFields(
    value,
    [...strings, ...arrays, ...objects, 'Epoch', 'SrcEpoch', 'Dev', 'Indirect', 'Locations'],
    'package',
  );
  assert.ok(typeof value.Name === 'string' && value.Name.length > 0, 'missing package name');
  stringFields(value, strings);
  stringArrays(value, arrays);
  for (const key of objects) if (Object.hasOwn(value, key)) object(value[key], key);
  for (const key of ['Epoch', 'SrcEpoch']) {
    if (Object.hasOwn(value, key)) assert.ok(Number.isSafeInteger(value[key]), `malformed ${key}`);
  }
  for (const key of ['Dev', 'Indirect']) {
    if (Object.hasOwn(value, key)) assert.equal(typeof value[key], 'boolean', `malformed ${key}`);
  }
  if (Object.hasOwn(value, 'Locations')) {
    assert.ok(Array.isArray(value.Locations), 'malformed Locations');
    for (const location of value.Locations) {
      knownFields(location, ['StartLine', 'EndLine'], 'location');
      for (const line of Object.values(location)) assert.ok(Number.isSafeInteger(line));
    }
  }
}

function validateSecret(value) {
  knownFields(
    value,
    [
      'RuleID',
      'Category',
      'Severity',
      'Title',
      'StartLine',
      'EndLine',
      'Code',
      'Match',
      'Layer',
      'Offset',
    ],
    'secret',
  );
  assert.ok(typeof value.RuleID === 'string' && value.RuleID.length > 0, 'missing secret RuleID');
  assert.ok(severities.includes(value.Severity), 'unknown secret severity');
  for (const key of ['Category', 'Title', 'Match'])
    assert.equal(typeof value[key], 'string', `malformed secret ${key}`);
  for (const key of [
    'StartLine',
    'EndLine',
    ...(Object.hasOwn(value, 'Offset') ? ['Offset'] : []),
  ]) {
    assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0, `malformed secret ${key}`);
  }
  assert.ok(value.EndLine >= value.StartLine, 'invalid secret line range');
  if (Object.hasOwn(value, 'Layer')) object(value.Layer, 'secret Layer');
  knownFields(value.Code, ['Lines'], 'secret Code');
  if (Object.hasOwn(value.Code, 'Lines')) {
    assert.ok(Array.isArray(value.Code.Lines), 'malformed secret Code.Lines');
    for (const line of value.Code.Lines) {
      knownFields(
        line,
        [
          'Number',
          'Content',
          'IsCause',
          'Annotation',
          'Truncated',
          'Highlighted',
          'FirstCause',
          'LastCause',
        ],
        'secret code line',
      );
      assert.ok(
        Number.isSafeInteger(line.Number) && line.Number >= 0,
        'malformed code line number',
      );
      stringFields(line, ['Content', 'Annotation', 'Highlighted']);
      for (const key of ['IsCause', 'Truncated', 'FirstCause', 'LastCause']) {
        if (Object.hasOwn(line, key)) assert.equal(typeof line[key], 'boolean', `malformed ${key}`);
      }
    }
  }
}

function validateResult(result) {
  object(result, 'result');
  const secret = result.Class === 'secret' && !Object.hasOwn(result, 'Type');
  const packages =
    (result.Class === 'os-pkgs' && result.Type === 'alpine') ||
    (result.Class === 'lang-pkgs' && ['gobinary', 'node-pkg'].includes(result.Type));
  assert.ok(secret || packages, 'unsupported result Class/Type');
  knownFields(
    result,
    secret
      ? ['Target', 'Class', 'Secrets']
      : ['Target', 'Class', 'Type', 'Packages', 'Vulnerabilities', 'ExperimentalModifiedFindings'],
    'result',
  );
  for (const key of ['Packages', 'Vulnerabilities', 'Secrets', 'ExperimentalModifiedFindings']) {
    if (Object.hasOwn(result, key)) assert.ok(Array.isArray(result[key]), `malformed ${key}`);
  }
  for (const pkg of result.Packages ?? []) validatePackage(pkg);
  for (const finding of result.Secrets ?? []) validateSecret(finding);
}

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
  const [tagged, digest] = image.split('@');
  const expected = `${tagged.slice(0, tagged.lastIndexOf(':'))}@${digest}`;
  // All four reviewed remote reports retain the requested index digest here.
  // ImageID is the selected ARM64 config digest, NOT an alternate accepted pin.
  assert.deepEqual(report.Metadata?.RepoDigests, [expected], 'missing or inconsistent RepoDigests');
  assert.equal(report.Metadata?.Reference, expected, 'missing or inconsistent Reference');
  assert.match(report.Metadata?.ImageID, /^sha256:[0-9a-f]{64}$/, 'malformed or missing ImageID');
  assert.equal(
    report.Metadata?.ImageConfig?.architecture,
    'arm64',
    'wrong or missing architecture',
  );
  assert.equal(report.Metadata?.ImageConfig?.os, 'linux', 'wrong or missing OS');
  assert.ok(Array.isArray(report.Results) && report.Results.length > 0, 'missing scan results');
  const targets = new Set();
  for (const result of report.Results) {
    validateResult(result);
    assert.ok(typeof result.Target === 'string' && result.Target.length > 0, 'missing target');
    assert.ok(!targets.has(result.Target), 'duplicate report target');
    targets.add(result.Target);
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
          knownFields(item, ['Type', 'Status', 'Statement', 'Source', 'Finding'], 'suppression');
          stringFields(item, ['Statement']);
          assert.equal(item.Status, 'ignored');
          assert.equal(item.Type, 'vulnerability');
          assert.equal(item.Source, legacySource, 'unexpected suppression source');
          return item.Finding;
        })
      : (result.Vulnerabilities ?? []);
    assert.ok(Array.isArray(vulnerabilities));
    for (const vulnerability of vulnerabilities) {
      validateVulnerability(vulnerability);
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
  assert.equal(
    raw.Metadata.ImageID,
    legacy.Metadata.ImageID,
    'converted image identity differs from raw',
  );
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
