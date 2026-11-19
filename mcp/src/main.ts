import { parseArgs } from 'node:util';

import type { LaunchOptions, Runtime } from './contract.js';
import { serve } from './server.js';

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const USAGE = 'Start pto-mcp with an optional named profile and a local stdio connection.\n';
const LOCAL_ERROR = 'The local PTO tool server could not start. Verify the local setup.\n';

export function parseLaunch(args: readonly string[]): LaunchOptions | null {
  try {
    const config = parseArgs({
      args: [...args],
      options: {
        profile: { type: 'string', multiple: true },
        'allow-loopback-http': { type: 'boolean', multiple: true },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    if (config.tokens.some((token) => token.kind === 'option-terminator')) return null;
    const names = config.values.profile ?? [];
    if (names.length > 1 || (config.values['allow-loopback-http']?.length ?? 0) > 1) return null;
    const profile = names[0];
    if (profile !== undefined && !PROFILE_NAME.test(profile)) return null;
    return {
      ...(profile === undefined ? {} : { profile }),
      allowLoopbackHttp: config.values['allow-loopback-http']?.[0] === true,
    };
  } catch {
    return null;
  }
}

function diagnostic(runtime: Runtime, message: string): Promise<void> {
  return new Promise((resolve) => {
    runtime.stderr.write(message, () => resolve());
  });
}

export async function runMcp(runtime: Runtime): Promise<number> {
  try {
    const launch = parseLaunch(runtime.args);
    if (launch === null) {
      await diagnostic(runtime, USAGE);
      return 2;
    }
    return await serve(runtime, launch);
  } catch {
    try {
      await diagnostic(runtime, LOCAL_ERROR);
    } catch {
      // No alternate stream for diagnostics: stdout always belongs to the wire.
    }
    return 10;
  }
}
