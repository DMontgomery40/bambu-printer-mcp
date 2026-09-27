# bambu-printer-mcp

This file is the repository's shared source of truth for local agents and GitHub Codex review. Read it before changing or reviewing code. CLAUDE.md and .claude/agents.md defer to these rules.

## Release and review

- Every update to main requires an npm patch version bump and publication, including code, documentation, and configuration. Run `npm version patch` once for the release, and include its package.json, package-lock.json, and manifest.json changes in the same integration to main.
- Use a PR to main. Include `@codex review` in change commit messages and request `@codex review` on the PR. After each update, wait at least five minutes and for review plus CI to complete on the current head. Inspect inline findings as well as summary comments; fix actionable findings and repeat. A stale review or passing local test does not authorize ignoring current CI failures.
- Prioritize substantive defects and regressions in supported workflows. Document and defer obscure edge cases, speculative hardening, and cosmetic objections instead of extending a sound release into an endless review loop.
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

- BAMBU_MODEL (or the explicit tool model) is required for every print operation. Elicit it when missing. Never skip validation: G-code for the wrong model can damage hardware.
- Preserve model-specific upload/command routes and complete positional AMS mappings. Add regressions for the changed model and unaffected routes, including external-spool use where supported.
- X2D is recognized for status and slicing with its own installed preset. Direct X2D print paths must reject before slicing, connecting, or uploading: internal eMMC needs a native transport that has not shipped. Do not infer working X2D printing from MQTT status, a successful slice, or mocked H2 routing. The explicitly configured BambuNetwork bridge is a separate transport and is not proof of direct-print support.
- Resolve both inherits and include dependencies recursively before BambuStudio, Orca, or FULU CLI slicing. Require the exact model/nozzle machine preset from the selected installation; never borrow a missing machine profile from another tree. Preserve configured user directories for custom process/filament dependencies. Missing references, cycles, malformed profiles, or incomplete slot mappings must stop preparation.
- Validate the selected bundled model's BBL/cli_config.json entry. Apply machine_limits when supplied; official P1S/H2D entries may intentionally contain only downward_check. Distinguish a validated no-overlay entry from missing/malformed configuration. The internal flattenForCli sourceProfiles.machine API preserves standalone explicit machine settings. Public Bambu-compatible CLI tools still require the selected model's bundled machine preset: slicer_profile supplies process settings, not a replacement machine configuration, and must not bypass that safety gate.
- Preserve custom overrides and filament-slot ordering. One explicit filament override replaces every declared project slot; partial positional lists must not silently reuse foreign profiles.
- Prepare one filament colour per slot, preserving explicit colours, project colours, and custom profile values in that order. Apply required colour overlays to standalone custom filament files without replacing their unrelated settings. Preserve an input project's saved prime-tower coordinates unless the caller explicitly overrides them; automatic multi-nozzle placement is only a fallback for an unset position.
- Never swallow inspection or auto-slice failures and upload the original unsliced project. Preserve the actionable error and stop before upload/print dispatch. A .gcode.md5 checksum is not printable G-code.

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
