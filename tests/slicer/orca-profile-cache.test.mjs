import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { resolveBblMachineProfile, flattenForCli } from '../../dist/slicer/profile-flatten.js';
const cacheModule = await import('../../dist/slicer/orca-profile-cache.js').catch(() => ({}));
const fixture = new URL('../fixtures/orca-cache/', import.meta.url);
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profiles = path.join(root, 'profiles');
  await fs.mkdir(path.join(profiles, 'BBL'), { recursive: true });
  const cache = gunzipSync(await fs.readFile(new URL('BBL.opc.gz', fixture)));
  await fs.writeFile(path.join(profiles, 'BBL.opc'), cache);
  await fs.copyFile(new URL('cli_config.json', fixture), path.join(profiles, 'BBL', 'cli_config.json'));
  return { root, profiles, cache };
}
test('official cache supplies the selected installation machine, inheritance and slot defaults', async t => {
  const { root, profiles } = await setup(t);
  assert.equal(typeof cacheModule.materializeOrcaProfilesRoot, 'function', 'cache-only installed profiles need a reader');
  const prepared = await cacheModule.materializeOrcaProfilesRoot(profiles, root);
  assert.notEqual(prepared, profiles);
  const machine = await resolveBblMachineProfile(prepared, 'Bambu Lab P1S 0.4 nozzle');
  assert.equal(machine.printer_model, 'Bambu Lab P1S');
  assert.deepEqual(machine.nozzle_diameter, ['0.4']);
  assert.equal(typeof machine.machine_start_gcode, 'string');
  assert.ok(machine.machine_start_gcode.length > 100);
  assert.ok(machine.default_print_profile);
  assert.ok(machine.default_filament_profile.length > 0);
  assert.equal(await fs.readFile(path.join(prepared, 'BBL/cli_config.json'), 'utf8'), await fs.readFile(path.join(profiles, 'BBL/cli_config.json'), 'utf8'));
  await assert.rejects(resolveBblMachineProfile(prepared, 'Bambu Lab P1S 0.8 nonexistent'), /not found/);
  assert.equal((await fs.readdir(path.join(profiles, 'BBL'))).length, 1, 'installed tree stays read-only');
});
test('corrupt/unknown caches and absent authoritative CLI matrix fail before preparation', async t => {
  const { root, profiles, cache } = await setup(t);
  assert.equal(typeof cacheModule.materializeOrcaProfilesRoot, 'function');
  await fs.rm(path.join(profiles, 'BBL/cli_config.json'));
  await assert.rejects(cacheModule.materializeOrcaProfilesRoot(profiles, root), /cli_config/);
  await fs.copyFile(new URL('cli_config.json', fixture), path.join(profiles, 'BBL/cli_config.json'));
  const changed = Buffer.from(cache); changed[100] ^= 1;
  await fs.writeFile(path.join(profiles, 'BBL.opc'), changed);
  await assert.rejects(cacheModule.materializeOrcaProfilesRoot(profiles, root), /CRC|checksum/);
  changed.writeUInt32LE(99, 4);
  await fs.writeFile(path.join(profiles, 'BBL.opc'), changed);
  await assert.rejects(cacheModule.materializeOrcaProfilesRoot(profiles, root), /version/);
});
test('ordinary selected JSON installations are preserved without reading an adjacent cache', async t => {
  const { root, profiles } = await setup(t);
  await fs.mkdir(path.join(profiles, 'BBL/machine'));
  await fs.writeFile(path.join(profiles, 'BBL/machine/selected.json'), '{"name":"selected"}');
  assert.equal(typeof cacheModule.materializeOrcaProfilesRoot, 'function');
  assert.equal(await cacheModule.materializeOrcaProfilesRoot(profiles, root), profiles);
});

test('cached defaults flatten through the same CLI limits, material dependencies and slot colours', async t => {
  const { root, profiles } = await setup(t);
  const prepared = await cacheModule.materializeOrcaProfilesRoot(profiles, root);
  const machine = await resolveBblMachineProfile(prepared, 'Bambu Lab P1S 0.4 nozzle');
  const result = await flattenForCli({ profilesRoot: prepared, tempDir: root,
    machineLeaf: 'Bambu Lab P1S 0.4 nozzle', processLeaf: machine.default_print_profile,
    filamentLeaves: [machine.default_filament_profile[0], machine.default_filament_profile[0]],
    filamentColours: ['#123456', '#abcdef'] });
  assert.equal(result.meta.cliConfigValidated, true);
  const filamentPaths = result.filamentPaths;
  assert.equal(filamentPaths.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(filamentPaths[0], 'utf8')).filament_colour, ['#123456']);
  assert.deepEqual(JSON.parse(await fs.readFile(filamentPaths[1], 'utf8')).filament_colour, ['#abcdef']);
});

test('public cache slicing stages canonical User identities and preserves project overrides', async t => {
  const { root, profiles } = await setup(t);
  const { STLManipulator } = await import('../../dist/stl/stl-manipulator.js');
  const executable = path.join(root, 'fake-orca');
  const trace = path.join(root, 'trace.json');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
const files=[...get('--load-settings').split(';'),...get('--load-filaments').split(';')];
const configs=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({args,files,configs}));
fs.writeFileSync(path.join(get('--outputdir'),get('--export-3mf')),'fixture output');
`, { mode: 0o755 });
  const input = path.join(root, 'cube.stl'); await fs.writeFile(input, 'solid cube\nendsolid cube');
  const processFile = path.join(root, 'process.json');
  await fs.writeFile(processFile, JSON.stringify({ name: 'Custom cache process', inherits: '0.20mm Standard @BBL X1C', layer_height: '0.16', use_relative_e_distances: '1', wipe_tower_x: ['180'], wipe_tower_y: ['181'] }));
  const filament = path.join(root, 'filament.json');
  await fs.writeFile(filament, JSON.stringify({ name: 'Custom PLA', inherits: 'Bambu PLA Basic @BBL P1S 0.4 nozzle', nozzle_temperature: ['210'] }));
  const previous = process.env.BAMBU_PROFILES_ROOT;
  process.env.BAMBU_PROFILES_ROOT = profiles;
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_PROFILES_ROOT; else process.env.BAMBU_PROFILES_ROOT = previous; });
  await new STLManipulator(path.join(root, 'out')).sliceSTL(input, 'orcaslicer', executable, processFile, undefined, 'Bambu Lab P1S 0.4 nozzle', {
    bedType: 'textured_plate', loadFilaments: `${filament};${filament}`, filamentColours: ['#123456', '#abcdef'],
  });
  const result = JSON.parse(await fs.readFile(trace, 'utf8'));
  const arg = key => result.args[result.args.indexOf(key) + 1];
  assert.equal(arg('--filament-colour'), '#123456;#abcdef');
  assert.equal(arg('--curr-bed-type'), 'Textured PEI Plate');
  assert.equal(arg('--wipe-tower-x'), '180'); assert.equal(arg('--wipe-tower-y'), '181');
  const dataDir = arg('--datadir');
  assert.ok(dataDir.startsWith(path.join(root, 'out')));
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'system/BBL.opc')), gunzipSync(await fs.readFile(new URL('BBL.opc.gz', fixture))));
  assert.equal(result.configs[0].inherits, 'Bambu Lab P1S 0.4 nozzle');
  assert.equal(result.configs[1].use_relative_e_distances, '1');
  assert.equal(result.configs[1].layer_height, '0.16');
  assert.deepEqual(result.configs[2].nozzle_temperature, ['210']);
  assert.deepEqual(result.configs[3].nozzle_temperature, ['210']);
  for (let i = 0; i < result.files.length; i++) {
    const config = result.configs[i];
    assert.equal(path.basename(result.files[i]), `${config.name}.json`);
    assert.equal(config.from, 'User'); assert.match(config.version, /^\d+\.\d+\.\d+/);
    assert.ok(!Array.isArray(config.renamed_from));
  }
});

test('cached supported machines retain exact model/nozzle and per-model bed exclusions', async t => {
  const { root, profiles } = await setup(t);
  const prepared = await cacheModule.materializeOrcaProfilesRoot(profiles, root);
  for (const [model, nozzle] of [['A1 mini', '0.4'], ['P1S', '0.2'], ['H2D', '0.4'], ['H2C', '0.6'], ['X2D', '0.4']]) {
    const machine = await resolveBblMachineProfile(prepared, `Bambu Lab ${model} ${nozzle} nozzle`);
    assert.equal(machine.printer_model, `Bambu Lab ${model}`);
    assert.ok(machine.nozzle_diameter.every(n => n === nozzle));
  }
  const model = JSON.parse(await fs.readFile(path.join(prepared, 'BBL/machine/__models__/Bambu%20Lab%20A1%20mini.json'), 'utf8'));
  assert.equal(model.image_bed_type, 'mini');
  assert.equal(model.not_support_bed_type, 'Cool Plate;Engineering Plate');
});
