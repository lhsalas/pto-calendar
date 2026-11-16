import { expect, expectTypeOf, it } from 'vitest';

it('augments synchronous and asynchronous Vitest assertions with jest-dom matchers', async () => {
  const synchronous = expect(document.body).toBeInTheDocument();
  expectTypeOf(synchronous).toEqualTypeOf<void>();

  const asynchronous = expect(Promise.resolve(document.body)).resolves.toBeInTheDocument();
  expectTypeOf(asynchronous).toEqualTypeOf<Promise<void>>();
  await asynchronous;
});
