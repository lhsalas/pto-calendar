const messages = {
  INVALID_PROFILE: 'Use a lowercase profile name of 1–32 letters, digits, underscores or hyphens.',
  INVALID_ORIGIN: 'Use a trusted HTTPS origin or explicitly opt into a literal loopback origin.',
  INVALID_TOKEN: 'Enter a valid personal access token without other text.',
  INVALID_OPTIONS: 'Check the local credential options and try again.',
  AMBIGUOUS_CREDENTIALS:
    'Choose either a configured profile or one managed environment credential.',
  ORIGIN_MISMATCH: 'The selected origin does not match the origin bound to this credential.',
  PROFILE_NOT_CONFIGURED: 'Set up a local profile before running this command.',
  PROFILE_CONFLICT: 'Remove the local profile before changing its origin or storage backend.',
  PROFILE_CORRUPT: 'The local profile could not be read as a valid profile.',
  CREDENTIAL_MISSING:
    'No local credential is available. Configure the profile with an active personal token.',
  FILE_UNSAFE: 'The local profile path is not safe for credential storage.',
  FILE_UNAVAILABLE: 'Profile file storage is unavailable on this local execution host.',
  FILE_BUSY:
    'This local profile is busy or has a stale lock; verify no profile operation is running.',
  KEYRING_UNSUPPORTED: 'The OS credential-store backend is not supported on this host.',
  KEYRING_UNAVAILABLE: 'The OS credential store is unavailable in this local session.',
  KEYRING_LOCKED: 'Unlock the OS credential store outside the tool call, then try again.',
  KEYRING_AMBIGUOUS:
    'Multiple local OS entries match this profile; review the matching entries before proceeding.',
  KEYRING_FAILED:
    'The OS credential-store operation could not be confirmed. Check the profile before retrying.',
  INPUT_REQUIRED: 'Provide one personal token using the selected secret input method.',
  INPUT_CANCELLED: 'Secret entry was cancelled.',
  INPUT_UNAVAILABLE: 'The selected secret input method is unavailable.',
} as const;

export type AgentAuthErrorCode = keyof typeof messages;

/** No environment, credential, path or original cause is included. */
export class AgentAuthError extends Error {
  constructor(public readonly code: AgentAuthErrorCode) {
    super(messages[code]);
    this.name = 'AgentAuthError';
  }
}
