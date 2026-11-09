# Optional code-CAD engine

Code-CAD makes dimensioned functional parts without starting a design app. It uses build123d 0.13.0 (OpenCascade), with pinned trimesh, Manifold3D and Pillow for mesh checks and rendering. Blender and Fusion integrations remain available and unchanged. Whether mesh cleanup in this environment can replace Blender is being tested separately; this release adds no cleanup algorithms.

A local prototype made a holder cavity at 65.800 × 28.800 mm, performed an exact +1 mm height edit in 137 seconds, and produced a valid articulated-unicorn mesh and STEP in 657 seconds after two historical Blender attempts timed out at 901 seconds with no model. The unicorn had actual endpoint errors and joint collisions in a claimed pose; the holders met calipers but collided with the inflated raw scan. Initial holder worker passes took 238–893 seconds, including the cold native-import stall; code-CAD is not uniformly fast. The sample is small, the environments differed, and no physical print or fit was verified. These results justify an optional tool for measured parts, not a promise that every design works.

## Leave it out or remove it

Nothing downloads or runs Python merely because this MCP is installed. `cad_setup` without arguments checks only; installation requires `{"install":true}`.

Set **`CAD_ENABLED=0`** in the MCP's environment and restart it to leave the engine out. No `cad_*` tools, `cad_design` prompt or `capabilities.cad` are registered. This does not disable printing, mesh tools, Blender or Fusion, and does not remove files.

To remove a downloaded runtime, first stop MCP instances using it, then move its CAD data folder to Trash with your file manager:

- macOS: `~/Library/Application Support/bambu-printer-mcp/cad`.
- Linux: `${XDG_DATA_HOME:-~/.local/share}/bambu-printer-mcp/cad`.
- A custom **`CAD_DATA_DIR`** replaces that location; remove that folder instead.

This folder contains the private Python environment, managed interpreter, package cache and setup/fit working files. Saved designs are under the `output_dir` chosen for `cad_run`, so removing the environment leaves those outputs alone. Keep input snapshots with a saved input-dependent design. Re-enable by removing `CAD_ENABLED=0`, restarting the MCP and running setup again when you want it.

Allow about **1.5 GiB**, including the download cache; platform wheels and cache state affect the exact size. To keep large dependencies off a tight system disk, set `CAD_DATA_DIR` to a private folder on a large local volume **before** setup. Cache and temporary installer files stay under that data folder, not the system temporary directory. `uv` must already be on the MCP's PATH. Setup downloads a managed Python 3.12 and only binary wheels from the complete pins shipped in `src/cad/requirements.lock`; it never uses the system/site Python environment or passes printer/provider credentials to subprocesses.

## Readiness and isolation

`cad_status` returns `{configured, ready, python, build123d, platform, error?}` from local files and a verification marker; it starts no process. Readiness means the installed runtime last passed the setup checks for these bundled helpers/pins, not that arbitrary generated CAD is correct. A changed helper or lock file requires verification again.

`cad_setup {install:true}` serializes against other CAD operations, installs or synchronizes the private environment, verifies imports, then performs a confined build and STL/STEP round trip and denial probes. A stalled macOS import triggers one bounded repair: remove provenance attributes and re-sign native files created under this runtime/managed-Python tree, skipping symlinks. It never re-signs system Python or another app. If import or confinement still fails, readiness stays false and the error says why.

- **macOS:** Seatbelt (`sandbox-exec`) denies network, Apple events, Mach service lookup, signals and process forking. Personal home/volume data are unreadable except the private environment, bundled helpers, this job and its explicit input snapshots. Only the job folder is writable; source, parameters, request and input snapshots are protected read-only.
- **Linux:** `bubblewrap` (`bwrap`) creates fresh user, mount, PID and network namespaces with an empty filesystem, read-only system/runtime mounts, only the job writable, and protected checkpoints/input mounts. Install bubblewrap with your distribution's package manager. If user namespaces or bubblewrap are missing/blocked, setup/run fails closed; it never retries unconfined. Network namespace isolation prevents reaching the host/network; it is not a general seccomp syscall filter.
- Other platforms fail closed. No Windows confinement is implemented.

Subprocesses have wall deadlines, bounded diagnostics, inherited-hard-limit-aware CPU/file/descriptor caps (plus an address-space cap on Linux; macOS does not support the finite data-memory limit used on other hosts), and cancellation kills their dispatched process group. CAD code is not allowed to spawn other applications on macOS; Linux descendants stay in the PID namespace. An engine-valid model is not a print-safety approval: printer operations retain their existing gates.

## Output and input paths

By default CAD outputs and selected inputs must be under this MCP instance's `TEMP_DIR`, the root already used for generated STL files. Additional roots are trusted configuration **`CAD_OUTPUT_DIRS`**, separated by `:` on macOS/Linux. Calls cannot add roots or executables. Paths are canonicalized; a symlink that leaves the roots is refused. The caller supplies an existing output directory, and each run creates a private unique child folder there. Repeating a call never overwrites an earlier output. The automatically created default `TEMP_DIR` is temporary and is deleted when the MCP exits. For checkpoints and renders that must survive an MCP restart, configure a persistent `TEMP_DIR` or `CAD_OUTPUT_DIRS` and choose an `output_dir` there. A configured `TEMP_DIR` is retained. This follows the existing STL storage policy; the environment and saved designs have separate lifetimes.

Inputs are an explicit array of `{name, path}` entries with up to 16 local regular files, at most 64 MiB each / 256 MiB total. The MCP snapshots them into the job's read-only `inputs/` folder. Scripts use `INPUTS["alias"]`; original user files and unrelated home files are not exposed. A path allowed by this MCP may still be refused by a remote client's narrower path policy.

## Script and edit contract

```python
from build123d import Box
P = {"width": 65.8, "depth": 28.8, "height": 70.0}

def build():
    return Box(P["width"], P["depth"], P["height"])
```

Declare exactly one top-level literal `P = {...}` dictionary of named JSON-compatible values. The MCP validates overrides against those names and types, substitutes effective values **before** derived expressions run, and invokes `build()`; it does not run a `__main__` export block. Functional dimensions belong in P. Unknown names, nonfinite values, excessive parameters and scalar/container type changes fail before user code executes. This intentionally narrower contract makes a parameter edit and recovery reproducible.

```json
{"script":"...source above...","output_dir":"/allowed/designs","name":"bracket"}
```

A solid `build()` returns a valid build123d Shape or Compound. `cad_run` exports `<name>.stl` and `<name>.step`, then a **separate trusted process** checks them and renders front/back/left/right/top/bottom plus a contact sheet. Model stdout is diagnostic text, never the validation receipt. The result includes paths, bounds/size in millimetres, STL/STEP volume, solid/component counts, and watertight/manifold/winding/STEP checks. `valid` describes geometry checks, not compliance with a user's request. Inspect the six returned views and measure actual interfaces, assembly paths and articulated poses.

For the next change, send just the saved script path and changed parameters:

```json
{"script_path":"/allowed/designs/cad-bracket-.../bracket.py","parameters":{"height":71.0},"output_dir":"/allowed/designs","name":"bracket-revised"}
```

The earlier parameter file is merged, preserving other choices. The source and effective parameters are saved **before execution**; on a timeout/cancellation the error gives checkpoint paths. For a solid design without inputs, those two files are enough to recover with another `cad_run`. Input-dependent designs also need their saved input snapshots and `<name>.inputs.json`; script-path edits reuse those snapshots by default, or `inputs` can explicitly replace them. There is no automatic replay of interrupted execution.

## Mesh experiments in the same environment

```python
import trimesh
P = {"lift_mm": 1.0}

def build():
    scan = trimesh.load(INPUTS["scan"], force="mesh")
    scan.apply_translation([0, 0, P["lift_mm"]])
    return scan
```

Call with `mode: "mesh"` and `inputs: [{"name": "scan", "path": "/allowed/scan.stl"}]`. A mesh-mode `build()` returns `trimesh.Trimesh`; the MCP exports STL, independently checks it and creates the same six renders. It reports **`step: null`** with `step_unavailable`, since a mesh edit has no parametric B-rep. It does not create a misleading faceted STEP. STEP-specific checks/volume are null, and `valid` refers to the mesh checks. This input/mesh path is infrastructure for experiments, not a scan-cleanup feature.

## Scan fit

`cad_check_fit` takes `model`, `reference`, optional `transform: {rotation_deg:[x,y,z], translation_mm:[x,y,z]}`, optional `clearance_mm` and a deadline. XYZ rotations are about the origin, followed by translation, applied only to the reference. Scaling is not supported implicitly or through the transform.

It returns Manifold3D float32 Boolean interference volume and float64 minimum triangle-surface distance, including vertex/face and edge/edge minima, with AABB pruning. Gap is zero at contact or overlap; the `clear` verdict requires no interference and at least the requested global gap. A bottle resting on a holder floor therefore has zero global gap even if side clearance is correct. Measure a selected interface separately when that distinction matters.

Both meshes must be positively wound, watertight and manifold. It refuses unsupported meshes or workloads above 250,000 triangles per mesh / ten million candidate triangle pairs rather than guessing. Single-pose results do not establish a continuous insertion path or articulation. Calipers and scans can disagree: report both measurements, never silently resize the reference to manufacture a fit.
