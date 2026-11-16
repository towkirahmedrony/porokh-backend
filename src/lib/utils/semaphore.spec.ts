import test from 'node:test';
import assert from 'node:assert/strict';
import { SemaphoreBusyError, createSemaphore } from './semaphore';

test('permits up to the configured limit and queues the rest', async () => {
  const semaphore = createSemaphore(2, 200);

  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  assert.equal(semaphore.inUse(), 2);

  let thirdGranted = false;
  const thirdPromise = semaphore.acquire().then((release) => {
    thirdGranted = true;
    return release;
  });

  // Yield once so any incorrect immediate grant is observed.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdGranted, false);
  assert.equal(semaphore.waiting(), 1);

  first();
  const third = await thirdPromise;
  assert.equal(thirdGranted, true);
  assert.equal(semaphore.inUse(), 2);

  second();
  third();
  assert.equal(semaphore.inUse(), 0);
});

test('a released permit reaches the next waiter exactly once', async () => {
  const semaphore = createSemaphore(1, 200);

  const release = await semaphore.acquire();
  const waiting = semaphore.acquire();

  release();
  release(); // Double release must not hand out two permits.

  const next = await waiting;
  assert.equal(semaphore.inUse(), 1);
  next();
  assert.equal(semaphore.inUse(), 0);
});

test('a caller that waits past the budget is rejected instead of queueing forever', async () => {
  const semaphore = createSemaphore(1, 20);
  const held = await semaphore.acquire();

  await assert.rejects(semaphore.acquire(), SemaphoreBusyError);
  assert.equal(semaphore.waiting(), 0);

  // The rejected waiter must not consume the permit, and the held one still
  // releases normally so capacity is not permanently lost.
  held();
  assert.equal(semaphore.inUse(), 0);

  const again = await semaphore.acquire();
  again();
  assert.equal(semaphore.inUse(), 0);
});

test('an invalid permit count is rejected at construction', () => {
  assert.throws(() => createSemaphore(0, 10));
  assert.throws(() => createSemaphore(-1, 10));
});
