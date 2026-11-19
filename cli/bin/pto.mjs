#!/usr/bin/env node
import { stdin, stdout, stderr, argv, env } from 'node:process';
import manifest from '../package.json' with { type: 'json' };

const control = new AbortController();
const cancel = () => control.abort();
let failedOutput = false;
const onOutputError = () => {
  failedOutput = true;
  cancel();
  process.exitCode = 10;
};

process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
stdout.on('error', onOutputError);
stderr.on('error', onOutputError);

try {
  const { runPto } = await import('../dist/main.js');
  const code = await runPto({
    args: argv.slice(2),
    env,
    input: stdin,
    stdout,
    stderr,
    signal: control.signal,
    version: manifest.version,
  });
  process.exitCode = failedOutput ? 10 : code;
} catch {
  process.exitCode = 10;
  if (!failedOutput)
    stderr.write('The PTO CLI could not start. Build the workspace and try again.\n');
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  // Leave the error guards in place for late stream errors while Node drains writes.
}
