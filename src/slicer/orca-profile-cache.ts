import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { profileJsonFiles } from './profile-files.js';

// OrcaSlicer 14da40e3a7b82aa8fc88593c2cf880e66560028f:
// PresetCacheFormat.{hpp,cpp}, Config.hpp, Config.cpp::save_to_json,
// Preset.hpp::VendorProfile and Semver.hpp. Only the named v2 format is read;
// the old ordinal-based cache must never be interpreted as this format.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 100_000;
const VECTOR = 0x4000;
// Nullable declarations in the same pinned PrintConfig.cpp; unknown nil values fail closed.
const NULLABLE_KEYS = new Set([
  "bridge_acceleration",
  "bridge_speed",
  "default_acceleration",
  "default_jerk",
  "default_junction_deviation",
  "deretract_speed_extruder_change",
  "enable_overhang_speed",
  "extruder_max_nozzle_count",
  "filament_adaptive_volumetric_speed",
  "filament_cooling_before_tower",
  "filament_deretraction_speed",
  "filament_flow_ratio",
  "filament_flush_temp",
  "filament_flush_temp_fast",
  "filament_flush_volumetric_speed",
  "filament_ironing_flow",
  "filament_ironing_inset",
  "filament_ironing_spacing",
  "filament_ironing_speed",
  "filament_long_retractions_when_cut",
  "filament_pre_cooling_temperature",
  "filament_pre_cooling_temperature_nc",
  "filament_preheat_temperature_delta",
  "filament_ramming_travel_time",
  "filament_ramming_travel_time_nc",
  "filament_ramming_volumetric_speed",
  "filament_ramming_volumetric_speed_nc",
  "filament_retract_after_wipe",
  "filament_retract_before_wipe",
  "filament_retract_length_nc",
  "filament_retract_length_toolchange",
  "filament_retract_lift_above",
  "filament_retract_lift_below",
  "filament_retract_lift_enforce",
  "filament_retract_restart_extra",
  "filament_retract_restart_extra_toolchange",
  "filament_retract_when_changing_layer",
  "filament_retraction_distances_when_cut",
  "filament_retraction_length",
  "filament_retraction_minimum_travel",
  "filament_retraction_speed",
  "filament_wipe",
  "filament_wipe_distance",
  "filament_z_hop",
  "filament_z_hop_types",
  "gap_infill_speed",
  "hotend_cooling_rate",
  "hotend_heating_rate",
  "infill_jerk",
  "initial_layer_acceleration",
  "initial_layer_infill_speed",
  "initial_layer_jerk",
  "initial_layer_speed",
  "initial_layer_travel_acceleration",
  "initial_layer_travel_jerk",
  "initial_layer_travel_speed",
  "inner_wall_acceleration",
  "inner_wall_jerk",
  "inner_wall_speed",
  "internal_bridge_speed",
  "internal_solid_infill_acceleration",
  "internal_solid_infill_speed",
  "long_retractions_when_ec",
  "nozzle_flush_dataset",
  "nozzle_type",
  "nozzle_volume",
  "outer_wall_acceleration",
  "outer_wall_jerk",
  "outer_wall_speed",
  "overhang_1_4_speed",
  "overhang_2_4_speed",
  "overhang_3_4_speed",
  "overhang_4_4_speed",
  "retraction_distances_when_ec",
  "slowdown_for_curled_perimeters",
  "small_perimeter_speed",
  "small_perimeter_threshold",
  "sparse_infill_acceleration",
  "sparse_infill_speed",
  "support_interface_speed",
  "support_speed",
  "top_solid_infill_flow_ratio",
  "top_surface_acceleration",
  "top_surface_jerk",
  "top_surface_speed",
  "travel_acceleration",
  "travel_jerk",
  "travel_speed",
  "travel_speed_z",
]);
const fail = (message: string): never => { throw new Error(`Orca profile cache: ${message}`); };

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) fail('truncated or invalid length');
    const result = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  u8(): number { return this.take(1).readUInt8(); }
  u16(): number { return this.take(2).readUInt16LE(); }
  u32(): number { return this.take(4).readUInt32LE(); }
  i32(): number { return this.take(4).readInt32LE(); }
  u64(): number {
    const value = this.take(8).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('length exceeds safe range');
    return Number(value);
  }
  count(): number {
    const n = this.u64();
    if (n > MAX_ITEMS || n > this.bytes.length - this.offset) fail('collection length out of bounds');
    return n;
  }
  string(): string {
    const raw = this.take(this.u64());
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { return fail('invalid UTF-8'); }
  }
  strings(): string[] { return this.array(() => this.string()); }
  array<T>(read: () => T): T[] { return Array.from({ length: this.count() }, read); }
  double(): number { return this.take(8).readDoubleLE(); }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface CachedProfile { subPath: string; data: Record<string, unknown>; }

/** Read raw source diffs, not merged profiles: inheritance/includes still use the shared resolver. */
export function decodeOrcaBblCache(bytes: Buffer): CachedProfile[] {
  if (bytes.length < 20 || bytes.length > MAX_CACHE_BYTES) fail('file size out of bounds');
  const header = new Reader(bytes);
  if (header.u32() !== 0x4f52435a) fail('unknown magic');
  if (header.u32() !== 2) fail('unsupported format version');
  if (header.u64() !== bytes.length - 20) fail('body size does not match file');
  const expectedCrc = header.u32();
  const body = bytes.subarray(20);
  if (crc32(body) !== expectedCrc) fail('CRC checksum mismatch');
  const r = new Reader(body);
  if (r.u32() !== 2) fail('unsupported body version');
  if (r.string() !== 'BBL') fail('expected BBL vendor');
  const version = r.string();
  if (!/^\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?$/.test(version)) fail('invalid vendor version');
  const keys = r.strings();
  const types = r.array(() => r.u16());
  const enums = r.strings();
  if (keys.length !== types.length || keys.length > 65535 || enums.length > 65535 || enums[0] !== '') fail('invalid option dictionary');
  if (new Set(keys).size !== keys.length || keys.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key))) fail('invalid option name');

  // VendorMap is std::map<string, VendorProfile>, serialized by cereal in declaration order.
  const modelsMetadata: CachedProfile[] = [];
  const vendors = r.count();
  let ownVendor = false;
  let vendorProfileVersion = "";
  for (let i = 0; i < vendors; i++) {
    const mapKey = r.string();
    r.string(); // display name
    const id = r.string();
    const profileVersion = r.string();
    if (mapKey === 'BBL' && id === 'BBL' && profileVersion) { ownVendor = true; vendorProfileVersion = profileVersion; }
    r.string(); r.string(); // update/changelog URLs
    const models = r.count();
    for (let j = 0; j < models; j++) {
      const modelId = r.string(); const modelName = r.string();
      r.string(); r.u8(); r.string();
      r.strings(); r.strings(); const unsupportedBeds = r.strings();
      r.string(); r.string(); const imageBedType = r.string();
      for (let k = 0; k < 6; k++) r.string();
      if (mapKey === 'BBL' && modelName) {
        modelsMetadata.push({ subPath: `machine/__models__/${encodeURIComponent(modelId)}.json`,
          data: { name: modelName, type: 'machine_model',
            ...(imageBedType ? { image_bed_type: imageBedType } : {}),
            ...(unsupportedBeds.length ? { not_support_bed_type: unsupportedBeds.join(';') } : {}) } });
      }
    }
    r.strings(); r.strings(); // default filament/material sets
  }
  if (!ownVendor) fail('cache does not carry its BBL vendor profile');

  const number = (value: number, nullable = false): string => {
    if (nullable && Number.isNaN(value)) return 'nil';
    if (!Number.isFinite(value)) return fail('non-finite numeric option');
    return String(value);
  };
  const point = (dimension: number, separator: string): string =>
    Array.from({ length: dimension }, () => number(r.double())).join(separator);
  const scalar = (type: number, vector: boolean): string => {
    switch (type) {
      case 1: return number(r.double(), vector);
      case 2: { const n = r.i32(); return vector && n === 2147483647 ? 'nil' : String(n); }
      case 3: return r.string();
      case 4: { const n = r.double(); return Number.isNaN(n) && vector ? 'nil' : `${number(n)}%`; }
      case 5: {
        const n = r.double(); const percent = r.u8();
        if (percent > 1) return fail('invalid percent flag');
        return Number.isNaN(n) && vector ? 'nil' : number(n) + (percent ? '%' : '');
      }
      case 6: return point(2, vector ? 'x' : ',');
      case 7: return point(3, ',');
      case 8: {
        const n = r.u8();
        if (vector && n === 255) return 'nil';
        if (n > 1) return fail('invalid boolean option');
        return String(n);
      }
      default: return fail(`unsupported option type ${type}`);
    }
  };
  const option = (type: number): string | string[] => {
    if (type === 9 || type === VECTOR + 9) {
      const count = r.u32();
      if (count > MAX_ITEMS || (type === 9 && count !== 1)) fail('invalid enum count');
      const values = Array.from({ length: count }, () => {
        const index = r.u16();
        if (index >= enums.length) return fail('enum index out of bounds');
        if (index !== 0) return enums[index];
        const value = r.i32();
        if (type === VECTOR + 9 && value === 2147483647) return 'nil';
        return fail('unnamed enum cannot be exported safely');
      });
      return type === 9 ? values[0] : values;
    }
    if (type === VECTOR + 10) return r.array(() => r.array(() => point(2, 'x')).join(','));
    if (type === VECTOR + 11) return r.array(() => r.array(() => String(r.i32())).join(','));
    if (type & VECTOR) return r.array(() => scalar(type - VECTOR, true));
    return scalar(type, false);
  };
  const profiles: CachedProfile[] = [...modelsMetadata];
  const names = new Set(profiles.map(p => String(p.data.name))); const paths = new Set(profiles.map(p => p.subPath.toLowerCase()));
  for (const kind of ['process', 'filament', 'machine']) {
    const count = r.u32();
    if (count > MAX_ITEMS) fail('preset count out of bounds');
    for (let i = 0; i < count; i++) {
      const name = r.string(); const subPath = r.string();
      if (!name || names.has(name)) fail('duplicate/empty preset name');
      const normalized = subPath.replace(/\\/g, '/');
      if (!normalized.startsWith(`${kind}/`) || !normalized.endsWith('.json') || normalized.split('/').some(p => !p || p === '.' || p === '..') || normalized.includes(':') || paths.has(normalized.toLowerCase())) fail('invalid or colliding preset path');
      names.add(name); paths.add(normalized.toLowerCase());
      const data: Record<string, unknown> = Object.create(null);
      const configCount = r.u32(); const seen = new Set<number>();
      if (configCount > keys.length) fail('option count out of bounds');
      for (let j = 0; j < configCount; j++) {
        const key = r.u16();
        if (key >= keys.length || seen.has(key)) fail('invalid/duplicate option index');
        seen.add(key);
        const value = option(types[key]);
        if (types[key] !== VECTOR + 3 && Array.isArray(value) && value.includes('nil') && !NULLABLE_KEYS.has(keys[key])) fail(`unexpected nil for ${keys[key]}`);
        data[keys[key]] = value;
      }
      const inherits = r.string(); const includes = r.strings();
      const description = r.string(); const instantiation = r.string();
      const settingId = r.string(); const filamentId = r.string(); const renamed = r.strings();
      Object.assign(data, { name, type: kind, from: 'system', version: vendorProfileVersion, instantiation, inherits });
      if (includes.length) data.include = includes;
      if (description) data.description = description;
      if (settingId) data.setting_id = settingId;
      if (filamentId) data.filament_id = filamentId;
      if (renamed.length) data.renamed_from = renamed.map(value => JSON.stringify(value)).join(';');
      profiles.push({ subPath: normalized, data });
    }
  }
  if (r.u64() !== 0) fail('vendor cache records profile parse errors');
  if (r.offset !== body.length) fail('unexpected trailing cache data');
  return profiles;
}

/** Expand only the selected installation's cache in the owning server's private temp directory. */
export async function materializeOrcaProfilesRoot(profilesRoot: string, tempDir: string): Promise<string> {
  if (profileJsonFiles(path.join(profilesRoot, 'BBL', 'machine')).length) return profilesRoot;
  const cachePath = path.join(profilesRoot, 'BBL.opc');
  let stat;
  try { stat = await fs.stat(cachePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return profilesRoot; throw error; }
  if (stat.size > MAX_CACHE_BYTES) fail('file size out of bounds');
  let cli: Buffer;
  try { cli = await fs.readFile(path.join(profilesRoot, 'BBL', 'cli_config.json')); }
  catch { return fail('selected installation is missing BBL/cli_config.json; update Orca or supply its exact matching profile tree'); }
  const parsed: unknown = JSON.parse(cli.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid BBL/cli_config.json');
  const cache = await fs.readFile(cachePath);
  const profiles = decodeOrcaBblCache(cache);
  const digest = createHash('sha256').update(cache).update(cli).digest('hex');
  const output = await fs.mkdtemp(path.join(tempDir, `orca-profiles-${digest.slice(0, 16)}-`));
  try {
    await fs.mkdir(path.join(output, 'BBL'), { recursive: true });
    await fs.writeFile(path.join(output, 'BBL', 'cli_config.json'), cli, { flag: 'wx' });
    await fs.writeFile(path.join(output, 'BBL.opc'), cache, { flag: 'wx' });
    for (const profile of profiles) {
      const file = path.join(output, 'BBL', profile.subPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(profile.data), { flag: 'wx' });
    }
    return output;
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

interface CliProfiles { settingsArg?: string; filamentPaths: string[]; }

/** Orca v2 cache builds resolve User presets by loaded file identity, not just inherits. */
export async function stageOrcaCliProfiles(
  profilesRoot: string, tempDir: string, bundle: CliProfiles
): Promise<CliProfiles & { extraArgs: string[] }> {
  const settings = bundle.settingsArg?.split(';') ?? [];
  if (settings.length !== 2) fail('complete machine and process settings are required');
  const root = await fs.mkdtemp(path.join(tempDir, 'orca-cli-'));
  try {
    await fs.mkdir(path.join(root, 'system'));
    await fs.copyFile(path.join(profilesRoot, 'BBL.opc'), path.join(root, 'system', 'BBL.opc'));
    const profiles = decodeOrcaBblCache(await fs.readFile(path.join(profilesRoot, 'BBL.opc')));
    const parents = new Set(profiles.map(p => `${p.data.type}:${p.data.name}`));
    const version = profiles.find(p => p.data.type === 'machine')?.data.version;
    if (typeof version !== 'string') fail('missing vendor profile version');
    const output: string[] = [];
    const colours: string[] = [];
    const extras: string[] = [];
    for (const [index, file] of [...settings, ...bundle.filamentPaths].entries()) {
      const kind = index === 0 ? 'machine' : index === 1 ? 'process' : 'filament';
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      if (kind === 'filament') {
        const colour = Array.isArray(data.filament_colour) ? data.filament_colour[0] : undefined;
        if (typeof colour !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(colour)) fail('missing positional filament colour');
        colours.push(colour);
      }
      if (kind === 'process') {
        if (typeof data.curr_bed_type === 'string') extras.push('--curr-bed-type', data.curr_bed_type);
        for (const key of ['wipe_tower_x', 'wipe_tower_y']) {
          if (data[key] === undefined) continue;
          const values = Array.isArray(data[key]) ? data[key] as unknown[] : [data[key]];
          if (!values.length || values.some(v => !Number.isFinite(Number(v)))) fail('invalid saved tower position');
          extras.push(`--${key.replace(/_/g, '-')}`, values.join(','));
        }
      }
      // The selected machine's system identity remains the validated cache leaf.
      // A fully resolved custom process/filament may be a standalone User root.
      if (!parents.has(`${kind}:${data.inherits}`)) {
        if (kind === 'machine') fail('selected machine parent is absent from the exact cache');
        delete data.inherits;
      }
      const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
      const name = `mcp_${kind}_${index}_${digest}`;
      Object.assign(data, { name, from: 'User', version });
      const directory = path.join(root, 'user', 'default', kind);
      await fs.mkdir(directory, { recursive: true });
      const staged = path.join(directory, `${name}.json`);
      await fs.writeFile(staged, JSON.stringify(data), { flag: 'wx' });
      output.push(staged);
    }
    return { settingsArg: output.slice(0, 2).join(';'), filamentPaths: output.slice(2),
      extraArgs: ['--datadir', root, ...extras, '--filament-colour', colours.join(';')] };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
