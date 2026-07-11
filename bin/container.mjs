#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const ENGINES = ['podman', 'docker'];
const [, , ...args] = process.argv;

for (const engine of ENGINES) {
  const probe = spawnSync(engine, ['--version'], { stdio: 'ignore' });
  if (probe.status === 0) {
    const result = spawnSync(engine, args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
}

console.error(
  'error: no container engine found. Install podman (Fedora: `sudo dnf install podman`) or docker (https://docs.docker.com/engine/install/).',
);
process.exit(127);
