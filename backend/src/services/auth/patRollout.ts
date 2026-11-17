import { z } from 'zod';

// Strict opt-in, including in development/test. "false" must not coerce to true.
const disabledByDefault = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
export const patRolloutFields = {
  PAT_AUTH_ENABLED: disabledByDefault,
  PAT_WRITES_ENABLED: disabledByDefault,
};
