import type { Writable } from 'node:stream';

import type { SecretInputSource } from '@pto-calendar/agent-auth';

import { parseArguments } from './args.js';
import { confirmWrite } from './confirmation.js';
import { executeCommand, type OperationContext } from './execute-command.js';
import { executeWrite } from './execute-write.js';
import { HELP_TEXT } from './help.js';
import { renderResult } from './output.js';
import {
  CLI_SCHEMA_VERSION,
  EXIT_CODES,
  type CliCommand,
  type CliResult,
  type ExitCode,
} from './contract.js';
import type { WriteCommand } from './write-contract.js';

type OutputStream = Pick<Writable, 'write'> & { readonly isTTY?: boolean };

/**
 * Whether a command is one of the three writes.
 *
 * Only a write needs a visible preview, so only a write can be refused for
 * a diagnostic stream that cannot show one. The guard keeps the narrowing of
 * the command union, so a write and a read never take the same path.
 */
function isWrite(command: CliCommand): command is WriteCommand {
  return command.kind === 'create' || command.kind === 'update' || command.kind === 'delete';
}

/**
 * The fixed refusal for a write whose preview cannot be shown.
 *
 * A terminal input with a redirected diagnostic stream cannot show the
 * preview a write needs, so the write is refused before any credential is
 * looked up, before a question is asked and before a request is sent. The
 * sentence is a constant: it names no stream, no path, no argument and no
 * cause.
 */
const WRITE_NEEDS_PREVIEW_STREAM =
  'The write was refused because it needs a terminal diagnostic stream to show its preview.';

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

async function publish(runtime: CliRuntime, result: CliResult, json: boolean): Promise<ExitCode> {
  const output = renderResult(result, json);
  try {
    await write(runtime.stdout, output.stdout);
    await write(runtime.stderr, output.stderr);
  } catch {
    // The stream may be gone. Trying to write diagnostics again would be unsafe.
    return EXIT_CODES.LOCAL;
  }
  return output.exitCode;
}

export async function runPto(runtime: CliRuntime): Promise<ExitCode> {
  const parsed = parseArguments(runtime.args);
  let result: CliResult;
  let publishing: Promise<ExitCode> | undefined;
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
      default: {
        if (isWrite(command) && runtime.input.isTTY === true && runtime.stderr.isTTY !== true) {
          // A terminal input with a redirected diagnostic stream cannot show
          // the preview a write needs. Such a write is refused here: before a
          // credential is looked up, before a question is asked and before a
          // request is sent. `--yes` never replaces a visible preview, and a
          // read or a setup command is never affected.
          result = {
            schemaVersion: CLI_SCHEMA_VERSION,
            ok: false,
            command: command.kind,
            error: {
              code: 'USAGE',
              message: WRITE_NEEDS_PREVIEW_STREAM,
              status: null,
              requestId: null,
              retryAfterMs: null,
            },
          };
          break;
        }
        try {
          const context: OperationContext = {
            env: runtime.env,
            input: runtime.input,
            interactive: runtime.input.isTTY === true && runtime.stderr.isTTY === true,
            prompt: (text) => {
              runtime.stderr.write(text);
            },
            signal: runtime.signal,
          };
          result = isWrite(command)
            ? await executeWrite(command, {
                ...context,
                confirm: (preview) =>
                  confirmWrite(
                    runtime.input,
                    runtime.stderr.isTTY === true,
                    runtime.signal,
                    (text) => write(runtime.stderr, text),
                    preview,
                  ),
                // Start at most one publication while the lease still
                // exists. Cancellation can release the lease before the
                // output stream acknowledges; never print the result twice.
                publishCreateResult: async (success) =>
                  (await (publishing ??= publish(runtime, success, parsed.json))) === 0,
              })
            : await executeCommand(command, context);
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
  }
  return publishing ?? publish(runtime, result, parsed.json);
}
