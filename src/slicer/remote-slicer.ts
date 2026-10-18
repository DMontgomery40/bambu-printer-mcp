/** AFKFelix/orca-slicer-api contract at a9a28f0a7b0c6f51b9be158509e9e9677532b868. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectPrintFile } from '../safety/print-file.js';
import { normalizeMaterial, normalizeModel } from '../safety/limits.js';
import type { BambuSliceOptions } from '../stl/stl-manipulator.js';

const MAX_BYTES = 100_000_000;
const SUPPORTED_OPTIONS = new Set([
  'arrange', 'orient', 'loadFilaments', 'filamentColours', 'bedType',
  'nozzleType', 'nozzleVolumeType', 'slicePlate',
]);

function configuration(): { base: string; headers: Record<string, string>; mode: string; timeout: number } {
  let url: URL;
  try { url = new URL(process.env.SLICER_API_URL ?? ''); }
  catch { throw new Error('Remote slicing requires a valid trusted SLICER_API_URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SLICER_API_URL must use HTTP(S) without embedded credentials, query or fragment.');
  }
  const mode = process.env.SLICER_API_MODE || 'sync';
  if (!['sync', 'async'].includes(mode)) throw new Error('SLICER_API_MODE must be sync or async.');
  const timeout = Number(process.env.SLICER_API_TIMEOUT_MS ?? 600000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000) {
    throw new Error('SLICER_API_TIMEOUT_MS must be an integer from 1 to 3600000.');
  }
  const headers: Record<string, string> = {};
  const token = process.env.SLICER_API_TOKEN;
  if (token) {
    const header = process.env.SLICER_API_TOKEN_HEADER || 'Authorization';
    if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(header) ||
        ['host', 'content-type', 'content-length', 'connection', 'transfer-encoding'].includes(header.toLowerCase()) ||
        /[^\x20-\x7e]/.test(token)) {
      throw new Error('Invalid remote slicing authentication configuration.');
    }
    headers[header] = header.toLowerCase() === 'authorization' ? `Bearer ${token}` : token;
  }
  return { base: url.href.replace(/\/+$/, ''), headers, mode, timeout };
}

export function validateRemoteSliceOptions(options: BambuSliceOptions = {}): number {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !SUPPORTED_OPTIONS.has(key)) {
      throw new Error(`Remote slicing option ${key} is unsupported by orca-slicer-api; use a local backend for this workflow.`);
    }
  }
  // Upstream evaluates multipart values by truthiness, so the string "false"
  // becomes true. Never silently turn an explicit false into an enabled flag.
  if (options.arrange === false || options.orient === false) {
    throw new Error('Remote arrange=false and orient=false are unsupported by the upstream multipart API.');
  }
  const plate = options.slicePlate ?? 1;
  if (!Number.isInteger(plate) || plate < 1) throw new Error('Remote slicing requires one positive plate number; slicing all plates is unsupported.');
  return plate;
}

async function readResponse(response: Response, limit: number): Promise<Buffer> {
  const size = Number(response.headers.get('content-length'));
  if (size > limit) { await response.body?.cancel(); throw new Error('Remote slicing response exceeds the size limit.'); }
  if (!response.body) throw new Error('Remote slicing returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Remote slicing response exceeds the size limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

async function readJob(response: Response): Promise<Record<string, unknown>> {
  try {
    const job: unknown = JSON.parse((await readResponse(response, 65536)).toString('utf8'));
    if (job && typeof job === 'object' && !Array.isArray(job)) return job as Record<string, unknown>;
  } catch { /* Do not echo an untrusted response, which may contain credentials. */ }
  throw new Error('Remote slicing returned invalid job metadata.');
}

/** Upload only locally prepared profiles, then inspect the exact downloaded 3MF. */
export async function sliceWithOrcaApi(input: {
  inputPath: string;
  machinePath: string;
  processPath: string;
  filamentPaths: string[];
  outputPath: string;
  options?: BambuSliceOptions;
  isCancelled: () => boolean;
}): Promise<string> {
  const options = input.options ?? {};
  const plate = validateRemoteSliceOptions(options);
  if (input.filamentPaths.length !== 1 || (options.filamentColours && options.filamentColours.length !== 1)) {
    throw new Error('orca-slicer-api supports exactly one filament slot; multi-slot projects require a local slicer.');
  }
  const config = configuration();
  const machine = JSON.parse(await fs.readFile(input.machinePath, 'utf8'));
  const filament = JSON.parse(await fs.readFile(input.filamentPaths[0], 'utf8'));
  const model = normalizeModel(machine.printer_model);
  const nozzles = Array.isArray(machine.nozzle_diameter) ? machine.nozzle_diameter.map(Number) : [];
  const materialValues: unknown[] = Array.isArray(filament.filament_type) ? filament.filament_type : [];
  const materials = materialValues.map(normalizeMaterial);
  if (!model || !nozzles.length || nozzles.some((n: number) => ![0.2, 0.4, 0.6, 0.8].includes(n)) ||
      materials.length !== 1 || !materials[0]) {
    throw new Error('Remote slicing requires explicit model, nozzle and single-material metadata in the prepared profiles.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeout);
  const cancelCheck = setInterval(() => { if (input.isCancelled()) controller.abort(); }, 100);
  let requestId: string | undefined;
  let terminalJob = false;
  let wroteOutput = false;
  const request = async (route: string, init: RequestInit = {}): Promise<Response> => {
    if (input.isCancelled()) controller.abort();
    let response: Response;
    try {
      response = await fetch(config.base + route, { ...init, headers: config.headers, signal: controller.signal, redirect: 'manual' });
    } catch { throw new Error('Remote slicing HTTP request failed; check the trusted service configuration.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Remote slicing HTTP ${response.status}.`); }
    return response;
  };
  try {
    const ext = path.extname(input.inputPath).toLowerCase();
    if (!['.stl', '.3mf'].includes(ext)) throw new Error('Remote slicing supports only STL or 3MF input.');
    const bytes = await fs.readFile(input.inputPath);
    if (bytes.length > MAX_BYTES) throw new Error('Remote slicing input exceeds the 100 MB upstream limit.');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)], { type: ext === '.3mf' ? 'model/3mf' : 'model/stl' }), `model${ext}`);
    for (const [field, filePath, type] of [
      ['printerProfile', input.machinePath, 'machine'],
      ['presetProfile', input.processPath, 'process'],
      ['filamentProfile', input.filamentPaths[0], 'filament'],
    ]) {
      const profile = JSON.parse(await fs.readFile(filePath, 'utf8'));
      // The remote validator requires these metadata fields even for standalone
      // user profiles. They do not change the resolved machine/process settings.
      const data = { ...profile, type, from: profile.from || 'User' };
      form.set(field, new Blob([JSON.stringify(data)], { type: 'application/json' }), `${field}.json`);
    }
    form.set('exportType', '3mf');
    form.set('plate', String(plate));
    form.set('resolveProfileInheritance', 'false');
    if (options.arrange === true) form.set('arrange', 'true');
    if (options.orient === true) form.set('orient', 'true');
    let response = await request(config.mode === 'async' ? '/slice-async' : '/slice', { method: 'POST', body: form });
    if (config.mode === 'async') {
      const submitted = await readJob(response);
      if (typeof submitted.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(submitted.requestId)) {
        throw new Error('Remote slicing returned an invalid request ID.');
      }
      requestId = submitted.requestId;
      for (;;) {
        // Construct the documented same-service paths. Returned URLs cannot
        // redirect authenticated requests to an arbitrary origin or route.
        const job = await readJob(await request(`/slice-async/${requestId}`));
        if (job.status === 'completed' || job.status === 'failed') {
          terminalJob = true;
          if (job.status === 'failed') throw new Error('Remote slicing job failed; inspect the service logs.');
          break;
        }
        if (job.status !== 'pending' && job.status !== 'processing') throw new Error('Remote slicing returned an unknown job state.');
        await delay(500, undefined, { signal: controller.signal });
      }
      response = await request(`/slice-async/${requestId}/result`);
    }
    const result = await readResponse(response, MAX_BYTES);
    await fs.writeFile(input.outputPath, result, { flag: 'wx', mode: 0o600 });
    wroteOutput = true;
    const inspection = await inspectPrintFile(input.outputPath, {
      model, nozzleDiameters: nozzles, plateIndex: plate - 1, bedType: options.bedType,
    });
    if (JSON.stringify(inspection.materials) !== JSON.stringify(materials)) {
      throw new Error('Remote sliced file materials contradict the prepared filament profile.');
    }
    if (input.isCancelled()) throw new Error('Remote slicing cancelled.');
    return input.outputPath;
  } catch (error) {
    if (wroteOutput) await fs.rm(input.outputPath, { force: true });
    if (controller.signal.aborted) {
      throw new Error(`Remote slicing ${timedOut ? 'timed out' : 'cancelled'}; the remote job may continue. No retry was sent.`);
    }
    throw error;
  } finally {
    // DELETE only removes finished jobs; upstream has no active-job cancellation.
    // Cleanup never retries submission or masks a valid result / original error.
    if (requestId && terminalJob && !controller.signal.aborted) {
      try { await (await request(`/slice-async/${requestId}`, { method: 'DELETE' })).body?.cancel(); }
      catch { console.error('Remote slicing finished-job cleanup failed; service retention applies.'); }
    }
    clearTimeout(deadline);
    clearInterval(cancelCheck);
  }
}
