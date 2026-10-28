import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BambuImplementation } from '../dist/printers/bambu.js';
import { validatePrinterState } from '../dist/safety/printer-state.js';

const serial = '20PCANCELTEST';
const canceled = (overrides = {}) => ({
  model: 'x2d', gcode_state: 'FAILED', print_error: 0, fail_reason: '50348044', hms: [],
  gcode_file: 'cache/previous.3mf', subtask_name: 'previous', task_id: '1', subtask_id: '0', job_id: '0',
  nozzle_diameter: ['0.4', '0.4'], vir_slot: [{ id: 255, tray_type: 'PETG' }, { id: 254, tray_type: 'PLA' }],
  ...overrides,
});
const fresh = raw => ({
  connected: true, model: raw.model, serial, status: raw.gcode_state, raw: structuredClone(raw),
  observation: { source: 'mqtt', requestedAt: Date.now() - 1, receivedAt: Date.now(), identitySource: 'report' },
});
const requirements = { model: 'x2d', nozzleDiameters: [0.4, 0.4], materials: ['PETG'], useAMS: false, amsMapping: [255], filamentNozzleIndices: [0] };
const inspection = { ...requirements, maxNozzleTemperature: 250, maxBedTemperature: 70, maxChamberTemperature: 0, sha256: 'a'.repeat(64) };

test('only the exact clean X2D cancellation qualifies as terminal', () => {
  assert.doesNotThrow(() => validatePrinterState(fresh(canceled()), requirements));
  for (const overrides of [
    { fail_reason: undefined }, { fail_reason: null }, { fail_reason: '' }, { fail_reason: 0 },
    { fail_reason: 0x0300400d }, { print_error: 123 }, { print_error: null },
    { subtask_name: '', gcode_file: '' }, { gcode_state: 'PAUSE' }, { gcode_state: 'RUNNING' },
    { hms: [{ attr: 1, code: 0x20001 }] }, { hms: undefined },
    { model: 'h2d' }, { nozzle_diameter: ['0.6', '0.4'] }, { vir_slot: [{ id: 255, tray_type: 'PLA' }] },
  ]) assert.throws(() => validatePrinterState(fresh(canceled(overrides)), requirements), JSON.stringify(overrides));
  const stale = fresh(canceled());
  stale.observation.requestedAt -= 60_000;
  assert.throws(() => validatePrinterState(stale, requirements), /fresh|stale/);
});

test('a canceled job still requires a person to confirm bed clearance in headless mode', async t => {
  const previous = process.env.BAMBU_REQUIRE_CONFIRMATION;
  process.env.BAMBU_REQUIRE_CONFIRMATION = '0';
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_REQUIRE_CONFIRMATION; else process.env.BAMBU_REQUIRE_CONFIRMATION = previous; });
  const messages = [];
  const implementation = new BambuImplementation(async message => { messages.push(message); return false; });
  await assert.rejects(implementation.confirmPrintPreflight(serial, fresh(canceled()), inspection), /confirmation.*declined/);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /canceled.*0300400C.*remove every detached part/);
});

test('bed clearance stays bound to the canceled task across confirmation and dispatch', async () => {
  const implementation = new BambuImplementation(async () => true);
  const preflight = await implementation.confirmPrintPreflight(serial, fresh(canceled()), inspection);
  assert.doesNotThrow(() => implementation.assertBedClearance(fresh(canceled()), preflight));
  for (const overrides of [{ task_id: '2' }, { subtask_name: 'other' }, { job_id: '2' }, { subtask_id: '2' }, { gcode_file: 'cache/other.3mf' }]) {
    assert.throws(() => implementation.assertBedClearance(fresh(canceled(overrides)), preflight), /newly finished job/);
  }
  const idle = await implementation.confirmPrintPreflight(serial, fresh(canceled({ gcode_state: 'IDLE' })), inspection);
  assert.throws(() => implementation.assertBedClearance(fresh(canceled()), idle), /newly finished job/);
});

for (const native of [false, true]) test(`error-clear confirmation rejects a job switch while the prompt is open (${native ? 'native' : 'MQTT'})`, async () => {
  const report = canceled();
  const sent = [];
  const implementation = new BambuImplementation(async message => {
    assert.match(message, /Current job: previous/);
    report.task_id = '2';
    report.subtask_name = 'other-job';
    return true;
  });
  implementation.getSafetyStatus = async () => fresh(report);
  implementation.getPrinter = async () => ({ publish: async message => sent.push(message) });
  await assert.rejects(implementation.clearHmsErrors('127.0.0.1', serial, 'DUMMY', native ? async (active, beforeDispatch) => {
    await beforeDispatch(); active(); sent.push('native');
  } : undefined), /job changed/);
  assert.deepEqual(sent, []);
});

test('error-clear guard rejects a changed job at the native helper dispatch boundary', async () => {
  const report = canceled();
  let sent = false;
  const implementation = new BambuImplementation(async () => true);
  implementation.getSafetyStatus = async () => fresh(report);
  await assert.rejects(implementation.clearHmsErrors('127.0.0.1', serial, 'DUMMY', async (active, beforeDispatch) => {
    report.task_id = '2';
    await beforeDispatch(); active(); sent = true;
  }), /job changed/);
  assert.equal(sent, false);
});

for (const model of ['p1s', 'x2d']) for (const change of ['job', 'errors', 'unchanged']) {
  test(`MQTT error clearing rechecks ${change} after connection acquisition (${model})`, async () => {
    const report = {
      gcode_state: 'PAUSE', gcode_file: 'cache/previous.3mf', subtask_name: 'previous',
      task_id: '1', subtask_id: '0', job_id: '0', print_error: 123, hms: [],
    };
    const sent = [];
    const connecting = Promise.withResolvers();
    const connected = Promise.withResolvers();
    const implementation = new BambuImplementation(async () => true);
    implementation.getSafetyStatus = async () => ({ model, raw: structuredClone(report) });
    implementation.getPrinter = async () => {
      connecting.resolve();
      await connected.promise;
      return { publish: async message => sent.push(message) };
    };
    const clearing = implementation.clearHmsErrors('127.0.0.1', serial, 'DUMMY');
    await connecting.promise;
    if (change === 'job') {
      report.task_id = '2';
      report.subtask_name = 'other-job';
    } else if (change === 'errors') report.print_error = 456;
    connected.resolve();
    if (change === 'unchanged') {
      assert.equal((await clearing).status, 'success');
      assert.deepEqual(sent, [{ print: { command: 'clean_print_error', sequence_id: '0' } }]);
    } else {
      await assert.rejects(clearing, change === 'job' ? /job changed/ : /errors changed/);
      assert.deepEqual(sent, []);
    }
  });
}
