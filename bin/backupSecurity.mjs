export const MIN_ENCRYPTION_KEY_LENGTH = 32;
export const MIN_ENCRYPTION_KEY_UNIQUE_CHARS = 16;

function uniqueCharacterCount(value) {
  return new Set(value).size;
}

export function assertStrongEncryptionKey(value) {
  if (value.length < MIN_ENCRYPTION_KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters long`);
  }
  if (uniqueCharacterCount(value) < MIN_ENCRYPTION_KEY_UNIQUE_CHARS) {
    throw new Error(
      `ENCRYPTION_KEY must contain at least ${MIN_ENCRYPTION_KEY_UNIQUE_CHARS} unique characters`,
    );
  }
  if (/^(replace[-_]?me|change[-_]?me|password|secret)/i.test(value)) {
    throw new Error('ENCRYPTION_KEY must not use a known placeholder or password prefix');
  }
}
