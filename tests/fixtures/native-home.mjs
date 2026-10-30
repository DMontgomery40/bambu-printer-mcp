import fs from "node:fs";
import path from "node:path";
import { BAMBU_NATIVE_CERTIFICATES, BAMBU_NATIVE_PLUGIN_LIBRARIES } from "../../dist/bambu-native.js";

/**
 * Create a Linux native home with placeholder plug-in and certificates so the
 * server accepts an explicit test helper. Nothing here is loaded or executed.
 * Placeholders are not the pinned plug-in, so callers must also pass
 * UNPINNED_PLUGIN_ENV to the server.
 */
export const UNPINNED_PLUGIN_ENV = Object.freeze({ BAMBU_NATIVE_ALLOW_UNPINNED_PLUGIN: "1" });

export function createFakeNativeHome(directory, { tunnelLibrary = true } = {}) {
  const home = path.join(directory, "native-home");
  fs.mkdirSync(path.join(home, "plugins"), { recursive: true });
  fs.mkdirSync(path.join(home, "cert"), { recursive: true });
  const libraries = tunnelLibrary ? BAMBU_NATIVE_PLUGIN_LIBRARIES : BAMBU_NATIVE_PLUGIN_LIBRARIES.slice(0, 1);
  for (const name of libraries) fs.writeFileSync(path.join(home, "plugins", name), "PLACEHOLDER");
  for (const name of BAMBU_NATIVE_CERTIFICATES) fs.writeFileSync(path.join(home, "cert", name), "PLACEHOLDER");
  return home;
}
