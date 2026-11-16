import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import unitConfig from '../../vitest.config.js';
import integrationConfig from '../../vitest.integration.config.js';

type Step = {
  run?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: { name?: string; path?: string; 'if-no-files-found'?: string };
};
type Job = { steps: Step[]; if?: unknown; 'continue-on-error'?: unknown };
type Workflow = { jobs: Record<string, Job> };

function validateCoverageWiring(workflow: Workflow, coverageScript: string): void {
  const unit = workflow.jobs['test-backend-unit'];
  if (!unit || 'if' in unit || 'continue-on-error' in unit) {
    throw new Error('unit job missing, conditional, or allowed to fail');
  }
  const commands = unit.steps.filter((step) => step.run === 'npm run test:coverage -w backend');
  if (commands.length !== 1 || 'if' in commands[0]! || 'continue-on-error' in commands[0]!) {
    throw new Error('unit coverage command not required');
  }
  if (coverageScript !== 'vitest run --coverage') throw new Error('coverage script changed');
  const check = unit.steps.find(
    (step) =>
      step.run ===
      'test -f backend/coverage-unit/lcov.info && test -f backend/coverage-unit/coverage-summary.json',
  );
  if (
    !check ||
    'if' in check ||
    'continue-on-error' in check ||
    unit.steps.indexOf(check) <= unit.steps.indexOf(commands[0]!)
  ) {
    throw new Error('unit report check not required after coverage');
  }
  const artifact = unit.steps.find((step) => step.with?.name === 'backend-unit-coverage');
  if (
    !artifact?.uses?.startsWith('actions/upload-artifact@') ||
    artifact.if !== 'always()' ||
    'continue-on-error' in artifact ||
    unit.steps.indexOf(artifact) <= unit.steps.indexOf(check) ||
    artifact.with?.path !== 'backend/coverage-unit' ||
    artifact.with?.['if-no-files-found'] !== 'error'
  ) {
    throw new Error('unit artifact missing or misconfigured');
  }
  for (const [jobName, name, reportPath] of [
    ['test-backend-integration', 'backend-coverage', 'backend/coverage'],
    ['test-frontend', 'frontend-coverage', 'frontend/coverage'],
  ] as const) {
    const uploads = workflow.jobs[jobName]?.steps.filter((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    if (
      !uploads?.length ||
      !uploads.some((step) => step.with?.name === name && step.with?.path === reportPath) ||
      uploads.some(
        (step) =>
          step.with?.name === 'backend-unit-coverage' ||
          step.with?.path === 'backend/coverage-unit',
      )
    ) {
      throw new Error('coverage artifacts collide');
    }
  }
}

describe('backend unit coverage wiring', () => {
  const workflow = parse(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  ) as Workflow;
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('requires the actual unit coverage command and a distinct artifact', () => {
    expect(() => validateCoverageWiring(workflow, pkg.scripts['test:coverage']!)).not.toThrow();
  });

  it('rejects reverting instrumentation or colliding artifact names', () => {
    const noCoverage = structuredClone(workflow);
    const command = noCoverage.jobs['test-backend-unit']!.steps.find(
      (step) => step.run === 'npm run test:coverage -w backend',
    )!;
    command.run = 'npm run test -w backend';
    expect(() => validateCoverageWiring(noCoverage, pkg.scripts['test:coverage']!)).toThrow();
    const conditional = structuredClone(workflow);
    conditional.jobs['test-backend-unit']!.steps.find(
      (step) => step.run === 'npm run test:coverage -w backend',
    )!.if = 'false';
    expect(() => validateCoverageWiring(conditional, pkg.scripts['test:coverage']!)).toThrow();
    expect(() => validateCoverageWiring(workflow, 'vitest run')).toThrow();
    const collision = structuredClone(workflow);
    const upload = collision.jobs['test-backend-integration']!.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    )!;
    upload.with!.name = 'backend-unit-coverage';
    expect(() => validateCoverageWiring(collision, pkg.scripts['test:coverage']!)).toThrow();
    const pathCollision = structuredClone(workflow);
    const otherUpload = pathCollision.jobs['test-backend-integration']!.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    )!;
    otherUpload.with!.path = 'backend/coverage-unit';
    expect(() => validateCoverageWiring(pathCollision, pkg.scripts['test:coverage']!)).toThrow();
    const noReportCheck = structuredClone(workflow);
    noReportCheck.jobs['test-backend-unit']!.steps = noReportCheck.jobs[
      'test-backend-unit'
    ]!.steps.filter((step) => !step.run?.startsWith('test -f backend/coverage-unit/'));
    expect(() => validateCoverageWiring(noReportCheck, pkg.scripts['test:coverage']!)).toThrow();
  });

  it('keeps local unit reports outside the integration report directory', () => {
    const unit = resolve('coverage-unit');
    const integration = resolve('coverage');
    expect(unitConfig.test?.coverage?.reportsDirectory).toBe('./coverage-unit');
    expect(integrationConfig.test?.coverage?.reportsDirectory).toBe('./coverage');
    expect(unit === integration || unit.startsWith(integration + sep)).toBe(false);
    expect(integration.startsWith(unit + sep)).toBe(false);
  });
});
