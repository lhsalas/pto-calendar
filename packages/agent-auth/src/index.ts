/**
 * The public surface of the local agent profile package.
 *
 * The package holds exactly four things: a factory that builds the profile
 * facade, the error type every failure is reported with, the types a caller
 * passes and receives, and the explicit secret reader.
 *
 * There is deliberately no way to add a store, a path, a header or a
 * transport from here. The facade binds a credential to the one origin it
 * belongs to, and it sends nothing.
 */

import { createLinuxKeyring } from './keyring.js';
import { createProfileFiles } from './profile-files.js';
import { createProfileFacade, type AgentAuth, type AgentAuthOptions } from './profiles.js';

/**
 * Creates the profile facade.
 *
 * The facade reads the local profile store and the operating system
 * credential store of this machine. The only thing a caller may choose is
 * the trusted absolute directory of the local store, which is useful on an
 * isolated or managed host.
 *
 * Neither store is opened here: a platform without a supported store still
 * gets a facade, and the failure is reported when the store is used.
 */
export function createAgentAuth(options: AgentAuthOptions = {}): AgentAuth {
  return createProfileFacade(
    { createFiles: createProfileFiles, createKeyring: createLinuxKeyring },
    options,
  );
}

export { AgentAuthError, type AgentAuthErrorCode } from './errors.js';

export {
  readSecretInput,
  type SecretInputMode,
  type SecretInputOptions,
  type SecretInputSource,
} from './secret-input.js';

export { AGENT_AUTH_GUIDANCE } from './profiles.js';

export type {
  AgentAuth,
  AgentAuthCredential,
  AgentAuthEnvironment,
  AgentAuthOptions,
  AgentAuthStatus,
  CredentialSource,
  ProfileStorage,
  RemoveProfileResult,
  ResolveInput,
  SetProfileInput,
  SetProfileResult,
  StatusInput,
} from './profiles.js';
