#!/usr/bin/env node
import { argv, env, stderr, stdin, stdout } from 'node:process';
import manifest from '../package.json' with { type: 'json' };

const control = new AbortController();
const cancel = () => control.abort();
let outputFailed = false;
function brokenOutput() {
  outputFailed = true;
  process.exitCode = 10;
  cancel();
}

process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
stdout.on('error', brokenOutput);
stderr.on('error', brokenOutput);
try {
  const { runMcp } = await import('../dist/main.js');
  const code = await runMcp({
    args: argv.slice(2),
    env,
    stdin,
    stdout,
    stderr,
    signal: control.signal,
    version: manifest.version,
  });
  process.exitCode = outputFailed ? 10 : code;
} catch {
  process.exitCode = 10;
  if (!outputFailed) stderr.write('The PTO tool server could not start. Verify the local build.\n');
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
