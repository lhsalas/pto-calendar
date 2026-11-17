import { describe, expect, it } from 'vitest';
import { timestampParameter } from './pgTime.js';

describe('timestamp without time zone parameters', () => {
  it('uses UTC wall-clock fields independent of process timezone', () => {
    const original = process.env.TZ;
    try {
      for (const timezone of ['Pacific/Honolulu', 'Asia/Kolkata']) {
        process.env.TZ = timezone;
        expect(timestampParameter(new Date('2026-06-01T12:34:56.789Z'))).toBe(
          '2026-06-01 12:34:56.789',
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('rejects invalid dates rather than generating an ambiguous timestamp', () => {
    expect(() => timestampParameter(new Date(NaN))).toThrow(RangeError);
  });
});
