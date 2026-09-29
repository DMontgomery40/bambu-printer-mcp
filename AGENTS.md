# bambu-printer-mcp

This file is the repository's shared source of truth for local agents and scheduled maintenance. Read it before changing or reviewing code. CLAUDE.md and .claude/agents.md defer to these rules.

## Release and review

- Every update to main requires an npm patch version bump and publication, including code, documentation, and configuration. Run `npm version patch` once for the release, and include its package.json, package-lock.json, and manifest.json changes in the same integration to main.
- Before opening or updating a PR, run Matt Pocock's `code-review` skill against the main merge base. Resolve substantive standards and spec findings locally; keep its issue-tracker note as ignored agent scratch rather than adding another required public template.
- Use a PR to main and wait for CI on the current head; the local `code-review` gate above is the review step, so GitHub CI only sees reviewed work. Codex review is not part of this process: don't put `@codex review` in commit messages or PR comments unless the maintainer asks for it. A passing local test does not authorize ignoring current CI failures.
- Prioritize substantive defects and regressions in supported workflows. Document and defer obscure edge cases, speculative hardening, and cosmetic objections instead of extending a sound release into an endless review loop.
- Never add AI or agent attribution anywhere in Git or GitHub: no `Co-Authored-By` trailers for Claude, Codex, or other assistants, no "Generated with" footers, and no agent session links in commits, PR titles or bodies, review replies, issue comments, or release notes.
- Preserve original authorship when integrating contributor PRs. Credit code, issue reports, hardware evidence, and useful superseded proposals in CONTRIBUTORS.md. Clearly distinguish merged changes, superseded proposals, and deferred work.
- The main-branch Publish Package workflow runs the checks and `npm publish` using trusted publishing. Verify that workflow and the exact npm version before claiming publication; do not publish an unmerged release ahead of review.
- Create a `v<version>` tag on the final merged release commit and a GitHub Release. The tag workflow builds and uploads the `.mcpb` extension. Verify npm, package/manifest versions, the release asset, and fresh installed startup before declaring the release complete. Never move a published tag.
- Changes to src/, scripts/, or printer behavior need a present-tense CHANGELOG.md entry under `## Unreleased`. Use the accumulated entries in GitHub release notes, with contributor credit and validation limits. Supply multiline notes via a body file.

## Build and test

- `npm run build` must finish with zero TypeScript errors before committing. Keep tracked dist/ output synchronized with source.
- `node --test tests/behavior.test.mjs` must pass all current tests before pushing. Do not rely on an old fixed test count.
- `npm test` builds and runs the full suite, including printer routing/status, slicer safety, Blender MCP, real npm installation layouts, and desktop packaging. It must pass before release; CI uses Node.js 24 on Linux.
- Tests use compiled dist/ files, so build before focused test commands. Optional tests against an installed BambuStudio profile tree may skip when that tree or model is unavailable; report those skips separately from failures.
- For installation changes, test the actual tarball in local-hoisted, global, and npm-exec layouts and check the patched dependency at runtime. For desktop changes, inspect and initialize the extracted MCPB archive.
- Do not start physical prints or mutate the user's live Blender scene during routine tests. Use dummy printer credentials, mocked transport boundaries, and isolated headless Blender. Set BAMBU_MODEL explicitly to an empty string in tests of missing-model behavior so dotenv cannot supply a real configuration.

## Architecture and installation

- Bambu-only fork of mcp-3D-printer-server. Do not add OctoPrint, Klipper, Duet, Repetier, Prusa, or Creality printer integrations.
- MCP transports: stdio by default and streamable-http. Printer commands/status use MQTT on port 8883; file operations use FTPS on port 990.
- Use basic-ftp directly for uploads to avoid the bambu-js double-path bug. Use bambu-node directly for project_file commands and correct AMS mapping.
- Keep bambu-node pinned to the version covered by patches/. scripts/install-patches.mjs resolves the dependency actually used by the installed server, validates and applies the bundled patch, supports fully patched reruns, and fails installation on incompatible contents. A guessed local node_modules path or a successful patch-package CLI exit is insufficient proof.
- Patches depend on pinned patch-package internals; changes require fresh-install regressions. Do not silently change unknown printer identities or throw from normal asynchronous status reports.
- Package only intended runtime, source, licenses, and contributor files. Build MCPB in isolated staging without pruning the developer checkout. Never package credentials, local configuration, or private models.
- Use a private OS temporary directory per server instance and distinct generated profile paths for differing content.

## Printer and slicer safety

- All print routes must inspect the exact dispatched file snapshot and selected plate, enforce independent model/component and declared-material temperature ceilings, and require fresh observed MQTT identity, nozzle configuration, ready state, and actionable-error checks. Configured serial inference and cached display status are not live safety evidence.
- Keep complete physical filament mappings and compare available reported materials. Manual non-RFID material declarations remain supported; do not claim they prove physical spool contents or installed nozzle hardware.
- Remote starts must inspect the actual remote artifact and dispatch an immutable checked copy. Raw bridge methods and option overrides must not bypass the shared gate. Heater-off and stop/cancel controls remain available.

- BAMBU_MODEL (or the explicit tool model) is required for every print operation. Elicit it when missing. Never skip validation: G-code for the wrong model can damage hardware.
- Preserve model-specific upload/command routes and complete positional AMS mappings. Add regressions for the changed model and unaffected routes, including external-spool use where supported.
- X2D status and slicing use its own installed preset. Resolve the model before selecting the optional macOS native eMMC transport. Native printing, upload, heating, resume, and error clearing must retain the shared safety checks. Reject unsupported platforms before slicing or connection, and keep legacy FTPS/remote-file starts blocked. Do not infer physical print success from MQTT status, a successful slice, helper exit status, or mocked routing.
- Resolve both inherits and include dependencies recursively before BambuStudio, Orca, or FULU CLI slicing. Require the exact model/nozzle machine preset from the selected installation; never borrow a missing machine profile from another tree. Preserve configured user directories for custom process/filament dependencies. Missing references, cycles, malformed profiles, or incomplete slot mappings must stop preparation.
- Validate the selected bundled model's BBL/cli_config.json entry. Apply machine_limits when supplied; official P1S/H2D entries may intentionally contain only downward_check. Distinguish a validated no-overlay entry from missing/malformed configuration. The internal flattenForCli sourceProfiles.machine API preserves standalone explicit machine settings. Public Bambu-compatible CLI tools still require the selected model's bundled machine preset: slicer_profile supplies process settings, not a replacement machine configuration, and must not bypass that safety gate.
- Preserve custom overrides and filament-slot ordering. One explicit filament override replaces every declared project slot; partial positional lists must not silently reuse foreign profiles.
- Prepare one filament colour per slot, preserving explicit colours, project colours, and custom profile values in that order. Apply required colour overlays to standalone custom filament files without replacing their unrelated settings. Preserve an input project's saved prime-tower coordinates unless the caller explicitly overrides them; automatic multi-nozzle placement is only a fallback for an unset position.
- Never swallow inspection or auto-slice failures and upload the original unsliced project. Preserve the actionable error and stop before upload/print dispatch. A .gcode.md5 checksum is not printable G-code.
- Bind dispatched plate paths and checksums to inspected bytes. Reject duplicate/case-colliding ZIP names and inconsistent central/local records before JSZip can collapse them. Printable upload-only requests inspect every plate, verify live model/nozzles, and use unique remote names without overwriting existing files.
- Print and positive-heating preflight use human MCP elicitation by default. Only explicit `BAMBU_REQUIRE_CONFIRMATION=0` opts out of ordinary prompts; finished-bed clearance and hardware-error clearing/re-acknowledgment still require human confirmation. Recheck fresh state after a human response. Stop and heater-off never require confirmation.

## Blender MCP

- Standard Blender integration uses a stdio MCP client configured by trusted BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS. Discover remote tool schemas, validate arguments, preserve MCP content/errors, and propagate addon-disconnected failures.
- Standard edit previews and execution require an explicit new output_path. Legacy-only custom bridge configuration may keep it optional and must not claim output verification.
- Standard STL edits preserve the existing scene, validate the export receipt and finite geometry, and never overwrite an existing output. Keep all processes on a shared local filesystem and require Blender Object Mode.
- Enforce deadlines/cancellation, close child processes, and never automatically replay a mutation. On an interrupted dispatched edit, report that execution may still be running. Test actual PID termination independently of graceful-shutdown logging.
- MCP process discovery does not prove the Blender addon is running; headless tests do not prove a live scene or physical print succeeded. State the evidence accurately.

## Repository hygiene

- `.gitignore` excludes agent scratch plans, progress logs, handoff notes, and draft comments with `*.md`, while explicitly allowing shared AGENTS/CLAUDE rules and public README, CHANGELOG, CONTRIBUTORS, and docs/SLICING documentation. Keep public docs and rules tracked and current; leave private agent notes local. Add an explicit exception for intentional new public documentation.
- Keep real credentials and private artifacts out of Git. Do not print secrets from .env or local configuration.
- The GitHub Pages site in site/ is generated from README.md, docs/, CHANGELOG.md, and CONTRIBUTORS.md; edit those sources, not generated output. Map new or renamed README sections in site/scripts/pages.mjs, keep the home page's model notes in site/scripts/sync-docs.mjs aligned with supported printing, and check documentation changes with `npm --prefix site ci && npm --prefix site run build`.
