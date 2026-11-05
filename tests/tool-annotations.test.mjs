import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_ANNOTATIONS, withAnnotations } from '../dist/tool-annotations.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/inspection-no-network.mjs', import.meta.url));
const HINTS = ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'];

async function listedTools(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tool-annotations-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, entry], cwd: dir, stderr: 'pipe',
    env: { HOME: dir, MCP_TRANSPORT: 'stdio', BAMBU_MODEL: '', BAMBU_PRINTER_MODEL: '', BAMBU_PRINTER_HOST: '127.0.0.1', PRINTER_HOST: '127.0.0.1',
      BAMBU_SERIAL: '', BAMBU_PRINTER_SERIAL: '', BAMBU_TOKEN: '', BAMBU_PRINTER_ACCESS_TOKEN: '', INSPECTION_NETWORK_LOG: join(dir, 'network.log') } });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'tool-annotations-test', version: '1' }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  return (await client.listTools()).tools;
}

test('every listed tool declares all four MCP annotation hints, and the table names only listed tools', async t => {
  const tools = await listedTools(t);
  assert.ok(tools.length > 50);
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.deepEqual(Object.keys(tool.annotations).sort(), HINTS, `${tool.name} annotations`);
    for (const hint of HINTS) assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}.${hint}`);
    // A read-only tool cannot destroy anything, and reading again changes nothing.
    if (tool.annotations.readOnlyHint) {
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-only but destructive`);
      assert.equal(tool.annotations.idempotentHint, true, `${tool.name} is read-only but not idempotent`);
    }
  }
  assert.deepEqual(Object.keys(TOOL_ANNOTATIONS).sort(), tools.map(tool => tool.name).sort());
});

test('annotations match what the tools do to the printer and files', async t => {
  const byName = Object.fromEntries((await listedTools(t)).map(tool => [tool.name, tool.annotations]));
  // The remote read scope is exactly these tools; adding one is a deliberate change here.
  assert.deepEqual(Object.keys(byName).filter(name => byName[name].readOnlyHint).sort(), ['blender_mcp_status', 'camera_frame',
    'counterpart_discover_printers', 'counterpart_print_progress', 'counterpart_printer_info', 'counterpart_propose_filaments', 'counterpart_setup_fields', 'get_printer_filaments', 'get_printer_status', 'get_stl_info',
    'inspect_print_file', 'list_3mf_plate_objects', 'list_printer_files', 'list_templates', 'resolve_3mf_ams_slots']);
  // Anything that moves, heats, prints or writes is not read-only and reaches the printer.
  for (const name of ['print_3mf', 'print_3mf_bambu_network', 'start_print', 'start_print_job', 'upload_file', 'pause_print', 'resume_print',
    'cancel_print', 'set_temperature', 'set_fan_speed', 'reread_ams_rfid', 'clear_hms_errors', 'delete_printer_file', 'bambu_network_call']) {
    assert.equal(byName[name].readOnlyHint, false, name);
    assert.equal(byName[name].openWorldHint, true, name);
  }
  // Irreversible or replacing: ending a job, skipping objects, deleting files, clearing errors, bridge agent setup, editor calls.
  for (const name of ['cancel_print', 'skip_objects', 'delete_printer_file', 'clear_hms_errors', 'bambu_network_call',
    'blender_mcp_call', 'fusion_mcp_call', 'save_template', 'camera_snapshot', 'bambu_network_bridge_status', 'counterpart_print_route']) assert.equal(byName[name].destructiveHint, true, name);
  // A repeated print start starts another job.
  for (const name of ['print_3mf', 'start_print_job', 'upload_file']) assert.equal(byName[name].idempotentHint, false, name);
  // A slice or local model edit replaces its earlier output of the same name, in the server's temporary directory.
  for (const name of ['scale_stl', 'slice_stl', 'get_slice_settings', 'print_3mf', 'print_3mf_bambu_network', 'print_collar_charm']) assert.equal(byName[name].destructiveHint, true, name);
  // Discovery listens on the local network and the proposal reads the live AMS; setup fields are this server's own.
  for (const name of ['counterpart_discover_printers', 'counterpart_propose_filaments']) assert.equal(byName[name].openWorldHint, true, name);
  assert.equal(byName.counterpart_setup_fields.openWorldHint, false);
  // Local model edits write only to the server's temporary directory only.
  for (const name of ['scale_stl', 'rotate_stl', 'lay_flat', 'get_stl_info']) assert.equal(byName[name].openWorldHint, false, name);
});

test('a tool missing from the table gets the most cautious hints', () => {
  assert.deepEqual(withAnnotations({ name: 'not_in_the_table' }).annotations,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
});
