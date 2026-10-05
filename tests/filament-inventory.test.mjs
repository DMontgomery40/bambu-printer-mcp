import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const printerModule = new URL("../dist/printers/bambu.js", import.meta.url).href;

async function inventoryFixture(t, { binary, profiles, slicerType = "bambustudio", override = false, missing = false, invalidDirectory = false }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-filament-inventory-"));
  const client = new Client({ name: "filament-inventory-test", version: "1" });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, binary);
  const profilesRoot = path.join(root, profiles);
  const filamentDir = path.join(profilesRoot, "BBL", "filament");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture executable; must never be launched");
  await fs.mkdir(path.join(profilesRoot, "BBL", "machine"), { recursive: true });
  await fs.mkdir(filamentDir, { recursive: true });
  await fs.writeFile(path.join(filamentDir, "Generic PLA @base.json"), JSON.stringify({ name: "Generic PLA @base", filament_id: "GFL99" }));
  const expectedProfile = path.join(filamentDir, "Generic PLA @BBL P2S.json");
  await fs.writeFile(expectedProfile, JSON.stringify({ name: "Generic PLA @BBL P2S", inherits: "Generic PLA @base" }));
  if (invalidDirectory) {
    await fs.rm(filamentDir, { recursive: true });
    await fs.writeFile(filamentDir, "not a profile directory");
  }
  const preload = `
    import { BambuImplementation } from ${JSON.stringify(printerModule)};
    BambuImplementation.prototype.getStatus = async () => ({
      connected: true, model: 'P2S', status: 'IDLE',
      ams: { tray_now: '255', ams: [{ id: '0', tray: [{ id: '0', state: 11,
        tray_info_idx: 'GFL99', tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: -1 }] }] }
    });
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`, serverEntry],
    cwd: root,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "TEST_SERIAL", BAMBU_PRINTER_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN", BAMBU_PRINTER_ACCESS_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "p2s", BAMBU_PRINTER_MODEL: "p2s",
      SLICER_TYPE: slicerType, SLICER_PATH: executable, BAMBU_STUDIO_PATH: "",
      BAMBU_PROFILES_ROOT: missing ? path.join(root, "missing-profiles") : override ? profilesRoot : "",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const result = await client.callTool({ name: "get_printer_filaments", arguments: {} });
  assert.notEqual(result.isError, true);
  return { inventory: JSON.parse(result.content[0].text), expectedProfile };
}

for (const [name, options] of [
  ["Windows installation", { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles" }],
  ["macOS bundle", { binary: "BambuStudio.app/Contents/MacOS/BambuStudio", profiles: "BambuStudio.app/Contents/Resources/profiles" }],
  ["Linux installation", { binary: "prefix/bin/bambu-studio", profiles: "prefix/share/BambuStudio/profiles" }],
  ["selected Orca installation", { binary: "OrcaSlicer/OrcaSlicer.exe", profiles: "OrcaSlicer/resources/profiles", slicerType: "orcaslicer" }],
  ["explicit profile root", { binary: "selected/bambu-studio.exe", profiles: "custom profiles", override: true }],
]) {
  test(`filament inventory resolves profiles from the ${name}`, async t => {
    const { inventory, expectedProfile } = await inventoryFixture(t, options);
    assert.equal(inventory.summary.loaded_slots, 1);
    assert.equal(inventory.summary.resolved_profile_slots, 1);
    assert.equal(await fs.realpath(inventory.trays[0].resolved_profile_path), await fs.realpath(expectedProfile));
    assert.equal(inventory.trays[0].profile_resolution, "model");
    assert.equal(inventory.trays[0].tray_color, "FFFFFFFF");
    assert.equal(inventory.recommended.load_filaments, inventory.trays[0].resolved_profile_path);
  });
}

test("filament inventory does not borrow profiles when its explicit root is missing", async t => {
  const { inventory } = await inventoryFixture(t, {
    binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", missing: true,
  });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
  assert.equal(inventory.recommended, null);
});

test("filament inventory remains available when slicer configuration is invalid", async t => {
  const { inventory } = await inventoryFixture(t, {
    binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", slicerType: "invalid-slicer",
  });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
});

test("filament inventory remains available when the profile directory cannot be read", async t => {
  const { inventory } = await inventoryFixture(t, {
    binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", invalidDirectory: true,
  });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
  assert.equal(inventory.recommended, null);
});
