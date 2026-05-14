# bambu-printer-mcp

## Release Rules

- **Always bump the npm version** (`npm version patch`) and `npm publish` after any change that gets pushed to main -- code, docs, config, anything.
- Commit the version bump and push it as part of the same push.

## Changelog & Release Notes

- **Every commit that changes src/, scripts/, or printer behavior must include a CHANGELOG.md entry** under the `## Unreleased` heading.
- Entries go under the appropriate subsection (`### Added`, `### Fixed`, `### Changed`, `### Removed`, `### Known issues`).
- Each entry is a bullet describing what changed and why, in present tense. Include PR/issue links when relevant.
- If the commit is a standalone CHANGELOG update (e.g. retroactive entry for a prior commit), the commit message should start with `docs(changelog):`.
- **When cutting a release** (bump + push to main), create a GitHub Release with the accumulated `## Unreleased` entries as the body:
  ```
  gh release create v<version> --title "v<version>" --notes "$(cat CHANGELOG.md | awk '/^## Unreleased/{flag=1; next} /^## \[/{flag=0} flag' | sed '/^$/d')"
  ```
  This extracts everything under `## Unreleased` (stopping at the next `##` heading) and passes it as the release body.

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
