# Changelog

## [1.1.35] – 2026-10-26

### Fixed
- Remove the unused `bambu-js` dependency and its last caller, a file-lookup method no tool used. It bundled basic-ftp 5.3.1, which carries the advisories basic-ftp 6.2.3 fixed for rejected control-character commands and password handling; every file transfer and listing already uses basic-ftp 6.2.3 directly, and printer commands use bambu-node.
- Update the desktop/CI lock for new production-dependency advisories: zod 4.6.7 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), memory exhaustion validating oversized constrained collections; every zod 3 release is affected, and the MCP SDK accepts zod 4), body-parser 2.4.0 ([GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)), fast-uri 3.1.9, hono 4.13.14 and ip-address 10.7.5. `npm audit --omit=dev` reports no vulnerabilities. npm omits the lock from published packages, so existing projects pick these up when they refresh their own locks. The documentation site's VitePress development server still pulls vite and esbuild versions with one high and two moderate advisories that have no VitePress 1.x fix; they affect only `vitepress dev`, not the published static site.

## [1.1.34] – 2026-10-25

### Fixed
- Let H2D printers with stock nozzles print. Every print stopped with `Printer nozzle 0 information is unreliable, abnormal or unknown` because the HS01 nozzles report `stat: 1` permanently. Bambu Studio reads bit 0 of `stat` as "information unreliable" and bits 1-2 as abnormal or unknown, and uses the unreliable bit only as a dismissible warning for H2C rack nozzles. Nozzles that report no identity chip (`sn: "N/A"`) now pass bit 0. Their configured diameter and type are still compared with the job. The print prompt names them so a person confirms they match the installed hotends, and checks log them once per printer on stderr, so a headless setup with `BAMBU_REQUIRE_CONFIRMATION=0` still records them. Abnormal or unknown nozzles still block, and a chipped nozzle with unreliable information asks for a refresh on the printer. Reported by [MorganFreeeman](https://github.com/MorganFreeeman) in [#67](https://github.com/DMontgomery40/bambu-printer-mcp/issues/67) with idle and mid-print H2D firmware 01.04.00.00 reports; maintainer validation uses that report in regressions, with no H2D hardware available.
- Say "declined or cancelled" when a person or the MCP client declines a hardware confirmation, instead of advising a client with elicitation support. Ordinary print and heating prompts point to `BAMBU_REQUIRE_CONFIRMATION=0` for deliberately headless setups; bed-clearance and hardware-error confirmations say a person must accept them. `BAMBU_REQUIRE_CONFIRMATION` and `BAMBU_CONFIRMATION_TIMEOUT_MS` are now in the setup guide's settings table. Also from [#67](https://github.com/DMontgomery40/bambu-printer-mcp/issues/67).
- Make FULU BambuNetwork bridge LAN printing work. Before a LAN print, open the networking plug-in's own LAN session as Bambu Studio and the native X2D helper do. It connects, installs the printer's application certificate, waits for the connection, requests the printer's state, and closes the session after the print command. Without this the plug-in uploaded the job but every print failed with `-4030`. Agent setup now passes the plug-in a certificate folder holding Bambu's public `printer.cer` and `slicer_base64.cer`, pinned by SHA-256 (`BAMBU_NETWORK_CERT_DIR` overrides it). FULU's runtime lacks `printer.cer`, without which LAN connections fail, and the host crashed when a printer connection opened before any certificate folder was set. A first `-4030` from the plug-in is retried once after another certificate exchange, with fresh safety checks; the error lists the plug-in's own job reports. Bridge jobs carry the unique checked name as their project name, because the plug-in names the uploaded file and printer job from it, so `resume_print` can bind to the inspected file. The result reports it as `printerJobName`. Because the plug-in signs the command as Bambu Studio does, LAN bridge printing worked on the maintainer's P1S with Developer Mode off; the direct LAN path still needs Developer Mode on firmware with authorization control. A host that rejects the certificate or callback calls still serves cloud jobs and probes; LAN prints then stop before connecting. LAN sessions on one bridge run one at a time, because the plug-in holds one LAN connection and the host one event queue.
- Work around FULU's Linux host bugs found in [#68](https://github.com/DMontgomery40/bambu-printer-mcp/issues/68). On Linux, pass the absolute `PJARCZAK_BAMBU_NETWORK_SO` and `PJARCZAK_BAMBU_SOURCE_SO` inside `PJARCZAK_BAMBU_PLUGIN_DIR` unless set, because the v1.0.0 host opens them from its working directory ([FULU #51](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/51)). Explain exit code 101, the host's failure on Node's socket stdout ([FULU #50](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50)), and document the `cat` wrapper that avoids it. A handshake reporting `file open failed` now stops before agent creation and names the missing setting. Bridge status reports the certificate folder and, on Linux, the library paths; macOS discovery paths appear only on macOS, and the wrapper command is suggested only when the wrapper exists. Reported with diagnosis, upstream issues and a working cloud configuration by [Aaron Roberts (aaroberts)](https://github.com/aaroberts). Maintainer validation: an x86-64 Ubuntu 24.04 container under emulation ran the FULU v1.0.0 host and plug-in 02.05.02.58 through the wrapper. It printed a 10 mm and then a 40 mm PLA cube on a P1S over LAN through `print_3mf_bambu_network`. The printer ran the second under the checked job name, and the opt-in real-host test opened and closed a LAN session with the same printer. Cloud printing, Windows/WSL and macOS wrappers were not retested.
- Return a live frame from `camera_snapshot` on A1, A1 mini, P1S and P1P. The printer first replays its last buffered frame, which after an idle period can show a finished part that was removed long ago; the tool returned exactly that frame. It now skips that frame and any identical repeat, returns the next live frame, and fails rather than return only buffered frames. Reported by the maintainer on a P1S; verified there and with a local TLS stream regression.
- Stop `get_printer_status` from intermittently reporting `UNKNOWN` with a near-empty `raw` report. A printer's first MQTT push is a sparse hello (model and modules); the full status followed after a fixed 500 ms wait, which a busy host missed. The read now waits, within its existing bound, until the full status has merged. Seen twice on a P1S during this release's Docker testing; covered by a regression with a delayed full push.
- Stop `slice_stl` option combinations from crashing OrcaSlicer's CLI. Orca 2.4.2 segfaults in `PartPlate::check_outside`, which needs the GUI, when `scale` or `rotate_x`/`rotate_y` moves an object below the bed while arranging, the default for STL input. A 140-run option matrix on Linux found no other crash. Orca rotates about the object's origin, so even rotations that shrink a part's height can crash it. For STL input with Orca or FULU, the server applies scale and rotations to a copy of the mesh and omits those flags. It follows Orca's own composition from its source: scale, then X, then Y, then Z, whatever the argument order. For 3MF input it refuses that combination with an explanation. `repetitions` on an STL now uses Orca's `--clone-objects`; it previously always failed with "invalid parameters". The `clone_objects` and `arrange` descriptions now state the CLI's real limits. Verified against OrcaSlicer 2.4.2 on Linux. The previously crashing scales and rotations slice, repetitions produce the requested copies, and a 10×20×30 mm box turned 90° about Z and X prints 20 mm tall, as Orca's rotation order requires. The `--rotate-x 45` reproducer from the closed upstream report [OrcaSlicer #13328](https://github.com/OrcaSlicer/OrcaSlicer/issues/13328) still crashes 2.4.2 this way.
- Report how a slicer failed. A crash now reads `the slicer crashed with SIGSEGV` (or the exit code) with the end of its output, instead of an empty `Stderr:`. Bambu Studio and Orca failures also name the CLI's own reason, from `result.json` on Linux or from the exit code. FULU OrcaSlicer-bambulab v1.0.0's CLI crashes on every run in `PartPlate::invalidate_plate_name_texture`; the FULU guide now says to export from its GUI or use upstream OrcaSlicer's CLI until FULU fixes it.

## [1.1.33] – 2026-10-23

### Added
- Prepare local OrcaSlicer builds that ship Bambu profiles only as version-2 `.opc` caches. Validate the exact selected cache's version, size, CRC, vendor and typed options, preserve inheritance/includes and model bed exclusions, and require that installation's retained `BBL/cli_config.json`. Expand profiles and stage canonical User preset identities in a private CLI data directory; never edit the installed slicer or use another installation's profiles. Preserve project colours, bed selection, custom settings and tower coordinates through explicit project-level CLI arguments. Keep native extrusion mode for these builds so multi-colour wipe towers work; legacy JSON-based Orca/FULU/BambuStudio preparation stays unchanged. Remote API cache mirrors remain unsupported. Remove per-slice expanded cache and CLI data directories after completion or failure.
- Verify the official October 23 Orca nightly (`14da40e3a7b82aa8fc88593c2cf880e66560028f`, Mac asset `669077524`) with real isolated P1S 0.4 single- and two-colour slices, custom PLA temperatures, saved tower coordinates and independent selected-plate inspection. Other models have cache/profile regressions; no physical printing or other-platform runtime validation is claimed. Thanks to [bwees](https://github.com/bwees) for the upstream packaging report/fix, and the OrcaSlicer cache-format contributors credited in CONTRIBUTORS.md.

## [1.1.32] – 2026-10-20

### Changed
- Store X2D native print jobs on the printer's SD card or USB stick when it reports one ready, as OrcaSlicer does, instead of always on internal storage (eMMC) like Bambu Studio's Print button. The job can then be reprinted from the printer, and tools that read the card over FTPS (such as Bambuddy) archive it with its thumbnail and slicer metadata. The card state is read as Bambu Studio reads it (`sdcard`, `home_flag` bits 8-9, then `aux` bits 12-13); without a card, or with an abnormal or read-only one, jobs still go to internal storage. An explicit `try_emmc_print` argument (now also listed on `print_3mf`, and refused unless it is a boolean) or `BAMBU_NATIVE_TRY_EMMC_PRINT` still decides. External storage is refused before the helper starts when the printer reports no ready card, and a card that stops being ready before dispatch stops the print. The result reports the requested `storage` as `external` or `internal`. Contributed by [mygrexit](https://github.com/mygrexit) in [#64](https://github.com/DMontgomery40/bambu-printer-mcp/pull/64), who reports an external-storage print on Linux X2D firmware 01.01.01.00 with plug-in 02.08.02.54 and a Bambuddy thumbnail. Maintainer verification uses pinned upstream source and mocked native helpers; no maintainer physical print was run. Related upstream storage proposal: [maziggy’s Bambu Studio #12146](https://github.com/bambulab/BambuStudio/pull/12146), still unmerged.

### Fixed
- Make the emergency MQTT connection-order regression independent of simulated reconnect timing, so loaded macOS CI does not confuse its 50 ms scheduling margin with a routing failure. Production deadlines and conservative post-send timeout reporting are unchanged.

## [1.1.31] – 2026-10-19

### Fixed
- Raise the server's direct MQTT minimum to 5.16.1 and refresh the desktop/CI lock to that version, including its upstream fix for reconnecting when the previous stream is already destroyed. Keep emergency expiry and queued-command cancellation covered by the transport regressions.
- Update the desktop/CI lock's `proxy-addr` to 2.0.8 for its IPv4-mapped IPv6 trust-subnet fix (GHSA-jqcg-44mw-7w3h), and the documentation build's `source-map-js` to 1.2.2 for indexed source-map offset denial of service (GHSA-68fv-2mgg-jv7q). npm omits this development lock from published packages: existing npm projects may retain older transitive MQTT/proxy versions and must update their own dependency locks to adopt those fixes. The direct MQTT minimum applies to the server's own resolution. This does not claim that the default MCP server trusts proxy headers or that all audit advisories are resolved.

## [1.1.30] – 2026-10-19

### Fixed
- Stop waiting indefinitely for MQTT on Linux X2D stop and heater-off. When the printer could not be reached over MQTT, the MQTT connect kept retrying and `cancel_print` or heater-off never returned, even after the native route had already sent the command. Each MQTT send now gives up after 15 seconds (`BAMBU_EMERGENCY_MQTT_TIMEOUT_MS`, 1–60000 ms) and is reported as failed; the result still counts the native route, and the call fails only when neither route succeeds. Expiry revokes dispatch before a delayed connection can publish the stale stop or heater-off, and force-closes an in-flight MQTT publisher so its offline queue cannot replay the expired command. The closed client is removed from the cache for future requests. The counted send waits for the immediate attempt to settle, so one timeout cannot close the other attempt's transport. The wait for older print or heating helpers to exit stays separate, so it never counts against that limit. Contributed by [mygrexit](https://github.com/mygrexit) in [#61](https://github.com/DMontgomery40/bambu-printer-mcp/pull/61), with the delayed-dispatch correction covered by additional regressions. Verified with mocked native helpers and a never-connecting MQTT client; on the previous code these calls hung until the MCP client gave up.

## [1.1.29] – 2026-10-18

### Added
- Add the optional `orca-slicer-api` backend for containerized deployments in [#50](https://github.com/DMontgomery40/bambu-printer-mcp/issues/50), requested by [Pavel Bukhatkin (welderpb)](https://github.com/welderpb). Use a trusted API URL, optional token/header, bounded timeout and synchronous or asynchronous jobs without a local slicer executable. A matching read-only Orca profile tree still supplies the exact model/nozzle preset and recursively resolved machine/process/filament profiles. The current upstream API supports one filament slot and one selected plate; unsupported options and multi-slot projects fail explicitly. Downloaded output is independently inspected before use, and print confirmation and fresh-state checks remain mandatory. Verified with local HTTP fixtures and the pinned genuine API application using an isolated fake CLI; no real remote slice or physical print is claimed.

### Fixed
- Forward the validated remote bed selection to the API and inspect the returned file against the same bed, preserving non-default hot/cool/custom process selections.
- Stop cancelled remote multipart requests before entering `fetch`, preventing an uncaught stream error in Node.js 24.21 while retaining cancellation and timeout warnings.
- Accept stock X2D `M104`/`M109 N` physical-nozzle selectors and the exact filament-change separator from Bambu Studio 02.08.02.61, contributed by [travismcashan](https://github.com/travismcashan) in [#59](https://github.com/DMontgomery40/bambu-printer-mcp/pull/59). Keep heater targets within every applicable declared material ceiling; retain H2C's startup-only record separator and reject unrelated executable-looking banners.
- Support both dual-nozzle external spools: `255` selects the right/main nozzle and `254` the left/deputy nozzle. Bind each selected spool to the inspected plate's composed `filament_map` and `physical_extruder_map`, require its fresh `vir_slot` report, and preserve explicit selections when `use_ams: false`. Encode both virtual trays as flat `-1` with the selected virtual ID and `slot_id: 0` in `ams_mapping2`, matching Bambu Studio. Single-nozzle routing stays unchanged. Covered by offline stock-template inspection and mocked direct, native and bridge dispatch regressions; no physical print was run.

## [1.1.28] – 2026-10-18

### Added
- Add `nozzle_volume_type` (`standard`, `high_flow`; default `BAMBU_NOZZLE_VOLUME_TYPE`, else the preset's Standard default) to `slice_stl`, `slice_with_template`, and `print_3mf`/`print_3mf_bambu_network` auto-slicing, and pass it to the profile flattener's existing `nozzleVolumeType` override. CLI slices were always Standard, so a printer with a High Flow nozzle got Standard per-variant values (for example the filament's Standard `filament_max_volumetric_speed`) and a job the print gate refuses as a nozzle flow mismatch. A flow type the machine preset doesn't declare in `extruder_variant_list` (for example High Flow on A1 presets) is refused before the slicer runs. Contributed by [patrikmadoran-cyber](https://github.com/patrikmadoran-cyber) in [#54](https://github.com/DMontgomery40/bambu-printer-mcp/pull/54), with a real Windows BambuStudio 02.06.00.51 H2S 0.6 nozzle slice: the sliced 3MF records `nozzle_volume_type` High Flow and the G-code header uses the filament's High Flow variant; no physical print was run.

- Support X2D native printing, upload and controls on x86-64 Linux. `bambu-printer-mcp-native-setup` builds the helper from the package source and installs the Linux networking plug-in that Bambu Studio downloads, the file-tunnel library it loads beside itself, and its two certificates, pinned to exact versions and SHA-256 under a private directory. After installing, it loads the plug-in once offline and withdraws the installation if that fails. `--verify` repeats these checks offline; `--check-update` reports newer plug-ins and whether their `PrintParams` layout still matches the helper, and never installs an unpinned plug-in. Linux without a complete installation, and non-x86-64 Linux, keeps its previous MQTT stop, pause and heater-off controls and names the setup command before any native print contacts the printer. The server passes the validated plug-in and certificate paths to the helper, accepts only the pinned plug-in checksums, never loads Bambu Studio's auto-updating copy, and refuses a helper built from another package version. On Linux, X2D stop and heater-off go out over the native route and MQTT at the same time, so a stuck helper cannot delay them, and MQTT is sent again once older print or heating helpers have exited; either the native route or that later send succeeding counts. Native upload resolves and enforces the X2D model before checking the native installation. Shared model, file, state, preflight and dispatch-authorization checks are unchanged.
- Build the native helper with a POSIX `sh` script on macOS and Linux; `npm run build:native` no longer needs zsh.

### Fixed
- Update direct FTPS transfers to basic-ftp 6.2.3: reject malformed passwords without crashing or including the password in errors, and recover after rejected control-character commands. Thanks to [Patrick Juchli](https://github.com/patrickjuchli) for the [upstream fixes](https://github.com/patrickjuchli/basic-ftp/releases/tag/v6.2.3). Verified with isolated localhost FTP fixtures, Bambu transport regressions and installed packages; no physical printer action was run.

- End one-shot native command, upload and probe runs right after the plug-in's own cleanup, as print runs already do. Its worker threads can outlive that cleanup, and process-exit destructors then crashed successful runs with SIGSEGV (2 of 8 X2D commands on Linux), so the server reported a delivered command as failed. Contributed by [mygrexit](https://github.com/mygrexit) in [#56](https://github.com/DMontgomery40/bambu-printer-mcp/pull/56), with contributor-reported X2D Linux hardware queries and print-start evidence. Maintainer verification uses offline and compiled stub tests; no maintainer physical print was run.

- Accept X2D jobs from OrcaSlicer 2.4.2. Its start G-code preheats a nozzle without assigned filament with `M620.17 … L-1` for toolhead-offset calibration, where Bambu Studio writes `L0`; that target is now checked against the X2D hardware limit and every declared material, which is never looser than the accepted `L<position>` form. The per-layer time-lapse capture `M9711 M<mode> E<extruder> …` from the official X2D and H2D templates is accepted with its exact parameters inside the machine volume instead of being read as a second `M0` command. The `L-1` form names one of the two physical nozzles; other models, other negative positions and extra parameters stay rejected. Material left in an idle nozzle from an earlier job is live state that file inspection cannot see, as with Bambu Studio's `L0` form. Contributed by [mygrexit](https://github.com/mygrexit) in [#57](https://github.com/DMontgomery40/bambu-printer-mcp/pull/57), with contributor-reported inspection of two real OrcaSlicer X2D files and a print start using their combined Linux changes. Maintainer validation uses offline fixtures; no maintainer physical print was run.

- Let printing, heating and resume proceed past HMS entries that Bambu hides for the printer's model. Bambu lists some serious or common codes in a model's HMS table with empty text, and its printer screen, Bambu Studio and Bambu Handy never show them; an X2D raises the hidden camera code `0500-0600-0002-0070` about 15 seconds after every boot, which `clean_print_error` does not remove, so no print could pass the gate. The hidden codes come from the bundled English HMS tables of Bambu Studio v02.08.02.61 (pinned by commit, with per-table versions and SHA-256) for X2D, P2S, H2D, H2D Pro, H2S and H2C, selected only by a serial returned in the fresh raw report (never a configured serial alone) as Bambu Studio does and regenerated with `scripts/generate-hidden-hms.mjs`; the print preflight names any it passes and stops the print if one first appears after the confirmation, checks log each once per printer, and `clear_hms_errors` leaves them alone. Fatal, documented, unlisted and other models' codes still block; the P2S table does not list `0500-0600-0002-0070`, so a P2S still blocks on it. X1/P1/A1 behaviour is unchanged. Contributed by [mygrexit](https://github.com/mygrexit) in [#58](https://github.com/DMontgomery40/bambu-printer-mcp/pull/58), who reports that their X2D keeps the entry after clearing and a power cycle. Maintainer verification reproduces the pinned official tables and uses mocked safety regressions; no maintainer physical print was run. Related hardware reports from [Bambuddy #1840](https://github.com/maziggy/bambuddy/issues/1840) and [#2728](https://github.com/maziggy/bambuddy/issues/2728) inform this change.

## [1.1.27] – 2026-10-14

### Added
- Add `inspect_print_file`, an offline read-only tool for an exact private snapshot and selected plate of prepared 3MF/text G-code. Reuse the existing model/nozzle/material/temperature and archive checks, reject unsliced/checksum-only input, and return generic versioned file-only evidence bound to SHA-256, byte length and plate. No printer is contacted, no auto-slicing is performed, and the receipt does not authorize dispatch or establish hardware readiness. Existing print routes retain their independent fresh preflight and human gate.

### Fixed
- Discover nested vendor process and filament profiles in the selected slicer installation, including inherited defaults and filament IDs, while refusing missing dependencies and linked external directories.
- Accept the X2D and P2S startup `SYNC R0 T` duration form; other reset forms and extra parameters remain rejected, and heater targets retain their independent limits. Validated offline; no physical print was run.

## [1.1.26] – 2026-10-10

### Fixed
- Correct H2C (`31B`) and H2D Pro (`239`) serial identity in displayed status, fresh print-safety evidence, and the installed bambu-node parser. Preserve model-conflict rejection and never use configured identity as fresh evidence. Thanks to Adam (@adamkaplan) for the report and H2C hardware observations in [#47](https://github.com/DMontgomery40/bambu-printer-mcp/issues/47).
- Accept the official Bambu Studio 02.08.02.61 H2C startup forms inside one explicitly bounded startup block: bare hotend remapping, checked all-hotend preheat, bed `D` targets, tower/probe setup, and the literal record-data separator. Keep layer-change settings in the config block from closing startup prematurely; actual layer markers and extrusion still close it. Independent heater/material ceilings, declared filament positions, and wrong-model rejection remain enforced. Thanks to Adam (@adamkaplan) for the reproductions in [#48](https://github.com/DMontgomery40/bambu-printer-mcp/issues/48). Covered by the exact pinned vendor template and unsafe mutations; no maintainer physical H2C print was run.
- Preserve the X2D native print dispatch result after flushing its receipt by ending the one-shot helper before plug-in teardown. If an older/custom helper crashes after authorized dispatch, report uncertainty and require checking printer status/job name before retrying instead of claiming ordinary failure. Thanks to @travismcashan for accepted-job, completed-print, and crash evidence in [#46](https://github.com/DMontgomery40/bambu-printer-mcp/issues/46). Maintainer tests use a compiled stub plug-in with crashing teardown and subprocess regressions; no physical print was run.

## [1.1.25] – 2026-10-05

### Fixed
- Accept the official X2D bare `B` material-switch flag and `M620.22 I<filament> P1` runout-purge form. Keep the allowance model-specific, reject numeric `B`, extra purge parameters and undeclared filament positions, and retain independent heater ceilings. Reported by [travismcashan](https://github.com/travismcashan) in [#44](https://github.com/DMontgomery40/bambu-printer-mcp/issues/44); the reporter verifies a physical X2D print with their local workaround, while release tests use isolated file inspection and mocked transports.
- Explain an accepted hardware-confirmation form with an unchecked box without suggesting a missing MCP capability. Keep the operation blocked, and send 3MF parsing and auto-slicing diagnostics to stderr so stdio remains protocol-only ([#44](https://github.com/DMontgomery40/bambu-printer-mcp/issues/44)).
- Resolve live AMS filament profiles from the configured slicer installation and `BAMBU_PROFILES_ROOT` on Windows, macOS, and Linux, instead of a fixed macOS BambuStudio path. Contributed by [Aleksei Popovich (@alexpapay)](https://github.com/alexpapay) in [#43](https://github.com/DMontgomery40/bambu-printer-mcp/pull/43). Preserve unresolved inventory when the selected profile tree is unavailable.
- Read chamber temperature from the packed `device.ctc.info.temp` field reported by P2S and newer firmware, retaining legacy chamber/frame temperature fallbacks. Validate with offline regressions and read-only checks on a Windows P2S with AMS 2 Pro: all four loaded slots resolve and chamber temperature matches the raw report. No print, heater, or motion commands are sent.

### Dependencies
- Update the MCP SDK, MQTT and ZIP libraries within their compatible release lines. Use basic-ftp 6.2.2 for direct file transfers, including its patched listing parser and default rejection of separate transfer hosts. Keep the tested bambu-node and patch-package versions pinned; this does not claim that the legacy bambu-js and braces transitive audit findings are resolved.

## [1.1.24] – 2026-10-03

### Fixed
- Accept the `M109 S<target> H<limit>` waits in the official A1 and A1 mini start G-code (`M109 S25 H140`, `M109 S220 H300`, and on the A1 mini `M109 S100 H170`), which rejected every job sliced with the stock A1 profiles in Bambu Studio 02.08 with "unsupported M109 temperature parameter H". `H` is not treated as a heater target: `S`/`R` remain the checked targets, and `H` is accepted only on `M109` for these models and only from 0 to 300. Other models, other heater commands, and out-of-range values still reject. The installed-profile startup check now covers the A1 and A1 mini. Contributed by [nitpreet22](https://github.com/nitpreet22) in [#41](https://github.com/DMontgomery40/bambu-printer-mcp/pull/41). Verified offline against the Bambu Studio 02.08.02.61 A1 and A1 mini machine profiles and a real A1 0.4 mm PLA job; that job was printed through Bambu Studio, not through this change.

## [1.1.23] – 2026-10-02

### Fixed
- Identify full-size A1 printers from serial prefix `039` and A1 mini printers from `030` in status, fresh MQTT safety checks, and the bundled parser. Correct routing fixtures and cover both models in fresh-install regressions; configured models still cannot override contradictory observed identity. Reported by [Steavie (@steavie)](https://github.com/steavie) in [#39](https://github.com/DMontgomery40/bambu-printer-mcp/issues/39). Verified with mocked reports and package installs; no physical print was run.

## [1.1.22] – 2026-09-30

### Fixed
- Date the published changelog by release version. The npm version hook moves pending notes into the new release section, and the GitHub Pages site reflects those versioned notes.

## [1.1.21] – 2026-09-30

### Fixed
- Accept fresh X2D identity reports when `model` identifies the printer but `model_id` contains an unrelated cloud print-job identifier. Unrecognized `model_id` values are no longer treated as printer declarations; the gate still requires another recognized observed model or returned serial, rejects recognized model conflicts and unknown values in actual model fields, and never falls back to configured identity. Reported with X2D firmware 01.02.00.00 status evidence in [#36](https://github.com/DMontgomery40/bambu-printer-mcp/issues/36) by JaviOFC. Covered by mocked safety regressions; no physical print was run.

## [1.1.20] – 2026-09-29

### Documentation
- Run the local code review before PR pushes to catch problems before GitHub Actions runs; retain GitHub Codex review and current-head CI as subsequent release gates.

### Fixed
- Accept P2S jobs sliced in Bambu Studio 02.08. The project settings store `printer_extruder_id` and `printer_extruder_variant` as per-variant tables (`["1","1","1"]` beside three `nozzle_type` rows), while the plate G-code header records the selected single-extruder values (`printer_extruder_id = 1`), so every such job failed with "unknown or malformed printer extruder id metadata". Table rows come only from the project settings; header values must have one entry per physical extruder, name each extruder in order, and match the selected variant, and contradictory ids, variants, or nozzle types still reject. Validate supplied variants even when every row uses the same nozzle material ([#33](https://github.com/DMontgomery40/bambu-printer-mcp/pull/33), by Izzy Mansurov (@sapoepsilon)).
- Accept `M145 P0`/`M145 P1` (airduct cooling/heating mode, no heater target) on the P2S, whose official start and end G-code emit it as the H2-series and X2D templates do. Other `M145` forms and models without a switchable airduct still reject. Verified offline against four real Bambu Studio 02.08.02.61 P2S 0.6 mm jobs (PLA and PETG) and mutated copies with an over-limit nozzle or chamber target, a parameterized `M145`, and contradictory extruder ids or nozzle types; no physical print was run for this change.

## [1.1.19] – 2026-09-29

### Documentation
- Make the local `code-review` skill run before each PR the review gate, instead of requesting Codex reviews, and forbid AI or agent attribution in commits, PRs, comments, and release notes.

## [1.1.18] – 2026-09-29

### Fixed
- Add `nozzle_type` (`stainless_steel`, `hardened_steel`, `tungsten_carbide`, `brass`; default `BAMBU_NOZZLE_TYPE`) to `slice_stl`, `slice_with_template`, and `print_3mf` auto-slicing, and write it into the resolved machine preset. Bambu machine presets assume the stock nozzle (stainless steel on P1S/P1P/A1), and the print gate compares the job with the printer's report, so a P1S with a hardened-steel nozzle could never print a CLI-sliced job. Found on the maintainer's P1S; covered here by fake-CLI and mocked MCP regressions. Ported from mcp-3D-printer-server.
- Report what the printer did after an MQTT print command instead of assuming success. `project_file` and `gcode_file` starts (checked `.3mf`, `.gcode.3mf`, and raw G-code) listen to the reports the printer pushes for up to `BAMBU_DISPATCH_CHECK_MS` (default 15000, 0–60000, 0 skips), take at most one full report if nothing arrives (no pushall polling on P1-series boards), and return `dispatch: "started"` or `"unconfirmed"`. A stop or heater-off during that window is reported instead of a started print. A new HMS 0500-0500-0001-0007 ("MQTT command verification failed" on firmware 01.08.05+ without LAN Only Mode and Developer Mode) fails the call with that explanation and says to clear the fatal entry (`clear_hms_errors` or the printer's screen), which otherwise blocks later prints; blocking HMS refusals now name their code; `print_3mf` now returns the adapter's result instead of a fixed "sent successfully" string. On the maintainer's P1S the firmware raised this HMS while the old code reported success; the regressions here use mocked MQTT reports, and no physical print was run for this change. The native X2D helper and FULU BambuNetwork bridge paths do not publish these MQTT commands and are unchanged.
- Refusals and printer rejections (nozzle mismatch, ambiguous nozzle reports, rejected commands, and "nothing was sent" safety stops) now suggest fixing the reported cause instead of "try again".

## [1.1.17] – 2026-09-29

### Fixed
- Keep machine settings in the selected machine preset. The Bambu-compatible CLI applies every key in every `--load-settings`/`--load-filaments` file, so a template 3MF's `project_settings`, a custom process JSON, or a custom filament JSON carrying another printer's `machine_start_gcode`, `printer_model`, or nozzle/bed values replaced the selected preset's settings. Every key the resolved machine preset defines, except profile metadata such as `name`, `inherits`, and `compatible_printers`, is now dropped from the process and filament files passed to the slicer, and the dropped keys are logged; the caller's files are not modified. OrcaSlicer applies its existing absolute-extrusion normalization (`use_relative_e_distances = 0`, no per-layer `G92 E0`) to the machine config as well, so the machine-owned extrusion mode and layer G-code stay absolute. With BambuStudio 02.01.01.52 on macOS, a P1S slice using a template whose start G-code carried a marker and whose `printer_model` named the X1 Carbon previously emitted the marker twice in `plate_1.gcode` with an X1 Carbon header; it now emits neither and keeps `; printer_model = Bambu Lab P1S`. None of the key sets of the installed stock BBL process and filament profiles overlaps a machine profile's, and all 32 installed stock model/nozzle presets load their default process and filament profiles unchanged. OrcaSlicer and FULU installations were not available for real-slicer verification, and no physical print was run. Ported from mcp-3D-printer-server.
- Wait ten minutes by default (`BAMBU_CONFIRMATION_TIMEOUT_MS`, 1000–3600000 ms; other values fall back to the default because Node clamps oversized timer delays to 1 ms) for human hardware confirmation and printer-model prompts instead of the MCP SDK's 60-second request limit, which a person walking to the printer to check the bed could exceed. An unanswered prompt is now reported as a timeout with nothing sent to the printer, instead of claiming the client lacks elicitation support and suggesting `BAMBU_REQUIRE_CONFIRMATION=0`; only a missing elicitation method or capability is reported as unsupported. Covered by MCP stdio regressions with delayed client answers and short configured timeouts; not exercised against a physical printer.
- Name unreadable or malformed profile files in "profile not found" errors so a corrupt profile tree is diagnosable instead of reported as a misspelled name.

## [1.1.16] – 2026-09-28

### Documentation
- Restore the published 1.1.14 and 1.1.15 release boundaries on the source changelog and generated GitHub Pages site instead of leaving shipped changes under `Unreleased`.

## [1.1.15] – 2026-09-28

### Fixed
- Keep printer file listings read-only and use the shared FTPS TLS-session options. Propagate connection and directory-listing failures instead of reporting empty or partial success; treat optional directories as absent only after a successful root listing ([#26](https://github.com/DMontgomery40/bambu-printer-mcp/pull/26), by Vail (@VailElla)).

## [1.1.14] – 2026-09-28

### Fixed
- Revalidate positive heating, resume, and confirmed hardware-error clearing immediately before native command dispatch; keep stop and heater-off available without preflight.
- Reject fractional AMS unit/slot addresses rather than truncating them to another physical address.
- Require fresh shared printer-state authorization after native connection setup and again before certificate-retry print dispatch.
- Select raw native metadata controls by the requested printer instead of the global default model.
- Preserve unknown observed printer identities in status instead of substituting the configured model.
- Validate and forward native upload plate, bed, project, and preset metadata; explicitly reject unsupported print options instead of silently ignoring them.
- Keep heater-off on the selected printer transport after model elicitation, including an overridden non-X2D serial.
- Interrupt pending native helpers on MCP cancellation, stop, and heater-off; wait for process exit before releasing snapshots, with bounded SIGKILL escalation when SIGTERM is ignored.
- Route X2D controls from the selected serial when the print model was elicited, without applying the configured X2D transport to an overridden printer.
- Preserve unit-local filament metadata tray IDs and absolute calibration tray IDs across multiple AMS units and AMS-HT; reject contradictory unit/slot mappings.
- Restrict public raw native controls to validated AMS metadata and calibration queries/selection; exclude motion, loading, heating, and safety-setting mutations.
- Add a macOS native build/test CI job while preserving the existing Linux test check.
- Remove machine-specific launchers and unused GUI automation from the upstream change and release archives.
- Resolve the model before selecting the X2D native route, including MCP model elicitation, and pass that resolved model through dispatch.
- Reject raw `ams_mapping2` overrides and missing/empty requested AMS mappings before dispatch; derive native mappings from checked structured tray assignments without silently selecting an external spool.
- Cover macOS and Linux control routing explicitly, and restrict native helper execution tests to supported hosts.
- Integrate X2D native prints, uploads, heaters, resume, and error clearing with the current shared file/state/confirmation checks. Preserve existing model routes and reject raw-control bypasses.
- Include only native source and build scripts in npm and desktop distributions; locate the optional compiled helper relative to the installed package and test fresh local, global, and npm-exec installations. Keep proprietary plug-ins and local binaries out of release archives.
- Resolve include-based installed templates and substitute current filament/hotend macro names in optional syntax regressions; do not assume a particular installed G383 variant.
- Retain VailElla's prior X2D eMMC/certificate investigation and hardware evidence. This follow-up uses mocked printer regressions and clean-install/build checks; it does not claim a new physical print.
- Include the printer host in FTPS TLS options so data connections resume the control session. basic-ftp wraps each data socket without a host, so Node can bind its resumable session to `localhost` instead of the printer host and printers requiring TLS session reuse replied `522 SSL connection failed: session reuse required` to every LIST, STOR and RETR. The contributor verifies successful upload, size check, and deletion on physical X2D USB storage; internal eMMC still refuses FTPS writes with `553`. Printing remains a separate check. `list_printer_files` still uses bambu-js's own FTP client and is not covered by this change.

## [1.1.13] – 2026-09-27

### Added
- Add shared print safety checks for declared model, nozzle, material, selected plate, and every supported heating command in the final printable file.
- Require fresh MQTT identity, nozzle configuration, ready state, and error checks before upload and dispatch; compare declared material with available mapped-spool reports.
- Preserve complete mixed dual-nozzle diameter metadata and accept explicit per-nozzle diameter requirements for pre-sliced direct and bridge jobs.
- Preserve the selected plate's used filament slots during all-nozzle warmup checks; temperature candidates do not create extra AMS mapping requirements.
- Apply independent printer/component and material temperature ceilings, reject nonfinite values before connecting, and require declared material for manual nozzle heating. Keep heater-off commands available.
- Inspect private file snapshots and use unique remote print names. Download and inspect remote G-code before starting a verified copy.
- Check the currently loaded material for manual heating and G-code-file dispatch, bind resume to an inspected paused job, and let stop/heater-off requests cancel pending operations before dispatch.
- Reject G-code-file starts and resumes when fresh telemetry explicitly reports an unloaded nozzle; preserve declared-material manual heating for loading filament.
- Register successful inspected BambuNetwork jobs for the same verified resume path, using unique submitted task identities.
- Reject ambiguous ZIP entries and bind the dispatched plate and checksum to inspected bytes; bound archive inspection and check every printable plate on upload-only requests, refusing noncanonical plate names and unrecognized G-code entries.
- Preserve existing remote files with unique upload names and destination collision checks; verify uploaded job model/nozzles against fresh printer reports.
- Add human print/heating preflight through MCP elicitation, mandatory finished-bed clearance, and confirmed hardware-error clearing with acknowledgment on the next print.
- Preserve cleared-error acknowledgment across failed print attempts until a checked dispatch succeeds. Release rejected bridge snapshots immediately and retain only files handed to an asynchronous upload.
- Validate H2D probing, wipe, and tool-change thermal commands and normalize GUI nozzle-variant tables. Apply a 260°C normal PLA ceiling with one narrowly bounded X1E startup-purge sequence; refuse explicit non-FFF jobs and recognized laser-enabling commands.
- Apply the checks to the optional BambuNetwork print wrapper and restrict raw bridge calls to named read-only probes. Require LAN telemetry even when the bridge submits through a cloud session.
- Require a single external-spool plate for legacy `.gcode.3mf` dispatch; use a `.3mf` project export when verified AMS mappings or plate selection are needed.
- Credit Boardy (@boardyai) for raising the nozzle-verification question and David Montgomery for the temperature and hardware-safety reports. Validation uses mocked printer boundaries; physical printer acceptance remains a separate check.
## [1.1.12] – 2026-09-27

### Documentation
- Publish a searchable documentation site on GitHub Pages at https://dmontgomery40.github.io/bambu-printer-mcp/. Pages are generated from the README, setup, slicing, and FULU guides, changelog, and contributor credits at build time, so the repository Markdown remains the single source.
- Keep README deep links working on the site with GitHub-compatible heading anchors. The site build fails on broken links, unknown anchors, or README content that no page publishes; pull requests build it without deploying.
- Add a large-image social card and per-page link-preview titles, descriptions, and canonical URLs for the site.
- Replace the outdated example commands with outcome-first requests: adapting a MakerWorld model, printing from a photo, and checking on a print by messaging an always-on agent from anywhere. Clarify which abilities come from the agent and which from this server.

## [1.1.11] – 2026-09-27

### Fixed
- Require the exact model/nozzle machine preset for FULU and Orca CLI slicing, including aliases and automatic slicing before printing. Reject missing or malformed presets before launching the slicer; process overrides cannot bypass the gate.
- Resolve FULU/Orca BBL inheritance and include templates, validate model CLI configuration, and preserve custom process settings and complete filament-slot mappings through the same preparation path as BambuStudio.
- Resolve inherited machine defaults before selecting process and filament profiles, including FULU's P1S family defaults.
- Preserve configured user directories for custom process/filament dependencies while keeping machine inheritance confined to the selected installation.
- Discover matching Orca/FULU profile trees beside the active executable and prevent fallback to another installation's bundled presets. Keep Orca extrusion normalization after inheritance resolution.
- Update agent setup guidance for the shared safety gate. Regression checks cover preparation and side-effect prevention; live FULU/Orca slicing and physical printing remain separate validation.

## [1.1.10] – 2026-09-27

### Documentation
- Restore prominent thanks to FULU Foundation, Louis Rossmann, and the OrcaSlicer-bambulab community, including the project's commitment to open-source software and cloud-free local printing.
- Add a dedicated FULU setup guide covering slicer/export and CLI use, Linux/WSL/macOS bridge configuration, cloud authentication, shared paths, probes, and validation limits.
- Replace manual README onboarding with one copy-and-paste agent setup request; move installation, environment variables, and LAN instructions into a linked setup reference. Treat code mode as optional.
- Document the existing FULU/Orca CLI missing-machine-preset safety limitation and direct users and setup agents to GUI-exported sliced projects until an equivalent validation gate ships.
- Make the README's major reference sections collapsible while keeping the FULU acknowledgment and agent setup request visible.
- Reorganize README navigation and correct stale client configuration, LAN/account requirements, firmware routing, AMS mapping, and bridge capability descriptions.

## [1.1.9] – 2026-09-27

### Added
- Recognize X2D (`N6`, serial prefix `20P`) for status, camera routing, and slicing with its own installed BambuStudio preset. Direct X2D printing remains deferred pending the native eMMC transport and stops before printer side effects. Contribution and hardware/status/slicing evidence: [#18](https://github.com/DMontgomery40/bambu-printer-mcp/pull/18), by Sebastian (@sebas1986).

### Fixed
- Give every CLI filament slot its own colour to address the multi-filament access violation reproduced by the contributor on Windows BambuStudio 02.08.02.60. Preserve explicit colours, input-project colours, and custom profile settings.
- Place an unset prime tower within the area shared by all nozzles, while retaining saved project positions and explicit process overrides.
- Apply required colour and tower overlays to standalone custom profiles without replacing unrelated settings.
- Correct the desktop-release workflow's Node setup cache option so extension packaging can run automatically.

## [1.1.8] – 2026-09-27

### Changed
- Consolidate shared agent rules for local and GitHub review, retain public documentation, and keep scratch plans, progress logs, and handoff notes out of Git.

### Added
- Connect to standard Blender MCP servers with tool discovery, schema-checked calls, timeouts/cancellation, and verified STL import/edit/export. Keep the custom-executable bridge available with explicit verification status.
- Package a Claude Desktop extension with prompted printer settings, safe staging, and synchronized release versions ([#11](https://github.com/DMontgomery40/bambu-printer-mcp/pull/11)).

### Fixed
- Validate large Blender STL meshes without boxing coordinate arrays, keeping finite-geometry checks within a bounded JavaScript heap.
- Preserve the selected bundled process preset identity through generated settings, and remove automatically created temporary roots on shutdown while retaining explicitly configured TEMP_DIR contents.
- Stop before printer uploads when automatic slicing or required profile preparation fails, preserving the original diagnostic. Validate model CLI configuration before flattening and advertise the required output path for standard Blender MCP edits.
- Apply the required printer dependency patch to the resolved installed package, including hoisted npm installations, and fail installation if it cannot be applied.
- Resolve CLI profile dependencies automatically and stop before slicing on incomplete profiles. Preserve custom overrides and filament-slot order, replace every declared 3MF slot for a single-profile override, discover platform-specific profile trees, and isolate concurrent config files.
- Point installation examples at `bambu-printer-mcp` and report the installed npm version in the MCP handshake.
- Create a private temporary directory per server instance, so desktop-extension startup does not depend on a writable working directory and concurrent printers cannot overwrite each other's default outputs.
- Resolve Bambu profile include templates so CLI slicing retains machine-specific G-code ([#16](https://github.com/DMontgomery40/bambu-printer-mcp/pull/16), reported in [#12](https://github.com/DMontgomery40/bambu-printer-mcp/issues/12)).
- Use the P2S project-file payload with its cache upload path while retaining legacy P1/X1 routes ([#15](https://github.com/DMontgomery40/bambu-printer-mcp/pull/15)).
- Start full-size A1 pre-sliced projects from the SD root via `project_file`, preserving other models' routes and all project filament mapping positions ([#14](https://github.com/DMontgomery40/bambu-printer-mcp/pull/14)).
- Keep H2C/H2D/H2S status connections alive when delayed OTA version messages arrive; recognize H2 serial prefixes, preserve unknown model identities, and accept unexpected status transitions without terminating the MQTT listener ([#7](https://github.com/DMontgomery40/bambu-printer-mcp/issues/7)).

### Security
- Refresh compatible transitive dependencies to resolve the nine npm audit findings in the previous lockfile; retain the pinned printer dependency patch.
- Per-call `slicer_path`, `ffmpeg_path`, and `bridge_command` executable selectors are now rejected by default. Trusted server-side environment configuration remains available, including `FFMPEG_PATH` for RTSP camera snapshots; set `MCP_ALLOW_EXECUTABLE_ARG=1` only when intentional per-call overrides are required. `MCP_ALLOW_BRIDGE_COMMAND_ARG` remains a compatibility alias for `bridge_command` only.

### Added
- **X2D model support** — `BAMBU_MODEL=x2d` is accepted by validation, elicitation, tool schemas, BambuStudio preset mapping, filament profile resolution, RTSP camera routing, and the dual-nozzle H2-family `project_file`/`ams_mapping2` print path. The X2D model ID `N6` is recognized when reported by the printer.

## [1.1.3] – 2026-05-31

### Added
- **H2C model support** — `BAMBU_MODEL=h2c` is now accepted by validation, elicitation, tool schemas, BambuStudio preset mapping, filament profile resolution, and the H2 project-file print path. H2C should not use `h2d` as a fallback; the explicit model is required for safe slicer preset selection and H2 AMS mapping behavior.

## [1.1.1] – 2026-04-29

### Fixed
- **`auto_match_ams` now handles same-SKU different-color filaments.** Previously the matcher keyed only on `tray_info_idx`, so a 3MF needing two GFG02 (PETG HF) trays — one black, one white — would error out as "could not find loaded AMS trays for: GFG02, GFG02" even when both were present. The matcher now joins on `(tray_info_idx, tray_color)` (RGB-normalized; alpha bytes ignored) and tracks already-claimed slots so two requirements can't collapse onto the same physical slot. Falls back to SKU-only matching when the 3MF carries no color or only one tray of that SKU is loaded. Returns a structured `missing` report with reasons (`no_loaded_match` / `color_mismatch` / `exhausted` / `no_sku`) when resolution fails.
- **`get_printer_filaments` retries when AMS data hasn't arrived yet.** The first MQTT push from an idle printer is sparse (model/modules only); AMS data arrives on a second push that often misses the 500ms settle window in `waitForInitialReport()`. Adds a 1.5s retry in `getResolvedPrinterFilamentInventory()` when trays are empty, matching the same retry pattern already used by the HMS resource handler. Validated on Parker H2S (4 loaded trays, all profiles resolved) and Kingpin H2D (no AMS connected — accepted gracefully).
- **HMS resource retries when first status push has no HMS data.** Same root cause — the first MQTT push is sparse (model/modules only); HMS/error fields arrive on a subsequent push. Added 1.5s settle-and-retry in the `printer://{host}/hms` resource handler. Validated on Parker H2S and Kingpin H2D: both returned `hms_errors: 1` (`code: 131099`).

### Added
- **`set_ams_drying` tool** — start or stop the AMS filament drying cycle on heated AMS units (AMS Pro / AMS-HT). Sends `print.ams_control` MQTT command with `start_drying`/`stop_drying` param. Includes input validation (action must be start/stop, ams_id must be 0-3) and 4 new unit tests covering validation and correct command payload shape.
- **`scripts/validate-printer.mjs`** — reusable MCP-over-stdio validation harness that tests HMS resource, set_light, set_fan_speed, set_airduct_mode, clear_hms_errors, get_printer_status, and get_printer_filaments against a live printer. Spawns the MCP server as a child process, sends JSON-RPC messages over stdin/stdout, reports pass/fail per test.
- **`PrinterFilamentInventory` now includes `summary`, `profile_resolution`, `match_confidence`, and `display_name`.** Each tray entry carries a resolution tier (`exact-model-nozzle` / `model` / `generic` / `unresolved`) and a human-readable display name combining sub-brand, type, and color. Top-level `summary` object reports loaded/resolved/empty slot counts and a recommended slot with a human-readable reason. Helps callers make informed `auto_match_ams` decisions without reading raw MQTT status.
- **`scripts/build-charm-3mf.mjs`** — constructs a multi-object source `.3mf` from two STLs (body + face/detail). Volume-based body/face detection (signed-tetrahedron sum, robust to OpenSCAD's uniform facet density). Inline meshes in `3D/3dmodel.model`, per-object `<metadata key="extruder" value="N"/>` in `Metadata/model_settings.config`, plate-level `filament_maps` for H2D dual-extruder routing. Carries `project_settings.config` from a known-good template 3MF. Output is a valid Bambu source project that the CLI parses cleanly; only the upstream slicer-setup SIGSEGV blocks it from being end-to-end useful today.

### Changed
- **Validation script now tests `get_printer_filaments`.** `scripts/validate-printer.mjs` added as test 8 with live tray output. Also fixed the AMS inspection in the `get_printer_status` test to read the correct raw structure (`data.ams.ams` array) instead of the nonexistent `.trays` path. Accepts "no AMS connected" as a valid printer state.

### Known issues
- **Multi-color CLI slicing is blocked upstream.** BambuStudio CLI 02.06.00.51 SIGSEGVs in `load_nozzle_infos_with_compatibility` for any H2D dual-extruder, multi-color project, regardless of input geometry. Verified via a two-cube minimal repro and filed as [bambulab/BambuStudio#10408](https://github.com/bambulab/BambuStudio/issues/10408). Workaround until upstream ships a fix: pre-slice in Bambu Studio GUI and hand the resulting `.gcode.3mf` to `print_3mf`. The dispatch path is fully functional. `scripts/build-charm-3mf.mjs` is ready to drive the CLI once #10408 lands.

## [1.1.0] – 2026-04-27

### Added
- **BambuStudio CLI auto-flatten** (`BAMBU_CLI_FLATTEN=true`): walks the BBL profile `inherits` chain and emits CLI-ready configs, working around upstream BambuStudio issues [#9636](https://github.com/bambulab/BambuStudio/issues/9636) and [#9968](https://github.com/bambulab/BambuStudio/issues/9968). Verified on H2S, H2D, X1C, P1S.
- **pause_print / resume_print** tools — MQTT pause and resume alongside the existing cancel_print.
- **AMS RFID slot resolution** — `resolve_3mf_ams_slots` dry-run tool matches sliced 3MF filament requirements against live AMS inventory; opt-in `auto_match_ams` flag on `print_3mf`.
- **HMS diagnostics resource** — `printer://{host}/hms` MCP resource for read-only HMS error summary.
- **set_light / set_fan_speed** — MQTT wrappers for chamber light and fan speed control.
- **skip_objects** — list object IDs from a sliced 3MF plate (`list_3mf_plate_objects`) and skip them during a running print (`skip_objects`).
- **Utility controls** — `set_print_speed`, `set_airduct_mode`, `clear_hms_errors`, `reread_ams_rfid`.
- **Bed-aware slicing** — `bed_type` parameter on `slice_stl` and `print_3mf` maps to BambuStudio CLI `--bed-type`.
- **Collar charm wrapper** (`print_collar_charm`) — fixed tray policy for two-colour dog collar charm projects.
- **delete_printer_file** — destructive FTPS DELETE with `confirm:true` gate, allowlist on `cache/`, `timelapse/`, `logs/`, and explicit rejection of `..` segments.
- **camera_snapshot** — capture a single JPEG from the printer's chamber camera. Two transports wired in:
  - **TCP-on-6000** (per OpenBambuAPI `video.md`) for **A1, A1 mini, P1S, P1P**.
  - **RTSPS via ffmpeg** (`rtsps://bblp:<token>@<host>:322/streaming/live/1`) for **X1, X1 Carbon, X1E, P2S** and **H2, H2S, H2D, H2C, H2D Pro**. Verified live against Parker (H2S), Kingpin (H2D), and an X1C — all return real chamber JPEGs in ~1.5s. The H2 series was not documented upstream; local investigation established the RTSP path.
  - Response includes a `transport` field so callers can tell which path produced the frame.
  - `experimental` flag from interim work is now a no-op (kept on the schema for compatibility).
  - Requires `ffmpeg` in `PATH` for the RTSP path; `ffmpeg_path` argument allows override.

### Fixed
- BambuStudio `--load-machine` flag replaced with the correct flag; 3MF inputs now accepted by `get_stl_info`.
- **H2/H2D mapping safety** — `print_3mf` now fails fast on H2 series pre-sliced jobs with declared filaments unless one of `ams_slots`, raw `ams_mapping`, or `auto_match_ams: true` is provided. Avoids sending an under-specified `project_file` that the printer accepts but does not visibly start. For H2/H2D, the embedded `slicerConfig.ams_mapping` parsed from the 3MF is no longer trusted (stale-metadata risk). Regression test locks in the recovered working H2 mapping shape.
- **SuperTack on CLI slicing** — `supertack_plate` is accepted on the pre-sliced print path (the only verified case) but rejected fast on the BambuStudio CLI auto-slice path because the CLI bed identifier is unverified and earlier attempts produced gcode that fell back to Cool Plate.

## [1.0.5] – prior release

Initial public release with core print, upload, slice, and status tooling.

[1.1.3]: https://github.com/DMontgomery40/bambu-printer-mcp/commit/d9742202bd931bf8ca39a348713efa6ef05f784c
[1.1.1]: https://github.com/DMontgomery40/bambu-printer-mcp/tree/v1.1.1
[1.1.0]: https://github.com/DMontgomery40/bambu-printer-mcp/commit/29b8ec4565ec4dd0858e14441b4fe1cd1d4d45a0
[1.0.5]: https://github.com/DMontgomery40/bambu-printer-mcp/tree/v1.0.5

[1.1.9]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.9
[1.1.8]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.8
[1.1.10]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.10
[1.1.12]: https://github.com/DMontgomery40/bambu-printer-mcp/releases/tag/v1.1.12
