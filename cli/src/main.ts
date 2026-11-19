import type { Writable } from 'node:stream';

import type { SecretInputSource } from '@pto-calendar/agent-auth';

import { parseArguments } from './args.js';
import { executeCommand } from './execute-command.js';
import { HELP_TEXT } from './help.js';
import { renderResult } from './output.js';
import { CLI_SCHEMA_VERSION, EXIT_CODES, type CliResult, type ExitCode } from './contract.js';

type OutputStream = Pick<Writable, 'write'> & { readonly isTTY?: boolean };

export interface CliRuntime {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly input: SecretInputSource;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly signal: AbortSignal;
  readonly version: string;
}

function write(stream: OutputStream, text: string): Promise<void> {
  if (text === '') return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(text, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function runPto(runtime: CliRuntime): Promise<ExitCode> {
  const parsed = parseArguments(runtime.args);
  let result: CliResult;
  if (!parsed.ok) {
    result = {
      schemaVersion: CLI_SCHEMA_VERSION,
      ok: false,
      command: null,
      error: {
        code: 'USAGE',
        message: parsed.message,
        status: null,
        requestId: null,
        retryAfterMs: null,
      },
    };
  } else {
    const { command } = parsed;
    switch (command.kind) {
      case 'help':
        result = {
          schemaVersion: CLI_SCHEMA_VERSION,
          ok: true,
          command: 'help',
          data: { text: HELP_TEXT },
        };
        break;
      case 'version':
        result = {
          schemaVersion: CLI_SCHEMA_VERSION,
          ok: true,
          command: 'version',
          data: { version: runtime.version },
        };
        break;
      default:
        try {
          result = await executeCommand(command, {
            env: runtime.env,
            input: runtime.input,
            interactive: runtime.input.isTTY === true && runtime.stderr.isTTY === true,
            prompt: (text) => {
              runtime.stderr.write(text);
            },
            signal: runtime.signal,
          });
        } catch {
          // Unexpected failures must not surface a stack, an input, or a raw cause.
          result = {
            schemaVersion: CLI_SCHEMA_VERSION,
            ok: false,
            command: command.kind,
            error: {
              code: 'LOCAL',
              message: 'The CLI could not complete the operation.',
              status: null,
              requestId: null,
              retryAfterMs: null,
            },
          };
        }
    }
  }
  const output = renderResult(result, parsed.json);
  try {
    await write(runtime.stdout, output.stdout);
    await write(runtime.stderr, output.stderr);
  } catch {
    // The stream may be gone. Trying to write diagnostics again would be unsafe.
    return EXIT_CODES.LOCAL;
  }
  return output.exitCode;
}
