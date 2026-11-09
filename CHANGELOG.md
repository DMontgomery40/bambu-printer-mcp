# Changelog

## [1.1.80] – 2026-11-09

### Security

- The streamable-http transport refuses requests whose Host header is not a loopback name, the bind address or an `MCP_HTTP_ALLOWED_HOSTS` entry, which blocks DNS rebinding from web pages. Without `MCP_HTTP_ALLOWED_ORIGINS`, it also refuses browser origins on other hosts, including the opaque `null` origin and app schemes; list those origins to keep them. A server bound to a specific non-loopback address that browsers reach by another name or IP needs that name in `MCP_HTTP_ALLOWED_HOSTS`. A wildcard bind (`0.0.0.0` or `::`) without `MCP_HTTP_ALLOWED_HOSTS` keeps accepting any Host and warns on stderr
- A malformed Host header gets 400 instead of crashing the HTTP server, and a failing request gets 500 instead of ending the process

## [1.1.79] – 2026-11-08

### Fixed

- Drain FULU events after a polling sleep crosses the delivery deadline so a queued printer reply is read before disconnecting. Validated with mocked hosts under CPU load; no physical printer was used.

## [1.1.78] – 2026-11-07

### Fixed

- Accept OrcaSlicer 2.5.0 dual-nozzle slices whose `nozzle_volume_type` contains one shared value. Resolve it only when the selected plate explicitly declares both physical extruder ids, types and matching nozzle variants; missing or conflicting selections still fail. This fixes the “unknown or malformed nozzle flow metadata” rejection reproduced with the official macOS build on H2C and X2D. The original output files pass inspection after the fix, with nozzle mapping and independent heater/material limits preserved. No physical print was run.

## [1.1.77] – 2026-11-07

### Fixed

- A large `print_3mf` upload to a P1S no longer fails with "Timeout (data socket)" when the printer's SD card pauses mid-file. The upload now waits up to 120 s for the printer to take more data. FTP commands keep their 15 s limit, so a printer that has really stopped is still reported. On Nov 6 an 18.4 MB plate stopped at 13,287,424 bytes for more than the 15 s limit 1.1.74 used for the upload. Checked with a local FTP server that pauses for twice the command timeout partway through a 12 MB file: it now completes with the exact bytes, and fails with only the command limit. The live check of an 18.4 MB upload to the P1S is recorded at release.

### Added

- `print_3mf` reports its LAN upload as MCP progress (counterpart/1) when the call has a progress token: `progress` is bytes sent, `total` the file's bytes, and `_meta["counterpart/stage"]` is `"upload"`, at most once per whole percent. Until now a client saw nothing between requesting the print and its result, so nobody could tell how far a failed upload got. Checked with unit tests and a local FTP server.

## [1.1.76] – 2026-11-06

### Added

- `fusion_mcp_status` reports `activeDesign` when Fusion is connected: whether a design is open, read from the Fusion360MCP add-in itself. It calls the add-in's read-only `get_design_type`, which reads the active document's Design product the way every design command does (`_design()`, `addon/server/command_handler.py:310-332` and `:3555-3563` at the pinned `86a3016a5a5b`). Success means a design is open. The add-in's own error kind `NO_ACTIVE_DESIGN` (`addon/server/hints.py:17-19`, rendered as `**get_design_type** ERROR (NO_ACTIVE_DESIGN)` by `src/fusion360_mcp/server.py:122`) means none is: Fusion is on its Home tab, and the pinned add-in refuses every design command, `fusion_mcp_new_design` included, until one is open (faust issue #12). Any other answer leaves `activeDesign` out (unknown). Clients such as Counterpart read this field instead of matching Fusion's error wording. Checked with the bridge's fake Fusion MCP: an open design, no design, another error, and the add-in not answering. Not run against a live Fusion.

## [1.1.75] – 2026-11-06

### Fixed

- `list_3mf_plates` no longer leaves out a painted filament when a part's mesh is too large to read. A mesh over 64 MiB, or past 256 MiB read in total, used to be taken as unpainted, so a filament painted on it could go unlisted. Such a plate now lists every filament the project declares and says `filaments_complete: false`, so a client offers a spare row rather than miss one that prints. Every other plate says `filaments_complete: true`. A sliced plate is unaffected, even when it shares the unread mesh with an unsliced plate, because Studio's own `plate_N.json` names its filaments. Checked with unit tests for the one-file and the total limit.

## [1.1.74] – 2026-11-06

### Fixed

- `print_3mf` and every other FTPS upload no longer fail a multi-megabyte job with "Timeout (data socket)" while it is still uploading. `ftpUpload` handed the whole file to basic-ftp as one write (`Readable.from(buffer)`). basic-ftp's `TransferWatchdog` counts progress by the data socket's `bytesWritten`, which takes in a single write all at once, so while a P1S stored the file at SD-card speed the count never moved and the upload was declared stalled after 15 s. The bytes are now written in 64 KiB pieces, so progress is seen as the printer takes them; an upload still fails after 15 s if the printer stops taking data. When the upload of a `print_3mf` job fails, the error now carries `code: "printer-upload-failed"` (counterpart/1), so a client knows no print command was sent: Counterpart had marked the failed base plate as "could not confirm a print start". Counterpart's 4.6 MB scan rig base plate failed this way on a P1S, and the same 4.6 MB upload of a scratch file reproduced it (a 1 KB upload worked). Checked with a local FTP server that stores at 4 MB/s against basic-ftp 6.2.3 and 6.2.6: a single write times out, the pieces arrive intact, and a server that stops reading still times out.

## [1.1.73] – 2026-11-06

### Fixed

- `list_3mf_plates` gives each plate its `filaments`: the project filaments that plate prints with, and only those, with each one's colour, material, filament id and the first part using it (counterpart/1). Clients asked people to choose spools for every filament any plate used: on the Kass 3D scan rig's Screws plate, which prints only filament 3, Counterpart also asked for filaments 1 and 2 from other plates. A sliced plate uses Studio's own `plate_N.json` `filament_ids`. An unsliced plate is worked out as Bambu Studio's CLI does (`PartPlate::get_extruders_under_cli`, `PartPlate.cpp:1298-1420`; `ModelVolume::get_extruders`, `Model.cpp:3357-3412`): each part's filament, its painted facets, including meshes a component keeps in the root model (a component without `p:path`, `bbs_3mf.cpp:4131-4148`) (decoded as `TriangleSelector::deserialize` reads them, `TriangleSelector.cpp:2111-2139`), feature filaments, support and raft filaments, layer ranges and the plate's tool changes. A mixed filament counts as the filaments it mixes (`PartPlate.cpp:1437-1449`). Feature filaments and support follow what the slice applies rather than Studio's plate list where the two differ: a part that names no extruder prints with the project's wall, sparse and solid infill filaments, a part's or object's feature filament counts whether or not `separate_filaments_for_features` is set (`PrintObject.cpp:3105-3150`; libslic3r never reads that key), and support and raft resolve one setting at a time, the object's own else the project's (`PrintObject.cpp:3052-3063`), with support filament 0 following the object (`Print.cpp:490-501`). Negative parts, support blockers and enforcers, copies that aren't printable (checked per copy, as each build item carries its own flag: `bbs_3mf.cpp:4183-4185`, `PartPlate.cpp:1311-1322`) and other plates don't count; a mesh too large to read is taken as unpainted rather than failing the listing. Checked against two projects written by Bambu Studio 02.08.02.61's CLI on a Mac (two plates, three filaments; sliced and unsliced give the same answer as Studio's own slice) and the scan rig's metadata.
- `print_3mf` sends a tray only for the filaments the plate prints and -1 for every other project filament, on the LAN and plug-in routes, as Bambu Studio does (`SelectMachineDialog::get_ams_mapping_result`, `SelectMachine.cpp:1463-1500`). A caller's project-level `ams_mapping` with trays for unused filaments was sent as it was. Checked with unit tests; no printer contacted.

## [1.1.72] – 2026-11-06

### Fixed

- `pause_at_layers` keeps a project's own colour changes and pauses. Bambu Studio saves them in `Metadata/custom_gcode_per_layer.xml` (02.08.02.61 `bbs_3mf.cpp:184`), not `custom_gcode_per_print_z.xml`, so they were never read. `--load-custom-gcodes` replaces the project's whole map (`BambuStudio.cpp:4005-4008`), so a requested pause on a designer's file dropped its colour changes and pauses. They are now merged in. Without a pause request nothing is passed: the CLI keeps the project's own entries itself. A pause on a project with more than one plate needs `slice_plate` (`print_3mf` uses the plate it prints), because the CLI carries custom G-code for one plate only. Checked on a Mac with Bambu Studio 02.08.02.61: a project saved with a colour change at 0.6 mm and a pause at 1.0 mm, sliced with a pause before layer 8, kept all three. Slicing only; nothing was printed.
- Print safety no longer refuses every Engineering Plate job as "contradictory bed type metadata". Studio writes `eng_plate` in `plate_N.json` and `Engineering Plate` in the project settings (`PrintConfig.hpp:437-456`, `PrintConfig.cpp:437-445`). Every Studio name and token for each of its five plates now reads as one plate. Checked with a real Bambu Studio 02.08.02.61 Engineering Plate slice, which 1.1.70 refused.
- An AMS-HT after the first is addressed as its own unit. Tray 129 is `{ams_id: 129, slot_id: 0}`, as Bambu Studio maps it (`DevFilaSystem.cpp:367-368`, `SelectMachine.cpp:1489-1497`), instead of slot 1 of unit 128, which doesn't exist. The fresh-state check finds that unit's tray the same way. Checked with unit tests; no printer contacted.
- When a slice fails without a usable result.json, the exit code is explained for every code Bambu Studio defines (`libslic3r/Utils.hpp:21-75`, 50 codes; 20 before), for example -66 (filaments can't be assigned to the nozzles) and -68 (a filament the nozzle can't print). A test checks the table against Utils.hpp.
- `list_3mf_plate_objects` lists every copy on the plate with its own identify_id from `slice_info.config`, as Bambu Studio's skip dialog does (`PartSkipDialog.cpp:734-741`). It no longer pairs `plate_N.json` boxes with ids by position: with copies, the lists differ in length, and those boxes carry internal object ids the printer doesn't know. It never offers the wipe tower, and a file without slice_info, or a plate that wasn't sliced, is refused instead of falling back to internal ids. It also reports `labelObjectEnabled` and each copy's `skipped` state. Checked with Bambu Studio's own slices: three CLI copies (identify_ids 15, 26, 37; box ids 50, 51, 52) and a 20-copy GUI plate.

### Changed

- `supertack_plate` slices as Studio's own `Supertack Plate` bed type. Checked on a Mac with Bambu Studio 02.08.02.61: the slice's `plate_1.json` says `supertack_plate`, the project says `Supertack Plate`, and the start G-code heats the bed to the filament's SuperTack temperature (45 °C for PLA). Slicing only; nothing was printed. OrcaSlicer takes the same name but wasn't sliced with it.
- `slice_stl`'s `skip_objects` takes identify_ids, which the CLI matches against each object copy (`BambuStudio.cpp:6530-6545`), not positions. `list_3mf_plates` gives each plate's `instances`: every object copy with its `identify_id` from `model_settings.config`.

## [1.1.71] – 2026-11-06

### Changed

- Pin the optional Linux X2D networking plug-in to Bambu Studio 02.09.01.70’s agent 02.09.01.54 after checking its offered archive and required library SHA-256 values, public certificates and matching native-helper `PrintParams` layout. Existing Linux X2D installations rerun `bambu-printer-mcp-native-setup` after the package update. Offline 0.4 mm single-PLA slices for all twelve supported models pass file inspection; this does not verify other multi-material jobs, Linux plug-in loading or physical printing. H3C remains unsupported.
- Require future printer-model and MCP-contract changes to be checked against Scan to Make’s Mac, iPhone/iPad, Android and Linux clients, with changes made only where the contract affects a client.

## [1.1.70] – 2026-11-06

### Fixed

- Slices that run at the same time no longer read each other's files. Each local Bambu Studio or OrcaSlicer slice writes into its own folder, `TEMP_DIR/slices/<operation>/`, with its own sliced 3MF and result.json. Before, every slice of a model named `model.3mf` wrote `TEMP_DIR/model_sliced.3mf` and `TEMP_DIR/result.json`, and each run deleted the result.json the others were about to read. Bambu Studio's CLI also writes each plate's G-code to `plate_<n>.gcode` in that folder before packing it into the 3MF, so one slice could pack another's G-code. Counterpart's Print sheet started four slices of one plate at once on Nov 6, and a refused slice could report a neighbour's success, or a success a neighbour's refusal. Generated profile files are written whole and renamed into place, so a running slice never reads one half-written. A slice's folder is kept for a day, then a later slice removes it; a failed or cancelled slice's folder is removed at once. Identical slices are still reused from the slice cache. Checked with a stand-in slicer: four overlapping slices of same-named models each return their own file and result.json.
- A cancelled `slice_stl` call stops its slicer. When the MCP client cancels the request (a Print sheet that moved on to newer settings), the slicer process is killed and nothing is kept for reuse, instead of finishing a slice nobody reads. Checked with a stand-in slicer: its process is gone after the cancel.

## [1.1.69] – 2026-11-06

### Added

- `list_3mf_plates` lists a designer's 3MF plates as Bambu Studio shows them before slicing: index, name, the objects on each plate, whether the plate is already sliced, and optionally the plate's own preview from the file. Clients show a kit's plates from here instead of reading `Metadata/model_settings.config` themselves (Counterpart PRD §8.0 item 9). Checked with unit tests and real Bambu Studio projects.

### Fixed

- File inspection accepts Bambu Studio's skip-object marker when its base64 object mask happens to read like a command (`M624 /g8C/B8AAAA=` contains `g8`). A multi-object plate with such a mask was refused as "multiple commands on one line", so it got no estimate or preview and couldn't be printed. Only the exact one-token `M624 <base64>` form is exempt; anything after the mask is still refused. Checked with inspection tests and a 37-part plate's G-code from Bambu Studio 02.09.

### Changed

- A slicer's refusal reaches a person as a plain sentence. `slicer_report.message`, and the start of a failed `slice_stl`'s text, say what is wrong. Bambu Studio's and OrcaSlicer's empty-plate, off-plate, too-tall, too-large and outside-the-printable-area refusals are matched on their own strings, and so are PrusaSlicer's and CuraEngine's. The slicer's words stay in the new `slicer_report.slicer_message` for logs, and a failure without a result.json carries a `slicer_report` too. A failure of the setup (no slicer, a crash, no output file) keeps this server's own words, which say what to fix. A successful slice's warnings are unchanged in `message`. Checked with unit tests and a stand-in slicer.

## [1.1.68] – 2026-11-06

### Added

- `fdm_slicing`, a design prompt next to `fdm_design`: how this server's configured slicer orients a model and generates supports, and how to check a choice with a checkpoint `slice_stl` (read `slicer_result`; set `orient`, and always set `enable_support`, since leaving it out applies the preset's own setting). The text follows `SLICER_TYPE`: Bambu Studio and OrcaSlicer say their auto-orient keeps overhang area low and does not check cantilevers; PrusaSlicer, Cura and Slic3r say they don't orient here and take no support settings from `slice_stl`, so supports follow the configured profile. Counterpart wrote this into its own design prompt; it now comes from the MCP that knows its slicer. Checked with the server's prompt tests.
- `BAMBU_NETWORK_BRIDGE_IMAGE` runs FULU's Linux host in a Docker image, with `BAMBU_NETWORK_BRIDGE_DOCKER`, `BAMBU_NETWORK_BRIDGE_DOCKER_HOST` and an optional Colima profile (`BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE`, `_HOME`, `BAMBU_NETWORK_BRIDGE_COLIMA`) that is started, never restarted, when Docker doesn't answer. The server mounts its own agent config folder and certificate folder at the same paths, so the host can always open them, and writes each print's checked snapshot inside the config folder (Colima shares the home folder, not `/tmp` or `/var/folders`). It replaces a hand-written launcher script that mounted another MCP's config folder, which made FULU through mcp-3D-printer-server abort. A Colima profile without `BAMBU_NETWORK_BRIDGE_DOCKER_HOST` uses that profile's own socket; a config folder reached through a symlink is mounted at the path the host is given, and a relative config or certificate folder is made absolute before it is mounted or sent; snapshots a killed server left behind are removed after a day. Concurrent calls on a cold bridge start one container. The container runs with `--init` and a name of its own and is stopped and removed when the bridge or the server stops, before the server waits for the docker client, whose wait is now bounded (a descendant still holding the pipes is let go of): with a shell as its first process, the host ignored the stop signal and kept running. Checked with a stand-in `docker` and `colima` running the fake FULU host, and on a Mac against the real FULU host image in its own container through mcp-3D-printer-server's identical code: the agent started and wrote its logs and certificates to the server's folder, and no container was left afterwards. No print was sent through it.

## [1.1.67] – 2026-11-06

### Added

- `blender_mcp_setup` checks the MCP for Blender add-on that the configured bridge needs, when it is the `mcp-for-blender` (or `blender-mcp`) package run with `uvx`: the add-on file Blender loads (for the running Blender's version), its protocol and the one the package expects, whether Blender is listening and the running add-on's own `get_addon_status`. It changes nothing. With `update: true` it stages the add-on with the package's own `install-addon` at the inspected version, refuses an installed file that isn't a regular local MCP for Blender add-on or a staged one with another protocol, keeps the old file as a backup next to it and renames the new one into place. It never starts, stops or edits Blender. A handshake that can't be read is reported as `live_error` with the rest of the check. Overlapping updates run one after the other, and a cancelled request stops its installer and changes nothing more (in `fusion_mcp_setup` too). Its subprocesses (uvx and the package) get only the login environment and uv's and Blender's settings, never printer access codes or other server secrets. When the add-on can't be checked or updated here it says what to do in `message`. `uvx.exe` counts as uvx on Windows. Both tools declare remote scope `read` for a check and `raw` for `update` or `install`, so no paired device gains the change. The running Blender's version folder is found in Blender's macOS, Windows and Linux (`~/.config/blender`) layouts. Another bridge reports `supported: false`. Counterpart did this itself; it now comes from the MCP that runs the bridge. Checked with a stand-in `uvx` and temporary add-on folders, and the check against the real package (2.2.7) and Blender 5.0 add-on on a Mac; no add-on was replaced there.
- `fusion_mcp_setup` checks, and with `install: true` installs on macOS, what the Fusion bridge needs: the Fusion360MCP add-in at the pinned commit (every file checked against its SHA-256; a symlink, an extra file or a changed byte installs nothing) set to run on startup, a login item that gives Fusion `FUSION_MCP_PORT` (installed only when launchd has it loaded), and this server's missing `FUSION_MCP_*` settings, added to its own `.env` after a copy of it. A `FUSION_MCP_*` setting the process has or the `.env` gives a value is never rewritten (an empty one, as `.env.example` leaves `FUSION_MCP_COMMAND`, is filled in), so a configured command or chosen arguments stay, and an add-in already at the pin is left in place. Without a `.env` it still installs the add-in and the login item and reports `env: "no-env-file"`, with `ready` false until the settings are added. It reports whether Fusion is installed, says in `message` what is missing when it isn't ready, and never starts or quits it. Counterpart's Mac app did this itself. Checked with a synthetic pinned archive and a recording `launchctl`; on a Mac, the check reported the real setup ready and a real install from the pinned GitHub archive into a temporary home folder succeeded and then found everything current.

### Changed

- The Fusion bridge's default server and the add-in `fusion_mcp_setup` installs are pinned to one commit, `86a3016a5a5b` of DMontgomery40/fusion360-mcp-server: faust-machines' server and add-in with the document binding `fusion_mcp_new_design`'s `bind_document` needs, while that change is reviewed upstream. Before, the default arguments named faust-machines `19b9f1e95192`, whose add-in has no `new_document`, while Counterpart installed the fork. A server configured with only `FUSION_MCP_COMMAND` now runs the fork; one with its own `FUSION_MCP_ARGS` is unchanged.

## [1.1.66] – 2026-11-05

### Fixed

- Every extraction of a 3MF's process settings for slicing gets its own temporary directory, removed when the tool call that made it ends. 1.1.59 named them by content, so two slices of the same project at once still wrote one file, and a write could truncate the file the other slice was reading; nothing removed them either. The path `get_slice_settings` returns stays, named by content and written whole before it is renamed into place. Checked with concurrent extraction tests and a stand-in slicer.

### Changed

- `get_slice_settings` on a 3MF with no slicer settings returns `raw_key_count` 0 (and no `extracted_settings_path`) instead of an error, so a client can tell a file with no settings to keep from one that couldn't be read. A file that isn't a readable 3MF, or whose settings file is there but can't be parsed, is still an error. Counterpart refuses an edit of a designer's 3MF when it can't read the designer's settings, and needs this to allow edits of a 3MF that has none.

## [1.1.65] – 2026-11-05

### Changed

- `get_slice_settings`' `own_process` answers for the slice a client would make. With `source_path`, the call also takes that slice's `slicer_profile`, `template_name` (its template), `template_3mf_path`, `layer_height`, `wall_loops`, `sparse_infill_density`, `enable_support`, `support_type`, `quality` and `strength`, as `slice_stl` takes them, with its `nozzle_diameter` to check layer heights against. `own_process` is true only when that slice prints the process the 3MF carries, unchanged. A named profile or template replaces the process; an explicit value or a quality or strength other than standard changes it. Clients then pass their own configuration through instead of deciding which settings replace a designer's process. Checked with a stand-in slicer.

## [1.1.64] – 2026-11-05

### Added

- Every tool declares in `_meta["counterpart/remote"]` how a client that offers this server to other devices (Counterpart's remote endpoint) may expose it: `scope`, the least device scope that may call it (read, design, control, print, raw); `raisedBy`, a boolean argument that needs more (`fusion_mcp_status` `launch`, `blender_mcp_status` `connect`); and `arguments`, the names this server's configuration chooses (`config`, or `config-top` for the top-level printer `type`: the printer it targets, its credentials, hardware and programs) and the local files it reads (`path`) or writes (`output`). A tool that forwards an open object (an RPC payload, another server's tool arguments) declares every configuration name. A new tool or argument is classed here, with no Counterpart release. A script compared every listed tool's declaration with Counterpart's hand classification (main `1b66d937`) and found no difference in scope or argument kind, so no paired device gains or loses a tool; the tests check every listed tool has one and hold the name floors. Checked by listing the tools over stdio; no printer.
- Every slice this server runs with the Bambu Studio or OrcaSlicer CLI (`slice_stl`, `slice_with_template`, `print_3mf`'s auto-slice) keeps each finished slice, and slicing the same model the same way again restores it instead of running the slicer: Print Again, or printing a model a client just estimated, no longer waits for the slicer. A slice is identified by exactly what the slicer was given: its executable (path, size and modification time, so a slicer update slices again), this server's version, and its full argument list with every input file (model, profiles, filaments, generated overrides) replaced by its content hash, so editing any of them slices again. A run whose arguments name any other folder is never kept, nor is a failed slice; every check after the slicer still runs on a restored slice. The newest 16 are kept in `~/.cache/<package>/slices`; `SLICE_CACHE=off` turns it off, `SLICE_CACHE_DIR` and `SLICE_CACHE_ENTRIES` move and size it. Counterpart kept its own copy of this keyed on the server's `.env`; it can now rely on the server. Presets the slicer finds by itself rather than through its arguments count only through its executable (a slicer update slices again). Checked with a stand-in slicer across a server restart; no real slicer.
- `inspect_print_file` returns `sliced`: the selected plate's `estimate` (`seconds`, `grams`, from the slicer's own slice_info.config) and `settings` (`layer_height_mm`, `sparse_infill_percent`, `wall_loops`, `layer_count`, from the 3MF's project settings and plate G-code, or a G-code file's own comments), and the file's `plate_count`. Slicing tools return `slicer_report` beside `slicer_result`: `failed`, `message` (the slicer's error and every plate warning, verbatim) and `plate_count`, on success and on a failed slice. Clients such as Counterpart read these instead of parsing slicer files themselves. Checked with synthetic 3MF and G-code files and recorded Bambu Studio result.json files.

## [1.1.63] – 2026-11-05

### Added

- `counterpart_discover_printers` finds Bambu printers on the local network from their own SSDP announcements, with serial, model (as `bambu_model` names it), name and firmware. It never connects to a printer. Checked with captured announcement packets; not run against the P1S's live announcements.
- `counterpart_setup_fields` lists the `.env` settings this server reads for a printer (address, serial, model, access code), with labels, hints, the model choices and the model each serial prefix names; older alias names this server reads first are listed so a client writing a setting removes them. Clients such as Counterpart offer printer setup from it instead of copying this server's model tables. It also reports the slicer this server would run (`slicer`: type, path, whether it is there, and the Bambu profiles folder) with the `SLICER_TYPE`, `SLICER_PATH` and `BAMBU_PROFILES_ROOT` fields, required only when what they default to is missing, so a client can say "Bambu Studio isn't installed" or ask where it is instead of the person editing paths by hand.
- `counterpart_propose_filaments` proposes which loaded spool prints each part's colour before slicing, with an explicit verdict per part: a colour that isn't loaded says so ("White isn't loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.") instead of quietly printing another colour. A colour that is loaded but not chosen (on the other feed, in another material, or on a spool another colour already prints from) says which. It checks a person's chosen spools against what is loaded now and maps painted slots; a sliced file's painted materials count when it chooses the feed. Each spool carries the filament `profile` `slice_stl` takes, so a client slices from the same read, and an AMS-HT spool is numbered as `print_3mf` takes it (its unit id, 128 and up). Checked against the P1S's AMS and the caliper card's filaments as read on Nov 5; not printed.
- `get_printer_filaments` trays carry `label` ("A2") and `spool_name` ("Sunflower Yellow PLA Basic"), from Bambu Studio's own colour names.

## [1.1.62] – 2026-11-05

### Added

- `get_slice_settings` on a 3MF returns `own_process`: true when the file carries its own process (a designer's Bambu Studio or Orca project), so `slice_stl` and `print_3mf`'s auto-slice slice it with that process unless the call names `slicer_profile`, `template_name` or `template_3mf_path`. It calls the same function those tools use, so a client can show that a designer's file prints with the designer's settings, and leave quality and strength at standard, without reading the 3MF itself. Counterpart's print sheet carried the last print's quality and strength over to a copy of a designer's 3MF, where they changed its layer height, walls or infill. Checked with a stand-in slicer.

## [1.1.61] – 2026-11-05

### Fixed

- `inspect_print_file`'s preview leaves out filament-change flushing only between a material-switch `M620 S…` and its `M621 S…`. Setup forms such as the H2C start template's `M620 O1` no longer hide everything printed after them, which left a one-filament H2C job with no preview. Checked with synthetic G-code.

## [1.1.60] – 2026-11-05

### Added

- `inspect_print_file` takes `include_preview`: it then also returns `preview`, two PNG pictures drawn from the exact file's G-code, with that file's `artifact_sha256`. Every extruding line on the selected plate is drawn in its filament's colour at its extrusion width, including arcs (I/J or R, full circles too), without the start-up purge and prime lines or Bambu's filament-change flushing (M620 to M621). Features are read from Bambu Studio/Orca `; FEATURE:` and PrusaSlicer/Cura `;TYPE:` comments; G-code naming none is drawn whole. The first view is the top as it sits on the bed; the second is the bed side, turned over toward you so text on that face reads as it will. It never uses the plate thumbnails a sliced file carries: Bambu Studio's CLI copies a project's old plate PNGs into the sliced file unchanged, so they can show a part that isn't the one printing. Off by default, because the pictures are tens of KB of base64; it is meant for apps that show the person what will print, such as Counterpart's print sheet. On a designer's caliper card sliced on Nov 4, the preview shows the ruler ticks and vernier scale missing from the G-code, which is the defect that print had. Checked with synthetic G-code and with real Bambu Studio 2.8.2 sliced files.

## [1.1.59] – 2026-11-05

### Fixed

- A template's or project's process settings extract to a file named by their content, so two projects sliced at once can't overwrite each other's settings and slice with the wrong layer height, walls or infill. Checked with a concurrent extraction test.
- A 3MF that carries its own process settings (a designer's Bambu Studio or Orca project) now slices with them: `slice_stl` and `print_3mf`'s auto-slice on every print route (LAN, Bambu cloud and native) take its layer height, walls, infill and the rest of its process unless the call names `slicer_profile`, `template_name` or `template_3mf_path`. A configured default profile or template used to replace them. The machine still comes from `bambu_model` and the nozzle, so a project made for another printer can't bring its machine settings along. A 3MF with no process of its own, such as one from `counterpart_make_3mf`, still slices with the preset. Found when a designer's fold-and-snap caliper card (0.16 mm layers, 100% infill) was printed at the preset's values and no longer folded. Checked with a stand-in slicer. On Bambu Studio 2.8.2, that designer's file sliced through this same route (its own file as `template_3mf_path`) kept 0.16 mm, 100% infill, 2 walls and 6 top and 4 bottom layers, where the default route gave the preset's 0.2 mm and 15%.
- `strength` `strong` and `max` only raise walls and infill: a process that already has more walls or denser infill keeps them. Strong used to write 4 walls and 25% infill as given, which lowered that caliper card's 100% infill. An explicit `wall_loops` or `sparse_infill_density` is still written as given. Checked with a stand-in slicer only.

## [1.1.58] – 2026-11-04

### Added

- `counterpart_printer_info` reports `capabilities.slicing`: whether `slice_stl` can apply supports, copies (`repetitions`) and auto-orient with this server's slicer. The Bambu Studio and OrcaSlicer CLIs take all three; remote `orca-slicer-api` takes supports and orient but makes no copies; PrusaSlicer, Slic3r and Cura take none. `slice_stl` with `repetitions` above 1 on a backend that can't make copies now says so and slices nothing, instead of slicing one copy without a word. Clients such as Counterpart offer those choices from this instead of knowing which slicers accept what. Checked with mocked transports only.

## [1.1.57] – 2026-11-04

### Added

- A printer refusal on `print_3mf` carries a stable `code` in its structured error: `printer-command-rejected` when the printer refuses the print command itself (Bambu HMS 0500-0500-0001-0007, MQTT command verification; the file is on the printer, nothing is printing), and `printer-not-ready` when the printer isn't in a state that can start a print. The message and suggestion are unchanged. Clients such as Counterpart can act on the code instead of matching the wording, which changes with printers and firmware. Checked with mocked MQTT only.

## [1.1.56] – 2026-11-04

### Added

- `slice_stl` takes `quality` (`draft`, `standard`, `fine`) and `strength` (`standard`, `strong`, `max`). The server turns them into the slicer's own settings: Draft and Fine set the layer height for the nozzle in use (0.28 and 0.12 mm on a 0.4 mm nozzle, scaled with it), Strong and Max set walls and infill (4 walls at 25%, 6 at 40%), and Standard leaves the resolved preset alone. An explicit `layer_height`, `wall_loops` or `sparse_infill_density` still wins. Clients such as Counterpart can now send the person's choice instead of carrying slicer numbers. Checked with stand-in slicers only.

## [1.1.55] – 2026-11-04

### Changed

- With no method given, a FULU print over Bambu Cloud goes the way Bambu Studio sends it to a cloud-bound printer it can reach on the LAN (`PrintJob.cpp`): `start_local_print_with_record`, which uploads to the printer over the LAN and records the task in the account, in the account's cloud session. When that fails before the print command (the plug-in's `-2010` to `-2140` preparation results, other than a missing or oversized file), the same checked job goes once through `start_print`, with the printer checked again first. Any other failure may have reached the printer and is not sent again. A printer that reports no storage goes straight to `start_print`, as in Studio. An explicit `bambu_network_method` is sent as given, as before. On a P1S with firmware 01.10.00.00, `start_print` alone returns `-3120`, HTTP 403 "internal blocking", every time. Errors name `-2120`, `-2130` and `-3120`. Checked with the stand-in host and intercepted transports only; not yet on a printer.

## [1.1.54] – 2026-11-04

### Added

- `slice_stl` takes `enable_support`, `support_type` (`normal(auto)`, `tree(auto)`, `normal(manual)`, `tree(manual)`) and `support_threshold_angle`, written over the resolved process preset like `layer_height` and `wall_loops`. Bambu-compatible slicers only. Checked with the installed Bambu Studio 02.08.02.61 on a T-shaped overhang: the sliced project carries the requested values, and Studio reports `support_used` true with supports on and false with them off. No printer was involved.

## [1.1.53] – 2026-11-04

### Added

- Every tool now declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), taken from what it actually does to the printer, files and other apps. One table in `src/tool-annotations.ts` holds them, and a test fails if a listed tool has none. Clients can use the hints to decide which tools to offer or confirm. Counterpart's remote endpoint will use them for per-device scopes. They are hints, not a safety gate: every print and control still runs the server's own checks.

## [1.1.52] – 2026-11-04

### Changed

- Print, heating and resume start without a prompt; clearing hardware errors and resuming a file that could not be re-read still ask a person. The client's own Print button is the yes, and the printer runs its own checks. The first print after a hardware clear still asks that the cleared causes are resolved. The `BAMBU_REQUIRE_CONFIRMATION` setting is removed and ignored if set.

### Fixed

- Keep authenticated FULU Pause, Resume and Stop request IDs as strings in Studio's 20000–29999 window, with a shared counter across LAN, cloud and retries that wraps inside the window. A cloud-bound P1S 01.10 rejects larger IDs with 0502400A even when their signatures are valid. Preserve reply correlation and the delivery hold; remove guidance claiming controls require Studio/Handy or Developer Mode. Automated regressions cover both transports and wraparound; hardware validation is limited to the maintainer's P1S.

- One connection decision for print and control: `cancel_print`, `pause_print` and `resume_print` now use `BAMBU_DEFAULT_CONNECTION_MODE` (and the new `BAMBU_DEFAULT_CONNECTION_TYPE`) exactly as `print_3mf` does. Before, a server configured for FULU printed through the authenticated bridge but sent Stop and Pause as plain MQTT, which protected firmware rejects with HMS 0500_0500_0001_0007. Pause and Resume now travel the authenticated FULU LAN session like Stop. A FULU cloud route refuses controls instead of sending plain MQTT.

- Authenticated LAN controls (Stop, Pause, Resume) wait briefly for FULU's certificate message but no longer refuse to send without it: on the real P1S it never arrived and Stop sent nothing. A synchronous SEND_MSG_FAILED (-4) or LP_PUBLISH_MSG_FAILED (-4030) means nothing was sent, so the certificate is reinstalled and the control tried again, up to three times, as the native X2D helper does; any other return is final. Each control's FULU events and sends are written to `control-trace.log` in the bridge config folder, without access codes.

- Send Stop through the selected authenticated FULU LAN bridge on non-native printers. A protected P1S no longer receives an unsigned MQTT stop after an authenticated print. Bridge failures remain errors; no unauthenticated fallback or automatic replay is used.

- Preserve Fusion tool text, images and genuine structured results without synthesizing an empty structured reply that hides modeling feedback in clients.

- Support document-bound Fusion design passes: return an isolated document identity, optionally import an F3D revision into a new document, and preserve the identity across every modeling/export subcall. Older bridges fail closed when binding is requested; existing unbound callers remain compatible. Requires a configured Fusion bridge/add-in that advertises the binding protocol.

- Slice multiple STL copies with Bambu Studio's `--clone-objects`, matching the existing Orca route. Bambu rejects `--repetitions` greater than one with the default all-plates slice. Keep selected-plate 3MF repetitions unchanged and reject competing STL copy counts. The output retains every generated plate; each `print_3mf` call still prints only its selected plate.

- Accept Bambu Studio 2.9 layer-temperature changes (`M104 M S<temperature>` with an optional `T` selector). Keep hardware and material temperature ceilings, tool validation, and rejection of numeric markers, other heater commands and extra parameters. Reproduced with isolated Studio 02.09.01.70 P1S single- and two-colour slices; no physical print was run.

- An X2D job on FULU's LAN or cloud route is paused, resumed and stopped through that route, even when the native plug-in is installed; other X2D controls keep the native route. `counterpart_print_route` keeps an X2D's native local route (implicit or configured) available after choosing Developer Mode or Bambu Cloud, and choosing the local network returns to it. Tested with simulated transports; no X2D hardware was used.

### Added

- Bundle the pinned native camera runtimes for supported desktop platforms in the generic MCPB extension; verify extracted release startup and JPEG processing on Linux, macOS and Windows before attaching the release asset.

- Add `camera_stream_start`, `camera_frame`, and `camera_stream_stop`: one camera connection per watched printer (host and serial together), bounded long-poll reads, native 32×18 change detection, and viewer-sized JPEGs with an optional encoded-byte budget. A1/P1 reuse the existing TLS frame decoder; RTSP models use one ffmpeg MJPEG process. Idle and MCP shutdown close owned resources; `camera_snapshot` reuses an active stream.
- Advertise the additive `capabilities.cameraStream` flag while keeping the existing camera transport field compatible. The implementation adapts the parked camera manager's contract with bounded native image processing and stable unchanged cursors.
- Validate stream lifecycle, decoder/authentication reuse, RTSP process shutdown, concurrent waiters, resize, and actual MCP tool discovery with simulated transports. Real-device and sustained CPU/bandwidth acceptance are recorded separately; no physical-print behavior changes.

- Serves design guidance for agents that design or edit models to print as MCP prompts: `fdm_design`, `fdm_multicolor`, `fdm_assembly` and `fdm_after_slice`, plus the resource `guidance://fdm/capability-guidance` for bridges and overhangs. The server's `instructions` point every client to them. The text is David Montgomery's FDM design prompt pack of 3 November 2026, unchanged. mcp-3D-printer-server serves the same guidance. Tested over a real stdio MCP connection; whether an agent follows it is a model behavior, not tested here.

## [1.1.51] – 2026-11-02

### Fixed

- `lay_flat` rests a model on a face that is its real bottom. Before, it turned the face-normal group with the largest area to face down and moved the lowest point to Z=0, without checking that those faces were the lowest. The stove gap filler from Scan to Make (six T strips) printed upside down: its cap undersides' 23,838 mm² face down but sit 12 mm above the fin tips, so it stood on its fins. Bambu Studio warned that it "has floating cantilever".
  - A pose qualifies only when some face, turned down, lies on the rotated model's lowest plane, within 0.5% of its height and at most 0.2 mm. The candidate poses are the 64 largest face groups and the model's six axes, so a domed part can flip exactly.
  - Among qualifying poses, `lay_flat` picks the one with the least part and support volume per mm² of bed contact. Support is the overhang more than 45° from vertical, times its height above the bed. Ties go to the larger contact, then to the face that already points down.
  - When no pose qualifies, the model is unchanged. The text result is still the STL path, and the new `structuredContent` `{path, laid_flat, message}` says why.
  - The gap filler now comes out cap-down, fin tips 14.4 mm up. Bambu Studio 02.08.02.61 slices it for a P1S 0.4 with return code 0 and no warning. The fin-down pose gave the floating-cantilever warning. That check runs on macOS where Bambu Studio is installed; CI skips it.
- `slice_stl` returns Bambu Studio's and OrcaSlicer's own checks. When the CLI writes `result.json` (Bambu Studio 02.08.02.61 writes it on macOS on success too), `structuredContent.slicer_result` carries it parsed and unchanged: `error_string`, `return_code` and each `sliced_plates[].warning_message`. Before, `slice_stl` returned only the path and dropped warnings such as "It seems object … has floating cantilever. Please re-orient the object or enable support generation."
  - The text result stays the sliced file's path.
  - A failed slice is an error result whose text starts with Studio's `error_string` (unless it reports success), then each plate's `warning_message`, then the exit code and command output. Its `structuredContent` carries `slicer_result` too. Before, the text began "Error: Slicer failed: …" and the warnings were lost.
  - A `result.json` reporting a nonzero `return_code` fails the slice even when the CLI exits 0.
  - Auto-slicing in `print_3mf` and `slice_with_template` fail the same way: Studio's words first, with `slicer_result` in the error's `structuredContent`.
  - When the Bambu CLI writes no `result.json`, the server says so on stderr.
  - Slicers that write no `result.json` (PrusaSlicer, Cura, Slic3r, the remote OrcaSlicer API) return `structuredContent` `{path}` only.
  - Tested with real `result.json` files from Bambu Studio 02.08.02.61 slicing the Scan to Make stove gap filler for a P1S, and with the installed Studio CLI on macOS (skipped in CI).

## [1.1.50] – 2026-11-02

### Fixed

- `fusion_mcp_status` reports the Fusion360MCP add-in as reachable. The pinned add-in answers a ping on its fast path with `{"ok":true,"status":"pong"}`, and the bridge accepted only `{"pong":true}`, so it reported `connected: false` with a running add-in.
- Send the print options Bambu Studio's Send dialog sends, on every print route: the BambuNetwork bridge, the native helper and LAN `project_file`. Before, the bridge sent its own defaults: for a P1S, vibration calibration on, first-layer inspection off, flow calibration on, and `auto_bed_leveling`, `auto_flow_cali`, `auto_offset_cali` 0 and `extruder_cali_manual_mode` -1. Each option the caller doesn't set now resolves as Studio 02.08.02.61 resolves it (`SelectMachine.cpp:3344-3356`, `load_option_vals`):
  - the value the user saved in Studio's `BambuStudio.conf` for that printer type, if the printer offers it;
  - else "auto" if offered, else "on".

  Vibration calibration is off and first-layer inspection on, as Studio hard-codes them; `extruder_cali_manual_mode` is 0. For a P1S that is `task_bed_leveling: true`, `auto_bed_leveling: 1`, `task_flow_cali: false`, `auto_flow_cali: 2`, `auto_offset_cali: 2`. An explicit option still wins. `BAMBU_STUDIO_CONFIG` overrides the config path; empty means none.
- `counterpart_print_progress` shows text for HMS and `print_error` codes the bundled tables lack, such as the P1S's `0300_0D00_0002_0001`. It reads it from the user's own Bambu Studio download: `hms_en_<serial prefix>.json`, then `hms_en.json`, in the `hms` folder next to `BambuStudio.conf`. The pinned Studio tag bundles no P1, X1 or A1 table. Bambu's files are read, never copied, and their text is passed through unchanged.
- `cancel_print` sends Bambu Studio's stop, `{"print":{"command":"stop","param":"","sequence_id":"<n>"}}`, at MQTT QoS 1 (`MachineObject::command_task_abort`), and waits up to 10 s for the printer's acknowledgement. Before, bambu-node sent the stop without `param`, at QoS 0. A stop that isn't acknowledged fails and closes its MQTT client, so it can't be sent late.

## [1.1.49] – 2026-11-02

### Removed

- Remove the last bed-clearance wording. The hardware-error clear prompt no longer mentions removing obstructions, and the rules and README no longer describe a bed check. The printer detects an occupied bed itself during bed leveling; print confirmations keep their spool and file checks.

## [1.1.48] – 2026-11-02

### Added
- Add the Counterpart contract (`counterpart/1`) shared with mcp-3D-printer-server. Each tool declares an `outputSchema` and returns `structuredContent` plus the same JSON as text, whatever `MCP_HTTP_JSON_RESPONSE` says. Errors from these tools are text only, because MCP SDK 1.32 clients validate `structuredContent` against the schema even on errors.
  - `counterpart_printer_info`: server name and version, the configured printer, and its progress, camera, filament and control capabilities, with no printer traffic.
  - `counterpart_print_progress`: state, job, stage words, temperatures, active filament and problems, read from the MQTT reports the server already keeps. A held session sends nothing to the printer. PushAll is sent only to fill an empty cache, and at most once every five minutes for a printer that has been quiet that long. An unreachable printer reports `offline` within 8 seconds instead of waiting on the MQTT reconnect. Time left converts minutes to seconds. A `FAILED` job with `0300400C` is `cancelled`. HMS entries become `AAAA_BBBB_CCCC_DDDD` problems with Bambu's severity, English text and page link, and `print_error` becomes 8 hex digits.
  - `counterpart_make_3mf`: combines STL parts into one 3MF assembly. Each part keeps its position and its own filament, so it slices as one multi-colour print.
- Generate `src/safety/hms-messages.ts` and `src/printers/bambu-stages.ts` with `scripts/generate-hms-messages.mjs`, from the same pinned Bambu Studio v02.08.02.61 tables and commit as `hidden-hms.ts`. Bambu bundles no P1S, X1 or A1 table at that tag, so those printers get the text the bundled tables share; that covers about 98% of the HMS codes in the P1S table Bambu Studio downloads.
- Add `layer_height`, `wall_loops` and `sparse_infill_density` to `slice_stl`. They are written as a process override on top of the resolved machine and process preset, on every Bambu-compatible route including remote slicing. PrusaSlicer, Slic3r and Cura refuse them.
- Return `subtaskName` from `print_3mf` when it starts a 3MF with the LAN `project_file` command, and `taskId` on H2 and P2S. These are the values sent as `subtask_name`/`task_id`, so clients can match a progress report to their own print. Pre-sliced `.gcode.3mf` files on P1, X1 and A1 mini, and the X2D native, BambuNetwork and Bambu Connect routes, don't return them yet.
- Add an optional Autodesk Fusion bridge through [faust-machines/fusion360-mcp-server](https://github.com/faust-machines/fusion360-mcp-server), pinned to commit `19b9f1e95192` and configured with `FUSION_MCP_COMMAND`, `FUSION_MCP_ARGS`, `FUSION_MCP_TIMEOUT_MS` and `FUSION_MCP_HOST`.
  - `fusion_mcp_status` reports whether Fusion is configured, running and reachable; `launch: true` starts it on macOS and waits up to 90 s for the add-in. The add-in counts as reachable only when it answers its own ping, so Blender's MCP add-on on the add-in's default port (9876) isn't mistaken for Fusion. The port defaults to 9877 (PRD §8.9), and the bridge passes `FUSION_MCP_PORT` to the faust server and, with `launch: true`, to Fusion through `open --env`, so the add-in listens where the bridge probes.
  - `fusion_mcp_call` passes a call through to a discovered Fusion tool, the same contract as `blender_mcp_call`.
  - `fusion_mcp_new_design` opens a new parametric design.
  - `fusion_mcp_export` writes `<name>.stl`, `<name>.f3d` and `<name>.parameters.json` together, never overwriting a file. It exports only a visible solid body whose name no other body shares (`export_stl` takes the first match, hidden or not), and returns the STL's `boundingBox`, the body's `fusionSizeMm`, the `stlUnits` read from comparing the two, and `warnings` when the STL isn't in millimetres.

  The stdio session stays open across calls. A timeout or cancellation closes it, and an interrupted call is never replayed. The child process gets only `FUSION_*` settings. At that commit the add-in refuses every command until some design is open (faust issue #12), so after Fusion starts at its Home tab a design must be opened once by hand. Verified with a stdio fixture shaped like the pinned server; no live Fusion was available.

### Changed
- `resume_print` is checked like a print start. It asks a person through elicitation (`BAMBU_REQUIRE_CONFIRMATION=0` skips the prompt) and reads the printer again after the prompt. First, it downloads the job's file over FTPS and compares its SHA-256 with the inspected bytes; a different file refuses and retires the job. A P1S removes an uploaded project once it starts printing and keeps the extracted `cache/<name>_plate_<n>.gcode`, which a live P1S showed to be byte-identical to the 3MF's plate G-code. That file is compared with the inspected plate instead. The resume record must still be current at dispatch. Cancel ends it, and so does a report that the job ended after it was seen running, or another job in its place. The server watches every MQTT report it receives, so a later job with the same name, such as a touchscreen reprint, is never resumed. The result adds `jobName` and `bytesVerified`. On the BambuNetwork and X2D native routes, where Bambu's plug-in places the file, a file that can't be read back is matched by its unique name with `bytesVerified: false`, and that resume always asks a person, even with `BAMBU_REQUIRE_CONFIRMATION=0`.
- `counterpart_print_progress` reports a raw G-code job's `name` as the basename of `gcode_file`. Raw G-code prints return that basename as `jobName`, so the two can be compared.
- `slice_stl` refuses `load_filament_ids` for 3MF input with an explanation. Bambu Studio's CLI rejects that combination itself with only "invalid parameters".

Verified with a real Bambu Studio 02.08.02.61 slice of a two-part stacked assembly on the P1S preset. The slice used two filaments, kept the parts together and applied 0.12 mm / 4 walls / 25%, and `inspect_print_file` accepted it. Read-only live `counterpart_printer_info` and `counterpart_print_progress` calls against a P1S passed the client's schema validation. No print was started.

## [1.1.47] – 2026-11-02

- Remove the separate bed-clearance prompt from print preflight, including after completed and eligible failed jobs. Continue checking printer job identity and state before dispatch.

## [1.1.46] – 2026-11-01

### Fixed
- Allow scoped P1S recovery from a named previous FAILED job that explicitly reports idle, zero print error and an empty HMS list. Require human bed-clearance confirmation bound to that same job even in headless mode; preserve fresh identity, nozzle, filament and temperature checks. No error reset is sent. Matches Bambu Studio 2.8.2.61’s finished-job classification; validated with offline readiness and job-bound clearance regressions, with physical print verification pending.

## [1.1.45] – 2026-11-01

### Fixed
- Accept official H2C time-lapse and mid-print filament-change commands from Bambu Studio: bounded `M9711` captures, `M620.14` tower coordinates during a selected filament change, and `M620.15 P` incoming-filament pre-cooling. Preserve exact parameter, model, coordinate and independent material/hardware temperature checks. Reported and diagnosed by [billh-hub](https://github.com/billh-hub) in [#84](https://github.com/DMontgomery40/bambu-printer-mcp/issues/84), checked against pinned Studio 2.7/2.8 sources, offline regressions and an actual isolated Studio 2.8.2.61 two-colour H2C slice; no physical print was run.

## [1.1.44] – 2026-11-01

### Fixed
- Resolve a relative `TEMP_DIR` such as `./temp` against the server's working directory at startup. BambuStudio 2.8.2.61 fails every 3MF export to a relative `--outputdir` ("Failed exporting 3mf files", return code -13), so slicing and auto-slicing before a print always failed with that setting. Relative `BAMBU_PROFILES_ROOT`, `BAMBU_SLICER_PROFILE_DIRS`, `load_filaments`, process profile and model paths also reach BambuStudio and Orca CLIs as absolute paths, and tools such as `slice_stl` and `lay_flat` return absolute output paths. Verified with a real BambuStudio 2.8.2.61 slice on macOS with `TEMP_DIR=./temp` and a regression that records the CLI arguments; no print was started.

## [1.1.43] – 2026-10-31

### Fixed
- Resolve H2C first-layer temperatures from Bambu Studio’s per-variant project tables using the selected plate’s filament indices and variants. Single-filament jobs with the official three-variant PLA preset now pass inspection; distinct temperatures and multiple filaments retain their own mappings, header agreement and independent thermal ceilings. Missing or ambiguous mappings still reject. Reported by [Steve Pritchard (sjpritchard)](https://github.com/sjpritchard) in [#81](https://github.com/DMontgomery40/bambu-printer-mcp/issues/81). Verified with an isolated Bambu Studio 2.8.2.61 H2C cube slice and offline regressions; no physical print was run.

## [1.1.42] – 2026-10-31

### Documentation
- Remove invented "no printer contact" agent rules from the Made to Fit scan-to-print PRD. Clarify that hosted design sandboxes expose fit tools only while print, slice, and control go through `bambu-printer-mcp` on bridge, phone, or any MCP client with AGENTS.md safety gates—not a repo-wide ban on agents reaching printers.

## [1.1.41] – 2026-10-30

### Fixed
- Keep already-horizontal faces eligible when `lay_flat` chooses the largest flat face. Thin plates previously stood on an edge, because faces pointing straight up or down were excluded; they now rest on their broad face at Z=0, including after repeated calls. When up- and down-facing areas tie exactly, as for a plate with a raised block or lettering, keep the face that already points down so a seated part is not flipped. Ported from mcp-3d-printer-server 1.2.20 with its regressions for horizontal, upside-down, edge-on, tilted and raised-block plates; generated STL geometry only, no printer is used.

### Tests
- Check native upload progress in MCP wire order, avoiding the client SDK callback race when progress and the final response arrive in one read.

### Documentation
- Add the Made to Fit scan-to-print proposal and reproducible cost model ([#51](https://github.com/DMontgomery40/bambu-printer-mcp/pull/51)). Make remix delivery probability explicit, reject unknown compute kinds, and require Fit Key coverage of the full measurement interval before reducing uncertainty. The proposal is repository documentation only; nothing in it is built.

## [1.1.40] – 2026-10-30

### Fixed
- Recheck the confirmed job and hardware-error codes after acquiring the MQTT connection, immediately before clearing errors on any printer model. Refuse dispatch if either changes during the connection wait; retain unchanged-job clearing and the native helper's dispatch checks. Contributed by [JackCA](https://github.com/JackCA) in [#76](https://github.com/DMontgomery40/bambu-printer-mcp/pull/76), with mocked P1S and X2D regressions.
- Let a freshly observed X2D task canceled with `fail_reason: 0300400C`, `print_error: 0`, and a reported job name/file reach checked print preparation. Keep other failures and active HMS errors blocked. Treat this terminal job like `FINISH`: require a person to confirm removal of the previous parts and debris, even when ordinary headless prompts are disabled, then recheck the same job after confirmation and at native dispatch. Do not send speculative error-dialog reset commands. Bind hardware-error clearing to the job observed before its confirmation so a different job cannot reuse approval. Reported with read-only X2D telemetry and contributed by [JackCA](https://github.com/JackCA) in [#76](https://github.com/DMontgomery40/bambu-printer-mcp/pull/76), with mocked printer/native-helper regressions; physical print delivery after this change remains unverified.

### Dependencies
- Refresh the installation lock to `@hono/node-server` 2.1.5 for GHSA-rmxm-3fg6-px4f, as in mcp-3d-printer-server 1.2.18. The advisory affects only `serveStatic`, which this server does not use. The lock controls the desktop extension bundle and source installs; npm installs on Node.js 20 or newer already resolve 2.1.5. The documented and tested runtime remains Node.js 24.

## [1.1.39] – 2026-10-30

### Fixed
- Accept `h2dpro` as a selectable printer model. The safety, identity and file-inspection layers already distinguished the H2D Pro (serial prefix `239`, model id `O1E`) from the H2D and reject an `h2d` request against a fresh H2D Pro identity, but every tool schema, model elicitation list and preset table omitted `h2dpro`, so an H2D Pro could not be selected for inspection, slicing, heating or printing at all. Tool schemas and elicitation now offer `h2dpro`, slicing resolves the exact `Bambu Lab H2D Pro <nozzle> nozzle` machine preset, filament lookup prefers the `@BBL H2DP` presets, and the H2 print branch includes it. Offline regressions cover MCP inspection, exact machine-preset selection, missing-preset rejection and mocked external-spool dispatch; no physical H2D Pro print is claimed.

## [1.1.38] – 2026-10-27

### Fixed
- Accept OrcaSlicer's `M620.17 T0|1 S<target> L-1` preheat for an unused H2D or H2D Pro nozzle. Single-filament H2D jobs previously stopped with "position -1 has no declared material". As for X2D, check the target against the model's hardware limit and every declared material without selecting a fictitious filament; invalid nozzle indices, other negative positions and extra parameters still reject. Reported and diagnosed by [ZombieLurker](https://github.com/ZombieLurker) in [#73](https://github.com/DMontgomery40/bambu-printer-mcp/issues/73), and verified against the pinned official OrcaSlicer 2.4.2 H2D/H2D Pro machine profiles and offline regressions. No physical printer test is claimed.

## [1.1.37] – 2026-10-26

### Documentation
- Show the documentation site's social card directly below the README title and link it to the site.

## [1.1.36] – 2026-10-26

### Documentation
- Link the upstream reports for FULU's Linux host, each reproduced against its v1.0.0 runtime:
  - the runtime omits Bambu's `printer.cer`, so LAN connections fail ([FULU #52](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/52); a connect-only P1S test failed as shipped and connected with `printer.cer` added);
  - it segfaults on `connect_printer`, `disconnect_printer` or `destroy_agent` before a certificate folder is set ([FULU #53](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/53));
  - it aborts when `create_agent` gets a log folder that doesn't exist ([FULU #54](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/54));
  - it aborts when its input closes after an agent exists ([FULU #55](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/55)).
  The server already works around the first three; the fourth can only follow an abrupt server exit and doesn't affect prints.
- Link the proposed fixes for FULU's CLI crash, [FULU #56](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/56) and [FULU #57](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/57). With both, a patched macOS arm64 build answers `--help` and slices a P1S cube; FULU v1.0.0 crashes on both.
- Credit OrcaSlicer's fix for the 2.4.2 `PartPlate::check_outside` CLI crash: [OrcaSlicer #14415](https://github.com/OrcaSlicer/OrcaSlicer/pull/14415) by packerlschupfer, released in 2.5.0-alpha. The STL transform workaround stays while 2.4.2 is the latest stable release; FULU's CLI has the same crash until it takes that fix.

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
