import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import JSZip from 'jszip';
import { STLManipulator, normalizeSlicerType } from '../dist/stl/stl-manipulator.js';

async function artifact({ model = 'p1s', nozzle = '0.4', plate = 1, command = 'G1 X10 Y10', material = 'PLA' } = {}) {
  const zip = new JSZip();
  zip.file(`Metadata/plate_${plate}.gcode`, `; printer_model = ${model}\n; nozzle_diameter = ${nozzle}\n; filament_type = ${material}\n; curr_bed_type = Textured PEI Plate\n${command}\n`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function fixture(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-remote-test-'));
  const profiles = path.join(dir, 'profiles');
  const write = async (kind, profile) => {
    const folder = path.join(profiles, 'BBL', kind);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${profile.name}.json`), JSON.stringify(profile));
  };
  await write('machine', { name: 'Machine base', type: 'machine', from: 'system', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], machine_start_gcode: 'G90', default_print_profile: 'Test process', default_filament_profile: ['Test PLA'] });
  await write('machine', { name: 'Bambu Lab P1S 0.4 nozzle', type: 'machine', from: 'system', inherits: 'Machine base' });
  await write('process', { name: 'Test process', type: 'process', from: 'system', layer_height: '0.2' });
  await write('filament', { name: 'Test PLA', type: 'filament', from: 'system', filament_type: ['PLA'], filament_colour: ['#FF0000'] });
  await fs.writeFile(path.join(profiles, 'BBL', 'cli_config.json'), JSON.stringify({ printer: { 'Bambu Lab P1S': { downward_check: { 'Bambu Lab P1S 0.4 nozzle': ['Bambu Lab A1 0.4 nozzle'] } } } }));
  const input = path.join(dir, 'cube.stl');
  await fs.writeFile(input, 'solid cube\nendsolid cube');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let form;
      if (req.method === 'POST') {
        form = await new Request('http://localhost', { method: 'POST', body, headers: req.headers }).formData();
      }
      requests.push({ url: req.url, method: req.method, headers: req.headers, form });
      await handler(req, res, form, requests);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const values = { SLICER_API_URL: `http://127.0.0.1:${server.address().port}`, SLICER_API_MODE: 'sync', SLICER_API_TIMEOUT_MS: '10000', SLICER_API_TOKEN: '', SLICER_API_TOKEN_HEADER: '', BAMBU_PROFILES_ROOT: profiles, BAMBU_SLICER_PROFILE_DIRS: '' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const manipulator = new STLManipulator(path.join(dir, 'output'));
  return { dir, profiles, input, requests, manipulator, write, slice: (options = {}, processProfile) => manipulator.sliceSTL(input, normalizeSlicerType('orca-slicer-api'), '/no-local-slicer-required', processProfile, undefined, 'Bambu Lab P1S 0.4 nozzle', options) };
}

function send(res, bytes) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes); }
function json(res, body, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

test('remote sync uploads exact resolved custom profiles and inspects downloaded bytes without a local binary', async t => {
  const result = await artifact();
  const f = await fixture(t, (_req, res) => send(res, result));
  const custom = path.join(f.dir, 'custom.json');
  await fs.writeFile(custom, JSON.stringify({ name: 'Custom', type: 'process', from: 'User', inherits: 'Test process', layer_height: '0.16', wall_loops: '5' }));
  process.env.SLICER_API_TOKEN = 'fixture-secret';
  const output = await f.slice({ filamentColours: ['#123456'], bedType: 'textured_plate', nozzleType: 'hardened_steel', nozzleVolumeType: 'Standard' }, custom);
  assert.deepEqual(await fs.readFile(output), result);
  const [{ form, url, headers }] = f.requests;
  assert.equal(url, '/slice');
  assert.equal(headers.authorization, 'Bearer fixture-secret');
  assert.equal(form.get('file').type, 'model/stl');
  assert.equal(form.get('exportType'), '3mf');
  assert.equal(form.get('plate'), '1');
  assert.equal(form.get('resolveProfileInheritance'), 'false');
  const machine = JSON.parse(await form.get('printerProfile').text());
  const processProfile = JSON.parse(await form.get('presetProfile').text());
  const filament = JSON.parse(await form.get('filamentProfile').text());
  assert.equal(machine.printer_model, 'Bambu Lab P1S');
  assert.equal(machine.inherits, 'Bambu Lab P1S 0.4 nozzle');
  assert.equal(machine.machine_start_gcode, 'G90');
  assert.deepEqual(machine.nozzle_type, ['hardened_steel']);
  assert.equal(processProfile.layer_height, '0.16');
  assert.equal(processProfile.wall_loops, '5');
  assert.deepEqual(filament.filament_colour, ['#123456']);
});

test('remote async polls documented routes, ignores returned external URLs, downloads and cleans up completed job', async t => {
  const result = await artifact({ plate: 2 });
  let polls = 0;
  const f = await fixture(t, (req, res) => {
    if (req.method === 'POST') return json(res, { requestId: 'job-123', status: 'pending', statusUrl: 'http://untrusted.invalid' }, 202);
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (req.url.endsWith('/result')) return send(res, result);
    return json(res, { requestId: 'job-123', status: ++polls === 1 ? 'processing' : 'completed', downloadUrl: 'http://untrusted.invalid' });
  });
  process.env.SLICER_API_MODE = 'async';
  process.env.SLICER_API_TOKEN = 'fixture-secret';
  process.env.SLICER_API_TOKEN_HEADER = 'X-API-Key';
  const output = await f.slice({ slicePlate: 2 });
  assert.deepEqual(await fs.readFile(output), result);
  assert.deepEqual(f.requests.map(r => `${r.method} ${r.url}`), ['POST /slice-async', 'GET /slice-async/job-123', 'GET /slice-async/job-123', 'GET /slice-async/job-123/result', 'DELETE /slice-async/job-123']);
  assert.ok(f.requests.every(r => r.headers['x-api-key'] === 'fixture-secret'));
  assert.equal(f.requests[0].form.get('plate'), '2');
});

for (const [name, response, expected] of [
  ['wrong printer', { model: 'a1' }, /contradicts requested model/],
  ['wrong nozzle', { nozzle: '0.6' }, /contradict.*nozzle/],
  ['wrong material', { material: 'PETG' }, /materials contradict/],
  ['unsafe heat', { command: 'M104 S310' }, /temperature/],
  ['renumbered plate', { plate: 1 }, /selected plate 2/],
]) test(`remote refuses ${name} downloaded artifact and removes it`, async t => {
  const result = await artifact(response);
  const f = await fixture(t, (_req, res) => send(res, result));
  await assert.rejects(f.slice(name === 'renumbered plate' ? { slicePlate: 2 } : {}), expected);
  assert.equal((await fs.readdir(path.join(f.dir, 'output'))).some(name => name.endsWith('.3mf')), false);
});

test('remote refuses unsupported multi-slot projects before sending HTTP', async t => {
  const f = await fixture(t, (_req, res) => send(res, Buffer.alloc(0)));
  const zip = new JSZip();
  zip.file('Metadata/project_settings.config', JSON.stringify({ filament_type: ['PLA', 'PLA'], filament_colour: ['#FF0000', '#00FF00'] }));
  const project = path.join(f.dir, 'project.3mf');
  await fs.writeFile(project, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(f.manipulator.sliceSTL(project, normalizeSlicerType('orca-slicer-api'), '', undefined, undefined, 'Bambu Lab P1S 0.4 nozzle'), /one filament slot/);
  assert.equal(f.requests.length, 0);
});

for (const options of [{ rotate: 90 }, { arrange: false }, { orient: false }, { loadFilamentIds: '1' }, { slicePlate: 0 }]) {
  test(`remote rejects unsupported option ${JSON.stringify(options)} before HTTP`, async t => {
    const f = await fixture(t, (_req, res) => send(res, Buffer.alloc(0)));
    await assert.rejects(f.slice(options), /unsupported|positive plate/i);
    assert.equal(f.requests.length, 0);
  });
}

test('remote requires the exact local machine profile and cli_config before HTTP', async t => {
  const f = await fixture(t, (_req, res) => send(res, Buffer.alloc(0)));
  await fs.rm(path.join(f.profiles, 'BBL', 'cli_config.json'));
  await assert.rejects(f.slice(), /cli_config/);
  assert.equal(f.requests.length, 0);
});

test('remote HTTP errors never echo endpoint credentials or upstream response text', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(401); res.end('fixture-secret private response'); });
  process.env.SLICER_API_TOKEN = 'fixture-secret';
  await assert.rejects(f.slice(), error => /HTTP 401/.test(error.message) && !/fixture-secret|private response|127\.0\.0\.1/.test(error.message));
  assert.equal(f.requests.length, 1);
});

test('remote async failure is terminal and never automatically resubmits', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.method === 'POST') return json(res, { requestId: 'job-failed', status: 'processing' }, 202);
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    return json(res, { status: 'failed', message: 'fixture-secret' });
  });
  process.env.SLICER_API_MODE = 'async';
  await assert.rejects(f.slice(), error => /remote.*failed/i.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('remote deadline aborts a stalled response without retry and warns that work may continue', async t => {
  const f = await fixture(t, () => {});
  process.env.SLICER_API_TIMEOUT_MS = '50';
  await assert.rejects(f.slice(), /timed out.*may continue/i);
  assert.equal(f.requests.length, 1);
});

test('remote rejects redirects so authentication cannot reach another endpoint', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/stolen' }); res.end(); });
  process.env.SLICER_API_TOKEN = 'fixture-secret';
  await assert.rejects(f.slice(), /HTTP 302/);
  assert.equal(f.requests.length, 1);
});


test('remote blocks malformed async IDs before any authenticated follow-up', async t => {
  const f = await fixture(t, (_req, res) => json(res, { requestId: '../other-route', status: 'pending' }, 202));
  process.env.SLICER_API_MODE = 'async';
  await assert.rejects(f.slice(), /invalid request ID/);
  assert.equal(f.requests.length, 1);
});

test('remote refuses declared oversized downloads without retaining an output', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': '100000001' }); res.end('x'); });
  await assert.rejects(f.slice(), /size limit/);
  assert.equal((await fs.readdir(path.join(f.dir, 'output'))).some(name => name.endsWith('.3mf')), false);
});

test('remote rejects an embedded-credential URL without echoing it or submitting', async t => {
  const f = await fixture(t, () => {});
  process.env.SLICER_API_URL = 'https://user:fixture-secret@example.invalid';
  await assert.rejects(f.slice(), error => /without embedded credentials/.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(f.requests.length, 0);
});

test('remote requires the selected exact machine preset despite an explicit process profile', async t => {
  const f = await fixture(t, () => {});
  await fs.rm(path.join(f.profiles, 'BBL', 'machine', 'Bambu Lab P1S 0.4 nozzle.json'));
  const custom = path.join(f.dir, 'custom.json');
  await fs.writeFile(custom, JSON.stringify({ name: 'Custom', type: 'process', from: 'User' }));
  await assert.rejects(f.slice({}, custom), /Printer profile .* was not found/);
  assert.equal(f.requests.length, 0);
});

async function directSlice(f, isCancelled) {
  const { sliceWithOrcaApi } = await import('../dist/slicer/remote-slicer.js');
  return sliceWithOrcaApi({
    inputPath: f.input,
    machinePath: path.join(f.profiles, 'BBL', 'machine', 'Machine base.json'),
    processPath: path.join(f.profiles, 'BBL', 'process', 'Test process.json'),
    filamentPaths: [path.join(f.profiles, 'BBL', 'filament', 'Test PLA.json')],
    outputPath: path.join(f.dir, 'cancelled-output.3mf'), isCancelled,
  });
}

test('remote cancellation before submission prevents any HTTP request', async t => {
  const result = await artifact();
  const f = await fixture(t, (_req, res) => send(res, result));
  await assert.rejects(directSlice(f, () => true), /cancelled/);
  assert.equal(f.requests.length, 0);
});

test('remote cancellation during HTTP aborts the wait and never resubmits', async t => {
  let cancelled = false;
  const f = await fixture(t, () => { cancelled = true; });
  await assert.rejects(directSlice(f, () => cancelled), /cancelled.*may continue/);
  assert.equal(f.requests.length, 1);
});

test('remote deadline also aborts a stalled response body', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('unfinished result'); });
  process.env.SLICER_API_TIMEOUT_MS = '50';
  await assert.rejects(f.slice(), /timed out.*may continue/i);
  assert.equal(f.requests.length, 1);
});

async function mcpFixture(t, f) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const eventsPath = path.join(f.dir, 'printer-events.jsonl');
  await fs.writeFile(eventsPath, '');
  const preload = path.join(f.dir, 'isolated-printer.mjs');
  await fs.writeFile(preload, `
    import fs from 'node:fs';
    import { BambuImplementation } from ${JSON.stringify(pathToFileURL(path.join(root, 'dist/printers/bambu.js')).href)};
    const log = action => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ action }) + '\\n');
    BambuImplementation.prototype.ftpUpload = async () => log('upload');
    BambuImplementation.prototype.ftpDownload = async () => { throw new Error('No remote printer files in this fixture'); };
    BambuImplementation.prototype.getPrinter = async () => ({ publish: async () => log('publish') });
    BambuImplementation.prototype.getSafetyStatus = async () => {
      log('status');
      const now = Date.now();
      return { connected:true, model:'p1s', status:'IDLE', serial:'01PTESTREMOTE',
        raw:{ model:'p1s', serial:'01PTESTREMOTE', gcode_state:'IDLE', nozzle_diameter:'0.4', print_error:0, hms:[],
          device:{nozzle:{info:[{id:0,diameter:0.4,type:'HH01',stat:0}]}}, vt_tray:{tray_type:'PLA'} },
        observation:{source:'mqtt',requestedAt:now,receivedAt:now,identitySource:'report'} };
    };
  `);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', preload, path.join(root, 'dist/index.js')], cwd: f.dir, stderr: 'pipe',
    env: {
      ...process.env, MCP_TRANSPORT: 'stdio', SLICER_TYPE: 'orca-slicer-api', SLICER_PATH: '/no-local-binary',
      SLICER_PROFILE: '', BAMBU_SLICER_PROFILE: '', BAMBU_TEMPLATE_3MF_PATH: '',
      BAMBU_MODEL: 'p1s', BAMBU_PRINTER_MODEL: '', BAMBU_SERIAL: '01PTESTREMOTE', BAMBU_PRINTER_SERIAL: '01PTESTREMOTE',
      BAMBU_TOKEN: 'DUMMY_TOKEN', BAMBU_PRINTER_ACCESS_TOKEN: 'DUMMY_TOKEN',
      PRINTER_HOST: '127.0.0.1', BAMBU_PRINTER_HOST: '127.0.0.1',
      BAMBU_NOZZLE_TYPE: '', BAMBU_NOZZLE_VOLUME_TYPE: '', NOZZLE_DIAMETER: '0.4', BED_TYPE: 'textured_plate',
      BAMBU_NETWORK_BRIDGE_COMMAND: '', BAMBU_REQUIRE_CONFIRMATION: '1', BAMBU_DISPATCH_CHECK_MS: '0',
      TEMP_DIR: path.join(f.dir, 'mcp-output'),
    },
  });
  const client = new Client({ name: 'remote-slicing-fixture', version: '1' }, { capabilities: {} });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { try { await client.close(); } catch {} });
  await client.connect(transport);
  return { client, stderr: () => stderr, events: async () => (await fs.readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse) };
}

test('MCP slice_stl uses the configured remote API without a local executable', async t => {
  const result = await artifact();
  const f = await fixture(t, (_req, res) => send(res, result));
  process.env.SLICER_API_TOKEN = 'mcp-fixture-secret';
  const mcp = await mcpFixture(t, f);
  const response = await mcp.client.callTool({ name: 'slice_stl', arguments: { stl_path: f.input, bambu_model: 'p1s', use_printer_filaments: false } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(await fs.readFile(response.content[0].text), result);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/slice');
  assert.match(mcp.stderr(), /server running on stdio/);
  assert.equal(mcp.stderr().includes('mcp-fixture-secret'), false);
  assert.deepEqual(await mcp.events(), []);
});

test('MCP slice_stl rejects explicit unsupported remote flags before HTTP', async t => {
  const f = await fixture(t, () => {});
  const mcp = await mcpFixture(t, f);
  const response = await mcp.client.callTool({ name: 'slice_stl', arguments: { stl_path: f.input, bambu_model: 'p1s', use_printer_filaments: false, ensure_on_bed: true } });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /ensureOnBed.*unsupported/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await mcp.events(), []);
});

test('MCP remote slicing rejects a per-call executable selector', async t => {
  const f = await fixture(t, () => {});
  const mcp = await mcpFixture(t, f);
  const response = await mcp.client.callTool({ name: 'slice_stl', arguments: { stl_path: f.input, bambu_model: 'p1s', slicer_path: '/some/local/binary', use_printer_filaments: false } });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /slicer_path is unsupported/);
  assert.equal(f.requests.length, 0);
});

test('MCP print_3mf remote auto-slice failure cannot upload or publish the unsliced input', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(503); res.end('mcp-fixture-secret private failure'); });
  process.env.SLICER_API_TOKEN = 'mcp-fixture-secret';
  const project = path.join(f.dir, 'unsliced.3mf');
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', '<?xml version="1.0"?><model unit="millimeter"><resources/><build/></model>');
  zip.file('Metadata/project_settings.config', JSON.stringify({ filament_type: ['PLA'], filament_colour: ['#FF0000'] }));
  await fs.writeFile(project, await zip.generateAsync({ type: 'nodebuffer' }));
  const processProfile = path.join(f.dir, 'explicit-process.json');
  await fs.writeFile(processProfile, JSON.stringify({ name: 'Explicit process', type: 'process', from: 'User', inherits: 'Test process', layer_height: '0.16' }));
  const mcp = await mcpFixture(t, f);
  const response = await mcp.client.callTool({ name: 'print_3mf', arguments: { three_mf_path: project, bambu_model: 'p1s', slicer_profile: processProfile, use_ams: false, plate_index: 0 } });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Remote slicing HTTP 503/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].form.get('file').type, 'model/3mf');
  assert.equal(f.requests[0].form.get('plate'), '1');
  assert.deepEqual((await mcp.events()).filter(event => ['upload', 'publish'].includes(event.action)), []);
  assert.equal(mcp.stderr().includes('mcp-fixture-secret'), false);
});
