# Scan-to-Print: iOS/Android Consumer App PRD

**Status:** Research & Product Definition  
**Product:** Open-source consumer mobile app (iOS + Android) enabling non-technical users to scan objects and spaces, design fitted parts in AI-assisted CAD, and 3D print them.  
**Owner Vision:** Democratize custom part design for Bambu Lab printer owners via phone camera LiDAR/depth, plain-language AI design, and integrated printing.  
**Competitors:** Fusion 360 with Print Studio (desktop), Snapmaker Luban (slicer-first), commercial CAD + cloud job queues  
**Release Model:** Open-source free tier (self-hosted); paid convenience tier (hosted compute/LLM)

---

## 1. Product Vision

### 1.1 Core Problems We Solve

**Today's workflow** is fragmented and requires CAD expertise:
1. Buy a Bambu printer
2. Find or create a 3D model (MakerWorld, Fusion 360, Blender, etc.)
3. Slice in BambuStudio/OrcaSlicer/FULU CLI
4. Print via USB, cloud, or LAN

**Real user pain points:**
- A parent needs a custom phone mount for a child's iPhone 15 clamped to a bicycle handlebar of a specific 27mm diameter → learns Fusion 360 or settles for a generic mount
- A drawer organizer for a specific cabinet under a kitchen sink → no quick way to validate fit without printing a prototype
- A coffee mug holder that wedges into a car's too-narrow cup holder → requires measuring, CAD modeling, and multiple print iterations

### 1.2 The Vision

> **A nontechnical person scans an object or space with their phone, describes what they want in plain language, an AI agent designs it in Blender/CAD, validates it against real dimensions, and prints it—all from one mobile app.**

**Core cases (MVP priority):**
1. **Fitted attachment:** "Design a cup holder that fits this 27mm handlebar and holds a 10oz mug"
2. **Drawer organizer:** "Make a holder for all these Dr. Brown bottle parts that fits my 18×14 inch drawer"
3. **Wall/clamp mount:** "A phone mount clamped to these bike handlebars for an iPhone 15 Pro"

**Free tier (self-hosted):**
- User runs our open-source MCP server + Blender on a home machine
- App connects via Tailscale or similar VPN tunnel
- Only CAD/slicer compute costs (user's hardware)
- User's printer auth (LAN mode for Bambu)
- Print via local LAN (no cloud)

**Paid tier (hosted):**
- We host GPU-accelerated Blender, CAD inference, LLM, slicer
- We manage printer connectivity (no local network required)
- User enters printer model + access code (auto-discover when possible)
- We handle all compute; user pays per design attempt
- Convenience: one tap to print

---

## 2. Competitive Positioning & Market Strategy

### 2.1 Why Bambu Won't Build This

**Conflict with Bambu's hardware roadmap:**
- Bambu released the **Bambu Lab X1 Scanner** (~$500) as a premium accessory
- A phone-based scan-to-print app **cannibalizes scanner sales** (phones are commodities; users already carry them)
- Bambu's incentives are hardware-first (printers, AMS, scanner); software is the moat
- Their BambuConnect cloud strategy favors cloud-native workflows (not edge/self-hosted)

**Our advantages:**
1. **Open-source ecosystem support** → We integrate FULU OrcaSlicer-bambulab, which Bambu won't push (competes with BambuStudio)
2. **Multi-vendor from day one** → We'll support OctoPrint, Klipper, Prusa, Creality; Bambu is Bambu-only
3. **Privacy & data ownership** → Free tier runs locally; users never trust cloud by default
4. **Community-driven development** → Faster iteration on edge cases (e.g., new printer models) than Bambu's official cycle

**Market reality:**
- 10K+ Bambu printer owners globally (P1S, H2D especially popular)
- 100K+ other FFF printer owners (RepRap, OctoPrint, Klipper)
- TAM starts at $2–3M/year (Bambu-only), expands to $10M+ (all printers) by Year 2

---

## 3. Multi-Vendor Architecture (Printer-Agnostic Backend)

### 3.1 Why Design Multi-Vendor from Day One

**Business case:**
- MVP launches Bambu-only (we own the MCP server)
- Phase 2 (6–9 months) adds OctoPrint + Klipper → 5–10× user base
- Phase 3 (12+ months) adds Prusa, Creality → commoditized DIY printing
- Single abstraction = one design, multiple implementations

**Technical case:**
- Parent project **[mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server)** already abstracts printer backends
- Our Bambu fork (this repo) is a *specialization*, not a fork-for-life
- Merging back or standing alongside is strategic optionality

### 3.2 Printer Backend Abstraction

**Interface (pseudocode):**

```typescript
// Abstract printer backend interface
interface PrinterBackend {
  // Connection & discovery
  discoverPrinters(): Promise<Printer[]>;
  connectPrinter(id: string, credentials: PrinterCredentials): Promise<Connection>;
  
  // Status & diagnostics
  getPrinterStatus(): Promise<PrinterStatus>;
  getCameraSnapshot(format: 'jpeg'): Promise<Buffer>;
  getAMSInventory?(): Promise<AMS[] | null>;  // Optional (Bambu, some OctoPrint)
  
  // File operations
  uploadFile(file: Buffer, remotePathHint: string): Promise<RemoteFile>;
  listFiles(): Promise<RemoteFile[]>;
  deleteFile(remotePath: string): Promise<void>;
  
  // Print control
  startPrint(remoteFilePath: string, options: PrintOptions): Promise<PrintJob>;
  pausePrint(jobId: string): Promise<void>;
  resumePrint(jobId: string): Promise<void>;
  cancelPrint(jobId: string): Promise<void>;
  
  // Printer-specific APIs (optional)
  skipObjects?(objectIds: number[]): Promise<void>;  // Bambu-only
  setTemperature?(component: 'nozzle' | 'bed', temp: number): Promise<void>;
  setAMSSlot?(slot: number): Promise<void>;  // Bambu, some others
}

// Concrete implementations
class BambuPrinterBackend implements PrinterBackend { /* ... */ }
class OctoPrintBackend implements PrinterBackend { /* ... */ }
class KlipperBackend implements PrinterBackend { /* ... */ }
class PrusaBackend implements PrinterBackend { /* ... */ }
```

### 3.3 Backend Implementation Roadmap

| Phase | Backend | Transport | Notes | MCP Server |
|-------|---------|-----------|-------|-----------|
| **MVP (now)** | Bambu | MQTT/FTPS + BambuNetwork bridge | LAN + cloud | [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) (this repo) |
| **Phase 2 (6–9mo)** | OctoPrint | HTTP (REST API) + camera | LAN via mDNS | mcp-3D-printer-server ([adapter](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/adapters/octoprint.ts)) |
| **Phase 2 (6–9mo)** | Klipper/Moonraker | HTTP (Moonraker REST API) + camera | LAN / Tailscale | mcp-3D-printer-server (adapter) |
| **Phase 3 (12+mo)** | Prusa | HTTP (Prusa API) + cloud | Cloud-first | mcp-3D-printer-server (adapter) |
| **Phase 3 (12+mo)** | Creality Cloud | HTTP (Creality REST) | Cloud | mcp-3D-printer-server (adapter) |

### 3.4 Integration with mcp-3D-printer-server

**Current state:**
- `bambu-printer-mcp`: specialized, Bambu-only, optimized
- `mcp-3D-printer-server`: generalized, multi-vendor, slower development

**Our strategy:**
1. **Maintain `bambu-printer-mcp` as our differentiator** (Bambu-first, FULU support, safety focus)
2. **Extract common abstraction** → `PrinterBackend` interface (publish as npm module)
3. **Keep mcp-3D-printer-server as fallback** → when `bambu-printer-mcp` doesn't support a feature, proxy to parent project

**Code architecture (app backend):**

```typescript
// App printer factory
class PrinterFactory {
  static async createBackend(model: PrinterModel): Promise<PrinterBackend> {
    switch (model.type) {
      case 'bambu':
        return new BambuPrinterBackend(model.credentials);
      case 'octoprint':
        // Use mcp-3D-printer-server's OctoPrint adapter under the hood
        return new OctoPrintBackend(model.credentials);
      case 'klipper':
        return new KlipperBackend(model.credentials);
      // ... others
      default:
        throw new Error(`Unsupported printer: ${model.type}`);
    }
  }
}

// User can register multiple printers, each with a backend
const myPrinters = [
  { type: 'bambu', model: 'h2d', ... },
  { type: 'octoprint', host: 'octoprint.local', ... },
  { type: 'klipper', host: '192.168.1.50', ... }
];
```

### 3.5 Slicing Abstraction

**Challenge:** Each printer ecosystem has a different default slicer.
- Bambu → BambuStudio (proprietary) or FULU OrcaSlicer
- OctoPrint → Cura, PrusaSlicer, Superslicer (community choice)
- Klipper → Cura, Superslicer (community)
- Prusa → PrusaSlicer (official)
- Creality → Cura, Creality Cloud (official)

**Solution: Slicer abstraction layer**

```typescript
interface SlicerBackend {
  getInstalledProfiles(printerModel: string): Promise<SliceProfile[]>;
  slice(
    stlPath: string,
    profile: SliceProfile,
    options: SliceOptions
  ): Promise<{ outputPath: string; weight: number; time: number }>;
}

// Implementations
class BambuStudioSlicer implements SlicerBackend { /* ... */ }
class OrcaSlicerSlicer implements SlicerBackend { /* ... */ }  // FULU alias
class CuraSlicer implements SlicerBackend { /* ... */ }
class PrusaSlicerSlicer implements SlicerBackend { /* ... */ }
```

**MVP:** Bambu (BambuStudio + FULU) only  
**Phase 2:** Add Cura (popular, free, multi-vendor)  
**Phase 3:** Add PrusaSlicer, Creality Slicer (native support where vendor-specific)

---

## 4. Supported Printers & Devices

### 4.1 Bambu Printer Models (MVP)

All printers must be auto-detected from serial number prefix or explicitly specified. **Safety:** observed serial, status, nozzle config, and model must agree before any operation.

| Model | Serial Prefix | Nozzles | AMS | Notes | Reference |
|-------|--------------|---------|-----|-------|-----------|
| **P1S** | `00` | 1 | Optional (AMS, AMS Pro) | Entry-level; common | AGENTS.md |
| **P1P** | `01` | 1 | Optional (AMS) | —— | AGENTS.md |
| **A1** | `039` | 1 | Optional (AMS) | Full-size; newer | AGENTS.md, CHANGELOG 1.1.23 |
| **A1 mini** | `030` | 1 | Optional (AMS) | Compact | AGENTS.md, CHANGELOG 1.1.23 |
| **P2S** | `094` | 2 | Required (dual-nozzle) | Dual nozzle; requires H2 AMS mapping | AGENTS.md, CHANGELOG 1.1.20 |
| **H2D** | `31A` | 1 | Optional (AMS) | Bambu's flagship | AGENTS.md |
| **H2S** | `31B` prefix (not `239`) | 1 | Optional (AMS) | Entry H2 | AGENTS.md, CHANGELOG 1.1.26 |
| **H2C** | `31B` prefix | 1 | Optional (AMS) | Multi-material | CHANGELOG 1.1.26 |
| **H2D Pro** | `239` prefix | 1 | Optional (AMS) | Pro variant | CHANGELOG 1.1.26 |
| **X1C** | `0B0` | 1 | No AMS | Earlier mid-tier | README.md |
| **X1E** | `0B1` | 1 | No AMS | Larger build plate | README.md |
| **X2D** | — | 2 | Optional (AMS) | Latest; macOS native eMMC printing | CHANGELOG 1.1.25, README.md, AGENTS.md |

**Critical safety invariants (from AGENTS.md):**
- H2C serial `31B` and H2D Pro serial `239` must agree across displayed status, fresh MQTT identity, and bundled parser
- Configured serial/model inference cannot replace fresh observed identity
- Retain conflicts as failures (do not silently override)

### 4.2 Phase 2–3 Printer Models (Future Multi-Vendor)

**OctoPrint-compatible printers (Phase 2):**
- Creality Ender 3 / 5 / Pro
- Anycubic Mega / i3 Mega
- Artillery X1 / X2 / Sidewinder
- Custom RepRap / Marlin-based printers
- Note: OctoPrint is software layer; hardware is commodity (almost all FFF)

**Klipper-compatible (Phase 2):**
- Voron (all)
- Prusa i3 MK3S+ (with Klipper firmware)
- Custom Klipper builds
- Note: Klipper replaces firmware; can run on any Marlin-based printer

**Prusa-official (Phase 3):**
- Prusa i3 MK3S+
- Prusa XL
- Connect directly via Prusa Cloud API

**Creality-official (Phase 3):**
- Creality K1 / K1 Max
- Creality Ender 3 v3 (with cloud firmware)
- Connect directly via Creality Cloud API

### 4.3 iOS Device Capture
- iPhone 12 Pro / Pro Max
- iPhone 13 Pro / Pro Max
- iPhone 14 Pro / Pro Max
- iPhone 15 Pro / Pro Max
- iPad Pro (M1+) with LiDAR

**LiDAR depth capture:**
- ~5m range, ±1% depth accuracy at 1–4m [Apple ARKit docs](https://developer.apple.com/arkit/)
- Point cloud density: ~200K–1M points per frame (configurable)
- Scan mesh: iPhone OS supports native `ARKit.RealityKit` or `ARMeshGeometry` (iOS 13.2+)
- Reference object detection: ARKit `ARReferenceObject` API for domain-specific learning
- Export: mesh as `.usdz`, point cloud as `.ply` / `.xyz`

**Metadata captured:**
- Intrinsic camera calibration (focal length, principal point)
- Device motion (gyro + accel) for mesh alignment
- Depth confidence per pixel
- Lighting estimates (for later shading in CAD preview)

### 4.4 Android Device Capture

**ARCore-capable Android:**
- Devices with depth sensor (ToF) or Stereo: Samsung Galaxy S20+, S21+, S22+, Note 10+, Pixel 6 Pro, 7 Pro, 8 Pro
- Or software stereo (slower): most recent high-end Android

**ARCore depth & mesh:**
- [ARCore Depth API](https://developers.google.com/ar/develop/java/depth) provides dense depth maps at camera framerate
- Mesh generation: ARCore does not have native mesh like RealityKit, so app must:
  - Capture depth + confidence frames at 30 Hz
  - Fuse into a voxel grid on-device or cloud (Poisson surface reconstruction)
  - Export `.glb`, `.obj`, or `.usdz`
- Range: 0.1–8m typical (varies by device/scene)
- Accuracy: ±2–5% on textured surfaces, worse on specular/transparent materials

**Baseline:** Pixel 6 Pro (or newer), Galaxy S21+ as reference devices

### 4.5 Computer Vision & Scanning

#### Depth Capture Library Choices

1. **RTAB-Map (BSD, C++)** [rtabmap.org](http://rtabmap.org/)
   - Pros: Visual SLAM + loop closure, works on mobile via NDK, BSD licensed (app-compatible)
   - Cons: Heavier build, requires tuning for indoor scenes, no iOS native binding
   - Use case: Offline 3D reconstruction when depth sensor data is sparse

2. **ORB-SLAM3 (GPL, C++)** [github.com/UZ-SPS/ORB_SLAM3](https://github.com/UZ-SPS/ORB_SLAM3)
   - Pros: Robust visual+inertial SLAM, loop closure
   - Cons: GPL (incompatible with closed-source app), heavier compute
   - Not recommended without relicense

3. **Native Platform APIs (recommended for MVP)**
   - **iOS:** ARKit `ARMeshGeometry` (iOS 13.2+) + `ARSession` depth frames → export `.usdz` directly
   - **Android:** ARCore Depth + custom Poisson reconstruction or cloud fusion
   - Pros: Simple, native, no extra dependencies, Apple/Google maintain
   - Cons: Limited to what the OS provides (no loop-closure SLAM)

4. **COLMAP (BSD, C++, Python)** [colmap.github.io](https://colmap.github.io/)
   - Pros: Gold-standard SfM, BSD licensed, structure-from-motion for many photos
   - Use case: Asynchronous batch processing on cloud when user uploads images
   - Cons: Not real-time on-device

#### Calibration & Reference Objects

**Scale ambiguity problem:** Monocular depth or single RGB frames cannot determine absolute scale.

**Solution: QR-code or printed-pattern references**
- User points phone at a **credit-card-sized QR code** with known dimensions (85.6 × 53.98 mm)
- Or user manually measures and enters one dimension (e.g., "the handlebar diameter is 27 mm")
- App scale-calibrates the depth point cloud before meshing
- Validation: at inference time, measure extracted dimensions against known object sizes (e.g., "iPhone is 120mm tall")

**On-device reference learning (optional, post-MVP):**
- ARKit `ARReferenceObject` API to learn "this is a coffee mug (80mm tall)" and detect similar objects in future scans
- Saves time on repeat scans of similar items

#### Mesh Cleanup & STL Generation

**On-device pipeline:**
1. **Voxelization:** Convert point cloud → 3D voxel grid (user-selected resolution, e.g., 1mm)
2. **Poisson reconstruction:** Screened Poisson surface reconstruction (fast implementations: [kazhdan-poisson](https://github.com/mkazhdan/PoissonRecon) C++ port or cloud offload)
3. **Mesh simplification:** Decimate to target face count (e.g., 50K faces for preview, 200K for print)
4. **STL export:** Binary STL to `/tmp` for app upload to design service

**Cloud pipeline (for complex/noisy scans):**
- User uploads raw depth frames + camera intrinsics
- Server runs COLMAP or Poisson on GPU
- Receives cleaned `.obj` / `.gltf` within seconds

---

## 5. AI Design Agent & Inference

### 5.1 Design Runtime

**Architecture:**
```
User Input (plain text + scanned mesh + optional reference dimensions)
    ↓
[Cloud] LLM → Blender Script Generator
    ↓
Blender MCP (headless) → Python script execution
    ↓
STL output → Slicer → .3mf (sliced)
    ↓
Print via Bambu MCP server
```

### 5.2 LLM Model Selection

**Requirements:**
- Vision capability (inspect scanned mesh image + reference photos)
- Code generation (Blender Python scripts)
- Instruction-following (generate parametric CAD with user constraints)
- Multi-turn (refine design based on user feedback)
- Reasonably fast (inference < 30–60 seconds per design)

**Candidates:**

| Model | Vision? | Code Gen | Speed | Cost | Notes |
|-------|---------|----------|-------|------|-------|
| **Claude 3.5 Sonnet** | Yes | Excellent | ~20s | ~0.03/design | Best for reasoning + code; slower inference |
| **GPT-4o** | Yes | Good | ~25s | ~0.024/design | Multimodal; reliable |
| **Gemini 2.0 Flash** | Yes | Good | ~5–10s | ~0.0001/design (cheap) | Very fast; newer, may have rougher edges |
| **Llama 3.3 (70B)** | No | Excellent | 30s+ | ~0.005/design (self-hosted) | If self-hosting; not hosted cheaply |
| **Qwen VL-Max** | Yes | Good | ~15s | Low in CN | Alibaba model; less available in US |

**MVP choice: Claude 3.5 Sonnet**
- Reasoning quality for constraint interpretation
- Proven Blender code output
- Vision for reference photo inspection
- Cost ~$0.03 per design attempt (~100K input tokens, 500 output tokens avg)

**Fallback/scaling: Gemini 2.0 Flash**
- 10× cheaper
- Acceptable code generation
- Risk: newer model, edge cases in Blender output

### 5.3 Blender CAD Workflow

**Tool:** Blender MCP (headless, stdio transport)

**Guaranteed to work:**
- Model primitives: cubes, cylinders, spheres (add + scale + rotate)
- Modify extrusion: extrude faces, set thickness (for hollow/wall designs)
- Boolean operations: union, difference, intersection (for attachment points, cutouts)
- Grid fill / bridge edge loops (for fit surfaces)
- Apply materials and UV mapping (preview only; not printed)

**LLM-driven script generation example:**
```python
# User request: "Make a phone mount that clamps to 27mm handlebars, rotates 360°, holds an iPhone 15 Pro"
# Scanned mesh: handlebar point cloud (diameter ~27mm confirmed by QR reference)

import bpy

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# 1. Create clamp base (two-piece hinged design)
# Handlebar: 27mm diameter → clamp inner diameter 27.5mm (0.5mm clearance)
# Hinge pin: 4mm stainless steel rod

bpy.ops.mesh.primitive_cylinder_add(radius=13.75, depth=40)  # Half cylinder for clamp
bpy.ops.transform.rotate(value=1.5708, orient_axis='Y')  # Rotate 90°

# 2. Extrude hinge axis
# ... (assembly constraint logic in comments, actual parametric modeling)

# 3. Add phone holder (U-bracket for iPhone 15 Pro: 77.7mm wide, 160.9mm tall)
# Bracket thickness: 3mm, material thickness 1.6mm
bpy.ops.mesh.primitive_cube_add(size=1)
# (scale, position, boolean, etc.)

# 4. Mesh cleanup, apply modifiers
# ... (shade smooth, decimate if needed, check manifold)

# Export
bpy.ops.export_mesh.stl(filepath="/tmp/phone_mount.stl")
print("STL exported successfully")
```

**Safety constraints checked by MCP:**
- No motion commands (motors, animation)
- No rendering (output-file required)
- No scene mutations without explicit `execute` flag
- Deadlines enforced (30s timeout per design generation)

### 5.4 Constraint Extraction & Validation

**From user input + scanned mesh:**
1. **Dimensional constraints**
   - Reference object: "handlebar diameter is 27mm" → validate scanned handlebar mesh fits cylinder(27)
   - Phone model: "iPhone 15 Pro" → lookup Apple's published dimensions [77.7 × 160.9 × 8.25 mm](https://www.apple.com/iphone-15-pro/specs/)
   - Draw space: "drawer is 18×14 inches" → user input, not scanned (hard to scan large flat spaces accurately)

2. **Fit constraints**
   - Clamp: inner diameter must fit handlebar, outer diameter should be < user's hand span (comfort)
   - Holder: must prevent phone from rotating or slipping (friction/geometry)
   - Wall mount: must support weight (calculate stress for 250g phone + 1.5× safety factor)

3. **Material/printability constraints**
   - Wall thickness ≥ 1.2 mm for PLA (common default)
   - Bridge spans ≤ 15 mm (unsupported)
   - Overhang angle ≥ 45° (limit need for support)
   - No isolated thin features (< 0.6 mm)

4. **AMS filament constraints (post-MVP)**
   - User specifies color/material (black PETG, transparent resin, etc.)
   - App validates loaded AMS against required filaments
   - Multi-color designs automatically split by slot

### 5.5 Model Validation

**Printability checks (before slicing):**

1. **Manifold mesh**
   - No holes, self-intersections, non-manifold edges
   - Tool: Blender `bmesh.utils.vert_connect_concave()`

2. **Volume & floating parts**
   - Minimum component volume: 1mm³ (avoid specks)
   - Isolated parts detected and warned (user decides keep/discard)

3. **Dimension validation**
   - Extracted bounding box from CAD output
   - Check against scanned reference dimensions (±5% tolerance)
   - Example: if design is "phone holder for iPhone 15 Pro," verify width ≈ 77.7 mm (allow 73.8–81.6)

4. **Stress estimation (heuristic)**
   - Wall thickness & material → approximate safe load (PLA ~20 MPa tensile)
   - Clamp designs: check clamping force geometry (lever advantage)
   - Warn if predicted load exceeds material strength

5. **Support requirement estimation**
   - Angle analysis → estimate support volume
   - Flag if supports > 30% of part volume (user decides refine/proceed)

---

## 6. Slicing & Print Validation

### 6.1 Slicer Integration

**MCP server:** [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp)

**Workflow:**
1. App receives validated STL from design agent
2. App calls `slice_stl` MCP tool with:
   - Printer model (from config or auto-detect)
   - Filament profile (user-selected: "Black PLA", etc.)
   - Layer height (default 0.2 mm for speed, 0.1 mm for detail)
   - Supports (enabled by default, disable if user confirms no overhang)
3. Slicer output: `.gcode.3mf` (contains sliced G-code + metadata)
4. MCP returns file path + weight estimate + print time

**Supported slicers** (from AGENTS.md):
- BambuStudio (bundled with Bambu printers) ✅
- FULU OrcaSlicer-bambulab (open-source) ✅
- OrcaSlicer (community) ✅
- PrusaSlicer (compatible) ⚠️ (may need profile adaptation)
- Cura (third-party) ⚠️ (community-maintained profiles)

**Safety gates (AGENTS.md section "Printer and slicer safety"):**
- Require exact printer model + nozzle preset (cannot guess)
- Validate machine limits from `BBL/cli_config.json`
- Independent heater ceilings per material
- Reject M109 H parameters outside bounds (A1/mini models, 0–300°C)
- Preserve AMS mapping and reject incomplete slot declarations
- Never silently reuse foreign filament profiles

### 6.2 AMS Mapping & Filament Auto-Matching

**AMS system:**
- Up to 4 units, 4 slots per unit (16 total slots)
- Each slot holds one spool + RFID chip
- Printer reports live AMS inventory → app queries via `get_printer_filaments` MCP tool

**Workflow (for multi-color designs):**
1. Design agent specifies filament requirements (e.g., "black outer shell, white accent stripe")
2. App calls `resolve_3mf_ams_slots` MCP dry-run:
   - Reads 3MF filament metadata (from slicer)
   - Matches against live AMS inventory
   - Returns matched slots or missing/exhausted report
3. If match fails, user is prompted:
   - "Design needs white PETG, but you have white PLA. Change filament? Or use PLA?"
   - Or app auto-selects single-color fallback

**Single-filament simplification (MVP):**
- Design is single material (e.g., all black)
- App queries live AMS, auto-matches to first loaded tray of that color/type
- No user intervention needed

---

## 7. Printer Connectivity

### 7.1 LAN-Only Mode (Default for Bambu)

**Bambu printer local network paths** (from README, AGENTS.md):

| Transport | Port | Purpose | Auth | Notes |
|-----------|------|---------|------|-------|
| **MQTT** | 8883 | Commands, status | `bblp` + LAN access code | All commands (print, cancel, temp, etc.) |
| **FTPS** | 990 | File upload/download | `bblp` + access code | SD card, cache, logs directories |
| **Camera (TCP)** | 6000 | Live snapshots | Access code | P1S, P1P only; H-series use RTSP-322 |
| **Camera (RTSP)** | 322 | Live video stream | Access code | H2D, H2S, X2D, X1E (requires ffmpeg) |

**Auto-discovery:**
- Printer broadcasts hostname via mDNS: `bambu-<serial>.local`
- Or user manually enters IP (e.g., 192.168.1.100)
- Validate: serial number from MCP tool `get_printer_status` matches configured serial

**Access code retrieval:**
- First-time setup: user enables "LAN Mode" in Bambu Studio app
- Access code displayed in Bambu Studio → user copies to Scan-to-Print app
- (Or: in future, QR code from printer screen)

### 7.2 Free Tier: Tailscale VPN Tunnel (Bambu + Multi-Vendor)

**Problem:** User's phone is at coffee shop, printer is at home.

**Solution:**
- App embeds Tailscale SDK ([tailscale-android](https://github.com/tailscale/tailscale-android), [tailscale-ios](https://github.com/tailscale/tailscale-ios))
- User signs in with Tailscale account (or GitHub/Google)
- Printer's home machine gets Tailscale IP (e.g., `100.0.0.50`)
- Phone connects via Tailscale, securely tunnels to printer's LAN
- No port forwarding, NAT traversal automatic (via Tailscale relay)

**MCP server:** User runs on a machine at home:
```bash
npx -y bambu-printer-mcp stdio
```
Or inside a Docker container, wrapped in Tailscale netcat listener.

**Latency & cost:**
- Tailscale: free tier (1 user, up to 3 devices); paid plans for teams/scaling
- Network latency: 50–500 ms (varies by relay)
- MQTT/FTPS work over VPN (verified in AGENTS.md testing)

### 7.3 Paid Tier: Cloud Connectivity (Bambu + Vendor APIs)

**Problem:** User doesn't want to run home server; wants one-tap printing.

**Solution:**
1. **User registration:** Email + password (or OAuth: Google, Apple)
2. **Printer registration:** User enters Bambu device ID + LAN access code
   - We validate offline using credentials
   - We store encrypted access code (AES-256 in Cloud KMS)
3. **Connectivity options:**
   - **Option A (recommended):** Use Bambu's BambuNetwork bridge [FULU guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#fulu-and-orca-cli-safety-limit)
     - Cloud API layer abstracts printer → can use cloud or LAN
     - User enables cloud in Bambu app, we use cloud API
     - Cost: pass-through of Bambu's cloud limits (unknown publicly; assume ~100K print jobs/month free tier)
   - **Option B (custom):** Direct MQTT/FTPS over cloud relay
     - We run a small relay service (e.g., nginx TCP proxy)
     - Phone → relay → printer MQTT/FTPS
     - Simpler auth, no dependency on Bambu cloud
     - Requires printer to reach our relay IP (user's firewall permitting)

**Preferred:** Option A (BambuNetwork bridge) because:
- Less infrastructure to maintain
- Bambu bears connectivity responsibility
- Official API
- Risk: Bambu could deprecate (low probability; they're incentivized to support)

**Cost model:**
- Per-design-attempt: LLM tokens + GPU inference + slicer overhead
- Estimate: 0.005–0.02 USD per design (see Section 3.2)
- Plus infrastructure: Blender GPU hours, bandwidth
- Margin: ~100–200% on direct compute cost

---

## 8. Cloud Architecture (Paid Tier)

### 8.1 Services

**Primary stack:**
- **API Gateway:** REST API (user authentication, design requests, printer queries)
- **Async Job Queue:** (SQS, Celery, or similar) for long-running design jobs
- **Compute:** GPU-accelerated containers for Blender + CAD inference
- **LLM Gateway:** Rate-limited calls to Claude / Gemini (with failover)
- **Database:** User accounts, printer registrations, design history
- **Storage:** Scanned meshes, design outputs, sliced 3MF files (temporary)
- **Monitoring:** Logs, traces, cost tracking (Datadog or similar)

### 8.2 Cost Breakdown Per Design Attempt

| Component | Typical Cost | Notes |
|-----------|--------------|-------|
| **LLM (Claude 3.5 Sonnet)** | $0.03 | 100K input (mesh image, description, constraints), 500 output tokens |
| **Blender render/export** | $0.005 | 30s GPU (H100: ~$2/hr → $0.017/30s; amortize overhead) |
| **Slicer (BambuStudio CLI)** | $0.001 | CPU-only, ~5s; negligible |
| **Storage (S3/GCS)** | $0.00005 | Scan mesh + output STL + 3MF (~50 MB total, deleted after 7d) |
| **API/infrastructure** | $0.005 | Share of load balancer, database, relay |
| **Margin (100%)** | $0.04 | Revenue |
| **Total user cost** | **$0.08/design** | ~$1–2 per successful print (depends on retries) |

**Volume economics:**
- At 10K designs/month: margin ~$400/mo (covers 0.5 person-month of ops)
- At 100K designs/month: margin ~$4K/mo (sustainable small team)
- Scaling pain: GPU capacity (H100 shortage, reservation costs)

### 8.3 Latency Targets

| Operation | Timeout | SLA |
|-----------|---------|-----|
| Scan upload | 30s | 99% (user quits if slow) |
| Design generation (LLM + Blender) | 60s | 99% (typical: 40–50s) |
| Slicing | 15s | 99.5% (can retry) |
| Print dispatch | 10s | 99% (local MQTT latency) |

---

## 9. Security & Privacy

### 9.1 Data Classification

| Data | Sensitivity | Handling |
|------|-------------|----------|
| **Scanned meshes** | Medium | Encrypt in transit (TLS 1.3), at rest (AES-256), delete after 7d or on user request |
| **Printer credentials** (access code, serial) | High | Encrypt in KMS, rotate access codes per device, never log |
| **LLM prompts** (user descriptions) | Medium | Do not send to Bambu/third parties; keep in our infrastructure |
| **Design outputs** (STL, 3MF) | Low | Compress, cache, delete after 7d |
| **Print history** | Medium | Retain for user; allow bulk export/delete |
| **User account** | High | Standard auth (bcrypt, 2FA optional); SOC 2 Type II compliant (paid tier) |

### 9.2 Privacy

**Open-source tier:** No user registration, all compute local (no data sent anywhere)

**Paid tier:**
- No account data is shared with Bambu, Claude API provider, or third parties
- Scan data is not used to train models (clarify in ToS)
- Design history is owned by user (can export/delete)
- GDPR/CCPA compliant: data deletion requests honored within 30 days

### 9.3 Printer Safety (Critical)

From AGENTS.md, enforced at MCP layer:

1. **Model validation:** scanned reference (QR code, measurement) + fresh printer telemetry must agree
   - Do not trust configured model alone
   - Reject if H2C serial `31B` conflicts with H2D Pro serial `239`

2. **Nozzle & material:** design must match installed nozzle type + material in AMS
   - Do not auto-select incompatible materials
   - Warn if design requires 260°C and only PLA (max 220°C) is loaded

3. **Temperature ceilings:** per-material maximums (PLA 220°C, ABS 250°C, etc.) enforced
   - Never let design override (baked into sliced G-code)

4. **Pre-print preflight:**
   - Inspect sliced 3MF for embedded safety violations (malformed M109 H, wrong model markers)
   - Check HMS (Health Management System) for active errors
   - Require human confirmation for "finished bed clearance" (user checks visually)
   - On X2D, use native eMMC route on macOS; block on Linux/Windows (unsupported)

5. **AMS safety:**
   - Require exact AMS mapping (not guessed)
   - Reject if design specifies white filament but only black is loaded
   - Dry-run `resolve_3mf_ams_slots` before printing

6. **Watchdog on dispatch:**
   - Listen to MQTT for up to 15 seconds after print command
   - Return `dispatch: "started"` or `"unconfirmed"` (not a certainty)
   - HMS 0500-0500-0001-0007 ("MQTT verification failed") requires LAN Only Mode + Developer Mode on some firmware
   - If error reported, require user to clear HMS before retrying

---

## 10. App Store Rules & Licensing

### 10.1 App Store Compliance

**iOS (Apple App Store):**
- Guideline 3.1.1: "apps may not encourage or promote the unauthorized manufacture of physical objects, weapons, or counterfeit goods"
  - **Our stance:** We explicitly block designs for weapons/explosives via prompt validation; legitimate manufacturer tools are allowed
  - **Precedent:** Fusion 360, Nomad Sculpt, Adobe Dimension all available on App Store
  - **Mitigation:** Terms of Service clause: user assumes responsibility for legality of designs
- Guideline 5.1.2: "cryptography" → disclose we use TLS, encryption at rest (standard practice)
- Guideline 5.1.3: "apps using HTTPS must follow current security best practices"
  - All API endpoints use TLS 1.3, HTTP/2
- Guideline 4.3: "apps that artificially manipulate ratings" → we won't
- Guideline 1.4.1: "apps must work as intended and not have bugs"
  - Will maintain high test coverage, crash reporting (Sentry)

**Rejection risk:** Minimal. Similar tools (Fusion 360, Blender iOS viewer, Nomad Sculpt) are approved. Our safety gates strengthen the case.

**Android (Google Play):**
- Fewer restrictions than Apple
- Same weapon/counterfeit policy applies
- Must declare all permissions (camera, file access, network)
- Allowed to direct users to TestFlight/sideload for beta

### 10.2 Licensing Strategy

**Code licensing:**
- **Open-source MCP server:** GPL-2.0 (inherited from [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp))
- **App codebase:** AGPL-3.0 or Apache 2.0 (TBD based on funding model)
  - AGPL: copyleft, requires any deployments to open-source; strong community commitment
  - Apache 2.0: permissive, allows proprietary modifications; easier adoption
  - **Recommendation:** AGPL for paid tier, Apache for OSS components (split repo)
- **Blender scripts:** Generated (LLM output), no explicit license needed (Blender is GPL-2.0 compatible)

**App store handling:**
- "Free" tier (open-source) → free download, no in-app purchase
- "Paid" tier → optional in-app subscription ($9.99/mo or $0.08/design)
  - Apple IAP: 30% commission (Apple takes 30%)
  - Google Play IAP: 30% commission (Google takes 30%)
  - Direct billing (web) for 15% commission (if available in your region)

**Considerations:**
- Paid tier should be ~3× direct cost to justify Stripe/payment processing + KMS + ops
- Estimate $0.08 cost → $0.24–0.30 user-facing price per design
- Monthly sub ($9.99) = ~40 designs/mo, break-even at ~2 retries per design (reasonable)

---

## 11. MVP Scope & Milestones

### 11.1 MVP Feature Set

**Phase 1 (Months 1–2): Feasibility & Core Loop**
- [ ] iOS app UI scaffold (SwiftUI)
  - Scan screen (ARKit integration, point cloud preview)
  - Design request input (text + reference dimensions)
  - Print preview (sliced job info, weight, time)
- [ ] Android app UI scaffold (Jetpack Compose)
- [ ] Design agent backend (single-region, single-GPU server)
  - User auth (email/password, no OAuth yet)
  - LLM call → Claude 3.5 Sonnet
  - Blender MCP invocation
  - Error handling & retry logic
- [ ] Integration with bambu-printer-mcp (LAN mode only)
  - Printer discovery & auth
  - Slice → print dispatch
- [ ] Design: simple single-part cases (no multi-color)
- [ ] Scans: ARKit mesh export, basic validation
- [ ] **Metrics:** 1 end-to-end scan → design → print working (internal testing)

**Phase 2 (Months 3–4): Paid Tier & Polish**
- [ ] Cloud backend infra (AWS Lambda / GCP Cloud Functions + GPU workers)
  - Multi-region failover
  - Job queue (SQS/Pub-Sub)
  - Cost tracking per user
- [ ] Paid tier sign-up (Stripe + App Store IAP)
  - BambuNetwork bridge integration OR custom cloud relay
  - Printer auto-discovery cloud endpoint
- [ ] Design refinement loop
  - User can request changes ("make it 5mm taller," "use lighter material")
  - Diff-based regeneration (faster: reuse previously generated geometry, modify one param)
- [ ] AMS multi-color support (basic)
  - App queries live AMS, shows available filaments
  - Design agent can request 2-color output (single change/color)
- [ ] Test on real printers: P1S, H2D, A1 (team has hardware)
- [ ] **Metrics:** 100 beta users, 80% successful print rate, < 3 retries per print

**Phase 3 (Months 5–6): Scale & Documentation**
- [ ] Support all printer models (P1S, P2S, X2D, H2D, H2C, H2S, A1, A1 mini, X1C, X1E)
  - Regression tests for model-specific G-code validation
  - Safety checks per AGENTS.md
- [ ] Scan quality improvements
  - Mesh simplification / denoising
  - Reference object API (optional for scale calibration)
- [ ] Designer feedback in app ("is this 27mm too wide for your handlebar?")
- [ ] Multi-platform: both iOS + Android at feature parity
- [ ] Documentation
  - User guide (how to scan, write prompts, resolve errors)
  - Developer guide (self-hosted server setup)
  - Safety guidelines (responsible design, not weapons)
- [ ] **Metrics:** App Store + Google Play release, 1K+ downloads, 50+ monthly active users

### 11.2 Post-MVP Roadmap

**Q3 2025 (6–9 months):**
- Parametric design library (user shares designs, community publishes templates)
- Advanced scanning (RTAB-Map optional for complex scenes, loop closure)
- Design marketplace (sell designs, revenue share with designers)

**Q4 2025+ (12+ months):**
- Tablet scanning (iPad LiDAR for larger objects)
- Bambu scanner integration (if Bambu releases hardware scanner)
- Multi-material assembly (print parts separately, embed in app how to assemble)
- Integration with Bambu's new cloud features (if/as they emerge)

---

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **LLM code generation fails** (Blender script has errors) | Medium | High | Sandboxed execution, timeout, MCP enforces schema; user gets clear error + UI to refine prompt |
| **Scan mesh is too noisy** (point cloud unusable) | Medium | Medium | User retry with different angle/lighting; provide in-app mesh viewer with filter strength controls |
| **Printer connectivity unreliable** (MQTT drops, FTPS fails) | Low | High | Retry logic (3× exponential backoff); local LAN mode is most reliable; fallback error message |
| **AMS mapping mismatch** (design wants white, printer has black) | Medium | Medium | Dry-run validation before print; user can swap filaments or request redesign |
| **Paid tier compute costs exceed revenue** (LLM tokens too expensive) | Low | High | Cap design complexity (max mesh size 50K triangles); use cheaper fallback models; implement caching for similar requests |
| **Apple/Google rejects app** | Low | High | App Store legal review early; precedent (Fusion 360); ToS clarifies user responsibility |
| **Bambu sunsets BambuNetwork API** | Low | Very High | Maintain custom cloud relay as fallback; publish spec so community can fork; open-source paid tier code if sunsetting |
| **User designs weapon/counterfeit** | Low | Very High | Prompt injection prevents request; explicit ToS disclaimer; DMCA safe harbor (user, not us, responsible); cooperation with law enforcement |
| **Competitor launches first** (Fusion 360 Print Studio 2.0) | High | Medium | Focus on best UX, free tier, community goodwill; differentiate on privacy/open-source |
| **GPU shortage/price spike** | Medium | Medium | Partner with cloud provider (AWS, GCP credit); use cheaper models (Gemini 2.0); pre-compute templates |

---

## 13. Success Metrics & KPIs

### 13.1 User Metrics (Free Tier)

| Metric | Target (12mo) | Notes |
|--------|---------------|-------|
| Total downloads | 10K | iOS + Android combined |
| Monthly active users (MAU) | 1K–2K | 10–20% retention from downloads |
| Avg designs per user per month | 2–3 | Sticky if users find value |
| Successful first-print rate | 70% | 1st design leads to printed part |
| Avg retries before print | 2–3 | Design tweaks due to fit/complexity |
| Avg print success rate | 85% | Hardware/filament issues, not app's fault |

### 13.2 Paid Tier Metrics

| Metric | Target (12mo) | Notes |
|--------|---------------|-------|
| Paid subscribers | 500–1K | ~5–10% of DAU convert to paid |
| Monthly recurring revenue (MRR) | $5K–10K | $9.99/mo × 500–1K users |
| Average revenue per user (ARPU) | $10–20/mo | Includes per-design spending |
| Cloud compute utilization | 70% | GPU efficient usage |
| Design generation success rate | 95%+ | Should be higher (cloud infrastructure) |
| Avg latency (design generation) | 45–60s | Target <60s for good UX |

### 13.3 Hardware & Printer Metrics

| Metric | Target | Notes |
|--------|--------|-------|
| Supported printer models | 12+ | P1S, P2S, H2D, H2C, H2S, X1C, X1E, X2D, A1, A1 mini, etc. |
| Printer compatibility rate | 95%+ | Can print sliced output from any model |
| LAN + Cloud paths working | 100% | Both local and hosted tiers functional |
| AMS multi-filament support | 100% of models | Correct mapping for all variants |
| Camera snapshot capture | 100% of models | TCP-6000 or RTSP-322 |

---

## 14. Open Questions & Dependencies

### 14.1 Technical Unknowns

1. **Blender CAD generation fidelity**
   - How reliably does Claude generate correct Blender Python for fit constraints?
   - Mitigation: prototype with 10–20 real prompts before shipping

2. **Scan mesh quality on consumer phones**
   - ARKit depth at 2–3m range: how noisy? How much cleanup needed?
   - Android ARCore depth fusion: feasible on-device or cloud-only?
   - Mitigation: test on multiple device generations (iPhone 12 Pro → 15 Pro, Pixel 6 → 8 Pro)

3. **BambuNetwork bridge reliability**
   - Is FULU bridge stable for cloud jobs? How often does it fail?
   - Fallback custom relay: is it worth the ops burden?
   - Mitigation: Rely on Bambu infrastructure first; custom relay as Plan B

4. **Model cost scaling**
   - At 100K designs/mo, will Claude pricing scale linearly or by volume?
   - When does switching to Gemini 2.0 or Llama (self-hosted) make sense?
   - Mitigation: Early partnership discussions with Claude/Anthropic; cost monitoring per user

5. **Printer safety gate coverage**
   - Are there edge cases in AGENTS.md's safety checks we're not hitting?
   - Are new printer models (e.g., Bambu X3) coming that break assumptions?
   - Mitigation: Close partnership with MCP maintainer; regression test for each new model

### 14.2 Business/Market Unknowns

1. **Willingness to pay**
   - Is $9.99/mo reasonable for convenience? Or should it be $19.99/mo + usage?
   - Do users prefer "design credits" (prepaid) or subscription?
   - Mitigation: A/B test pricing with early access cohorts

2. **Competitor response**
   - Will Bambu bundle AI design into their mobile app?
   - Will Fusion 360 / Autodesk move faster?
   - Mitigation: Focus on differentiation (privacy, open-source, Bambu-only expertise)

3. **Regulatory exposure**
   - Are there regions that restrict 3D printing of certain objects?
   - Could our app be held liable if user prints a banned item?
   - Mitigation: Geofence (block app in restricted regions); include DMCA safe-harbor language in ToS

4. **Bambu hardware roadmap**
   - Is there a Bambu scanner coming that would commoditize our scanning feature?
   - Will Bambu release official AI design tools?
   - Mitigation: Stay in close contact; offer to integrate rather than compete; focus on open-source angles

---

## 15. Sourced Specifications & References

### 15.1 Bambu Printer Ecosystem

| Reference | URL | Key Info |
|-----------|-----|----------|
| **bambu-printer-mcp** | [github.com/DMontgomery40/bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) | MCP server for Bambu printers; GPL-2.0; supports 12+ models; LAN + cloud paths; safety checks |
| **AGENTS.md** | `/workspace/AGENTS.md` (this repo) | Shared source of truth for safety, slicing, printer routing, release process |
| **FULU OrcaSlicer-bambulab** | [github.com/FULU-Foundation/OrcaSlicer-bambulab](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) | Open-source slicer fork; MIT license; FULU Foundation |
| **BambuNetwork Bridge** | [docs/FULU.md](docs/FULU.md) | Cloud-to-printer relay; FULU setup guide |
| **OpenBambuAPI** | [github.com/Doridian/OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) | Reverse-engineered Bambu MQTT protocol; community documentation |
| **Bambu Printer Models** | [bambu-lab.com](https://bambu-lab.com/) | P1S, P2S, H2D, H2C, H2S, X2D, A1, A1 mini, X1C, X1E official specs |

### 15.2 Mobile AR & Scanning

| Reference | URL | Key Info |
|-----------|-----|----------|
| **Apple ARKit** | [developer.apple.com/arkit](https://developer.apple.com/arkit/) | LiDAR on iPhone 12 Pro+; ARMeshGeometry; depth API; up to 5m range |
| **Google ARCore** | [developers.google.com/ar](https://developers.google.com/ar) | ARCore Depth API; available on Pixel 6+, Samsung Galaxy S20+ |
| **Tailscale iOS/Android** | [tailscale.com/downloads](https://tailscale.com/downloads) | VPN SDK for iOS/Android; open-source client |
| **RealityKit** | [developer.apple.com/realitykit](https://developer.apple.com/realitykit/) | Native iOS mesh export, `ARMeshGeometry` (iOS 13.2+) |
| **RTAB-Map** | [rtabmap.org](http://rtabmap.org/) | BSD-licensed visual SLAM library; C++ with NDK support |
| **COLMAP** | [colmap.github.io](https://colmap.github.io/) | BSD-licensed structure-from-motion; cloud-based reconstruction option |
| **Poisson Surface Reconstruction** | [github.com/mkazhdan/PoissonRecon](https://github.com/mkazhdan/PoissonRecon) | Classic mesh generation from point clouds |

### 15.3 AI & CAD Models

| Reference | URL | Key Info |
|-----------|-----|----------|
| **Claude 3.5 Sonnet** | [anthropic.com](https://www.anthropic.com/) | Vision + code generation; ~$0.03/design estimated |
| **GPT-4o** | [openai.com](https://openai.com/) | Multimodal; ~$0.024/design estimated |
| **Gemini 2.0 Flash** | [ai.google.dev](https://ai.google.dev/) | Very fast; ~$0.0001/design (cheap) |
| **Blender MCP** | [github.com/ModelContextProtocol](https://github.com/ModelContextProtocol) (community) | Headless Blender via MCP; stdio transport; Python scripting |
| **LLM Cost Calculator** | [openrouter.io](https://openrouter.io/), [artificialanalysis.ai](https://artificialanalysis.ai/) | Public pricing and performance comparisons |

### 15.4 App Store & Legal

| Reference | URL | Key Info |
|-----------|-----|----------|
| **Apple App Store Guidelines** | [developer.apple.com/app-store/review/guidelines](https://developer.apple.com/app-store/review/guidelines) | Guideline 3.1.1 (manufacturing), 5.1.2 (crypto), 4.3 (ratings) |
| **Google Play Policies** | [play.google.com/about/developer-content-policy](https://play.google.com/about/developer-content-policy) | Weapon/counterfeit restrictions, similar to Apple |
| **DMCA Safe Harbor** | [17 U.S.C. § 512](https://www.law.cornell.edu/uscode/text/17/512) | Safe harbor for platforms; user is responsible for their uploads |
| **AGPL-3.0 License** | [gnu.org/licenses/agpl-3.0](https://www.gnu.org/licenses/agpl-3.0) | Copyleft; any deployment must release source |
| **Apache 2.0 License** | [apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Permissive; allows proprietary modifications |

### 15.5 Standards & Formats

| Reference | URL | Key Info |
|-----------|-----|----------|
| **3MF (3D Manufacturing Format)** | [3mf.io](https://3mf.io/) | Standard for 3D print job metadata; XML-based; embedded G-code |
| **STL (Stereolithography)** | [en.wikipedia.org/wiki/Stereolithography](https://en.wikipedia.org/wiki/Stereolithography) | Binary/ASCII triangle mesh format; no metadata |
| **G-code** | [reprap.org/wiki/G-code](https://reprap.org/wiki/G-code) | 3D printer command language; thermal, motion, extrusion |
| **GLTF/GLB** | [khronos.org/gltf](https://khronos.org/gltf/) | Modern 3D format; widely supported; compressed (GLB) variant |
| **USD/USDZ** | [pixar.com/usd](https://pixar.com/usd/) | Pixar's universal scene format; native iOS support |

---

## 16. Competitive Landscape

### 16.1 Direct Competitors

| Product | Link | Strengths | Weaknesses | Our Edge |
|---------|------|-----------|-----------|----------|
| **Fusion 360** | [autodesk.com/products/fusion/overview](https://www.autodesk.com/products/fusion/overview) | Parametric CAD, sketches, assembly, industry-standard | Steep learning curve, expensive ($680/yr), cloud-only, not specialized for Bambu | Free, mobile-first, Bambu-specific, open-source free tier |
| **Bambu Studio GUI** | [bambulab.com](https://bambulab.com/en/download) | Familiar to Bambu users, BambuStudio cloud integration | Desktop-only, no AI, manual CAD required | Mobile-first, AI-assisted, phone scanning |
| **Snapmaker Luban** | [snapmakerjs.com](https://snapmakerjs.com/) | Free, open-source, multi-tool support | Not AI-powered, basic CAD features | LLM-driven design, depth scanning, premium UX |
| **MakerWorld** | [makerworld.com](https://makerworld.com/) | Community models, sliced & printable | Browse-only, not generative, requires account | Generative, phone camera, instant design |

### 16.2 Indirect Competitors / Adjacent Markets

| Category | Product | Notes |
|----------|---------|-------|
| **AI CAD** | TinkerCAD AI, Pixelcraft AI | Easier CAD, not printing-focused |
| **Phone scanning** | Polycam, Scapple, Twinmotion | Scanning tools; no design/print integration |
| **Cloud printing** | Printful, Shapeways | Service bureaus; not consumer app |
| **Bambu ecosystem** | BambuConnect, BambudStore | Official cloud; proprietary, less open |

---

## 17. Conclusion & Call to Action

### 17.1 Strategic Opportunity

Scan-to-Print fills a critical gap: **turning anyone into a designer-maker in 3 minutes**. Unlike desktop CAD (months to learn) or cloud print services (expensive, slow), our app empowers users to:
- Solve real household problems (custom holders, adapters, organizers)
- Own their designs (open-source code, privacy-first)
- Print on their own hardware (no vendor lock-in)

With Bambu's market growing (P1S, H2D, H2C, X2D, A1), a simple, delightful mobile app can expand the addressable user base from **tinkerers and engineers → every household that owns a Bambu printer**.

### 17.2 Next Steps

1. **MVP prototyping (Weeks 1–4):**
   - Build iOS ARKit scanning UI (SwiftUI)
   - Integrate Claude 3.5 Sonnet with Blender MCP backend
   - Connect to bambu-printer-mcp for single-model print flow
   - Test on P1S (internal hardware)

2. **Validation (Weeks 5–8):**
   - 10–20 user interviews with Bambu printer owners
   - Gather feedback on scan quality, design accuracy, UX friction
   - Prototype paid tier (Stripe subscription, cloud backend)

3. **Expansion (Months 3–6):**
   - Android feature parity
   - All printer models support (regression tests per AGENTS.md)
   - App Store & Google Play release

4. **Scaling (Months 6–12):**
   - Community features (share designs, marketplace)
   - Advanced scanning (RTAB-Map, reference learning)
   - Geographic expansion (pricing, localization)

### 17.3 Success Criteria

**MVP success:** 
- 1 internal end-to-end flow: scan handlebar → "make a phone mount for iPhone 15" → sliced 3MF → printed part
- Zero safety violations (AGENTS.md compliance)
- User can complete scan & design in < 5 minutes

**Product-market fit (12 months):**
- 1K+ MAU (free + paid tiers)
- 70%+ first-print success rate
- $5K–10K MRR from paid tier
- 95%+ user satisfaction (design generated matches user intent)

---

**Document version:** 1.0  
**Last updated:** 2026-10-14  
**Status:** Research phase complete, ready for technical feasibility review and MVP planning
