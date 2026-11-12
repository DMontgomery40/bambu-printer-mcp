import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import JSZip from 'jszip';
import { trackedMkdtemp } from './support/temp.mjs';
import { BambuImplementation } from '../dist/printers/bambu.js';

process.env.BAMBU_DISPATCH_CHECK_MS = '0';

async function attempt(t, { requested = 'p1p', suffix = '.3mf' } = {}) {
  t.mock.method(net.Socket.prototype, 'connect', () => { throw new Error('Network forbidden'); });
  const dir = await trackedMkdtemp(path.join(os.tmpdir(), 'p1p-enclosure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `cube${suffix}`);
  const zip = new JSZip();
  zip.file('Metadata/plate_1.gcode', '; printer_model = p1s\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; filament_colour = #FFFFFF\nM104 S220\nM140 S60\nG1 X0 Y0\n');
  zip.file('Metadata/plate_1.json', JSON.stringify({ filament_ids: [0] }));
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const printer = new BambuImplementation(async () => true);
  const packets = [];
  const uploads = [];
  let stateReads = 0;
  printer.ftpUpload = async (_host, _token, snapshot, remote) => {
    assert.deepEqual(await fs.readFile(snapshot), await fs.readFile(file), 'dispatch uses inspected snapshot bytes');
    uploads.push(remote);
  };
  printer.getSafetyStatus = async () => {
    stateReads++;
    const now = Date.now();
    return { connected: true, model: 'p1p', serial: '01STEST', status: 'IDLE',
      raw: { serial: '01STEST', model: 'p1p', gcode_state: 'IDLE', print_error: 0, hms: [],
        nozzle_diameter: '0.4', nozzle_type: 'hardened_steel', vt_tray: { id: 254, tray_type: 'PLA' }, ams: { tray_now: '254' } },
      observation: { source: 'mqtt', requestedAt: now, receivedAt: now, identitySource: 'report' } };
  };
  printer.getPrinter = async () => ({ publish: async packet => packets.push(typeof packet === 'string' ? JSON.parse(packet) : packet) });
  const promise = printer.print3mf('127.0.0.1', '01STEST', 'DUMMY', {
    projectName: 'cube', filePath: file, bambuModel: requested, nozzleDiameters: [0.4], useAMS: false,
  });
  return { promise, packets, uploads, stateReads: () => stateReads };
}

for (const suffix of ['.3mf', '.gcode.3mf']) {
  test(`fresh P1P dispatches P1S-sliced ${suffix} through its existing checked route`, async t => {
    const s = await attempt(t, { suffix });
    const result = await s.promise;
    assert.equal(result.status, 'success');
    assert.ok(s.stateReads() >= 3, 'fresh state is rechecked before dispatch');
    assert.equal(s.uploads.length, 1);
    assert.equal(s.packets.length, 1, 'no automatic start replay');
    assert.equal(s.packets[0].print.command, suffix === '.3mf' ? 'project_file' : 'gcode_file');
    assert.match(s.uploads[0], /^\/cache\/checked-/);
  });
}

test('a requested P1S still rejects fresh P1P identity before upload or start', async t => {
  const s = await attempt(t, { requested: 'p1s' });
  await assert.rejects(s.promise, /identity mismatch|contradictory|requested p1s.*observed p1p/i);
  assert.ok(s.stateReads() > 0);
  assert.deepEqual(s.uploads, []);
  assert.deepEqual(s.packets, []);
});
