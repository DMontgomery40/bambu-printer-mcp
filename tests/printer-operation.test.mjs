import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { cancelPendingPrinterOperations, withPrinterOperation } from '../dist/safety/artifact.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('printer operations serialize across host aliases and retain the queue while a successor runs', async t => {
  const firstGate = deferred();
  const secondGate = deferred();
  t.after(() => { firstGate.resolve(); secondGate.resolve(); });
  const events = [];
  const first = withPrinterOperation('mock-host', 'QUEUE_TEST', async () => {
    events.push('first');
    await firstGate.promise;
  });
  const second = withPrinterOperation('mock-alias', 'QUEUE_TEST', async () => {
    events.push('second');
    await secondGate.promise;
  });
  await setImmediate();
  assert.deepEqual(events, ['first']);
  firstGate.resolve();
  await first;
  await setImmediate();
  assert.deepEqual(events, ['first', 'second']);
  const third = withPrinterOperation('mock-host', 'QUEUE_TEST', async () => events.push('third'));
  await setImmediate();
  assert.deepEqual(events, ['first', 'second']);
  secondGate.resolve();
  await Promise.all([second, third]);
  assert.deepEqual(events, ['first', 'second', 'third']);
});

test('a failed printer operation does not strand the next queued operation', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const failure = new Error('mock preflight failure');
  const first = withPrinterOperation('mock-host', 'FAILURE_TEST', async () => {
    await gate.promise;
    throw failure;
  });
  const rejected = assert.rejects(first, error => error === failure);
  const second = withPrinterOperation('mock-host', 'FAILURE_TEST', async assertActive => {
    assertActive();
    return 'next operation completed';
  });
  gate.resolve();
  await rejected;
  assert.equal(await second, 'next operation completed');
});

test('stop invalidates active checks and queued starts but permits a newly requested operation', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let activeCheck;
  let queuedRan = false;
  const active = withPrinterOperation('mock-host', 'CANCEL_TEST', async assertActive => {
    activeCheck = assertActive;
    await gate.promise;
    assertActive();
  });
  const activeRejected = assert.rejects(active, /cancelled by stop or heater-off/);
  const queued = withPrinterOperation('mock-alias', 'CANCEL_TEST', async () => { queuedRan = true; });
  const queuedRejected = assert.rejects(queued, /cancelled by stop or heater-off/);
  await setImmediate();
  assert.equal(typeof activeCheck, 'function');
  cancelPendingPrinterOperations('mock-host', 'CANCEL_TEST');
  assert.throws(activeCheck, /cancelled by stop or heater-off/);
  const fresh = withPrinterOperation('mock-host', 'CANCEL_TEST', async assertActive => {
    assertActive();
    return 'fresh request';
  });
  gate.resolve();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(queuedRan, false, 'a cancelled queued callback must never dispatch');
  assert.equal(await fresh, 'fresh request');
});

test('a blocked or cancelled printer does not block or cancel another printer on the same host', async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const blocked = withPrinterOperation('mock-host', 'PRINTER_A', async () => gate.promise);
  let independentCheck;
  const independent = withPrinterOperation('mock-host', 'PRINTER_B', async assertActive => {
    independentCheck = assertActive;
    await gate.promise;
    assertActive();
    return 'independent printer completed';
  });
  await setImmediate();
  assert.equal(typeof independentCheck, 'function');
  cancelPendingPrinterOperations('mock-host', 'PRINTER_A');
  assert.doesNotThrow(independentCheck);
  gate.resolve();
  assert.equal(await independent, 'independent printer completed');
  await blocked;
});
