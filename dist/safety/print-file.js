import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { MACHINE_LIMITS, normalizeMaterial, normalizeModel, validateTemperature } from './limits.js';
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const fail = (message) => { throw new Error(`Print safety: ${message}`); };
function list(value) {
    if (Array.isArray(value))
        return value.map(String).map(s => s.trim().replace(/^"|"$/g, ''));
    if (typeof value === 'string')
        return value.split(/[;,]/).map(s => s.trim().replace(/^"|"$/g, ''));
    return [];
}
function normalizeBed(value) {
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    const text = value.trim().toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
    if (['textured pei plate', 'textured plate'].includes(text))
        return 'textured pei plate';
    if (['supertack plate', 'cool plate supertack'].includes(text))
        return 'cool plate supertack';
    if (['smooth pei plate', 'high temp plate', 'high temperature plate', 'hot plate'].includes(text))
        return 'smooth pei plate';
    return text;
}
function metadataValues(metadata, keys) {
    return metadata.flatMap(data => keys.filter(key => data[key] !== undefined).map(key => data[key]));
}
function consistent(values, convert, field) {
    if (!values.length)
        return fail(`missing ${field} metadata; export a fully sliced Bambu job with machine, nozzle and filament settings`);
    const converted = values.map(convert);
    if (converted.some(value => value === undefined))
        return fail(`unknown or malformed ${field} metadata`);
    if (converted.some(value => JSON.stringify(value) !== JSON.stringify(converted[0])))
        return fail(`contradictory ${field} metadata`);
    return converted[0];
}
function stripComments(line) {
    let clean = '';
    let depth = 0;
    for (const char of line) {
        if (char === ';' && depth === 0)
            break;
        if (char === '(') {
            if (depth)
                fail('unsupported nested comment syntax');
            depth = 1;
        }
        else if (char === ')') {
            if (!depth)
                fail('unbalanced comment syntax');
            depth = 0;
            clean += ' ';
        }
        else if (!depth)
            clean += char;
    }
    if (depth)
        fail('unclosed comment syntax');
    return clean.trim();
}
/** A deliberately narrow parameter lexer for commands affecting heat/material selection.
 * Unknown nonthermal vendor commands do not require a global G-code allowlist.
 */
function parameters(text, flags = '') {
    const result = new Map();
    let rest = text.trim();
    while (rest) {
        const token = rest.match(/^([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))?/i);
        if (!token)
            return fail(`unsupported temperature command parameter syntax '${rest}'`);
        const key = token[1].toUpperCase();
        if (result.has(key))
            return fail(`duplicate ${key} temperature command parameter`);
        if (!token[2] && !flags.includes(key))
            return fail(`missing numeric ${key} temperature target or parameter`);
        result.set(key, token[2] === undefined ? NaN : Number(token[2]));
        rest = rest.slice(token[0].length).trimStart();
    }
    return result;
}
function validateBounds(headers, model, plate) {
    const volume = MACHINE_LIMITS[model].volume;
    const boxes = [];
    if (plate.bbox_all !== undefined)
        boxes.push(plate.bbox_all);
    if (plate.bbox_objects !== undefined) {
        if (!Array.isArray(plate.bbox_objects))
            fail('malformed declared object bounds');
        for (const object of plate.bbox_objects) {
            if (!object || typeof object !== 'object')
                fail('malformed declared object bounds');
            const box = object.bbox;
            if (box !== undefined)
                boxes.push(box);
        }
    }
    for (const box of boxes) {
        if (!Array.isArray(box) || box.length !== 4 || box.some(value => typeof value !== 'number' || !Number.isFinite(value)))
            fail('malformed declared object bounds');
        const [minX, minY, maxX, maxY] = box;
        if (minX < 0 || minY < 0 || maxX < minX || maxY < minY || maxX > volume[0] || maxY > volume[1])
            fail(`declared object bounds exceed ${model} printable volume`);
    }
    for (let axis = 0; axis < 3; axis++) {
        const name = 'xyz'[axis];
        const minimum = metadataValues(headers, [`min${name}`]);
        const maximum = metadataValues(headers, [`max${name}`]);
        if (!minimum.length && !maximum.length)
            continue;
        const number = (v) => typeof v === 'string' && NUMBER.test(v) && Number.isFinite(Number(v)) ? Number(v) : undefined;
        const low = consistent(minimum, number, `object bounds min${name}`);
        const high = consistent(maximum, number, `object bounds max${name}`);
        if (low < 0 || high < low || high > volume[axis])
            fail(`declared object bounds ${name}=${low}..${high} exceed ${model} printable volume 0..${volume[axis]} mm`);
    }
}
/** Inspect the exact selected plate. This does not simulate firmware or arbitrary motion:
 * only declared object bounds are checked, never purge/homing/wipe travel coordinates.
 * It also cannot authenticate self-declared metadata or the physical spool/nozzle.
 */
export async function inspectPrintFile(filePath, options) {
    const model = normalizeModel(options.model);
    if (!model)
        return fail(`unknown or missing printer model '${options.model}'`);
    const plateIndex = options.plateIndex ?? 0;
    if (!Number.isInteger(plateIndex) || plateIndex < 0)
        return fail('selected plate index must be a nonnegative integer');
    if (/\.md5$/i.test(filePath))
        return fail('a checksum file is not a printable artifact');
    const bytes = await readFile(filePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let source;
    let project = {};
    let plate = {};
    let plateInternalPath;
    if (/\.3mf$/i.test(filePath)) {
        const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
        plateInternalPath = `Metadata/plate_${plateIndex + 1}.gcode`;
        const entry = zip.file(plateInternalPath);
        if (!entry)
            return fail(`selected plate ${plateIndex + 1} has no printable ${plateInternalPath}; slice that plate first`);
        source = await entry.async('string');
        for (const [name, assign] of [["Metadata/project_settings.config", (data) => project = data], [`Metadata/plate_${plateIndex + 1}.json`, (data) => plate = data]]) {
            const config = zip.file(name);
            if (!config)
                continue;
            try {
                const data = JSON.parse(await config.async('string'));
                if (!data || Array.isArray(data) || typeof data !== 'object')
                    throw new Error('expected object');
                assign(data);
            }
            catch {
                return fail(`malformed ${name} metadata`);
            }
        }
    }
    else if (/\.gcode$/i.test(filePath)) {
        if (plateIndex !== 0)
            return fail('raw G-code has only plate index 0');
        source = bytes.toString('utf8');
    }
    else
        return fail('unsupported printable artifact; use a sliced .3mf or textual .gcode file');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(source))
        return fail('binary or malformed G-code is not supported');
    const lines = source.split(/\r\n|\n|\r/);
    const metadata = [project];
    for (const line of lines) {
        const match = line.match(/^\s*;\s*([a-z_][a-z0-9_]*(?:\s+used\s+\[(?:g|mm)\])?)\s*(?:=|:)\s*(.*?)\s*$/i);
        if (match)
            metadata.push({ [match[1].toLowerCase()]: match[2] });
    }
    const declaredModel = consistent(metadataValues(metadata, ['printer_model']), normalizeModel, 'printer model');
    if (declaredModel !== model)
        return fail(`file model ${declaredModel} contradicts requested model ${model}`);
    const nozzleDiameters = consistent(metadataValues(metadata, ['nozzle_diameter']), value => {
        const values = list(value);
        return values.length && values.every(v => NUMBER.test(v) && [0.2, 0.4, 0.6, 0.8].includes(Number(v))) ? values.map(Number) : undefined;
    }, 'nozzle diameter');
    if (options.nozzleDiameters && (options.nozzleDiameters.length === 1 ? !nozzleDiameters.every(value => value === options.nozzleDiameters[0]) : JSON.stringify(options.nozzleDiameters) !== JSON.stringify(nozzleDiameters)))
        return fail('file nozzle diameters contradict the requested nozzle diameters');
    if (plate.nozzle_diameter !== undefined) {
        const values = typeof plate.nozzle_diameter === 'number' ? [String(plate.nozzle_diameter)] : list(plate.nozzle_diameter);
        if (!values.length || values.some(value => !NUMBER.test(value) || !Number.isFinite(Number(value))) ||
            (values.length === 1 ? nozzleDiameters.some(diameter => Math.abs(diameter - Number(values[0])) > 1e-6) :
                values.length !== nozzleDiameters.length || values.some((value, index) => Math.abs(Number(value) - nozzleDiameters[index]) > 1e-6))) {
            fail('selected plate nozzle diameter metadata contradicts the sliced project nozzles');
        }
    }
    const nozzleMetadata = (keys) => {
        const values = metadataValues(metadata, keys);
        return values.length ? consistent(values, value => {
            const entries = list(value).map(entry => entry.toLowerCase().replace(/[\s_-]+/g, '_'));
            return entries.length === nozzleDiameters.length && entries.every(Boolean) ? entries : undefined;
        }, keys[0].replace(/_/g, ' ')) : undefined;
    };
    const nozzleTypes = nozzleMetadata(['nozzle_type']);
    const nozzleFlows = nozzleMetadata(['nozzle_flow', 'nozzle_volume_type']);
    const materials = consistent(metadataValues(metadata, ['filament_type']), value => {
        const values = list(value);
        return values.length && values.every(v => !!normalizeMaterial(v)) ? values.map(v => normalizeMaterial(v)) : undefined;
    }, 'filament material');
    const bedValues = metadataValues([...metadata, plate], ['curr_bed_type', 'bed_type']);
    const bedType = bedValues.length ? consistent(bedValues, normalizeBed, 'bed type') : undefined;
    if (options.bedType && (!bedType || normalizeBed(options.bedType) !== bedType))
        return fail('selected bed type cannot be verified or contradicts the sliced file; re-slice with the intended bed');
    validateBounds(metadata, model, plate);
    const used = new Set();
    const requirePosition = (position) => {
        if (!Number.isInteger(position) || position < 0 || position >= materials.length)
            return fail(`filament/tool position ${position} has no declared material`);
        used.add(position);
        return position;
    };
    if (plate.filament_ids !== undefined) {
        if (!Array.isArray(plate.filament_ids) || !plate.filament_ids.length)
            return fail('malformed selected plate filament_ids metadata');
        for (const value of plate.filament_ids) {
            if (typeof value !== 'number' || !Number.isInteger(value))
                return fail('malformed selected plate filament position');
            requirePosition(value);
        }
    }
    let active = materials.length === 1 ? 0 : undefined;
    let nozzleTarget = 0;
    let selectsAms = false;
    let pending;
    let previous;
    let maxNozzleTemperature = 0, maxBedTemperature = 0, maxChamberTemperature = 0, commandCount = 0;
    const heat = (component, value, position, allMaterials = false) => {
        const affected = allMaterials ? materials.map((_, index) => index) : position === undefined ? [...(used.size ? used : new Set(materials.map((_, index) => index)))] : [requirePosition(position)];
        validateTemperature(component, value, model, affected.map(index => materials[index]));
        if (component === 'nozzle') {
            nozzleTarget = value;
            maxNozzleTemperature = Math.max(maxNozzleTemperature, value);
            if (value > 0)
                affected.forEach(index => used.add(index));
        }
        else if (component === 'bed')
            maxBedTemperature = Math.max(maxBedTemperature, value);
        else
            maxChamberTemperature = Math.max(maxChamberTemperature, value);
    };
    for (let index = 0; index < lines.length; index++) {
        try {
            let line = stripComments(lines[index]);
            if (!line || line === '%')
                continue;
            line = line.replace(/^N\d+\s*/i, '').replace(/\*\d+\s*$/, '');
            if (/[{}\[\]#]/.test(line))
                fail('unresolved dynamic command syntax');
            const command = line.match(/^([GMT])(\d+(?:\.\d+)?)(?=$|\s|[A-Z+-])/i);
            if (!command)
                fail(`unsupported G-code command syntax '${line.slice(0, 100)}'`);
            const [base, subcode] = command[2].split('.');
            const code = command[1].toUpperCase() + String(Number(base)) + (subcode === undefined ? '' : '.' + subcode);
            const argumentsText = line.slice(command[0].length).trim();
            commandCount++;
            if (!['M117', 'M118', 'M1002', 'M1006', 'M900', 'M970', 'M983.1', 'G383'].includes(code) && /[GM]\s*\d/i.test(argumentsText))
                fail('multiple commands on one line are unsupported');
            if (/^T\d+$/.test(code)) {
                const position = Number(code.slice(1));
                if ([254, 255, 1000, 1001, 1100, 65279, 65535].includes(position)) {
                    previous = active;
                    active = undefined;
                }
                else {
                    validateTemperature('nozzle', nozzleTarget, model, [materials[requirePosition(position)]]);
                    selectsAms = true;
                    previous = active;
                    active = position;
                }
                continue;
            }
            if (['M104', 'M109', 'M140', 'M190', 'M141', 'M191'].includes(code)) {
                const args = parameters(argumentsText, 'A');
                for (const key of args.keys())
                    if (!'SRTA'.includes(key))
                        fail(`unsupported ${code} temperature parameter ${key}`);
                if (!args.has('S') && !args.has('R'))
                    fail(`missing ${code} temperature target`);
                const component = ['M104', 'M109'].includes(code) ? 'nozzle' : ['M140', 'M190'].includes(code) ? 'bed' : 'chamber';
                // Heater T is a physical nozzle, unlike standalone remapped T filament selection.
                // Without a verified per-filament nozzle map, apply all possible materials.
                if (args.has('T') && (!Number.isInteger(args.get('T')) || args.get('T') < 0 || args.get('T') >= nozzleDiameters.length))
                    fail('physical heater target has no declared nozzle');
                const position = args.has('T') ? undefined : active;
                for (const key of ['S', 'R'])
                    if (args.has(key))
                        heat(component, args.get(key), position, args.has('T') || args.has('A'));
            }
            else if (code === 'M620' || code === 'M621') {
                const args = parameters(argumentsText, 'MA');
                if (args.has('S')) {
                    const position = args.get('S');
                    if ([254, 255, 65279, 65535].includes(position)) {
                        if (code === 'M621') {
                            previous = active;
                            active = undefined;
                        }
                        pending = undefined;
                    }
                    else {
                        selectsAms = true;
                        requirePosition(position);
                        if (code === 'M620')
                            pending = position;
                        else {
                            validateTemperature('nozzle', nozzleTarget, model, [materials[position]]);
                            previous = active;
                            active = position;
                            pending = undefined;
                        }
                    }
                }
            }
            else if (code === 'M620.1' || code === 'M620.10') {
                const args = parameters(argumentsText, 'E');
                const position = code === 'M620.10' && args.get('A') === 1 ? pending ?? active : code === 'M620.10' && args.get('A') === 0 ? active : undefined;
                for (const key of code === 'M620.10' ? ['T', 'P'] : ['T'])
                    if (args.has(key))
                        heat('nozzle', args.get(key), position);
            }
            else if (code === 'G383') {
                // Bambu probing command carries a nozzle-temperature threshold in T.
                const args = parameters(argumentsText);
                if (args.has('T'))
                    heat('nozzle', args.get('T'), active);
            }
            else if (code === 'M620.17') {
                const args = parameters(argumentsText);
                if (!args.has('S') || !args.has('L') || !args.has('T') || !Number.isInteger(args.get('T')) || args.get('T') < 0 || args.get('T') >= nozzleDiameters.length)
                    fail('unsupported M620.17 nozzle/material temperature mapping');
                for (const key of args.keys())
                    if (!'SLT'.includes(key))
                        fail(`unsupported M620.17 parameter ${key}`);
                heat('nozzle', args.get('S'), requirePosition(args.get('L')));
            }
            else if ((/^M620\./.test(code) && !['M620.3', 'M620.6', 'M620.11'].includes(code)) || /^M621\./.test(code)) {
                fail(`unsupported thermal-affecting filament command ${code}`);
            }
            else if (code === 'M145') {
                const args = parameters(argumentsText);
                if (args.size !== 1 || !args.has('P') || ![0, 1].includes(args.get('P')) || !['h2d', 'h2dpro', 'h2c', 'h2s', 'x2d'].includes(model))
                    fail('unsupported thermal-affecting M145 parameters');
            }
            else if (code === 'M142') {
                // Bambu chamber fan regulation thresholds, not an active heater command.
                const args = parameters(argumentsText);
                for (const key of ['S', 'R'])
                    if (args.has(key) && (!Number.isFinite(args.get(key)) || args.get(key) < 0 || args.get(key) > 65))
                        fail('unsupported chamber fan temperature threshold');
            }
            else if (/^(?:M(?:104|109|140|190|141|191)\.|M(?:143|144|145|149|301|302|303|304|306|307|568|570|950|98|32)$)/.test(code) || (code === 'G10' && /[SR]/i.test(argumentsText))) {
                fail(`unsupported thermal-affecting or external program command ${code}; re-slice with standard Bambu heater commands`);
            }
        }
        catch (error) {
            throw new Error(`Print safety line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!commandCount)
        return fail('selected G-code contains no printable commands');
    if (!used.size)
        materials.forEach((_, index) => used.add(index));
    return { model, nozzleDiameters, materials, usedFilamentPositions: [...used].sort((a, b) => a - b), plateInternalPath, sha256, maxNozzleTemperature, maxBedTemperature, maxChamberTemperature, bedType, selectsAms, nozzleTypes, nozzleFlows };
}
