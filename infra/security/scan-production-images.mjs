#!/usr/bin/env node
// Save raw evidence first; only the exact #273 tuples can affect the exit status.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateImage, EXPIRY } from './image-risk-policy.mjs';
import { IMAGE_PATTERN } from './production-images.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = resolve(process.env.IMAGE_SCAN_OUTPUT ?? resolve(root, 'security-reports'));
const trivy = process.env.TRIVY_BIN ?? 'trivy';
const legacySource = resolve(root, '.trivyignore.yaml');
const summary = {
  status: 'accepted risk, NOT remediated',
  expiresOn: EXPIRY,
  remediationIssue: 247,
  images: [],
  errors: [],
};
mkdirSync(output, { recursive: true });
assert.equal(
  readdirSync(output).length,
  0,
  'use a fresh report directory; never reuse stale evidence',
);

function run(command, args, log) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(
    log,
    `${JSON.stringify({ command, args })}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed (status=${result.status}, signal=${result.signal}); see ${log}`,
  );
  return result.stdout;
}

try {
  const images = run(
    process.execPath,
    [resolve(root, 'infra/security/production-images.mjs')],
    resolve(output, 'enumeration.log'),
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.ok(images.length > 0, 'empty image inventory');
  assert.equal(new Set(images).size, images.length, 'duplicate image inventory');
  for (const [index, image] of images.entries()) {
    const prefix = resolve(output, String(index).padStart(2, '0'));
    try {
      assert.ok(IMAGE_PATTERN.test(image), 'refusing to scan an unpinned image');
      const rawFile = `${prefix}-raw.json`;
      const legacyFile = `${prefix}-legacy.json`;
      run(
        trivy,
        [
          'image',
          '--config',
          '',
          '--image-src',
          'remote',
          '--platform',
          'linux/arm64',
          '--scanners',
          'vuln,secret',
          '--severity',
          'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL',
          '--ignore-unfixed=false',
          '--ignorefile',
          '',
          '--exit-code',
          '0',
          '--no-progress',
          '--format',
          'json',
          '--output',
          rawFile,
          image,
        ],
        `${prefix}-scan.log`,
      );
      // Even invalid/missing policy inputs must not prevent the other raw scans.
      const policy = JSON.parse(
        readFileSync(resolve(root, 'infra/security/image-risk-acceptances.json'), 'utf8'),
      );
      const legacyHash = createHash('sha256').update(readFileSync(legacySource)).digest('hex');
      assert.equal(
        legacyHash,
        policy.legacyIgnoreSha256,
        'legacy exceptions changed without a policy review',
      );
      run(
        trivy,
        [
          'convert',
          '--config',
          '',
          '--ignorefile',
          legacySource,
          '--show-suppressed',
          '--exit-code',
          '0',
          '--format',
          'json',
          '--output',
          legacyFile,
          rawFile,
        ],
        `${prefix}-convert.log`,
      );
      const result = evaluateImage(
        image,
        JSON.parse(readFileSync(rawFile, 'utf8')),
        JSON.parse(readFileSync(legacyFile, 'utf8')),
        policy,
        legacySource,
      );
      summary.images.push(result);
      console.log(
        `${image}: accepted risk, NOT remediated; new=${result.accepted.length}, legacy=${result.legacyAccepted.length}, rejected=${result.rejected.length}`,
      );
    } catch (error) {
      summary.errors.push({ image, error: error.message });
      console.error(`${image}: ${error.message}`);
    }
  }
} catch (error) {
  summary.errors.push({ error: error.message });
  console.error(error.message);
}

const failed =
  summary.errors.length > 0 || summary.images.some((image) => image.rejected.length > 0);
summary.passedPolicy = !failed;
writeFileSync(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const lines = [
  '# Production image scan: accepted risk, NOT remediated',
  '',
  `Policy result: **${failed ? 'FAIL' : 'PASS WITH ACCEPTED RISK'}**. Owner-approved 2026-11-15; owner: Repository maintainers.`,
  `Temporary expiry: **${EXPIRY} (00:00 UTC)**. Permanent remediation **#247 stays OPEN, priority:high**.`,
  'Raw reports are unfiltered by severity, fix availability or exceptions; legacy reports retain suppressed entries.',
  '',
  ...summary.images.map(
    (image) =>
      `- \`${image.image}\`: raw HIGH/CRITICAL fixable=${image.rawBlocking}; temporary accepted=${image.accepted.length}; legacy accepted=${image.legacyAccepted.length}; rejected=${image.rejected.length}.`,
  ),
  ...summary.errors.map(({ image, error }) => `- ERROR ${JSON.stringify({ image, error })}`),
  '',
  'See summary.json for every accepted/rejected tuple and the original raw reports for all findings.',
  'Review maintained official candidates at least weekly; remove acceptances after validated pin replacement. No silent renewal.',
  '',
];
const markdown = lines.join('\n');
writeFileSync(resolve(output, 'accepted-risk.md'), markdown);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
process.exitCode = failed ? 1 : 0;
