import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import * as fs from 'fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { readSafe3mfArchive } from './safety/archive.js';
// Parses Bambu Studio's JSON config data
function parseBambuJSONConfig(jsonData) {
    const config = {};
    const amsMapping = {};
    // Map known keys, converting types as needed
    if (jsonData.layer_height !== undefined)
        config.layer_height = parseFloat(jsonData.layer_height);
    if (jsonData.initial_layer_print_height !== undefined)
        config.first_layer_height = parseFloat(jsonData.initial_layer_print_height);
    if (jsonData.sparse_infill_density !== undefined)
        config.sparse_infill_density = parseFloat(jsonData.sparse_infill_density);
    if (jsonData.sparse_infill_pattern !== undefined)
        config.sparse_infill_pattern = String(jsonData.sparse_infill_pattern);
    if (jsonData.enable_support !== undefined)
        config.support_enabled = String(jsonData.enable_support) === '1' || String(jsonData.enable_support).toLowerCase() === 'true';
    if (jsonData.support_type !== undefined)
        config.support_type = String(jsonData.support_type);
    if (jsonData.support_angle !== undefined)
        config.support_threshold_angle = parseFloat(jsonData.support_angle);
    if (jsonData.raft_layers !== undefined)
        config.raft_layers = parseInt(String(jsonData.raft_layers), 10);
    if (jsonData.brim_width !== undefined)
        config.brim_width = parseFloat(jsonData.brim_width);
    if (jsonData.wall_loops !== undefined)
        config.wall_loops = parseInt(String(jsonData.wall_loops), 10);
    if (jsonData.top_shell_layers !== undefined)
        config.top_shell_layers = parseInt(String(jsonData.top_shell_layers), 10);
    if (jsonData.bottom_shell_layers !== undefined)
        config.bottom_shell_layers = parseInt(String(jsonData.bottom_shell_layers), 10);
    // Temperatures (handle potential arrays)
    if (Array.isArray(jsonData.nozzle_temperature) && jsonData.nozzle_temperature.length > 0) {
        config.nozzle_temperature = jsonData.nozzle_temperature.map((t) => parseFloat(String(t)));
    }
    else if (jsonData.nozzle_temperature !== undefined) {
        config.nozzle_temperature = [parseFloat(String(jsonData.nozzle_temperature))];
    }
    // Bed Temp (prefer initial layer temp)
    let bedTempKey = jsonData.hot_plate_temp_initial_layer !== undefined ? 'hot_plate_temp_initial_layer' : 'hot_plate_temp';
    if (jsonData[bedTempKey] !== undefined) {
        if (Array.isArray(jsonData[bedTempKey]) && jsonData[bedTempKey].length > 0) {
            config.bed_temperature = parseFloat(String(jsonData[bedTempKey][0]));
        }
        else {
            config.bed_temperature = parseFloat(String(jsonData[bedTempKey]));
        }
    }
    // Filaments and Flow (handle potential arrays)
    if (Array.isArray(jsonData.filament_type) && jsonData.filament_type.length > 0) {
        config.filament_type = jsonData.filament_type.map(String);
    }
    if (Array.isArray(jsonData.filament_flow_ratio) && jsonData.filament_flow_ratio.length > 0) {
        config.flow_ratio = jsonData.filament_flow_ratio.map((f) => parseFloat(String(f)));
    }
    // AMS Mapping (derive from filament_settings_id order)
    if (Array.isArray(jsonData.filament_settings_id) && jsonData.filament_settings_id.length > 0) {
        jsonData.filament_settings_id.forEach((filamentId, index) => {
            // Map filament ID (e.g., "Generic PLA @BBL P1P") to its index (assumed AMS slot)
            if (filamentId) { // Ensure filamentId is not empty
                amsMapping[filamentId] = index;
            }
        });
        if (Object.keys(amsMapping).length > 0) {
            config.ams_mapping = amsMapping;
        }
    }
    // Store remaining keys found in the config
    for (const key in jsonData) {
        if (!config.hasOwnProperty(key)) {
            // Simple assignment for remaining keys, preserving original type if possible
            config[key] = jsonData[key];
        }
    }
    return config;
}
/** The files a 3MF's slicer settings are read from, first found wins. */
const SLICER_SETTINGS_FILES = [
    'Metadata/project_settings.config',
    'Metadata/Slic3r_PE.config',
    'Metadata/model_settings.config',
    'Metadata/slice_info.config'
];
/** Whether a 3MF carries a slicer settings file at all (readable or not). */
export async function hasSlicerSettingsFile(filePath) {
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    return SLICER_SETTINGS_FILES.some(name => zip.file(name));
}
async function parseBambuConfig(zip) {
    // Look for common Bambu config file names
    const potentialFiles = SLICER_SETTINGS_FILES;
    let configFile = null;
    let configContent = '';
    for (const name of potentialFiles) {
        const file = zip.file(name);
        if (file) {
            configFile = file;
            configContent = await file.async('string');
            console.error(`Found Bambu config file: ${configFile.name}`);
            break; // Use the first one found (project usually has the most)
        }
    }
    if (configFile && configContent) {
        try {
            // Attempt to parse as JSON
            const jsonData = JSON.parse(configContent);
            const parsedConfig = parseBambuJSONConfig(jsonData);
            console.error('Bambu config parsed successfully as JSON.');
            return parsedConfig;
        }
        catch (jsonError) {
            console.warn(`Failed to parse ${configFile.name} as JSON: ${jsonError.message}. Attempting INI parse as fallback...`);
            // Fallback: Try parsing as INI if JSON fails (though unlikely based on sample)
            try {
                const parsedConfig = parseFallbackINIConfig(configContent); // Keep a simple INI parser as fallback
                console.error('Bambu config parsed successfully as INI (fallback).');
                return parsedConfig;
            }
            catch (iniError) {
                console.error(`Error parsing Bambu config ${configFile.name} as INI (fallback):`, iniError);
                return {};
            }
        }
    }
    else {
        console.error('No Bambu-specific config file found in Metadata directory.');
        return {};
    }
}
// Fallback INI parser (Simplified version of the previous one)
function parseFallbackINIConfig(configContent) {
    const config = {};
    const lines = configContent.split(/\r?\n/);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';'))
            continue;
        const equalsIndex = trimmedLine.indexOf('=');
        if (equalsIndex === -1)
            continue;
        const key = trimmedLine.substring(0, equalsIndex).trim();
        const value = trimmedLine.substring(equalsIndex + 1).trim();
        // Simple assignment - no type conversion here for fallback
        config[key] = value;
    }
    return config;
}
async function parse3DModelConfig(zip) {
    const modelFile = zip.file('3D/3dmodel.model');
    if (!modelFile) {
        throw new Error('3D/3dmodel.model not found in 3MF archive');
    }
    const modelContent = await modelFile.async('string');
    try {
        const parsedXml = await parseStringPromise(modelContent, {
            explicitArray: false,
            mergeAttrs: true,
            charkey: 'value'
        });
        const modelData = parsedXml.model;
        if (!modelData) {
            throw new Error('Invalid 3dmodel.model format: <model> tag not found.');
        }
        const metadata = { unit: modelData.unit || 'millimeter' };
        if (modelData.metadata) {
            const metas = Array.isArray(modelData.metadata) ? modelData.metadata : [modelData.metadata];
            metas.forEach((meta) => {
                if (meta.name && meta.value !== undefined) {
                    metadata[meta.name] = String(meta.value);
                }
            });
        }
        const objects = [];
        if (modelData.resources?.object) {
            const resources = Array.isArray(modelData.resources.object) ? modelData.resources.object : [modelData.resources.object];
            resources.forEach((objResource) => {
                objects.push({
                    id: objResource.id,
                    name: objResource.name,
                    type: objResource.type || 'model'
                    // Actual mesh data (vertices, triangles) is nested deeper if needed
                });
            });
        }
        const buildItems = [];
        if (modelData.build?.item) {
            const items = Array.isArray(modelData.build.item) ? modelData.build.item : [modelData.build.item];
            items.forEach((item) => {
                buildItems.push({
                    objectId: item.objectid,
                    transform: item.transform
                });
            });
        }
        console.error('3dmodel.model parsed successfully.');
        return { metadata, objects, build: { items: buildItems } };
    }
    catch (error) {
        console.error('Error parsing 3dmodel.model XML:', error);
        throw new Error(`Failed to parse 3dmodel.model: ${error.message}`);
    }
}
export async function parse3MF(filePath) {
    console.error(`Parsing 3MF file: ${filePath}`);
    try {
        const data = await fs.readFile(filePath);
        const zip = await JSZip.loadAsync(data);
        // List files for debugging
        // const fileList = Object.keys(zip.files);
        // console.error('Files in 3MF:', fileList);
        const { metadata, objects, build } = await parse3DModelConfig(zip);
        const bambuConfig = await parseBambuConfig(zip);
        // Combine data into the final structure
        const combinedData = {
            metadata,
            objects,
            build,
            slicerConfig: bambuConfig
        };
        console.error('3MF parsing completed.');
        return combinedData;
    }
    catch (error) {
        console.error(`Error parsing 3MF file ${filePath}:`, error);
        throw new Error(`Failed to parse 3MF file: ${error.message}`);
    }
}
/** Whether a 3MF carries its own Bambu Studio/Orca process (a designer's project, not a bare mesh archive). */
export async function hasBambuProjectSettings(filePath) {
    try {
        const zip = await JSZip.loadAsync(await fs.readFile(filePath));
        const settings = zip.file('Metadata/project_settings.config');
        if (!settings)
            return false;
        const parsed = JSON.parse(await settings.async('string'));
        return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.layer_height !== undefined;
    }
    catch {
        return false;
    }
}
const extractionScope = new AsyncLocalStorage();
/** Runs one operation; the directory of every settings file extracted during it is removed when it settles. */
export async function withExtractedSettingsCleanup(operation) {
    const dirs = [];
    try {
        return await extractionScope.run(dirs, operation);
    }
    finally {
        await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    }
}
/**
 * Writes a 3MF's slicer settings to a file of their own and returns its path. Each extraction gets its own directory,
 * removed when the surrounding withExtractedSettingsCleanup operation settles. `keep` is for a path handed back to the
 * caller: it is named by content, so repeat calls reuse one file, and written whole before it is renamed into place.
 */
export async function extractBambuTemplateSettings(filePath, outputDir, options = {}) {
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    const potentialFiles = SLICER_SETTINGS_FILES;
    for (const name of potentialFiles) {
        const file = zip.file(name);
        if (!file)
            continue;
        const content = await file.async('string');
        if (options.keep) {
            const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
            const outputPath = path.join(outputDir, `${digest}_${name.replace(/\//g, '_')}`);
            const partial = `${outputPath}.${randomUUID()}.partial`;
            await fs.writeFile(partial, content, 'utf8');
            await fs.rename(partial, outputPath);
            return outputPath;
        }
        // Its own directory for every extraction, so two slices at once (of different projects or the same one)
        // never share, overwrite or half-read one settings file.
        const dir = await fs.mkdtemp(path.join(outputDir, 'slicer-settings-'));
        extractionScope.getStore()?.push(dir);
        const outputPath = path.join(dir, name.replace(/\//g, '_'));
        await fs.writeFile(outputPath, content, 'utf8');
        return outputPath;
    }
    throw new Error(`No slicer settings config found in template 3MF: ${filePath}`);
}
const COLLAR_CHARM_ROLE_COLORS = {
    inner: 'black',
    outer: 'white',
};
const COLLAR_CHARM_ROLE_AMS_SLOTS = {
    // User-facing convention:
    // - inner/smaller object -> AMS 1 slot 1 black
    // - outer/larger object -> AMS 2 slot 1 white
    // Internal absolute tray indices are 0-based:
    // AMS 1 slot 1 -> absolute tray 0
    // AMS 2 slot 1 -> absolute tray 4
    inner: 0,
    outer: 4,
};
export async function analyzeCollarCharm3MF(filePath, plateIndex = 0) {
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    const plateName = `Metadata/plate_${plateIndex + 1}.json`;
    const plateFile = zip.file(plateName);
    if (!plateFile) {
        throw new Error(`Prepared collar charm 3MF is missing ${plateName}. Slice the project first or export a printable 3MF.`);
    }
    const plateJson = JSON.parse(await plateFile.async('string'));
    const bboxObjects = Array.isArray(plateJson?.bbox_objects) ? plateJson.bbox_objects : [];
    const usedFilamentPositions = Array.isArray(plateJson?.filament_ids)
        ? plateJson.filament_ids.filter((value) => Number.isInteger(value)).map((value) => value)
        : [];
    if (bboxObjects.length !== 2) {
        throw new Error(`Collar charm wrapper requires exactly 2 plate objects; found ${bboxObjects.length} in ${plateName}.`);
    }
    if (usedFilamentPositions.length !== 2) {
        throw new Error(`Collar charm wrapper requires exactly 2 used filament positions; found ${usedFilamentPositions.length} in ${plateName}.`);
    }
    if (bboxObjects.length !== usedFilamentPositions.length) {
        throw new Error(`Collar charm wrapper requires object count and used filament count to match; found ${bboxObjects.length} objects and ${usedFilamentPositions.length} filament positions in ${plateName}.`);
    }
    const normalizedObjects = bboxObjects.map((object, objectIndex) => {
        const area = Number(object?.area);
        if (!Number.isFinite(area) || area <= 0) {
            throw new Error(`Collar charm object ${objectIndex} in ${plateName} has invalid area metadata.`);
        }
        const name = typeof object?.name === 'string' && object.name.trim().length > 0
            ? object.name.trim()
            : `object_${objectIndex + 1}`;
        return {
            objectIndex,
            name,
            area,
            filamentPosition: usedFilamentPositions[objectIndex],
        };
    });
    const sortedByArea = [...normalizedObjects].sort((a, b) => a.area - b.area);
    if (sortedByArea[0].area === sortedByArea[1].area) {
        throw new Error(`Collar charm wrapper could not distinguish inner vs outer object because both plate objects have the same reported area in ${plateName}.`);
    }
    const roles = [
        {
            role: 'inner',
            objectIndex: sortedByArea[0].objectIndex,
            name: sortedByArea[0].name,
            area: sortedByArea[0].area,
            filamentPosition: sortedByArea[0].filamentPosition,
        },
        {
            role: 'outer',
            objectIndex: sortedByArea[1].objectIndex,
            name: sortedByArea[1].name,
            area: sortedByArea[1].area,
            filamentPosition: sortedByArea[1].filamentPosition,
        },
    ];
    const trayByFilamentPosition = new Map();
    for (const role of roles) {
        trayByFilamentPosition.set(role.filamentPosition, COLLAR_CHARM_ROLE_AMS_SLOTS[role.role]);
    }
    const amsSlots = usedFilamentPositions.map((position) => {
        const tray = trayByFilamentPosition.get(position);
        if (tray === undefined) {
            throw new Error(`Collar charm wrapper could not assign a tray to project filament position ${position}.`);
        }
        return tray;
    });
    return {
        plateIndex,
        usedFilamentPositions,
        amsSlots,
        roles,
    };
}
export function getCollarCharmRolePolicy() {
    return {
        colors: COLLAR_CHARM_ROLE_COLORS,
        amsSlots: COLLAR_CHARM_ROLE_AMS_SLOTS,
    };
}
export async function analyze3MFAmsRequirements(filePath, plateIndex = 0) {
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    const plateNumber = plateIndex + 1;
    const plateName = `Metadata/plate_${plateNumber}.json`;
    const plateFile = zip.file(plateName);
    if (!plateFile) {
        throw new Error(`3MF is missing ${plateName}; cannot derive AMS filament order.`);
    }
    const plateJson = JSON.parse(await plateFile.async('string'));
    const usedFilamentPositions = Array.isArray(plateJson?.filament_ids)
        ? plateJson.filament_ids.filter((value) => Number.isInteger(value)).map((value) => value)
        : [];
    if (usedFilamentPositions.length === 0) {
        throw new Error(`${plateName} does not declare filament_ids; cannot derive AMS filament order.`);
    }
    const sliceInfo = zip.file('Metadata/slice_info.config');
    const filamentById = new Map();
    if (sliceInfo) {
        try {
            const parsed = await parseStringPromise(await sliceInfo.async('string'), {
                explicitArray: false,
                mergeAttrs: true,
            });
            const plateNodes = parsed?.config?.plate
                ? Array.isArray(parsed.config.plate) ? parsed.config.plate : [parsed.config.plate]
                : [];
            const selectedPlate = plateNodes.find((plate) => {
                const metadata = Array.isArray(plate?.metadata)
                    ? plate.metadata
                    : plate?.metadata
                        ? [plate.metadata]
                        : [];
                return metadata.some((item) => item?.key === 'index' && Number(item?.value) === plateNumber);
            }) || plateNodes[plateIndex] || plateNodes[0];
            const filamentNodes = selectedPlate?.filament
                ? Array.isArray(selectedPlate.filament) ? selectedPlate.filament : [selectedPlate.filament]
                : [];
            for (const filament of filamentNodes) {
                const id = Number.parseInt(String(filament?.id ?? ''), 10);
                if (!Number.isFinite(id))
                    continue;
                filamentById.set(id, {
                    tray_info_idx: typeof filament?.tray_info_idx === 'string' ? filament.tray_info_idx : null,
                    type: typeof filament?.type === 'string' ? filament.type : null,
                    color: typeof filament?.color === 'string' ? filament.color : null,
                });
            }
        }
        catch {
            // plate_N.json already gives the project filament order. Bad
            // slice_info should degrade metadata only, not block AMS planning.
        }
    }
    return {
        plateIndex,
        usedFilamentPositions,
        filaments: usedFilamentPositions.map((position, order) => {
            const filamentId = position + 1;
            const byOneBasedId = filamentById.get(filamentId);
            const byOrder = Array.from(filamentById.values())[order];
            const filament = byOneBasedId || byOrder || null;
            return {
                filamentPosition: position,
                filamentId,
                tray_info_idx: filament?.tray_info_idx ?? null,
                type: filament?.type ?? null,
                color: filament?.color ?? null,
            };
        }),
    };
}
/**
 * The objects of one sliced plate that the printer can skip, as Bambu Studio lists them in its skip dialog
 * (02.08.02.61 slic3r/GUI/PartSkipDialog.cpp:734-741, SkipPartCanvas.cpp:690-730): one entry per instance
 * from Metadata/slice_info.config's plate whose `index` matches (written per instance at bbs_3mf.cpp:8718-8750),
 * with its identify_id. plate_N.json's bbox_objects are not paired by position: their `id` is an internal
 * object id the printer doesn't know (BambuStudio.cpp:7374-7382), and copies share a name. The wipe tower
 * is never a slice_info object.
 */
export async function analyze3MFPlateObjects(filePath, plateIndex = 0) {
    // Bounded, with colliding or inconsistent entry names refused, as the other 3MF reads here.
    const { zip } = await readSafe3mfArchive(filePath);
    const plateNumber = plateIndex + 1;
    const sliceInfo = zip.file('Metadata/slice_info.config');
    if (!sliceInfo) {
        throw new Error('This 3MF has no Metadata/slice_info.config, so it was not sliced by Bambu Studio or OrcaSlicer and has no skip-object ids. Slice it first.');
    }
    const parsed = await parseStringPromise(await sliceInfo.async('string'), { explicitArray: true });
    const plates = parsed?.config?.plate ?? [];
    const selected = plates.find(plate => (plate?.metadata ?? [])
        .some((item) => item?.$?.key === 'index' && Number(item?.$?.value) === plateNumber));
    if (!selected) {
        throw new Error(`Plate ${plateNumber} was not sliced in this 3MF, so it has no skip-object ids.`);
    }
    const labelObjectEnabled = (selected.metadata ?? [])
        .some((item) => item?.$?.key === 'label_object_enabled' && item?.$?.value === 'true');
    const instances = (selected.object ?? []).flatMap((object) => {
        const id = Number(object?.$?.identify_id);
        if (!Number.isSafeInteger(id) || id <= 0)
            return [];
        return [{ id, name: typeof object.$.name === 'string' ? object.$.name : `object_${id}`, skipped: object.$.skipped === 'true' }];
    });
    // First-layer area and box, attached by name only where one instance and one box carry it.
    const boxes = new Map();
    const plateFile = zip.file(`Metadata/plate_${plateNumber}.json`);
    if (plateFile) {
        try {
            const plateJson = JSON.parse(await plateFile.async('string'));
            for (const box of Array.isArray(plateJson?.bbox_objects) ? plateJson.bbox_objects : []) {
                if (typeof box?.name !== 'string' || box.name === 'wipe_tower')
                    continue;
                boxes.set(box.name, [...(boxes.get(box.name) ?? []), box]);
            }
        }
        catch {
            // The ids above still stand without the boxes.
        }
    }
    const nameCount = new Map();
    for (const instance of instances)
        nameCount.set(instance.name, (nameCount.get(instance.name) ?? 0) + 1);
    return {
        plateIndex,
        labelObjectEnabled,
        objects: instances.map((instance) => {
            const box = nameCount.get(instance.name) === 1 && boxes.get(instance.name)?.length === 1 ? boxes.get(instance.name)[0] : undefined;
            return {
                ...instance,
                area: box && Number.isFinite(Number(box.area)) ? Number(box.area) : null,
                bbox: box?.bbox ?? null,
            };
        }),
    };
}
