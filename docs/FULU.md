# FULU setup: open-source slicing and printer connections

[Back to README](../README.md) · [Slicing and model routing](./SLICING.md) · [Contributors](../CONTRIBUTORS.md)

We support **[FULU Foundation](https://www.fulu.org/), Louis Rossmann, and the [OrcaSlicer-bambulab community](https://github.com/FULU-Foundation/OrcaSlicer-bambulab)**. Owners should be free to repair their printers, choose open-source software, and print without a vendor cloud. That commitment belongs alongside the setup instructions, not just in a credits footer.

## Choose your workflow

| Workflow | What you need | Bambu software/services in the print path |
|---|---|---|
| **FULU GUI export → MCP direct LAN** | FULU slicer, sliced project, printer IP/serial/access code, supported LAN firmware | No Bambu Studio, Bambu Connect, or Bambu Cloud required by this workflow |
| **FULU BambuNetwork bridge, LAN** | Separately installed bridge host/runtime, local credentials, shared file access | Uses Bambu's networking libraries through FULU's bridge |
| **FULU BambuNetwork bridge, cloud** | Bridge runtime, internet access, authenticated BambuNetwork session, device ID | Still uses Bambu's networking libraries and cloud services |

The first workflow is the place to start if you want to skip Bambu's software and cloud for slicing and printing. The hardware is still a Bambu printer, with model- and firmware-specific capabilities. This repository does not replace printer firmware or add other manufacturers' printer adapters.

Setting `SLICER_TYPE=orcaslicer-bambulab` selects a slicer; it does **not** activate BambuNetwork, log in, or change the default `print_3mf` transport. Bridge printing is explicitly selected with `print_3mf_bambu_network` or `print_3mf` plus `connection_mode: "bambu_network"`.

## Start with FULU export and direct LAN

1. Obtain FULU OrcaSlicer-bambulab from its [upstream project and installation instructions](https://github.com/FULU-Foundation/OrcaSlicer-bambulab#installation). Follow the instructions for your build and operating system; the MCP npm package does not contain the slicer or its networking runtime.
2. Enable the printer's [LAN / Developer Mode settings](./SETUP.md#enabling-developer-mode-for-direct-lan) for direct third-party control. Record its IP, serial number, and LAN access code.
3. [Install the MCP](./SETUP.md#installation) and configure your client using the [client configuration example](./SETUP.md#mcp-client-configuration). At minimum, set the following in the **server's** environment, replacing the sample values:

```env
PRINTER_HOST=192.168.1.100
BAMBU_SERIAL=YOUR_PRINTER_SERIAL
BAMBU_TOKEN=YOUR_LAN_ACCESS_CODE
BAMBU_MODEL=p1s
```

4. In FULU, select the exact printer, nozzle, bed, and loaded filaments. Slice, inspect the preview, and export the **sliced plate** as `.gcode.3mf`, not an unsliced project. See [the slicing recipe](./SLICING.md#slicing-recipe-fulu-orcaslicer-or-bambu-studio).
5. Call `get_printer_status` first. When ready to print, call `print_3mf` with the exported file and the correct material selection. For a single-filament plate using AMS tray 2:

```json
{
  "three_mf_path": "/absolute/path/bracket.gcode.3mf",
  "bambu_model": "p1s",
  "ams_slots": [2],
  "use_ams": true
}
```

For an external spool, follow the [no-AMS guidance](../README.md#printing-without-ams). H2 jobs with declared filaments still need the positional mapping described in [`print_3mf`](../README.md#print_3mf). Inspect printer status and HMS errors after submission; command acceptance and actual printing are different checks.

**X2D:** status and slicing with its own preset are supported. Direct X2D printing is rejected before slicing, connection, or upload because the native eMMC transport has not shipped. Neither a successful FULU slice nor bridge initialization changes that limit; do not substitute `h2d`.

<a id="optional-fulu-cli-slicing"></a>

<a id="fulu-and-orca-cli-safety-limit"></a>

## FULU and Orca CLI safety checks

**Starting with 1.1.11, FULU and Orca use the same MCP machine-preset gate and BBL profile preparation as BambuStudio.** The server requires the exact model/nozzle preset from the selected profile tree. A missing or malformed preset stops slicing; a custom `slicer_profile` only supplies process settings and cannot replace the machine preset.

Set these in the environment used to launch the MCP server, replacing paths with your installed FULU or Orca build:

```bash
export SLICER_TYPE=orcaslicer-bambulab  # or orcaslicer; fulu-orca and orca-studio aliases also work
export SLICER_PATH=/absolute/path/to/your/slicer
export BAMBU_PROFILES_ROOT=/absolute/path/to/its/resources/profiles
export BAMBU_MODEL=p1s                # your exact printer model
export NOZZLE_DIAMETER=0.4           # your installed nozzle diameter
```

`BAMBU_PROFILES_ROOT` is the directory containing `BBL`, including the machine, process, filament, and `cli_config.json` files from that same slicer installation. It is optional when the tree is discoverable beside the executable. For AppImage or custom installations, point it to the matching extracted resources. The server does not borrow a missing machine from another installation. Configured user-profile directories remain available for custom process and filament dependencies, but cannot supply machine ancestors.

When multiple Orca/OrcaStudio variants share one Linux install prefix, set `BAMBU_PROFILES_ROOT` explicitly: automatic discovery does not distinguish those co-installed variants.

Before launching the CLI, the MCP resolves `inherits` and `include`, validates the selected model's CLI configuration, and prepares every filament slot. Missing references, cycles, malformed configuration, and incomplete slot mappings stop preparation. Failed auto-slicing stops before upload or print dispatch; the original unsliced project is never used as a fallback.

The regression suite verifies these checks, alias routing, and generated CLI settings using isolated profile trees and fake executables. It does not establish live FULU/Orca slicing or physical printing across versions and platforms. Start with `slice_stl`, inspect the output in the slicer, and use GUI export if your build rejects CLI flags or lacks the required profiles. The existing [BambuStudio version evidence](./SLICING.md#multi-colour-cli-support-and-version-limits) remains specific to BambuStudio.

## Configure the bridge

This is an optional, advanced connection path. The MCP implements the framed stdin/stdout protocol expected by FULU's bridge host. It does not install that runtime, provision a VM, or supply a cloud-login UI.

| Setting | Purpose |
|---|---|
| `BAMBU_NETWORK_BRIDGE_COMMAND` | Full trusted shell command for the host binary or platform wrapper. Do not point this at the slicer GUI or another MCP server. |
| `BAMBU_MODEL` | Exact target printer model; required for printing. |
| `BAMBU_DEV_ID` | Fallback device ID if no printer serial is resolved. An explicit tool `dev_id` takes priority over the serial and this setting; use it when several printers are configured. |
| `BAMBU_NETWORK_CONFIG_DIR` | Persistent writable agent config/log directory. Default: `~/.config/bambu-printer-mcp/bambu-network`. |
| `BAMBU_NETWORK_COUNTRY_CODE` | Region/country passed to the runtime, default `US`; use the appropriate setting for your account. |
| `BAMBU_NETWORK_USER_INFO` | Optional sensitive JSON passed to `net.change_user`; see [cloud authentication](#cloud-authentication). |
| `PJARCZAK_BAMBU_PLUGIN_DIR` | Upstream runtime's library directory, containing the matching network/source libraries. |

Set these where your MCP client launches the server. Desktop applications may not inherit variables exported in a terminal. Restart the server after changes. Keep the command in trusted client configuration; do not enable per-call `bridge_command` overrides just to follow this guide.

### Linux

Use a FULU runtime built for your CPU architecture. It must include the bridge executable and matching libraries such as `libbambu_networking.so` and `libBambuSource.so`. The [upstream host sources and packaging script](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/tree/main/tools/pjarczak_bambu_linux_host) describe that component; installing upstream OrcaSlicer alone does not establish that the FULU host is present.

For a shell-launched MCP, this is the configuration shape; replace both paths with your actual installation:

```bash
export BAMBU_NETWORK_BRIDGE_COMMAND="'/opt/fulu-runtime/pjarczak_bambu_linux_host'"
export PJARCZAK_BAMBU_PLUGIN_DIR=/opt/fulu-runtime
export BAMBU_NETWORK_COUNTRY_CODE=US
export BAMBU_DEV_ID=YOUR_DEVICE_ID
export BAMBU_MODEL=p1s
npx -y bambu-printer-mcp
```

Use the same variable values in a desktop client's `env` object. Quote paths containing spaces inside the bridge command. Proceed to the probes below before attempting a print.

### Windows / WSL 2

FULU's [installation instructions](https://github.com/FULU-Foundation/OrcaSlicer-bambulab#windows) require **WSL 2** and a restart after enabling its Windows features. Follow those instructions for the slicer/runtime build you install.

For MCP bridge testing, running both the Node.js MCP server and Linux bridge host **inside the same WSL environment** avoids passing Windows paths to a Linux process. Install Node.js/npm there, use the Linux settings above, and reference shared files with paths such as `/mnt/c/Users/yourname/Downloads/bracket.gcode.3mf`. The MCP and bridge must both be able to read that exact path. Configure a desktop MCP client to launch the server in that WSL environment, with the bridge settings available there.

A native Windows MCP calling `wsl.exe` only for the bridge needs a wrapper that translates paths in both directions or otherwise makes identical paths accessible. This MCP forwards file paths unchanged; a Windows `C:\...` path is not automatically converted to `/mnt/c/...`. Do not mistake a successful handshake for a working upload.

### macOS

As checked on **2026-09-27**, FULU's [upstream README](https://github.com/FULU-Foundation/OrcaSlicer-bambulab#macos) still labels macOS a work in progress. The MCP has runtime discovery hints, but it does not provide a turnkey macOS installer.

Start with `bambu_network_bridge_status` and `{}`. It inspects these conventional locations without launching a process:

```text
~/Library/Application Support/OrcaSlicer/plugins/
~/Library/Application Support/OrcaSlicer/macos-bridge/runtime/
```

When it finds the wrapper, the response includes `runtime.suggestedMacCommand`. Copy it to `BAMBU_NETWORK_BRIDGE_COMMAND` only after confirming the paths exist. A typical installed Lima-wrapper command has this shape:

```bash
export BAMBU_NETWORK_BRIDGE_COMMAND="PJARCZAK_BAMBU_PLUGIN_DIR='$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime' '$HOME/Library/Application Support/OrcaSlicer/plugins/pjarczak-bambu-linux-host-wrapper' '$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime/pjarczak_bambu_linux_host'"
```

The upstream [Lima wrapper](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/blob/main/tools/pjarczak_bambu_linux_host/pjarczak-bambu-linux-host-wrapper) needs an already prepared Linux instance, the correct host architecture, and mounted files. It accepts `PJARCZAK_MAC_LIMA_INSTANCE` for the instance name and `PJARCZAK_LIMACTL` for a specific `limactl` executable. Follow the runtime instructions shipped with your FULU build; older install/verify scripts are not guaranteed to be included in every current package.

The Linux guest must see the project file and writable config/log directory at the same absolute paths the MCP passes. A Docker/VM wrapper that mounts only the runtime libraries is insufficient for printing. If files are missing or the host crashes with an architecture error, resolve the upstream runtime installation before trying print commands.

## Probe without printing

Use these MCP calls in order:

1. **`bambu_network_bridge_status` with `{}`** reports configuration, process state, and macOS discovery hints without starting the bridge.
2. **`bambu_network_bridge_status` with `{"connect": true}`** launches the host, performs `bridge.handshake`, and initializes the network agent. It creates/uses the config directory and contacts the network service, but does not submit a print.
3. **`bambu_network_call` with `{"method": "net.is_user_login", "payload": {}}`** checks the runtime's login state before a cloud job.

Check the returned handshake, `agentReady`, and any errors. The macOS file hints are not Linux/Windows requirements. Agent initialization alone does not establish cloud login, printer reachability, or print success. The MCP can retry the handshake using the reported network ABI version when the runtime reports an expected-version mismatch; avoid hard-coding an old ABI version from a sample.

For raw `bridge.handshake`, call `bambu_network_call` with `with_agent: false`. Other raw methods can change state; consult your installed FULU bridge's method contract.

## Cloud authentication

The bridge's default config directory is separate from the slicer's. Logging into the FULU GUI does **not** automatically prove that this MCP's bridge agent is logged in.

Use the authentication/session configuration supported by your installed runtime and verify it with `net.is_user_login`. If that runtime supplies a compatible `user_info` JSON value, `BAMBU_NETWORK_USER_INFO` passes it to `net.change_user` after agent initialization. It is not your plain account password, and this project does not define a universal token schema or automatically copy the GUI's session. Use an authenticated config directory only when supported by your runtime, with the correct region and filesystem access.

If login cannot be established, stop at the probe and use direct LAN where supported, or use FULU's own UI. Cloud bridge jobs still require Bambu services; they are not the cloud-free workflow described at the top of this guide. Keep tokens, access codes, account JSON, and unredacted logs out of public issues.

## Print through the bridge

These examples **submit real print jobs**. Run them only after checking the sliced preview, printer model, material mapping, runtime, and authentication. They are not connection tests.

Call `print_3mf_bambu_network` for a single-filament cloud job assigned to AMS tray 0:

```json
{
  "three_mf_path": "/absolute/shared/path/bracket.gcode.3mf",
  "bambu_model": "p1s",
  "dev_id": "YOUR_DEVICE_ID",
  "connection_type": "cloud",
  "plate_index": 0,
  "use_ams": true,
  "ams_mapping": [0]
}
```

For a LAN bridge job, use the same tool and explicitly select LAN:

```json
{
  "three_mf_path": "/absolute/shared/path/bracket.gcode.3mf",
  "bambu_model": "p1s",
  "dev_id": "YOUR_DEVICE_ID",
  "dev_ip": "192.168.1.100",
  "bambu_token": "YOUR_LAN_ACCESS_CODE",
  "connection_type": "lan",
  "plate_index": 0,
  "use_ams": true,
  "ams_mapping": [0]
}
```

For the equivalent `print_3mf` calls, add `connection_mode: "bambu_network"`. Its default remains direct LAN; the dedicated bridge tool defaults to `connection_type: "cloud"`. Local bridge methods require the printer IP and access code. Cloud submission requires a device ID and authenticated runtime; `auto_match_ams: true` additionally queries live inventory through **local MQTT**, so it also needs LAN credentials/reachability. For a remote-only job, supply a mapping verified against the loaded materials instead.

`plate_index` is zero-based in MCP calls and converted to one-based for FULU. `ams_mapping` is positional across project filaments; `[0]` above is only for a one-filament project. For advanced firmware requirements, the dedicated tool exposes `ams_mapping_bridge`, `ams_mapping2`, `ams_mapping_info`, `nozzle_mapping`, and `nozzles_info` as JSON strings. The bridge forwards these; do not assume the direct H2 path's full mapping conversion is applied to every bridge job.

| `bambu_network_method` | Runtime call | Default/use |
|---|---|---|
| `start_print` | `net.start_print` | Default for cloud |
| `start_local_print` | `net.start_local_print` | Default for LAN |
| `start_local_print_with_record` | `net.start_local_print_with_record` | Local job with task-record behavior |
| `start_send_gcode_to_sdcard` | `net.start_send_gcode_to_sdcard` | Advanced runtime-specific transfer |
| `start_sdcard_print` | `net.start_sdcard_print` | Advanced runtime-specific SD-card start |

Non-zero numeric bridge results are errors. A successful submission does not prove that the printer starts or finishes the job. For LAN, inspect `get_printer_status` and HMS diagnostics; for a cloud-only connection, check the runtime/slicer UI and printer. Ordinary MCP status, camera, pause/resume, and file tools still use the direct local connection.

## Troubleshooting and evidence to report

| Symptom | Next check |
|---|---|
| `configured: false` | Set `BAMBU_NETWORK_BRIDGE_COMMAND` in the MCP process environment and restart it. |
| Invalid frame magic or immediate exit | Confirm the command starts the binary-protocol host, not the GUI; wrapper stdout must contain only protocol frames. |
| Missing library / architecture / VM error | Check the matching upstream runtime, CPU architecture, library directory, and platform wrapper. |
| Handshake works, file upload fails | Verify the project and config paths inside the host/VM/WSL process, including read/write permissions. |
| Agent ready, cloud print rejected | Verify login, region, and device ID; `agentReady` is not an authenticated-session guarantee. |
| Non-zero result or `send msg failed` | Inspect the redacted runtime error and printer diagnostics; do not blindly repeat a possible print submission. |
| FULU/Orca CLI slicing requested | Use 1.1.11+ with the matching installed profile tree and exact model/nozzle; see the CLI checks above. Use GUI export if preparation or slicing fails. |
| X2D direct-print rejection | Expected limitation. Use its own slicing preset and a supported slicer transport; do not relabel it as H2D. |

The repository's automated tests exercise mocked bridge framing, initialization, method/parameter handling, and failure responses. They do not certify live FULU printing on Linux, Windows, or macOS. Earlier macOS experiments reached a handshake but encountered print-start failures; they are not current physical-print validation. No physical print is performed as part of this documentation sweep.

For a useful [issue report](https://github.com/DMontgomery40/bambu-printer-mcp/issues), include MCP version, OS/CPU, printer model and firmware, slicer/runtime version, direct-LAN versus bridge/cloud selection, method used, redacted error, and whether the printer actually started. Credit both working and failing hardware evidence so future compatibility claims remain specific.
