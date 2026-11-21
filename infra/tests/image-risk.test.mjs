#!/usr/bin/env node
// Native Node tests: no npm install, container daemon, DB or network required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateImage, validatePolicy } from '../security/image-risk-policy.mjs';
import { productionImages } from '../security/production-images.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ciWorkflow = resolve(root, '.github/workflows/ci.yml');
const normalizeExpression = (value) => value.replace(/\s+/g, ' ').trim();
// #309: the reviewed fail-safe invariant. The whole Security scan runs unless
// the named opt-in is exactly true AND GitHub's server context proves the
// canonical repository and a known non-tag route with a recognized branch ref
// type for PR/branch routes. Both tag indicators are conjuncts, so any tag
// (including a malformed event with only one indicator) always runs the entire
// scan. Keep this byte-for-byte reviewable.
const TAG_ONLY_GUARD = `
  !(
  vars.PTO_TAG_ONLY_SECURITY_SCAN == 'true' &&
  github.repository == 'lhsalas/pto-calendar' &&
  github.ref_type != 'tag' &&
  !startsWith(github.ref, 'refs/tags/') &&
  (
  (
  github.event_name == 'pull_request' &&
  github.ref_type == 'branch' &&
  github.event.pull_request.base.repo.full_name == 'lhsalas/pto-calendar' &&
  github.event.pull_request.head.repo.full_name == 'lhsalas/pto-calendar' &&
  github.event.pull_request.base.repo.id > 0 &&
  github.event.pull_request.head.repo.id == github.event.pull_request.base.repo.id &&
  github.event.pull_request.base.ref == github.base_ref &&
  github.event.pull_request.head.ref == github.head_ref &&
  github.base_ref != '' &&
  github.base_ref != null &&
  github.head_ref != '' &&
  github.head_ref != null &&
  github.event.pull_request.number > 0 &&
  github.ref == format('refs/pull/{0}/merge', github.event.pull_request.number)
  ) ||
  (
  (github.event_name == 'push' || github.event_name == 'schedule') &&
  github.ref_type == 'branch' &&
  github.ref == 'refs/heads/master'
  )
  )
  )
`;
const committed = JSON.parse(
  readFileSync(resolve(root, 'infra/security/image-risk-acceptances.json'), 'utf8'),
);

function tagOnlyGuard(ci = readFileSync(ciWorkflow, 'utf8')) {
  const security = ci.split('\n  security:\n')[1].split('\n  e2e:\n')[0];
  const jobLevelGuards = security.match(/^ {4}if\s*:/gm) ?? [];
  assert.equal(jobLevelGuards.length, 1, 'the security job may carry only the #309 job guard');
  const block = /^ {4}if:\s*>-\n((?: {6,}.*\n)+)/m.exec(security)?.[1];
  assert.ok(block, 'the security job must carry the exact #309 job guard');
  return { security, guard: normalizeExpression(block) };
}
const image = `fixture:1@sha256:${'a'.repeat(64)}`;
const otherImage = `other:1@sha256:${'b'.repeat(64)}`;
const legacySource = '/fixture/.trivyignore.yaml';
const target = 'Node.js';
const path = 'usr/local/lib/node_modules/npm/node_modules/undici/package.json';
const finding = {
  VulnerabilityID: 'CVE-2026-109383',
  PkgName: 'undici',
  PkgPath: path,
  InstalledVersion: '6.28.0',
  FixedVersion: '6.28.1',
  Severity: 'HIGH',
};
const entry = {
  image,
  targets: [target],
  packages: [
    {
      name: 'undici',
      target,
      path,
      installedVersion: '6.28.0',
      severity: 'HIGH',
      advisories: [finding.VulnerabilityID],
    },
  ],
};
const policy = { ...committed, images: [entry] };
const metadata = (reference) => ({
  RepoDigests: [reference.replace(/:[^:@/]+@/, '@')],
  Reference: reference.replace(/:[^:@/]+@/, '@'),
  ImageID: `sha256:${'c'.repeat(64)}`,
  ImageConfig: { os: 'linux', architecture: 'arm64' },
});
const report = {
  SchemaVersion: 2,
  ArtifactName: image,
  ArtifactType: 'container_image',
  Metadata: metadata(image),
  Results: [
    {
      Target: target,
      Class: 'lang-pkgs',
      Type: 'node-pkg',
      Packages: [{ Name: 'undici', Version: '6.28.0', FilePath: path }],
      Vulnerabilities: [finding],
    },
  ],
};
// Actual Trivy 0.76.2 output from a synthetic custom-rule scan, not credentials.
// Secret results have NO Type, Packages or Vulnerabilities fields.
const secretResult = {
  Target: 'settings.py',
  Class: 'secret',
  Secrets: [
    {
      RuleID: 'schema-test-rule',
      Category: 'general',
      Severity: 'HIGH',
      Title: 'Synthetic schema test marker (not credentials)',
      StartLine: 1,
      EndLine: 1,
      Code: {
        Lines: [
          {
            Number: 1,
            Content: 'marker = "***********************************" # Synthetic, not a credential',
            IsCause: true,
            Annotation: '',
            Truncated: false,
            Highlighted:
              'marker = "***********************************" # Synthetic, not a credential',
            FirstCause: true,
            LastCause: true,
          },
          {
            Number: 2,
            Content: '',
            IsCause: false,
            Annotation: '',
            Truncated: false,
            FirstCause: false,
            LastCause: false,
          },
        ],
      },
      Match: 'marker = "***********************************" # Synthetic, not a credential',
      Offset: 10,
    },
  ],
};
const clone = (value) => structuredClone(value);
// #294: the exact owner-authorized CVE-2026-86144 tuple, reproduced from the
// real pinned PostgreSQL image report that Trivy 0.76.2 produced for it.
const postgresImage =
  'postgres:16-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36';
const postgresTarget = `${postgresImage} (alpine 3.24.3)`;
const gosuTarget = 'usr/local/bin/gosu';
const libxml2Finding = {
  VulnerabilityID: 'CVE-2026-86144',
  PkgName: 'libxml2',
  InstalledVersion: '2.13.9-r2',
  FixedVersion: '2.13.9-r3',
  Severity: 'HIGH',
  Status: 'fixed',
};
const postgresReport = {
  SchemaVersion: 2,
  ArtifactName: postgresImage,
  ArtifactType: 'container_image',
  Metadata: metadata(postgresImage),
  Results: [
    {
      Target: postgresTarget,
      Class: 'os-pkgs',
      Type: 'alpine',
      Packages: [
        { Name: 'krb5-libs', Version: '1.22.2-r1' },
        { Name: 'libxml2', Version: '2.13.9-r2' },
        { Name: 'libxslt', Version: '1.1.43-r3' },
      ],
      Vulnerabilities: [libxml2Finding],
    },
    {
      Target: gosuTarget,
      Class: 'lang-pkgs',
      Type: 'gobinary',
      Packages: [{ Name: 'stdlib', Version: 'v1.26.8' }],
    },
  ],
};
const evaluatePostgres = (raw = postgresReport) =>
  evaluateImage(postgresImage, raw, clone(raw), committed, legacySource, '2026-11-15');
const evaluate = (raw = report, legacy = clone(raw), acceptance = policy, reference = image) =>
  evaluateImage(reference, raw, legacy, acceptance, legacySource, '2026-11-15');

test('committed policy covers exactly the current pinned production inventory', () => {
  validatePolicy(committed);
  assert.deepEqual(committed.images.map((item) => item.image).sort(), productionImages());
  const hash = createHash('sha256')
    .update(readFileSync(resolve(root, '.trivyignore.yaml')))
    .digest('hex');
  assert.equal(committed.legacyIgnoreSha256, hash, 'legacy scope/expiry must not change silently');
});

test('all eleven original CI jobs and mandatory security controls remain', () => {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  for (const job of [
    'lint',
    'typecheck',
    'test-backend-unit',
    'test-backend-integration',
    'test-frontend',
    'build',
    'deployment-config',
    'security',
    'e2e',
    'docker-smoke',
    'coverage-gate',
  ]) {
    assert.ok(ci.includes(`\n  ${job}:\n`), `missing required job: ${job}`);
  }
  const security = ci.split('\n  security:\n')[1].split('\n  e2e:\n')[0];
  assert.doesNotMatch(security, /continue-on-error|contents: write|security-events: write/);
  assert.match(security, /contents: read/);
  assert.match(security, /run: node infra\/security\/audit\.mjs/);
  assert.match(security, /version: v0\.76\.2/);
  assert.match(security, /run: node infra\/security\/scan-production-images\.mjs/);
  assert.match(security, /if: always\(\)/);
  assert.match(security, /if-no-files-found: error/);
  assert.match(security, /retention-days: 30/);
  assert.match(security, /^ {4}permissions:\n {6}contents: read$/m);
  assert.equal(
    (security.match(/^ {6}- /gm) ?? []).length,
    6,
    'the unchanged scanner steps must remain the only Security scan steps',
  );
  assert.doesNotMatch(security, /^ {4}(?:needs|outputs|env|continue-on-error)\s*:/m);
  assert.doesNotMatch(security, /waive_security_scan|PTO_SOURCE_DELIVERY|source-scan-waiver/i);
  assert.match(ci, /^  push:\n    branches: \[master\]\n    tags: \['v\*\.\*\.\*'\]$/m);
  assert.match(ci, /^  schedule:\n    - cron: '30 6 \* \* 1'$/m);
  // #309: the old #294 "never job-level guard" assertion is replaced by the
  // exact fail-safe tag-only invariant. The whole scan runs unless the named
  // opt-in is exactly true AND GitHub's server context proves a known non-tag
  // route; both tag indicators and the canonical repo/PR/fork checks are
  // conjuncts. No checkout, step output, needs, env or secret is consulted.
  const { guard } = tagOnlyGuard(ci);
  assert.equal(guard, normalizeExpression(TAG_ONLY_GUARD));
  assert.doesNotMatch(guard, /needs\.|steps\.|outputs\.|secrets\./);
});

test('tag refs always run the whole Security scan, including malformed tag metadata', () => {
  const { guard } = tagOnlyGuard();
  assert.equal(guard, normalizeExpression(TAG_ONLY_GUARD));
  assert.ok(guard.includes("github.ref_type != 'tag'"));
  assert.ok(guard.includes("!startsWith(github.ref, 'refs/tags/')"));
  // Both tag checks are conjuncts before the non-tag alternatives. Either
  // indicator alone therefore forces the full scan; the guard never contains
  // a positive ref-type tag route.
  const tagType = guard.indexOf("github.ref_type != 'tag'");
  const tagPrefix = guard.indexOf("!startsWith(github.ref, 'refs/tags/')");
  const firstEvent = guard.indexOf('github.event_name');
  assert.ok(tagType > 0 && tagPrefix > tagType && firstEvent > tagPrefix);
  assert.doesNotMatch(guard, /github\.ref_type == 'tag'/);
  assert.equal((guard.match(/refs\/tags\//g) ?? []).length, 1);
});

test('only a branch push or scheduled run on current master is a skippable branch route', () => {
  const { guard } = tagOnlyGuard();
  assert.equal(guard, normalizeExpression(TAG_ONLY_GUARD));
  assert.ok(
    guard.includes(
      "(github.event_name == 'push' || github.event_name == 'schedule') && github.ref_type == 'branch' && github.ref == 'refs/heads/master'",
    ),
  );
  assert.deepEqual(
    [...new Set([...(guard.match(/refs\/heads\/[^' ]+/g) ?? [])])],
    ['refs/heads/master'],
  );
});

test('a pull-request skip requires canonical same-repo base/head and the exact merge ref', () => {
  const { guard } = tagOnlyGuard();
  assert.equal(guard, normalizeExpression(TAG_ONLY_GUARD));
  assert.ok(guard.includes("github.event_name == 'pull_request' && github.ref_type == 'branch'"));
  assert.ok(
    guard.includes(
      "github.event_name == 'pull_request' && github.ref_type == 'branch' && github.event.pull_request.base.repo.full_name == 'lhsalas/pto-calendar'",
    ),
  );
  assert.ok(
    guard.includes("github.event.pull_request.head.repo.full_name == 'lhsalas/pto-calendar'"),
  );
  assert.ok(guard.includes('github.event.pull_request.base.repo.id > 0'));
  assert.ok(
    guard.includes(
      'github.event.pull_request.head.repo.id == github.event.pull_request.base.repo.id',
    ),
  );
  assert.ok(guard.includes('github.event.pull_request.base.ref == github.base_ref'));
  assert.ok(guard.includes('github.event.pull_request.head.ref == github.head_ref'));
  assert.ok(guard.includes("github.base_ref != ''"));
  assert.ok(guard.includes('github.base_ref != null'));
  assert.ok(guard.includes("github.head_ref != ''"));
  assert.ok(guard.includes('github.head_ref != null'));
  assert.ok(guard.includes('github.event.pull_request.number > 0'));
  assert.ok(
    guard.includes("github.ref == format('refs/pull/{0}/merge', github.event.pull_request.number)"),
  );
});

test('a pull-request skip requires a recognized branch ref type; missing/unknown values scan', () => {
  const { guard } = tagOnlyGuard();
  assert.equal(guard, normalizeExpression(TAG_ONLY_GUARD));
  // GitHub documents github.ref_type as "The type of ref that triggered the
  // workflow run. Valid values are branch or tag." A pull_request merge ref is
  // the non-tag PR merge branch (refs/pull/<n>/merge), so the PR skip requires
  // the recognized branch value. The outer `!= 'tag'` is not sufficient:
  // missing, null or unknown types must fail the PR clause and run the scan.
  const prStart = guard.indexOf("github.event_name == 'pull_request'");
  const prEnd = guard.indexOf(') ||');
  const prClause = guard.slice(prStart, prEnd);
  assert.ok(prStart > 0 && prEnd > prStart);
  assert.ok(prClause.includes("github.ref_type == 'branch'"));
  assert.ok(
    prClause.includes(
      "github.ref == format('refs/pull/{0}/merge', github.event.pull_request.number)",
    ),
  );
  assert.equal((guard.match(/github\.ref_type == 'branch'/g) ?? []).length, 2);
  assert.ok(guard.includes("github.ref_type != 'tag'"));
});

test('fork, unknown, invalid and absent/false opt-in contexts fail safe to the scan', () => {
  const { guard } = tagOnlyGuard();
  assert.equal(guard, normalizeExpression(TAG_ONLY_GUARD));
  // The guard is a single negation of a conjunction. The opt-in is the first
  // conjunct, so an absent, false or otherwise unequal value runs the whole
  // scan (GitHub string equality is case-insensitive, so a case variant is not
  // a second switch); every other requirement must also hold to skip.
  assert.ok(guard.startsWith('!('));
  assert.ok(
    guard.startsWith(
      "!( vars.PTO_TAG_ONLY_SECURITY_SCAN == 'true' && github.repository == 'lhsalas/pto-calendar'",
    ),
  );
  const eventNames = [
    ...new Set([...guard.matchAll(/github\.event_name == '([a-z_]+)'/g)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(eventNames, ['pull_request', 'push', 'schedule']);
  assert.equal((guard.match(/vars\./g) ?? []).length, 1, 'the named opt-in is the only variable');
  assert.equal((guard.match(/github\.repository == 'lhsalas\/pto-calendar'/g) ?? []).length, 1);
  assert.equal((guard.match(/base\.repo\.full_name == 'lhsalas\/pto-calendar'/g) ?? []).length, 1);
  assert.equal((guard.match(/head\.repo\.full_name == 'lhsalas\/pto-calendar'/g) ?? []).length, 1);
  assert.match(guard, /github\.ref == format\('refs\/pull\/\{0\}\/merge'/);
  assert.doesNotMatch(guard, /needs\.|steps\.|outputs\.|secrets\./);
});

test('exact tuple is accepted visibly without changing the raw report', () => {
  const raw = clone(report);
  const before = JSON.stringify(raw);
  const result = evaluate(raw);
  assert.equal(result.rawBlocking, 1);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.legacyAccepted.length, 0);
  assert.equal(JSON.stringify(raw), before);
});

for (const [field, value] of [
  ['VulnerabilityID', 'CVE-2026-999999'],
  ['PkgName', 'unrelated'],
  ['PkgPath', 'usr/lib/node_modules/undici/package.json'],
  ['InstalledVersion', '6.29.0'],
  ['Severity', 'CRITICAL'],
]) {
  test(`changed ${field} cannot inherit acceptance`, () => {
    const raw = clone(report);
    raw.Results[0].Vulnerabilities[0][field] = value;
    const result = evaluate(raw);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
  });
}

test('same advisory in another target cannot inherit acceptance', () => {
  const raw = clone(report);
  raw.Results.push({ ...clone(raw.Results[0]), Target: 'unrelated' });
  const result = evaluate(raw);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
});

test('the committed CVE-2026-86144 tuple is accepted visibly without changing the raw report', () => {
  const raw = clone(postgresReport);
  const before = JSON.stringify(raw);
  const result = evaluatePostgres(raw);
  assert.equal(result.rawBlocking, 1);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.legacyAccepted.length, 0);
  assert.deepEqual(result.accepted[0], {
    id: 'CVE-2026-86144',
    package: 'libxml2',
    target: postgresTarget,
    path: postgresTarget,
    installedVersion: '2.13.9-r2',
    severity: 'HIGH',
    fixedVersion: '2.13.9-r3',
  });
  assert.equal(JSON.stringify(raw), before);
});

for (const [label, mutate] of [
  [
    'advisory',
    (raw) => {
      raw.Results[0].Vulnerabilities[0].VulnerabilityID = 'CVE-2026-999999';
    },
  ],
  [
    'installed version',
    (raw) => {
      raw.Results[0].Vulnerabilities[0].InstalledVersion = '2.13.9-r3';
    },
  ],
  [
    'severity',
    (raw) => {
      raw.Results[0].Vulnerabilities[0].Severity = 'CRITICAL';
    },
  ],
  [
    'path',
    (raw) => {
      raw.Results[0].Vulnerabilities[0].PkgPath = 'usr/lib/libxml2.so';
    },
  ],
]) {
  test(`the committed CVE-2026-86144 acceptance cannot be inherited with a changed ${label}`, () => {
    const raw = clone(postgresReport);
    mutate(raw);
    const result = evaluatePostgres(raw);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
  });
}

test('the committed CVE-2026-86144 acceptance cannot be inherited by another image digest', () => {
  const otherDigest = `postgres:16-alpine@sha256:${'d'.repeat(64)}`;
  const raw = clone(postgresReport);
  raw.ArtifactName = otherDigest;
  raw.Metadata = metadata(otherDigest);
  assert.throws(
    () => evaluateImage(otherDigest, raw, clone(raw), committed, legacySource, '2026-11-15'),
    /no explicit review/,
  );
});

test('the committed policy names CVE-2026-86144 exactly once, for that tuple only', () => {
  const matches = committed.images.flatMap((entry) =>
    entry.packages.flatMap((pkg) =>
      pkg.advisories
        .filter((id) => id === 'CVE-2026-86144')
        .map(() => ({ image: entry.image, ...pkg })),
    ),
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].image, postgresImage);
  assert.equal(matches[0].name, 'libxml2');
  assert.equal(matches[0].target, postgresTarget);
  assert.equal(matches[0].path, postgresTarget);
  assert.equal(matches[0].installedVersion, '2.13.9-r2');
  assert.equal(matches[0].severity, 'HIGH');
  assert.deepEqual(matches[0].advisories, ['CVE-2026-86144']);
});

test('the committed policy carries exactly the 41 accepted advisories of the current raw scan', () => {
  const total = committed.images.reduce(
    (sum, entry) => sum + entry.packages.reduce((count, pkg) => count + pkg.advisories.length, 0),
    0,
  );
  assert.equal(total, 41);
});

test('changed digest and unknown clean image both fail closed', () => {
  for (const vulnerabilities of [[finding], []]) {
    const raw = clone(report);
    raw.ArtifactName = otherImage;
    raw.Results[0].Vulnerabilities = vulnerabilities;
    assert.throws(() => evaluate(raw, clone(raw), policy, otherImage), /no explicit review/);
  }
});

test('known, covered image can genuinely have zero blocking findings', () => {
  const raw = clone(report);
  delete raw.Results[0].Vulnerabilities;
  assert.equal(evaluate(raw).rawBlocking, 0);
  assert.equal(evaluate(raw).accepted.length, 0);
});

for (const side of ['raw', 'converted']) {
  for (const key of ['UnrecognizedFindings', 'Vulnerabilities', 'FutureFindings', 'BOM']) {
    test(`envelope: ${side} cannot move unreviewed CRITICAL findings into ${key}`, () => {
      const raw = clone(report);
      const converted = clone(report);
      for (const candidate of [raw, converted]) delete candidate.Results[0].Vulnerabilities;
      (side === 'raw' ? raw : converted)[key] = [
        { ...finding, VulnerabilityID: 'CVE-2026-999999', Severity: 'CRITICAL' },
      ];
      assert.throws(() => evaluate(raw, converted));
    });
  }
  for (const [label, change] of [
    [
      'ReportID number',
      (r) => {
        r.ReportID = 42;
      },
    ],
    [
      'ReportID null',
      (r) => {
        r.ReportID = null;
      },
    ],
    [
      'ArtifactID object',
      (r) => {
        r.ArtifactID = {};
      },
    ],
    [
      'ArtifactID null',
      (r) => {
        r.ArtifactID = null;
      },
    ],
    [
      'CreatedAt array',
      (r) => {
        r.CreatedAt = [];
      },
    ],
    [
      'CreatedAt invalid timestamp',
      (r) => {
        r.CreatedAt = 'not-a-timestamp';
      },
    ],
    [
      'Trivy array',
      (r) => {
        r.Trivy = [];
      },
    ],
    [
      'Trivy null',
      (r) => {
        r.Trivy = null;
      },
    ],
    [
      'Trivy string',
      (r) => {
        r.Trivy = '0.76.2';
      },
    ],
    [
      'Trivy.Version number',
      (r) => {
        r.Trivy = { Version: 42 };
      },
    ],
    [
      'Trivy unknown field',
      (r) => {
        r.Trivy = { UnrecognizedFindings: [] };
      },
    ],
    [
      'Trivy.Server string',
      (r) => {
        r.Trivy = { Server: 'not-an-object' };
      },
    ],
    [
      'Metadata array',
      (r) => {
        r.Metadata = [];
      },
    ],
    [
      'Results object',
      (r) => {
        r.Results = {};
      },
    ],
    [
      'SchemaVersion string',
      (r) => {
        r.SchemaVersion = '2';
      },
    ],
    [
      'ArtifactName array',
      (r) => {
        r.ArtifactName = [];
      },
    ],
    [
      'ArtifactType object',
      (r) => {
        r.ArtifactType = {};
      },
    ],
  ]) {
    test(`envelope: malformed ${side} ${label} blocks`, () => {
      const raw = clone(report);
      const converted = clone(report);
      change(side === 'raw' ? raw : converted);
      assert.throws(() => evaluate(raw, converted));
    });
  }
}

test('envelope: genuine optional metadata types preserve clean omitempty results', () => {
  const raw = clone(report);
  // Report/TrivyInfo values serialized by the pinned standalone scanner.
  raw.Trivy = { Version: '0.76.2' };
  raw.ReportID = '01a1e128-a6c0-710e-83a4-2d70cb46332b';
  raw.CreatedAt = '2026-11-15T16:41:40.160069868-05:00';
  raw.ArtifactID = 'sha256:abc';
  delete raw.Results[0].Vulnerabilities;
  assert.equal(evaluate(raw).rawBlocking, 0);
  assert.deepEqual(evaluate(raw).rejected, []);
  for (const key of ['Trivy', 'ReportID', 'CreatedAt', 'ArtifactID']) delete raw[key];
  assert.equal(evaluate(raw).rawBlocking, 0);
  raw.Results.push(clone(secretResult));
  assert.equal(evaluate(raw).rejected[0].kind, 'secret');
});

for (const [label, change] of [
  [
    'missing RepoDigests',
    (m) => {
      delete m.RepoDigests;
    },
  ],
  [
    'wrong RepoDigests',
    (m) => {
      m.RepoDigests = [`fixture@sha256:${'f'.repeat(64)}`];
    },
  ],
  [
    'empty RepoDigests',
    (m) => {
      m.RepoDigests = [];
    },
  ],
  [
    'null RepoDigests',
    (m) => {
      m.RepoDigests = null;
    },
  ],
  [
    'non-array RepoDigests',
    (m) => {
      m.RepoDigests = m.RepoDigests[0];
    },
  ],
  [
    'non-string digest',
    (m) => {
      m.RepoDigests = [42];
    },
  ],
  [
    'wrong repository',
    (m) => {
      m.RepoDigests = [m.RepoDigests[0].replace('fixture@', 'elsewhere@')];
    },
  ],
  [
    'config digest substituted for pin',
    (m) => {
      m.RepoDigests = [`fixture@${m.ImageID}`];
    },
  ],
  [
    'mixed image identities',
    (m) => {
      m.RepoDigests.push(otherImage.replace(/:[^:@/]+@/, '@'));
    },
  ],
  [
    'duplicate digest identities',
    (m) => {
      m.RepoDigests.push(m.RepoDigests[0]);
    },
  ],
  [
    'missing Reference',
    (m) => {
      delete m.Reference;
    },
  ],
  [
    'wrong Reference',
    (m) => {
      m.Reference = otherImage.replace(/:[^:@/]+@/, '@');
    },
  ],
  [
    'malformed Reference',
    (m) => {
      m.Reference = { digest: m.Reference };
    },
  ],
  [
    'missing ImageID',
    (m) => {
      delete m.ImageID;
    },
  ],
  [
    'malformed ImageID',
    (m) => {
      m.ImageID = 'not-an-image-id';
    },
  ],
]) {
  test(`review: ${label} fails despite unchanged ArtifactName`, () => {
    const raw = clone(report);
    change(raw.Metadata);
    assert.throws(() => evaluate(raw));
  });
}

test('review: converted identity cannot differ from raw selected image configuration', () => {
  const converted = clone(report);
  converted.Metadata.ImageID = `sha256:${'d'.repeat(64)}`;
  assert.throws(() => evaluate(report, converted));
});

for (const [label, change] of [
  [
    'unsupported Class',
    (r) => {
      r.Class = 'future-class';
    },
  ],
  [
    'unsupported Type',
    (r) => {
      r.Type = 'future-package-format';
    },
  ],
  [
    'missing Class',
    (r) => {
      delete r.Class;
    },
  ],
  [
    'missing Type',
    (r) => {
      delete r.Type;
    },
  ],
  [
    'mismatched Class/Type',
    (r) => {
      r.Class = 'os-pkgs';
    },
  ],
  [
    'renamed vulnerability array',
    (r) => {
      r.UnrecognizedFindings = r.Vulnerabilities;
      delete r.Vulnerabilities;
    },
  ],
  [
    'unknown findings field alongside known findings',
    (r) => {
      r.FutureFindings = [];
    },
  ],
  [
    'unexpected scanner field',
    (r) => {
      r.Misconfigurations = [];
    },
  ],
  [
    'renamed fix availability',
    (r) => {
      r.Vulnerabilities[0].PatchedVersion = r.Vulnerabilities[0].FixedVersion;
      delete r.Vulnerabilities[0].FixedVersion;
    },
  ],
  [
    'malformed package value',
    (r) => {
      r.Packages.push({ Name: 42 });
    },
  ],
  [
    'malformed optional version',
    (r) => {
      r.Packages.push({ Name: 'extra', Version: [] });
    },
  ],
  [
    'malformed advisory array value',
    (r) => {
      r.Vulnerabilities[0].VendorIDs = [42];
    },
  ],
  [
    'null optional advisory field',
    (r) => {
      r.Vulnerabilities[0].FixedVersion = null;
    },
  ],
  [
    'malformed suppression value',
    (r) => {
      r.ExperimentalModifiedFindings = [null];
    },
  ],
]) {
  test(`review: ${label} in both reports cannot masquerade as a clean schema`, () => {
    const raw = clone(report);
    change(raw.Results[0]);
    assert.throws(() => evaluate(raw));
  });
}

test('global threshold stays HIGH/CRITICAL with a published fix', () => {
  const raw = clone(report);
  raw.Results[0].Vulnerabilities = [
    { ...finding, VulnerabilityID: 'CVE-2026-999991', Severity: 'MEDIUM' },
    { ...finding, VulnerabilityID: 'CVE-2026-999992', FixedVersion: '' },
    { ...finding, VulnerabilityID: 'CVE-2026-999993', Severity: 'CRITICAL' },
  ];
  const result = evaluate(raw);
  assert.equal(result.rawBlocking, 1);
  assert.deepEqual(
    result.rejected.map((item) => item.id),
    ['CVE-2026-999993'],
  );
});

test('expiry starts at 00:00 UTC; approval and expiry cannot silently move', () => {
  validatePolicy(policy, '2026-12-14');
  for (const today of ['2026-11-14', '2026-12-15', '2027-01-01']) {
    assert.throws(() => validatePolicy(policy, today), /expired or not yet authorized/);
  }
  for (const [key, value] of [
    ['expiresOn', '2027-01-15'],
    ['approvedOn', '2026-11-16'],
    ['owner', 'someone else'],
    ['issue', 247],
    ['remediationIssue', 273],
  ]) {
    assert.throws(() => validatePolicy({ ...policy, [key]: value }, '2026-11-15'));
  }
});

test('wildcard paths, advisory globs, duplicate tuples and mutable images are invalid', () => {
  for (const change of [
    (p) => {
      p.images[0].packages[0].path = '*undici*';
    },
    (p) => {
      p.images[0].packages[0].advisories = ['CVE-*'];
    },
    (p) => {
      p.images[0].packages.push(clone(p.images[0].packages[0]));
    },
    (p) => {
      p.images.push(clone(p.images[0]));
    },
    (p) => {
      p.images[0].image = 'fixture:latest';
    },
    (p) => {
      p.images[0].targets = [];
    },
  ]) {
    const invalid = clone(policy);
    change(invalid);
    assert.throws(() => validatePolicy(invalid, '2026-11-15'));
  }
});

for (const [label, change] of [
  [
    'schema',
    (r) => {
      r.SchemaVersion = 3;
    },
  ],
  [
    'artifact type',
    (r) => {
      r.ArtifactType = 'filesystem';
    },
  ],
  [
    'image identity',
    (r) => {
      r.ArtifactName = otherImage;
    },
  ],
  [
    'platform',
    (r) => {
      r.Metadata.ImageConfig.architecture = 'amd64';
    },
  ],
  [
    'OS',
    (r) => {
      r.Metadata.ImageConfig.os = 'windows';
    },
  ],
  [
    'missing metadata',
    (r) => {
      delete r.Metadata;
    },
  ],
  [
    'missing results',
    (r) => {
      delete r.Results;
    },
  ],
  [
    'empty results',
    (r) => {
      r.Results = [];
    },
  ],
  [
    'missing target',
    (r) => {
      delete r.Results[0].Target;
    },
  ],
  [
    'duplicate target',
    (r) => {
      r.Results.push(clone(r.Results[0]));
    },
  ],
  [
    'missing coverage',
    (r) => {
      delete r.Results[0].Packages;
    },
  ],
  [
    'empty coverage',
    (r) => {
      r.Results[0].Packages = [];
    },
  ],
  [
    'missing affected package',
    (r) => {
      r.Results[0].Packages[0].Name = 'unrelated';
    },
  ],
  [
    'malformed findings',
    (r) => {
      r.Results[0].Vulnerabilities = {};
    },
  ],
  [
    'null findings',
    (r) => {
      r.Results[0].Vulnerabilities = null;
    },
  ],
  [
    'invalid severity',
    (r) => {
      r.Results[0].Vulnerabilities[0].Severity = 'NONE';
    },
  ],
  [
    'missing package',
    (r) => {
      delete r.Results[0].Vulnerabilities[0].PkgName;
    },
  ],
  [
    'malformed path',
    (r) => {
      r.Results[0].Vulnerabilities[0].PkgPath = {};
    },
  ],
  [
    'malformed fixed version',
    (r) => {
      r.Results[0].Vulnerabilities[0].FixedVersion = [];
    },
  ],
]) {
  test(`${label} report fails closed`, () => {
    const raw = clone(report);
    change(raw);
    assert.throws(() => evaluate(raw));
  });
}

function withLegacy() {
  const raw = clone(report);
  const old = { ...finding, VulnerabilityID: 'CVE-2026-19534' };
  raw.Results[0].Vulnerabilities.push(old);
  const legacy = clone(report);
  legacy.Results[0].ExperimentalModifiedFindings = [
    {
      Type: 'vulnerability',
      Status: 'ignored',
      Source: legacySource,
      Finding: old,
    },
  ];
  return { raw, legacy };
}

test('unchanged legacy filtering is visible and reconciled with every raw finding', () => {
  const { raw, legacy } = withLegacy();
  const result = evaluate(raw, legacy);
  assert.equal(result.rawBlocking, 2);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.legacyAccepted.length, 1);
});

for (const [label, change] of [
  [
    'finding removed',
    (r) => {
      r.Results[0].Vulnerabilities = [];
    },
  ],
  [
    'finding changed',
    (r) => {
      r.Results[0].Vulnerabilities[0].Severity = 'LOW';
    },
  ],
  [
    'suppression source changed',
    (r) => {
      r.Results[0].ExperimentalModifiedFindings[0].Source = '/elsewhere';
    },
  ],
  [
    'suppression status changed',
    (r) => {
      r.Results[0].ExperimentalModifiedFindings[0].Status = 'accepted';
    },
  ],
  [
    'suppression type changed',
    (r) => {
      r.Results[0].ExperimentalModifiedFindings[0].Type = 'secret';
    },
  ],
  [
    'package coverage changed',
    (r) => {
      r.Results[0].Packages.push({ Name: 'extra' });
    },
  ],
]) {
  test(`legacy tampering (${label}) fails closed`, () => {
    const { raw, legacy } = withLegacy();
    change(legacy);
    assert.throws(() => evaluate(raw, legacy));
  });
}

test('suppressed raw report cannot masquerade as unfiltered evidence', () => {
  const { legacy } = withLegacy();
  assert.throws(() => evaluate(legacy), /raw report must not suppress/);
});

test('secrets are never covered by a vulnerability acceptance or hidden by conversion', () => {
  const raw = clone(report);
  raw.Results.push(clone(secretResult));
  assert.equal(evaluate(raw).rejected[0].kind, 'secret');
  const legacy = clone(raw);
  legacy.Results.pop();
  assert.throws(() => evaluate(raw, legacy), /hide secrets/);
  raw.Results[1].Secrets[0].Severity = 'UNKNOWN-SCHEMA';
  assert.throws(() => evaluate(raw), /unknown secret severity/);
});

test('genuine secret shape omits Type and unrelated arrays, but keeps findings blocking', () => {
  const raw = clone(report);
  raw.Results.push(clone(secretResult));
  const result = evaluate(raw);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.rejected[0], {
    id: 'schema-test-rule',
    target: 'settings.py',
    severity: 'HIGH',
    kind: 'secret',
  });
});

for (const [label, change] of [
  [
    'unexpected Type',
    (r) => {
      r.Type = 'node-pkg';
    },
  ],
  [
    'null Type',
    (r) => {
      r.Type = null;
    },
  ],
  [
    'package findings on secret result',
    (r) => {
      r.Vulnerabilities = [];
    },
  ],
  [
    'renamed secret array',
    (r) => {
      r.OtherSecrets = r.Secrets;
      delete r.Secrets;
    },
  ],
  [
    'malformed secret entry',
    (r) => {
      r.Secrets = [null];
    },
  ],
  [
    'malformed RuleID',
    (r) => {
      r.Secrets[0].RuleID = [];
    },
  ],
  [
    'malformed Category',
    (r) => {
      r.Secrets[0].Category = {};
    },
  ],
  [
    'malformed line number',
    (r) => {
      r.Secrets[0].StartLine = '1';
    },
  ],
  [
    'malformed Match',
    (r) => {
      r.Secrets[0].Match = [];
    },
  ],
  [
    'malformed code lines',
    (r) => {
      r.Secrets[0].Code.Lines = {};
    },
  ],
  [
    'unknown secret field',
    (r) => {
      r.Secrets[0].OtherFinding = {};
    },
  ],
]) {
  test(`secret schema rejects ${label} in raw and converted reports`, () => {
    const raw = clone(report);
    const secret = clone(secretResult);
    change(secret);
    raw.Results.push(secret);
    assert.throws(() => evaluate(raw));
  });
}

function fixture(t) {
  const directory = mkdtempSync(
    join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'image-risk-test-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (name, content) => {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  };
  for (const name of [
    'production-images.mjs',
    'image-risk-policy.mjs',
    'scan-production-images.mjs',
  ]) {
    mkdirSync(join(directory, 'infra/security'), { recursive: true });
    copyFileSync(resolve(root, 'infra/security', name), join(directory, 'infra/security', name));
  }
  put('backend/Dockerfile', `FROM ${image} AS build\nFROM ${image} AS runtime\n`);
  put('frontend/Dockerfile', `FROM --platform=linux/arm64 ${otherImage} AS frontend\n`);
  put('docker-compose.prod.yml', `services:\n  proxy:\n    image: '${otherImage}'\n`);
  put('.trivyignore.yaml', 'vulnerabilities: []\n');
  const acceptance = clone(policy);
  acceptance.legacyIgnoreSha256 = createHash('sha256')
    .update('vulnerabilities: []\n')
    .digest('hex');
  acceptance.images.push({ ...clone(entry), image: otherImage });
  const savePolicy = () =>
    put('infra/security/image-risk-acceptances.json', JSON.stringify(acceptance));
  savePolicy();
  const clean = clone(report);
  clean.ArtifactName = otherImage;
  clean.Metadata = metadata(otherImage);
  clean.Results[0].Vulnerabilities = [];
  put('reports.json', JSON.stringify({ [image]: report, [otherImage]: clean }));
  put(
    'trivy-stub.mjs',
    `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const flag = (key) => args[args.indexOf(key) + 1];
appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
assert.equal(flag('--exit-code'), '0');
assert.equal(flag('--config'), '');
const mode = process.env.IMAGE_RISK_TEST_MODE;
if (args[0] === 'image') {
  assert.equal(flag('--platform'), 'linux/arm64');
  assert.equal(flag('--image-src'), 'remote');
  assert.equal(flag('--scanners'), 'vuln,secret');
  assert.equal(flag('--severity'), 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL');
  assert.equal(flag('--ignorefile'), '');
  assert.ok(args.includes('--ignore-unfixed=false'));
  const reference = args.at(-1);
  const raw = JSON.parse(readFileSync('reports.json'))[reference];
  if (reference.startsWith('fixture:')) {
    if (mode === 'missing-report') process.exit(0);
    if (mode === 'malformed-report') {
      writeFileSync(flag('--output'), '{not JSON');
      process.exit(0);
    }
    if (mode === 'new-advisory') raw.Results[0].Vulnerabilities[0].VulnerabilityID = 'CVE-2026-999999';
    if (mode === 'identity-missing') delete raw.Metadata.RepoDigests;
    if (mode === 'identity-mismatch') raw.Metadata.RepoDigests = ['fixture@sha256:' + 'f'.repeat(64)];
    if (mode === 'schema-unsupported-type') raw.Results[0].Type = 'future-package-format';
    if (mode === 'schema-renamed-findings') {
      raw.Results[0].UnrecognizedFindings = raw.Results[0].Vulnerabilities;
      delete raw.Results[0].Vulnerabilities;
    }
  }
  writeFileSync(flag('--output'), JSON.stringify(raw));
  if (mode === 'scan-error' && reference.startsWith('fixture:')) process.exit(7);
} else {
  assert.equal(args[0], 'convert');
  assert.ok(args.includes('--show-suppressed'));
  assert.ok(flag('--ignorefile').endsWith('.trivyignore.yaml'));
  const raw = JSON.parse(readFileSync(args.at(-1)));
  if (mode === 'convert-error' && raw.ArtifactName.startsWith('fixture:')) process.exit(8);
  writeFileSync(flag('--output'), JSON.stringify(raw));
}
`,
  );
  // Use a Node wrapper rather than relying on executable-mode portability.
  put(
    'trivy-stub',
    `#!/bin/sh\nexec "${process.execPath}" "${join(directory, 'trivy-stub.mjs')}" "$@"\n`,
  );
  const output = join(directory, 'evidence');
  const run = (mode) =>
    spawnSync(process.execPath, [join(directory, 'infra/security/scan-production-images.mjs')], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        IMAGE_SCAN_OUTPUT: output,
        TRIVY_BIN: join(directory, 'trivy-stub'),
        IMAGE_RISK_TEST_MODE: mode ?? '',
        GITHUB_STEP_SUMMARY: join(directory, 'step-summary.md'),
      },
    });
  chmodSync(join(directory, 'trivy-stub'), 0o700);
  const calls = () =>
    readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const summary = () => JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  return { directory, output, put, acceptance, savePolicy, run, calls, summary };
}

test('runner retains complete evidence, logs and conspicuous accepted-risk summaries', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.summary().passedPolicy, true);
  assert.deepEqual(
    f.summary().images.map((item) => item.accepted.length),
    [1, 0],
  );
  assert.match(result.stdout, /accepted risk, NOT remediated/);
  assert.match(
    readFileSync(join(f.directory, 'step-summary.md'), 'utf8'),
    /#247 stays OPEN, priority:high/,
  );
  for (const prefix of ['00', '01']) {
    for (const suffix of ['raw.json', 'legacy.json', 'scan.log', 'convert.log']) {
      assert.ok(existsSync(join(f.output, `${prefix}-${suffix}`)));
    }
  }
  assert.equal(
    JSON.parse(readFileSync(join(f.output, '00-raw.json'))).Results[0].Vulnerabilities.length,
    1,
  );
  assert.equal(f.calls().length, 4);
});

for (const mode of [
  'scan-error',
  'convert-error',
  'missing-report',
  'malformed-report',
  'new-advisory',
  'identity-missing',
  'identity-mismatch',
  'schema-unsupported-type',
  'schema-renamed-findings',
]) {
  test(`runner blocks ${mode} and still attempts every image`, (t) => {
    const f = fixture(t);
    const result = f.run(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.summary().passedPolicy, false);
    assert.deepEqual(
      f
        .calls()
        .filter((args) => args[0] === 'image')
        .map((args) => args.at(-1)),
      [image, otherImage],
    );
    assert.ok(existsSync(join(f.output, '01-raw.json')));
    assert.match(
      readFileSync(join(f.output, 'accepted-risk.md'), 'utf8'),
      /Policy result: \*\*FAIL/,
    );
  });
}

for (const problem of ['unknown-digest', 'legacy-changed', 'policy-missing', 'policy-malformed']) {
  test(`runner blocks ${problem} without skipping later raw scans`, (t) => {
    const f = fixture(t);
    if (problem === 'unknown-digest') {
      f.acceptance.images.shift();
      f.savePolicy();
    } else if (problem === 'legacy-changed') {
      f.put('.trivyignore.yaml', 'vulnerabilities: []\n# changed\n');
    } else if (problem === 'policy-missing') {
      rmSync(join(f.directory, 'infra/security/image-risk-acceptances.json'));
    } else {
      f.put('infra/security/image-risk-acceptances.json', '{not JSON');
    }
    assert.equal(f.run().status, 1);
    assert.equal(f.summary().passedPolicy, false);
    assert.equal(f.calls().filter((args) => args[0] === 'image').length, 2);
  });
}

test('runner rejects stale output without overwriting previous evidence', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const before = readFileSync(join(f.output, 'summary.json'), 'utf8');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fresh report directory/);
  assert.equal(readFileSync(join(f.output, 'summary.json'), 'utf8'), before);
  assert.equal(f.calls().length, 4);
});

for (const source of [
  'FROM fixture:latest',
  'FROM fixture:latest AS build',
  'FROM --platform=linux/arm64 fixture:latest AS build',
  'FROM ${BASE_IMAGE} AS build',
  `FROM ${image} AS build unexpected`,
  'FROM scratch',
  '# no image references',
]) {
  test(`enumeration error is blocking: ${source}`, (t) => {
    const f = fixture(t);
    f.put('backend/Dockerfile', `${source}\n`);
    assert.throws(() => productionImages(f.directory), /production image/);
    assert.equal(f.run().status, 1);
    assert.equal(f.summary().passedPolicy, false);
    assert.equal(existsSync(join(f.directory, 'calls.jsonl')), false);
  });
}

test('enumeration rejects unpinned Compose references and missing source files', (t) => {
  const f = fixture(t);
  f.put('docker-compose.prod.yml', 'services:\n  proxy:\n    image: nginx:latest\n');
  assert.throws(() => productionImages(f.directory), /digest-pinned/);
  rmSync(join(f.directory, 'backend/Dockerfile'));
  assert.equal(f.run().status, 1);
  assert.match(f.summary().errors[0].error, /failed/);
});

const unreviewedImage = `unreviewed:1@sha256:${'e'.repeat(64)}`;
for (const [label, declaration] of [
  ['flow service', `  unreviewed: { image: '${unreviewedImage}' }\n`],
  ['flow service with quoted image key', `  unreviewed: { "image": "${unreviewedImage}" }\n`],
  ['quoted image key', `  unreviewed:\n    'image': '${unreviewedImage}'\n`],
  ['JSON image key', `  unreviewed:\n    "image": "${unreviewedImage}"\n`],
  ['escaped image key', `  unreviewed:\n    "\\u0069mage": "${unreviewedImage}"\n`],
  ['explicit image key', `  unreviewed:\n    ? image\n    : '${unreviewedImage}'\n`],
  ['flow alias', `  unreviewed: &hidden { image: '${unreviewedImage}' }\n`],
]) {
  test(`review: valid unreviewed Compose ${label} cannot escape the runner`, (t) => {
    const f = fixture(t);
    f.put(
      'docker-compose.prod.yml',
      `services:\n  reviewed:\n    image: '${otherImage}'\n${declaration}`,
    );
    const result = f.run();
    assert.equal(result.status, 1, 'unreviewed service silently escaped scanning/policy');
    assert.equal(f.summary().passedPolicy, false);
  });
}

test('review: a JSON/flow Compose document cannot escape enumeration', (t) => {
  const f = fixture(t);
  f.put(
    'docker-compose.prod.yml',
    JSON.stringify({
      services: { reviewed: { image: otherImage }, unreviewed: { image: unreviewedImage } },
    }),
  );
  assert.equal(f.run().status, 1);
  assert.equal(f.summary().passedPolicy, false);
});
