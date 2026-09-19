import { expect, it } from 'vitest';
import { acquireAssetStream, releaseAssetStream } from './props';

it('reserves a released slot for its queued waiter before new arrivals', async () => {
  await Promise.all(Array.from({ length: 4 }, () => acquireAssetStream()));
  const fifth = acquireAssetStream();
  releaseAssetStream();
  let sixthAcquired = false;
  const sixth = acquireAssetStream().then(() => { sixthAcquired = true; });
  await fifth;
  expect(sixthAcquired).toBe(false);
  releaseAssetStream();
  await sixth;
  for (let i = 0; i < 4; i++) releaseAssetStream();
});

it('passes a reserved slot past an aborted waiter without exceeding capacity', async () => {
  await Promise.all(Array.from({ length: 4 }, () => acquireAssetStream()));
  const controller = new AbortController();
  const cancelled = acquireAssetStream(controller.signal).catch((error) => error);
  const next = acquireAssetStream();
  controller.abort();
  releaseAssetStream();
  expect(await cancelled).toBeInstanceOf(Error);
  await next;
  for (let i = 0; i < 4; i++) releaseAssetStream();
  await expect(acquireAssetStream(controller.signal)).rejects.toThrow('aborted');
  await Promise.all(Array.from({ length: 4 }, () => acquireAssetStream()));
  for (let i = 0; i < 4; i++) releaseAssetStream();
});
