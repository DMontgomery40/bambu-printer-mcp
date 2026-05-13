# bambu-printer-mcp

## Release Rules

- **Always bump the npm version** (`npm version patch`) and `npm publish` after any change that gets pushed to main -- code, docs, config, anything.
- Commit the version bump and push it as part of the same push.

## Build & Test

- `npm run build` must pass clean (zero tsc errors) before committing.
- `node --test tests/behavior.test.mjs` must pass 4/4 before pushing.
- Tests use the compiled `dist/index.js` -- always build before testing.

## Architecture

- Bambu-only fork of mcp-3D-printer-server. No OctoPrint/Klipper/Duet/Repetier/Prusa/Creality.
- Transports: stdio (default) and streamable-http.
- Printer communication: MQTT (port 8883) for commands/status, FTPS (port 990) for file ops.
- Uses `basic-ftp` directly (not bambu-js) for uploads to avoid double-path bug.
- Uses `bambu-node` directly for MQTT project_file command (not bambu-js) for correct AMS mapping.

## Safety

- `BAMBU_MODEL` is required for any print operation. The server uses MCP elicitation to ask if missing.
- Never skip model validation -- wrong model = wrong G-code = potential hardware damage.
