import { describe, expect, it } from 'vitest';
import { LoginSchema } from './schemas.js';

describe('LoginSchema', () => {
  it('accepts a valid email and non-empty password', () => {
    const result = LoginSchema.safeParse({ email: 'a@b.com', password: 'whatever' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty email', () => {
    const result = LoginSchema.safeParse({ email: '', password: 'whatever' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty password', () => {
    const result = LoginSchema.safeParse({ email: 'a@b.com', password: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-email email', () => {
    const result = LoginSchema.safeParse({ email: 'not-an-email', password: 'whatever' });
    expect(result.success).toBe(false);
  });

  it('rejects oversized email and password values before authentication work', () => {
    expect(
      LoginSchema.safeParse({ email: `${'a'.repeat(249)}@b.com`, password: 'whatever' }).success,
    ).toBe(false);
    expect(LoginSchema.safeParse({ email: 'a@b.com', password: 'a'.repeat(73) }).success).toBe(
      false,
    );
    expect(LoginSchema.safeParse({ email: 'a@b.com', password: 'a'.repeat(72) }).success).toBe(
      true,
    );
  });
});
