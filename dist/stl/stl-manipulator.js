import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { flattenForCli, detectProfilesRoot } from '../slicer/profile-flatten.js';
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const BAMBU_PROFILE_ROOTS = [
    '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL',
    '/Applications/OrcaSlicer.app/Contents/Resources/profiles/BBL',
];
const BAMBU_CLI_BED_TYPES = {
    textured_plate: 'Textured PEI Plate',
    cool_plate: 'Cool Plate',
    engineering_plate: 'Engineering Plate',
    hot_plate: 'High Temp Plate',
};
export const SLICER_TYPES = [
    'bambustudio',
    'orcaslicer',
    'orcaslicer-bambulab',
    'prusaslicer',
    'cura',
    'slic3r',
];
const SLICER_TYPE_ALIASES = {
    bambustudio: 'bambustudio',
    'bambu-studio': 'bambustudio',
    bblstudio: 'bambustudio',
    orcaslicer: 'orcaslicer',
    'orca-slicer': 'orcaslicer',
    orca: 'orcaslicer',
    'orcaslicer-bambulab': 'orcaslicer-bambulab',
    'orca-slicer-bambulab': 'orcaslicer-bambulab',
    'orca-bambulab': 'orcaslicer-bambulab',
    'fulu-orca': 'orcaslicer-bambulab',
    'fulu-orcaslicer': 'orcaslicer-bambulab',
    'fulu-orca-slicer': 'orcaslicer-bambulab',
    'orca-studio': 'orcaslicer-bambulab',
    orcastudio: 'orcaslicer-bambulab',
    'orcaslicer-bmcu': 'orcaslicer-bambulab',
    'orca-bmcu': 'orcaslicer-bambulab',
    prusaslicer: 'prusaslicer',
    'prusa-slicer': 'prusaslicer',
    cura: 'cura',
    curaengine: 'cura',
    slic3r: 'slic3r',
};
export function normalizeSlicerType(rawSlicerType) {
    const key = rawSlicerType.trim().toLowerCase().replace(/_/g, '-');
    const normalized = SLICER_TYPE_ALIASES[key];
    if (!normalized) {
        throw new Error(`Unsupported slicer_type: "${rawSlicerType}". Valid values: ${SLICER_TYPES.join(', ')}`);
    }
    return normalized;
}
export function isBambuCompatibleSlicer(slicerType) {
    return (slicerType === 'bambustudio' ||
        slicerType === 'orcaslicer' ||
        slicerType === 'orcaslicer-bambulab');
}
function isPathLikeExecutable(slicerPath) {
    return (path.isAbsolute(slicerPath) ||
        slicerPath.startsWith("./") ||
        slicerPath.startsWith("../") ||
        slicerPath.includes("/") ||
        slicerPath.includes("\\") ||
        /^[A-Za-z]:/.test(slicerPath));
}
function configuredBambuProfileDirs() {
    const override = process.env.BAMBU_SLICER_PROFILE_DIRS;
    if (override !== undefined) {
        return override.split(path.delimiter).filter(Boolean);
    }
    const home = os.homedir();
    const macAppSupport = path.join(home, 'Library', 'Application Support');
    const linuxConfig = path.join(home, '.config');
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const appNames = [
        'BambuStudio',
        'Bambu Studio',
        'OrcaSlicer',
        'Orca Slicer',
        'OrcaStudio',
        'Orca Studio',
    ];
    const roots = [
        macAppSupport,
        linuxConfig,
        ...(appData ? [appData] : []),
        ...(localAppData ? [localAppData] : []),
    ];
    return roots.flatMap((root) => appNames.map((appName) => path.join(root, appName, 'system', 'BBL')));
}
export class STLManipulator extends EventEmitter {
    constructor(tempDir = path.join(process.cwd(), 'temp')) {
        super();
        this.activeOperations = new Map();
        this.tempDir = tempDir;
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }
    /**
     * Generate a unique operation ID
     */
    generateOperationId() {
        return crypto.randomUUID();
    }
    getAvailableProfileRoots() {
        return [...BAMBU_PROFILE_ROOTS, ...configuredBambuProfileDirs()].filter((root) => fs.existsSync(root));
    }
    findProfileFile(category, profileName) {
        if (!profileName) {
            return undefined;
        }
        for (const root of this.getAvailableProfileRoots()) {
            const candidate = path.join(root, category, `${profileName}.json`);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }
    buildFilamentIdIndex() {
        const index = new Map();
        for (const root of this.getAvailableProfileRoots()) {
            const filamentDir = path.join(root, 'filament');
            if (!fs.existsSync(filamentDir)) {
                continue;
            }
            for (const entry of fs.readdirSync(filamentDir)) {
                if (!entry.endsWith('.json')) {
                    continue;
                }
                const filePath = path.join(filamentDir, entry);
                try {
                    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const filamentId = typeof parsed?.filament_id === 'string' ? parsed.filament_id.trim() : '';
                    if (filamentId && !index.has(filamentId)) {
                        index.set(filamentId, filePath);
                    }
                }
                catch {
                    // Ignore malformed JSON.
                }
            }
        }
        return index;
    }
    readJsonFile(filePath) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    stripAbsoluteExtruderResets(value) {
        if (typeof value === 'string') {
            return value
                .split(/\r?\n/)
                .filter((line) => line.trim().toUpperCase() !== 'G92 E0')
                .join('\n');
        }
        if (Array.isArray(value)) {
            return value.filter((line) => String(line).trim().toUpperCase() !== 'G92 E0');
        }
        return value;
    }
    sanitizeProcessForOrca(processConfig, printerPreset) {
        const sanitized = { ...processConfig };
        sanitized.type = 'process';
        if (!sanitized.from || sanitized.from === 'project') {
            sanitized.from = 'User';
        }
        if (printerPreset) {
            sanitized.compatible_printers = [printerPreset];
        }
        if (sanitized.prime_tower_brim_width !== undefined &&
            Number(sanitized.prime_tower_brim_width) < 0) {
            sanitized.prime_tower_brim_width = '0';
        }
        else if (sanitized.prime_tower_brim_width !== undefined) {
            sanitized.prime_tower_brim_width = String(sanitized.prime_tower_brim_width);
        }
        sanitized.use_relative_e_distances = '0';
        sanitized.before_layer_change_gcode = this.stripAbsoluteExtruderResets(sanitized.before_layer_change_gcode);
        sanitized.layer_gcode = this.stripAbsoluteExtruderResets(sanitized.layer_gcode);
        sanitized.layer_change_gcode = this.stripAbsoluteExtruderResets(sanitized.layer_change_gcode);
        return sanitized;
    }
    writeTempJson(outputBase, suffix, value) {
        const outPath = path.join(this.tempDir, `${outputBase}_${suffix}.json`);
        fs.writeFileSync(outPath, JSON.stringify(value, null, 2));
        return outPath;
    }
    resolveBambuLikeSettingsBundle(outputBase, slicerType, slicerProfile, printerPreset, bambuOptions) {
        const machinePath = this.findProfileFile('machine', printerPreset);
        const machineConfig = machinePath ? this.readJsonFile(machinePath) : null;
        const hasSlicerProfile = !!slicerProfile && fs.existsSync(slicerProfile);
        const filamentPaths = [];
        let processPath;
        let parsedProfile = null;
        if (hasSlicerProfile) {
            try {
                parsedProfile = this.readJsonFile(slicerProfile);
            }
            catch {
                parsedProfile = null;
            }
        }
        if (parsedProfile && typeof parsedProfile === 'object') {
            const inheritedProcessName = (typeof parsedProfile.inherits === 'string' && parsedProfile.inherits) ||
                (typeof parsedProfile.print_settings_id === 'string' &&
                    parsedProfile.print_settings_id !== parsedProfile.name
                    ? parsedProfile.print_settings_id
                    : undefined) ||
                (typeof parsedProfile.default_print_profile === 'string'
                    ? parsedProfile.default_print_profile
                    : undefined) ||
                (typeof machineConfig?.default_print_profile === 'string'
                    ? machineConfig.default_print_profile
                    : undefined);
            const inheritedProcessPath = this.findProfileFile('process', inheritedProcessName);
            const inheritedProcess = inheritedProcessPath && fs.existsSync(inheritedProcessPath)
                ? this.readJsonFile(inheritedProcessPath)
                : {};
            const mergedProcess = {
                ...inheritedProcess,
                ...parsedProfile,
                type: 'process',
            };
            processPath = this.writeTempJson(outputBase, slicerType === 'orcaslicer' ? 'process_orca' : 'process', slicerType === 'orcaslicer'
                ? this.sanitizeProcessForOrca(mergedProcess, printerPreset)
                : mergedProcess);
            const defaultFilamentProfiles = Array.isArray(parsedProfile.default_filament_profile)
                ? parsedProfile.default_filament_profile
                : [];
            for (const profileName of defaultFilamentProfiles) {
                const filamentPath = this.findProfileFile('filament', String(profileName));
                if (filamentPath) {
                    filamentPaths.push(filamentPath);
                }
            }
            if (filamentPaths.length === 0 && Array.isArray(parsedProfile.filament_ids)) {
                const filamentIdIndex = this.buildFilamentIdIndex();
                for (const filamentId of parsedProfile.filament_ids) {
                    const filamentPath = filamentIdIndex.get(String(filamentId));
                    if (filamentPath) {
                        filamentPaths.push(filamentPath);
                    }
                }
            }
        }
        else if (hasSlicerProfile) {
            processPath = slicerProfile;
        }
        if (!processPath) {
            const defaultProcessName = typeof machineConfig?.default_print_profile === 'string'
                ? machineConfig.default_print_profile
                : undefined;
            const defaultProcessPath = this.findProfileFile('process', defaultProcessName);
            if (defaultProcessPath) {
                processPath =
                    slicerType === 'orcaslicer'
                        ? this.writeTempJson(outputBase, 'process_default_orca', this.sanitizeProcessForOrca(this.readJsonFile(defaultProcessPath), printerPreset))
                        : defaultProcessPath;
            }
        }
        if (!bambuOptions?.loadFilaments &&
            filamentPaths.length === 0 &&
            Array.isArray(machineConfig?.default_filament_profile)) {
            for (const profileName of machineConfig.default_filament_profile) {
                const filamentPath = this.findProfileFile('filament', String(profileName));
                if (filamentPath) {
                    filamentPaths.push(filamentPath);
                }
            }
        }
        if (bambuOptions?.loadFilaments) {
            filamentPaths.length = 0;
            for (const filamentPath of bambuOptions.loadFilaments.split(';')) {
                const trimmed = filamentPath.trim();
                if (trimmed) {
                    filamentPaths.push(trimmed);
                }
            }
        }
        const settingsParts = [machinePath, processPath].filter((entry) => Boolean(entry));
        return {
            settingsArg: settingsParts.length > 0 ? settingsParts.join(';') : undefined,
            filamentPaths: Array.from(new Set(filamentPaths)),
        };
    }
    /**
     * Optionally rewrite a Bambu-like settings bundle so the paths point at
     * fully-flattened temp configs instead of the BBL-shipped leaf JSONs.
     *
     * BambuStudio's CLI does not resolve the `inherits` chain when loading
     * profiles via --load-settings / --load-filaments, which causes a
     * cluster of upstream bugs (see https://github.com/bambulab/BambuStudio/issues/9636
     * and #9968). Our flattener (src/slicer/profile-flatten.ts) reproduces
     * what the GUI does at slice time so the CLI accepts the configs.
     *
     * Opt-in via `BAMBU_CLI_FLATTEN=true`. When the env var is unset or
     * not "true"/"1", returns the bundle unchanged so behavior is
     * backward-compatible. When enabled, only BBL-shipped leaves get
     * flattened; user-provided custom configs pass through untouched.
     */
    async maybeFlattenBundle(bundle, bambuOptions, activeSlicerPath) {
        const flag = process.env.BAMBU_CLI_FLATTEN;
        if (flag !== 'true' && flag !== '1')
            return bundle;
        if (!bundle.settingsArg)
            return bundle;
        // settingsArg is "machine.json;process.json".
        const parts = bundle.settingsArg.split(';').filter(Boolean);
        if (parts.length < 2)
            return bundle;
        const [machinePath, processPath] = parts;
        // Pull leaf names from each JSON's `name` field. If any is missing or
        // looks non-BBL (e.g. a user-saved custom config), bail out and
        // return the original bundle untouched.
        const machineLeaf = this.readLeafName(machinePath);
        const processLeaf = this.readLeafName(processPath);
        const filamentLeaves = bundle.filamentPaths
            .map((p) => this.readLeafName(p))
            .filter((n) => Boolean(n));
        if (!machineLeaf || !processLeaf || filamentLeaves.length === 0) {
            console.log('[cli-flatten] skipping: could not derive BBL leaf names from bundle paths');
            return bundle;
        }
        const bedType = this.resolveBambuStudioBedType(bambuOptions?.bedType);
        try {
            const profilesRoot = detectProfilesRoot(activeSlicerPath || process.env.SLICER_PATH);
            const flat = await flattenForCli({
                machineLeaf,
                processLeaf,
                filamentLeaves,
                profilesRoot,
                tempDir: this.tempDir,
                bedType,
            });
            console.log(`[cli-flatten] applied for ${machineLeaf} (cliOverlay=${flat.meta.cliOverlayApplied})`);
            return {
                settingsArg: `${flat.machinePath};${flat.processPath}`,
                filamentPaths: flat.filamentPaths,
            };
        }
        catch (err) {
            console.error(`[cli-flatten] failed, falling back to unflattened bundle: ${err?.message ?? err}`);
            return bundle;
        }
    }
    resolveBambuStudioBedType(bedType) {
        if (!bedType)
            return undefined;
        const normalized = bedType.trim().toLowerCase();
        if (normalized === 'supertack_plate') {
            throw new Error('BambuStudio CLI SuperTack bed type is not verified; use a pre-sliced 3MF or choose textured_plate, cool_plate, engineering_plate, or hot_plate.');
        }
        return BAMBU_CLI_BED_TYPES[normalized] || bedType;
    }
    /** Read a profile JSON's top-level `name` field, or null if unreadable. */
    readLeafName(filePath) {
        try {
            const data = this.readJsonFile(filePath);
            return typeof data?.name === 'string' && data.name.length > 0 ? data.name : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Load STL file and return geometry and bounding box
     */
    async loadSTL(stlFilePath, progressCallback) {
        try {
            if (progressCallback)
                progressCallback(10, "Loading STL file...");
            // Read the STL file
            const stlData = await readFileAsync(stlFilePath);
            if (progressCallback)
                progressCallback(30, "Parsing STL data...");
            // Load the STL data into a Three.js geometry
            const loader = new STLLoader();
            const rawArrayBuffer = stlData.buffer.slice(stlData.byteOffset, stlData.byteOffset + stlData.byteLength);
            const geometry = loader.parse(rawArrayBuffer);
            // Create a mesh from the geometry
            const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            // Compute the bounding box
            geometry.computeBoundingBox();
            const boundingBox = geometry.boundingBox;
            if (progressCallback)
                progressCallback(50, "STL loaded successfully");
            return { geometry, boundingBox, mesh };
        }
        catch (error) {
            console.error("Error loading STL file:", error);
            throw new Error(`Failed to load STL file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Save a geometry to STL file
     */
    async saveSTL(geometry, outputFilePath, progressCallback) {
        try {
            if (progressCallback)
                progressCallback(80, "Exporting to STL...");
            // Create mesh for export
            const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            // Export the mesh as STL
            const exporter = new STLExporter();
            const stlString = exporter.parse(mesh);
            // Write the STL to file
            await writeFileAsync(outputFilePath, stlString);
            if (progressCallback)
                progressCallback(100, "STL saved successfully");
            return outputFilePath;
        }
        catch (error) {
            console.error("Error saving STL file:", error);
            throw new Error(`Failed to save STL file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Get comprehensive information about an STL file
     */
    async getSTLInfo(stlFilePath) {
        try {
            const fileStats = fs.statSync(stlFilePath);
            // Handle 3MF files: extract mesh data from embedded object models
            if (stlFilePath.toLowerCase().endsWith('.3mf')) {
                return await this.get3MFInfo(stlFilePath, fileStats.size);
            }
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath);
            // Count faces (each face is a triangle in STL)
            const positionAttribute = geometry.getAttribute('position');
            const vertexCount = positionAttribute.count;
            const faceCount = vertexCount / 3;
            // Calculate center and dimensions
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            const dimensions = new THREE.Vector3();
            boundingBox.getSize(dimensions);
            return {
                filePath: stlFilePath,
                fileName: path.basename(stlFilePath),
                fileSize: fileStats.size,
                boundingBox: {
                    min: boundingBox.min,
                    max: boundingBox.max,
                    center,
                    dimensions
                },
                vertexCount,
                faceCount
            };
        }
        catch (error) {
            console.error("Error getting STL info:", error);
            throw new Error(`Failed to get STL info: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Extract mesh info from a 3MF file by parsing the XML object models.
     */
    async get3MFInfo(filePath, fileSize) {
        const JSZip = (await import('jszip')).default;
        const data = fs.readFileSync(filePath);
        const zip = await JSZip.loadAsync(data);
        // Find all object model files
        const objectFiles = Object.keys(zip.files).filter((name) => /^3D\/Objects\/.*\.model$/i.test(name));
        const overallBox = new THREE.Box3(new THREE.Vector3(Infinity, Infinity, Infinity), new THREE.Vector3(-Infinity, -Infinity, -Infinity));
        let totalVerts = 0;
        let totalFaces = 0;
        const objects = [];
        for (const objFile of objectFiles) {
            const content = await zip.file(objFile).async('string');
            // Parse vertices from XML: <vertex x="..." y="..." z="..."/>
            const vertexRegex = /<(?:\w+:)?vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
            const triangleRegex = /<(?:\w+:)?triangle\s/g;
            const objBox = new THREE.Box3(new THREE.Vector3(Infinity, Infinity, Infinity), new THREE.Vector3(-Infinity, -Infinity, -Infinity));
            let vCount = 0;
            let match;
            while ((match = vertexRegex.exec(content)) !== null) {
                const x = parseFloat(match[1]);
                const y = parseFloat(match[2]);
                const z = parseFloat(match[3]);
                objBox.expandByPoint(new THREE.Vector3(x, y, z));
                overallBox.expandByPoint(new THREE.Vector3(x, y, z));
                vCount++;
            }
            let fCount = 0;
            while (triangleRegex.exec(content) !== null)
                fCount++;
            totalVerts += vCount;
            totalFaces += fCount;
            if (vCount > 0) {
                const center = new THREE.Vector3();
                objBox.getCenter(center);
                const dims = new THREE.Vector3();
                objBox.getSize(dims);
                objects.push({
                    name: path.basename(objFile),
                    vertexCount: vCount,
                    faceCount: fCount,
                    boundingBox: { min: objBox.min, max: objBox.max, center, dimensions: dims },
                });
            }
        }
        // If no object files found, try the main 3dmodel.model
        if (objects.length === 0) {
            const mainModel = zip.file('3D/3dmodel.model');
            if (mainModel) {
                const content = await mainModel.async('string');
                const vertexRegex = /<(?:\w+:)?vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
                const triangleRegex = /<(?:\w+:)?triangle\s/g;
                let match;
                while ((match = vertexRegex.exec(content)) !== null) {
                    const x = parseFloat(match[1]);
                    const y = parseFloat(match[2]);
                    const z = parseFloat(match[3]);
                    overallBox.expandByPoint(new THREE.Vector3(x, y, z));
                    totalVerts++;
                }
                while (triangleRegex.exec(content) !== null)
                    totalFaces++;
            }
        }
        if (totalVerts === 0) {
            throw new Error('No mesh data found in 3MF file. The archive may not contain any 3D objects.');
        }
        const center = new THREE.Vector3();
        overallBox.getCenter(center);
        const dimensions = new THREE.Vector3();
        overallBox.getSize(dimensions);
        return {
            filePath,
            fileName: path.basename(filePath),
            fileSize,
            boundingBox: { min: overallBox.min, max: overallBox.max, center, dimensions },
            vertexCount: totalVerts,
            faceCount: totalFaces,
            objects,
        };
    }
    /**
     * Scale an STL model uniformly or along specific axes
     */
    async scaleSTL(stlFilePath, scaleFactors, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting scaling operation...");
            // Load the STL file
            const { geometry, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying scaling transformation...");
            // Apply scaling
            let scaleX, scaleY, scaleZ;
            if (typeof scaleFactors === 'number') {
                // Uniform scaling
                scaleX = scaleY = scaleZ = scaleFactors;
            }
            else {
                // Non-uniform scaling
                [scaleX, scaleY, scaleZ] = scaleFactors;
            }
            const scaleMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
            geometry.applyMatrix4(scaleMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_scaled.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'scale',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'scale',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Rotate an STL model around specific axes
     */
    async rotateSTL(stlFilePath, rotationAngles, // [x, y, z] in degrees
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting rotation operation...");
            // Load the STL file
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying rotation transformation...");
            // Convert degrees to radians
            const [rotX, rotY, rotZ] = rotationAngles.map(angle => angle * Math.PI / 180);
            // Get the center of the model
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            // Create translation matrices to rotate around the center
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'XYZ'));
            const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
            // Apply the transformations
            geometry.applyMatrix4(toOriginMatrix);
            geometry.applyMatrix4(rotationMatrix);
            geometry.applyMatrix4(fromOriginMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_rotated.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'rotate',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'rotate',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Translate (move) an STL model along specific axes
     */
    async translateSTL(stlFilePath, translationValues, // [x, y, z] in mm
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting translation operation...");
            // Load the STL file
            const { geometry } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying translation transformation...");
            // Apply translation
            const [translateX, translateY, translateZ] = translationValues;
            const translationMatrix = new THREE.Matrix4().makeTranslation(translateX, translateY, translateZ);
            geometry.applyMatrix4(translationMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_translated.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'translate',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'translate',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Cancel an ongoing operation
     */
    cancelOperation(operationId) {
        if (this.activeOperations.has(operationId)) {
            this.activeOperations.set(operationId, false);
            this.emit('operationCancelled', { operationId });
            return true;
        }
        return false;
    }
    /**
     * Generate an SVG visualization of an STL file from multiple angles
     * @param stlFilePath Path to the STL file
     * @param width Width of each view in pixels
     * @param height Height of each view in pixels
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated SVG file
     */
    async generateVisualization(stlFilePath, width = 300, height = 300, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting visualization generation...");
            // Load the STL file
            const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(50, "Setting up 3D scene...");
            // Create a scene
            const scene = new THREE.Scene();
            scene.add(mesh);
            // Create a camera
            const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
            // Calculate the ideal camera position based on bounding box
            const size = new THREE.Vector3();
            boundingBox.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = camera.fov * (Math.PI / 180);
            const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.5; // 1.5 is a factor for some padding
            // Add lighting to the scene
            const ambientLight = new THREE.AmbientLight(0x404040); // soft white light
            scene.add(ambientLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
            directionalLight.position.set(1, 1, 1).normalize();
            scene.add(directionalLight);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Generating SVG representation...");
            // Since we can't use the DOM-dependent SVGRenderer in a Node.js environment,
            // let's create a simple representation of the model using its bounding box
            // This is a simplified visual representation
            // Create SVG content with a simple representation of the STL model
            const viewBox = `0 0 ${width * 2} ${height * 2}`;
            let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width * 2}" height="${height * 2}">`;
            // Add a title and model info
            svgContent += `
        <text x="10" y="20" font-family="Arial" font-size="16" fill="black">
          STL Visualization: ${path.basename(stlFilePath)}
        </text>
        <text x="10" y="40" font-family="Arial" font-size="12" fill="black">
          Dimensions: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} mm
        </text>
      `;
            // Define views
            const views = [
                { name: "front", transform: "rotateY(0deg)" },
                { name: "side", transform: "rotateY(90deg)" },
                { name: "top", transform: "rotateX(90deg)" },
                { name: "isometric", transform: "rotateX(30deg) rotateY(45deg)" }
            ];
            // Draw each view
            for (let i = 0; i < views.length; i++) {
                const view = views[i];
                const x = (i % 2) * width + width / 2;
                const y = Math.floor(i / 2) * height + height / 2 + 50; // Add 50px for the header text
                // Calculate a representative size for the simple cube visualization
                const cubeSize = Math.min(width, height) * 0.4;
                // Draw a simple cube representation
                svgContent += `
          <g transform="translate(${x}, ${y})">
            <rect x="${-cubeSize / 2}" y="${-cubeSize / 2}" width="${cubeSize}" height="${cubeSize}" 
                  style="fill:#e0e0e0;stroke:#000;stroke-width:1;opacity:0.8;${view.transform}" />
            <text x="0" y="${cubeSize / 2 + 30}" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
              ${view.name}
            </text>
          </g>
        `;
                if (progressCallback)
                    progressCallback(60 + (i + 1) * 10, `Generated ${view.name} view`);
            }
            // Add STL information
            svgContent += `
        <g transform="translate(20, ${height * 2 - 60})">
          <text font-family="Arial" font-size="14" fill="black">
            File: ${path.basename(stlFilePath)}
          </text>
          <text y="20" font-family="Arial" font-size="12" fill="black">
            Vertices: ${mesh.geometry.attributes.position.count / 3}
          </text>
          <text y="40" font-family="Arial" font-size="12" fill="black">
            Dimensions: W:${size.x.toFixed(2)}mm × H:${size.y.toFixed(2)}mm × D:${size.z.toFixed(2)}mm
          </text>
        </g>
      `;
            // Close the SVG
            svgContent += '</svg>';
            if (progressCallback)
                progressCallback(90, "Visualization generated");
            if (progressCallback)
                progressCallback(90, "Saving visualization...");
            // Write the SVG to file
            const outputFileName = path.basename(stlFilePath, '.stl') + '_visualization.svg';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await writeFileAsync(outputFilePath, svgContent);
            if (progressCallback)
                progressCallback(100, "Visualization saved successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'visualization',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            console.error("Error generating visualization:", error);
            this.emit('operationError', {
                operationId,
                type: 'visualization',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to generate visualization: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Apply a specific transformation to a selected section of an STL file
     * This allows for targeted modifications of specific parts of a model
     */
    async modifySection(stlFilePath, selection, transformation, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting section modification...");
            // Load the STL file
            const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(40, "Identifying section to modify...");
            // Convert named sections to actual bounding boxes
            let selectionBox;
            if (selection === 'top') {
                // Select top third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const topThreshold = boundingBox.max.y - (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, topThreshold, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z));
            }
            else if (selection === 'bottom') {
                // Select bottom third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const bottomThreshold = boundingBox.min.y + (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, bottomThreshold, boundingBox.max.z));
            }
            else if (selection === 'center') {
                // Select middle third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const bottomThreshold = boundingBox.min.y + (height / 3);
                const topThreshold = boundingBox.max.y - (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, bottomThreshold, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, topThreshold, boundingBox.max.z));
            }
            else {
                // Use the provided bounding box
                selectionBox = selection;
            }
            if (progressCallback)
                progressCallback(50, "Applying transformation to selected section...");
            // Get position attribute for direct manipulation
            const positionAttribute = geometry.getAttribute('position');
            const positions = positionAttribute.array;
            // Create transformation matrix based on the requested operation
            let transformMatrix = new THREE.Matrix4();
            const center = new THREE.Vector3();
            selectionBox.getCenter(center);
            // Matrices for transforming around the selection center
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
            // Build the appropriate transformation matrix
            switch (transformation.type) {
                case 'scale':
                    if (typeof transformation.value === 'number') {
                        transformMatrix = new THREE.Matrix4().makeScale(transformation.value, transformation.value, transformation.value);
                    }
                    else {
                        const [scaleX, scaleY, scaleZ] = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
                    }
                    break;
                case 'rotate':
                    const rotValues = (typeof transformation.value === 'number')
                        ? [0, 0, transformation.value * Math.PI / 180]
                        : transformation.value.map(v => v * Math.PI / 180);
                    transformMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotValues[0], rotValues[1], rotValues[2], 'XYZ'));
                    break;
                case 'translate':
                    if (typeof transformation.value === 'number') {
                        const translateValue = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeTranslation(translateValue, translateValue, translateValue);
                    }
                    else {
                        const [transX, transY, transZ] = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeTranslation(transX, transY, transZ);
                    }
                    break;
                default:
                    throw new Error(`Unsupported transformation type: ${transformation.type}`);
            }
            // Build complete transformation (to origin, transform, back from origin)
            const finalTransform = new THREE.Matrix4()
                .multiply(fromOriginMatrix)
                .multiply(transformMatrix)
                .multiply(toOriginMatrix);
            // Create temporary vector for calculations
            const tempVector = new THREE.Vector3();
            try {
                // Apply transformation only to vertices within the selection box
                for (let i = 0; i < positionAttribute.count; i++) {
                    tempVector.fromBufferAttribute(positionAttribute, i);
                    // Check if this vertex is within our selection box
                    if (selectionBox.containsPoint(tempVector)) {
                        // Apply the transformation to this vertex
                        tempVector.applyMatrix4(finalTransform);
                        // Update the position in the buffer
                        positionAttribute.setXYZ(i, tempVector.x, tempVector.y, tempVector.z);
                    }
                }
                // Mark the attribute as needing an update
                positionAttribute.needsUpdate = true;
                // Update the geometry's bounding box
                geometry.computeBoundingBox();
            }
            catch (error) {
                console.error("Error modifying vertices:", error);
                throw new Error(`Failed to modify section: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_modified.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'modifySection',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'modifySection',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Enhanced version of extendBase with progress reporting
     * @param stlFilePath Path to the input STL file
     * @param extensionInches Amount to extend base in inches
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the modified STL file
     */
    async extendBase(stlFilePath, extensionInches, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting base extension operation...");
            console.log(`Extending base of ${stlFilePath} by ${extensionInches} inches`);
            // Load the STL file
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Creating extended base geometry...");
            // Find the minimum Y value (assuming Y is up, which is common in 3D printing)
            const minY = boundingBox.min.y;
            // Convert inches to millimeters (STL files typically use mm)
            const extensionMm = extensionInches * 25.4;
            // Create a transformation matrix to move the mesh up by the extension amount
            const matrix = new THREE.Matrix4().makeTranslation(0, extensionMm, 0);
            geometry.applyMatrix4(matrix);
            // Create a box geometry for the base extension
            const baseWidth = boundingBox.max.x - boundingBox.min.x;
            const baseDepth = boundingBox.max.z - boundingBox.min.z;
            const baseGeometry = new THREE.BoxGeometry(baseWidth, extensionMm, baseDepth);
            // Position the base geometry
            const baseMatrix = new THREE.Matrix4().makeTranslation((boundingBox.min.x + boundingBox.max.x) / 2, minY + extensionMm / 2, (boundingBox.min.z + boundingBox.max.z) / 2);
            baseGeometry.applyMatrix4(baseMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(70, "Merging geometries...");
            if (progressCallback)
                progressCallback(75, "Creating merged geometry...");
            // Create material for both meshes
            const material = new THREE.MeshStandardMaterial();
            // Create individual meshes
            const originalMesh = new THREE.Mesh(geometry, material);
            const baseMesh = new THREE.Mesh(baseGeometry, material);
            // Export each mesh separately and merge the STL strings
            const exporter = new STLExporter();
            const originalStl = exporter.parse(originalMesh);
            const baseStl = exporter.parse(baseMesh);
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_extended.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            if (progressCallback)
                progressCallback(90, "Saving extended STL...");
            // Write the combined STL data to file
            await writeFileAsync(outputFilePath, originalStl + baseStl);
            if (progressCallback)
                progressCallback(100, "STL saved successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'extendBase',
                success: true,
                output: outputFilePath
            });
            console.log(`Modified STL saved to ${outputFilePath}`);
            return outputFilePath;
        }
        catch (error) {
            console.error("Error extending STL base:", error);
            this.emit('operationError', {
                operationId,
                type: 'extendBase',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to extend STL base: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Slice an STL or 3MF file using the specified slicer
     * @param stlFilePath Path to the input STL or 3MF file
     * @param slicerType Type of slicer (prusaslicer, cura, slic3r, orcaslicer, bambustudio)
     * @param slicerPath Path to the slicer executable
     * @param slicerProfile Optional path to the slicer profile/config file
     * @param progressCallback Optional callback for progress updates
     * @param printerPreset Optional BambuStudio printer preset name (e.g., "Bambu Lab P1S 0.4 nozzle")
     * @param bambuOptions Optional BambuStudio-specific CLI flags
     * @returns Path to the generated G-code or sliced 3MF file
     */
    async sliceSTL(stlFilePath, slicerType, slicerPath, slicerProfile, progressCallback, printerPreset, bambuOptions) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        if (isPathLikeExecutable(slicerPath) && !fs.existsSync(slicerPath)) {
            throw new Error(`Slicer executable not found at: ${slicerPath}`);
        }
        if (slicerProfile && !fs.existsSync(slicerProfile)) {
            console.warn(`Slicer profile specified but not found: ${slicerProfile}. Slicer might use defaults.`);
            // Allow proceeding without profile, slicer might handle it
        }
        const outputFileName = path.basename(stlFilePath, '.stl') + '.gcode';
        let outputFilePath = path.join(this.tempDir, outputFileName);
        let args = [];
        try {
            if (progressCallback)
                progressCallback(0, `Starting slicing with ${slicerType}...`);
            switch (slicerType) {
                case 'prusaslicer':
                case 'slic3r': // PrusaSlicer and Slic3r share similar CLI args
                    args = [
                        '--slice',
                        '--output', outputFilePath,
                        '--load', slicerProfile || '', // Pass profile path
                        stlFilePath
                    ];
                    // Remove empty profile arg if not provided
                    args = args.filter(arg => arg !== '');
                    break;
                case 'cura':
                    // CuraEngine CLI args are different, often requiring -s for settings
                    // Example: curaengine slice -v -j cura_settings.json -s layer_height=0.2 -o output.gcode -l input.stl
                    // This requires parsing the profile or passing individual settings.
                    // Keeping it simple for now, assuming profile contains necessary info.
                    args = [
                        'slice',
                        '-l', stlFilePath,
                        '-o', outputFilePath
                    ];
                    if (slicerProfile) {
                        args.push('-j', slicerProfile); // Load settings from profile definition file
                    }
                    break;
                case 'bambustudio':
                case 'orcaslicer':
                case 'orcaslicer-bambulab':
                    // Bambu-compatible CLI: slice and export as 3MF with embedded gcode.
                    // FULU's OrcaSlicer-bambulab fork keeps this Bambu-style path.
                    // For 3MF input: slice in place and export sliced 3MF
                    // For STL input: slice and export as 3MF
                    {
                        const is3mf = stlFilePath.toLowerCase().endsWith('.3mf');
                        const outputBase = path.basename(stlFilePath, is3mf ? '.3mf' : '.stl');
                        const bambuOutputPath = path.join(this.tempDir, outputBase + '_sliced.3mf');
                        const outputDir = path.dirname(bambuOutputPath);
                        const rawBundle = this.resolveBambuLikeSettingsBundle(outputBase, slicerType, slicerProfile, printerPreset, bambuOptions);
                        // Opt-in flatten step: walks the BBL `inherits` chain so the
                        // CLI accepts what we hand it. See maybeFlattenBundle docstring.
                        const settingsBundle = slicerType === 'bambustudio'
                            ? await this.maybeFlattenBundle(rawBundle, bambuOptions, slicerPath)
                            : rawBundle;
                        args = [
                            '--slice', String(bambuOptions?.slicePlate ?? 0),
                            '--outputdir', outputDir,
                            '--export-3mf', path.basename(bambuOutputPath),
                        ];
                        if (settingsBundle.settingsArg) {
                            args.push('--load-settings', settingsBundle.settingsArg);
                        }
                        // Always allow newer-version 3MF files (the CLI rejects them by default)
                        args.push('--allow-newer-file');
                        // BambuSliceOptions flags
                        if (bambuOptions?.uptodate)
                            args.push('--uptodate');
                        if (bambuOptions?.ensureOnBed)
                            args.push('--ensure-on-bed');
                        if (bambuOptions?.enableTimelapse)
                            args.push('--enable-timelapse');
                        if (bambuOptions?.allowMixTemp)
                            args.push('--allow-mix-temp');
                        if (bambuOptions?.minSave)
                            args.push('--min-save');
                        if (bambuOptions?.skipModifiedGcodes)
                            args.push('--skip-modified-gcodes');
                        if (bambuOptions?.orient !== undefined)
                            args.push('--orient', bambuOptions.orient ? '1' : '0');
                        if (bambuOptions?.arrange !== undefined)
                            args.push('--arrange', bambuOptions.arrange ? '1' : '0');
                        if (bambuOptions?.repetitions !== undefined)
                            args.push('--repetitions', String(bambuOptions.repetitions));
                        if (bambuOptions?.scale !== undefined)
                            args.push('--scale', String(bambuOptions.scale));
                        if (bambuOptions?.rotate !== undefined)
                            args.push('--rotate', String(bambuOptions.rotate));
                        if (bambuOptions?.rotateX !== undefined)
                            args.push('--rotate-x', String(bambuOptions.rotateX));
                        if (bambuOptions?.rotateY !== undefined)
                            args.push('--rotate-y', String(bambuOptions.rotateY));
                        if (bambuOptions?.cloneObjects)
                            args.push('--clone-objects', bambuOptions.cloneObjects);
                        if (bambuOptions?.skipObjects)
                            args.push('--skip-objects', bambuOptions.skipObjects);
                        if (settingsBundle.filamentPaths.length > 0) {
                            args.push('--load-filaments', settingsBundle.filamentPaths.join(';'));
                            args.push('--load-defaultfila');
                        }
                        if (bambuOptions?.loadFilamentIds)
                            args.push('--load-filament-ids', bambuOptions.loadFilamentIds);
                        args.push(stlFilePath);
                        // Override outputFilePath for bambustudio since it produces 3MF, not gcode
                        outputFilePath = bambuOutputPath;
                    }
                    break;
                default:
                    throw new Error(`Unsupported slicer type: ${slicerType}`);
            }
            if (progressCallback)
                progressCallback(20, `Executing slicer: ${slicerPath} ${args.join(' ')}`);
            console.log(`Executing: ${slicerPath} ${args.join(' ')}`);
            // Execute the slicer
            await new Promise((resolve, reject) => {
                const process = execFile(slicerPath, args, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Slicer Error: ${error.message}`);
                        console.error(`Slicer Stderr: ${stderr}`);
                        reject(new Error(`Slicer failed: ${error.message}. Stderr: ${stderr}`));
                    }
                    else {
                        console.log(`Slicer Stdout: ${stdout}`);
                        if (stderr) {
                            console.warn(`Slicer Stderr: ${stderr}`); // Log stderr even on success
                        }
                        resolve();
                    }
                });
                // Optional: Add listeners for stdout/stderr for real-time progress if slicer provides it
                // process.stdout?.on('data', (data) => { console.log(`Slicer stdout: ${data}`); });
                // process.stderr?.on('data', (data) => { console.log(`Slicer stderr: ${data}`); });
                // Check for cancellation periodically
                const checkCancel = setInterval(() => {
                    if (!this.activeOperations.get(operationId)) {
                        clearInterval(checkCancel);
                        try {
                            process.kill(); // Attempt to kill the slicer process
                            reject(new Error("Slicing operation cancelled"));
                        }
                        catch (killError) {
                            console.error("Error attempting to kill slicer process:", killError);
                            reject(new Error("Slicing operation cancelled, but failed to kill process."));
                        }
                    }
                }, 500);
                process.on('exit', () => clearInterval(checkCancel));
                process.on('error', () => clearInterval(checkCancel)); // Ensure interval cleared on process error too
            });
            if (!this.activeOperations.get(operationId)) {
                // This check might be redundant if the promise rejected on kill, but good safety
                throw new Error("Slicing operation cancelled after process finished");
            }
            if (!fs.existsSync(outputFilePath)) {
                throw new Error(`Slicer finished but output file not found: ${outputFilePath}`);
            }
            if (progressCallback)
                progressCallback(100, "Slicing completed successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'slice',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            console.error(`Slicing failed for ${stlFilePath}:`, error);
            this.emit('operationError', {
                operationId,
                type: 'slice',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Enhanced version of confirmTemperatures with better error handling
     * @param gcodePath Path to the G-code file
     * @param expected Expected temperature settings
     * @param progressCallback Optional callback for progress updates
     * @returns Object with comparison results
     */
    async confirmTemperatures(gcodePath, expected, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting temperature verification...");
            // Verify the G-code file exists
            if (!fs.existsSync(gcodePath)) {
                throw new Error(`G-code file not found: ${gcodePath}`);
            }
            if (progressCallback)
                progressCallback(20, "Reading G-code file...");
            // Read the G-code file
            const gcode = await readFileAsync(gcodePath, 'utf8');
            const lines = gcode.split('\n');
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(50, "Analyzing temperature commands...");
            // Extract temperature settings from G-code
            const actual = {};
            const allTemperatures = { extruder: [], bed: [] };
            for (const line of lines) {
                // Look for extruder temperature (M104 or M109)
                const extruderMatch = line.match(/M10[49] S(\d+)/);
                if (extruderMatch) {
                    const temp = parseInt(extruderMatch[1], 10);
                    allTemperatures.extruder.push(temp);
                    // Keep the first temperature for compatibility with original function
                    if (!actual.extruder) {
                        actual.extruder = temp;
                    }
                }
                // Look for bed temperature (M140 or M190)
                const bedMatch = line.match(/M1[49]0 S(\d+)/);
                if (bedMatch) {
                    const temp = parseInt(bedMatch[1], 10);
                    allTemperatures.bed.push(temp);
                    // Keep the first temperature for compatibility with original function
                    if (!actual.bed) {
                        actual.bed = temp;
                    }
                }
            }
            if (progressCallback)
                progressCallback(80, "Comparing temperatures...");
            // Compare actual with expected
            let match = true;
            if (expected.extruder !== undefined && actual.extruder !== expected.extruder) {
                match = false;
            }
            if (expected.bed !== undefined && actual.bed !== expected.bed) {
                match = false;
            }
            if (progressCallback)
                progressCallback(100, "Temperature verification complete");
            this.emit('operationComplete', {
                operationId,
                type: 'confirmTemperatures',
                success: true,
                result: { match, actual, expected, allTemperatures }
            });
            return { match, actual, expected, allTemperatures };
        }
        catch (error) {
            console.error("Error confirming temperatures:", error);
            this.emit('operationError', {
                operationId,
                type: 'confirmTemperatures',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to confirm temperatures: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Merge vertices within a specified tolerance.
     */
    async mergeVertices(stlFilePath, tolerance = 0.01, // Default tolerance in mm
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting vertex merging...");
            const { geometry } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(60, "Merging vertices...");
            const originalVertexCount = geometry.attributes.position.count;
            const mergedGeometry = BufferGeometryUtils.mergeVertices(geometry, tolerance);
            const newVertexCount = mergedGeometry.attributes.position.count;
            console.log(`Merged vertices: ${originalVertexCount} -> ${newVertexCount} (Tolerance: ${tolerance}mm)`);
            if (progressCallback)
                progressCallback(70, `Vertices merged: ${originalVertexCount} -> ${newVertexCount}`);
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            const outputFileName = path.basename(stlFilePath, '.stl') + '_merged.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await this.saveSTL(mergedGeometry, outputFilePath, progressCallback); // 80-100% progress
            this.emit('operationComplete', { operationId, type: 'mergeVertices', success: true, output: outputFilePath, verticesRemoved: originalVertexCount - newVertexCount });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', { operationId, type: 'mergeVertices', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Center the model at the origin (0,0,0).
     */
    async centerModel(stlFilePath, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting centering operation...");
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(60, "Calculating center...");
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            if (center.lengthSq() < 0.0001) { // Already centered (or very close)
                if (progressCallback)
                    progressCallback(100, "Model is already centered.");
                console.log("Model already centered. No changes made.");
                this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: stlFilePath, message: "Model already centered." });
                return stlFilePath; // Return original path
            }
            if (progressCallback)
                progressCallback(70, `Applying translation: (${-center.x.toFixed(2)}, ${-center.y.toFixed(2)}, ${-center.z.toFixed(2)})`);
            const translationMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            geometry.applyMatrix4(translationMatrix);
            geometry.computeBoundingBox(); // Recompute bounds after moving
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            const outputFileName = path.basename(stlFilePath, '.stl') + '_centered.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await this.saveSTL(geometry, outputFilePath, progressCallback); // 80-100% progress
            this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: outputFilePath });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', { operationId, type: 'centerModel', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Rotate the model so its largest flat face lies on the XY plane (Z=0).
     */
    async layFlat(stlFilePath, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting lay flat operation...");
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50%
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(55, "Analyzing faces...");
            const positionAttribute = geometry.getAttribute('position');
            if (!positionAttribute)
                throw new Error("Geometry has no position attribute.");
            const faces = [];
            const vA = new THREE.Vector3();
            const vB = new THREE.Vector3();
            const vC = new THREE.Vector3();
            const faceNormal = new THREE.Vector3();
            const cb = new THREE.Vector3(), ab = new THREE.Vector3();
            // Iterate through faces (triangles)
            for (let i = 0; i < positionAttribute.count; i += 3) {
                vA.fromBufferAttribute(positionAttribute, i);
                vB.fromBufferAttribute(positionAttribute, i + 1);
                vC.fromBufferAttribute(positionAttribute, i + 2);
                // Calculate face normal
                cb.subVectors(vC, vB);
                ab.subVectors(vA, vB);
                cb.cross(ab);
                faceNormal.copy(cb).normalize();
                // Calculate face area (using cross product magnitude / 2)
                const area = cb.length() / 2;
                faces.push({
                    normal: faceNormal.clone(),
                    area: area,
                    vertices: [vA.clone(), vB.clone(), vC.clone()] // Store vertices if needed for center calculation
                });
            }
            if (faces.length === 0)
                throw new Error("No faces found in geometry.");
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(65, "Grouping faces by normal...");
            // Group faces by similar normal vectors (tolerance for floating point errors)
            const normalGroups = new Map();
            const tolerance = 1e-5;
            for (const face of faces) {
                let foundGroup = false;
                for (const [key, group] of normalGroups.entries()) {
                    if (face.normal.distanceToSquared(group.representativeNormal) < tolerance) {
                        group.totalArea += face.area;
                        // Optional: Average the normal? For now, just use the first one.
                        foundGroup = true;
                        break;
                    }
                }
                if (!foundGroup) {
                    const key = `${face.normal.x.toFixed(5)},${face.normal.y.toFixed(5)},${face.normal.z.toFixed(5)}`;
                    if (!normalGroups.has(key)) { // Ensure unique key even if floats slightly differ after toFixed
                        normalGroups.set(key, { totalArea: face.area, representativeNormal: face.normal });
                    }
                }
            }
            if (normalGroups.size === 0)
                throw new Error("Could not group faces by normal.");
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            if (progressCallback)
                progressCallback(75, "Finding largest flat surface...");
            // Find the group with the largest total area (excluding near-vertical faces)
            let largestArea = 0;
            let targetNormal = null;
            const upVector = new THREE.Vector3(0, 1, 0); // Assuming Y is up for most models initially?
            const downVector = new THREE.Vector3(0, 0, -1); // Target normal (pointing down)
            for (const group of normalGroups.values()) {
                // Check if the normal is reasonably horizontal (not too close to vertical Z)
                // Angle threshold could be adjusted (e.g., > 5 degrees from Z axis)
                if (Math.abs(group.representativeNormal.z) < 0.99 && group.totalArea > largestArea) {
                    largestArea = group.totalArea;
                    targetNormal = group.representativeNormal;
                }
            }
            if (!targetNormal) {
                // If no suitable horizontal face found, maybe pick the lowest Z face?
                // For now, throw an error or return unchanged.
                console.warn("Could not find a suitable large flat face to lay down. No changes made.");
                this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: stlFilePath, message: "No suitable flat face found." });
                return stlFilePath;
            }
            if (progressCallback)
                progressCallback(80, "Calculating rotation...");
            // Calculate the rotation needed to align targetNormal with downVector
            const quaternion = new THREE.Quaternion().setFromUnitVectors(targetNormal, downVector);
            const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
            // Rotate around the model's center
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
            // Apply rotation
            geometry.applyMatrix4(toOriginMatrix);
            geometry.applyMatrix4(rotationMatrix);
            geometry.applyMatrix4(fromOriginMatrix);
            // Translate so the new bottom is at Z=0
            geometry.computeBoundingBox(); // Recompute bounds after rotation
            const newMinZ = geometry.boundingBox.min.z;
            const translateToZeroMatrix = new THREE.Matrix4().makeTranslation(0, 0, -newMinZ);
            geometry.applyMatrix4(translateToZeroMatrix);
            geometry.computeBoundingBox(); // Final bounds
            if (!this.activeOperations.get(operationId))
                throw new Error("Operation cancelled");
            const outputFileName = path.basename(stlFilePath, '.stl') + '_flat.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await this.saveSTL(geometry, outputFilePath, progressCallback); // 90-100% progress
            this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: outputFilePath });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', { operationId, type: 'layFlat', error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
}
