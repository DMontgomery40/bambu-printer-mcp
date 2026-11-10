import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { CadRefusal, cadFailure } from "./cad/refusal.js";
import { withCadLock } from "./cad/serial.js";
import { measureEnvironment, snapshotInputs, storageInfo, } from "./cad/storage.js";
import { cadSandbox, defaultCadSystem } from "./cad/process.js";
import { counterpartBuild, counterpartFit, counterpartInspect, counterpartStatus, } from "./cad/counterpart.js";
const ASSETS = fileURLToPath(new URL("../src/cad/", import.meta.url));
const BUILD123D = "0.13.0";
const PACKAGE_NAME = createRequire(import.meta.url)("../package.json")
    .name;
function engineOf(args) {
    const e = args.engine ??
        (typeof args.script_path === "string" && /\.mjs$/i.test(args.script_path)
            ? "counterpart"
            : "build123d");
    if (e !== "build123d" && e !== "counterpart")
        throw new Error("engine must be build123d or counterpart.");
    return e;
}
export class CadEngine {
    constructor(options) {
        this.options = options;
        this.system = options.system ?? defaultCadSystem;
        this.dataDir = path.resolve(options.dataDir ??
            process.env.CAD_DATA_DIR ??
            path.join(process.platform === "darwin"
                ? path.join(os.homedir(), "Library", "Application Support")
                : (process.env.XDG_DATA_HOME ??
                    path.join(os.homedir(), ".local", "share")), PACKAGE_NAME, "cad"));
    }
    async status() {
        const python = path.join(this.dataDir, "runtime", "bin", "python");
        const configured = await fs.stat(python).then((s) => s.isFile(), () => false);
        let ready = false;
        let sizeMarker;
        try {
            const marker = JSON.parse(await fs.readFile(path.join(this.dataDir, "ready.json"), "utf8"));
            sizeMarker = marker.storage;
            ready =
                configured &&
                    marker.build123d === BUILD123D &&
                    marker.platform === this.system.platform &&
                    marker.fingerprint === (await this.fingerprint()) &&
                    marker.dataDevice === (await fs.stat(this.dataDir)).dev;
        }
        catch {
            /* setup not verified */
        }
        return {
            counterpart: await counterpartStatus(),
            configured,
            ready,
            python: configured ? python : null,
            build123d: BUILD123D,
            platform: this.system.platform,
            storage: storageInfo(sizeMarker, configured ||
                (await Promise.all(["runtime", "python", "cache"].map((name) => fs.stat(path.join(this.dataDir, name)).then(() => true, () => false)))).some(Boolean)),
            ...(!ready
                ? {
                    error: "Run cad_setup with install: true to install and verify the confined CAD runtime.",
                }
                : {}),
        };
    }
    async failure(error, tool) {
        const storage = await this.status().then((status) => status.storage, () => storageInfo(undefined, true));
        return { ...cadFailure(error, tool), storage };
    }
    async allowedDirectory(value) {
        if (typeof value !== "string" || !value)
            throw new Error("output_dir must be an existing allowed output directory.");
        const dir = await fs.realpath(path.resolve(value)).catch(() => {
            throw new Error("output_dir must be an existing allowed output directory.");
        });
        for (const root of this.options.outputRoots) {
            const real = await fs.realpath(path.resolve(root)).catch(() => undefined);
            if (real &&
                (dir === real || dir.startsWith(real + path.sep)) &&
                (await fs.stat(dir)).isDirectory())
                return dir;
        }
        throw new Error("output_dir is outside the allowed output directories (TEMP_DIR or trusted CAD_OUTPUT_DIRS).");
    }
    environment(home) {
        return {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: home,
            TMPDIR: path.join(home, "tmp"),
            TMP: path.join(home, "tmp"),
            TEMP: path.join(home, "tmp"),
            LANG: "en_US.UTF-8",
            PYTHONDONTWRITEBYTECODE: "1",
            MPLCONFIGDIR: path.join(home, "tmp", "mpl"),
            OPENBLAS_NUM_THREADS: "1",
            OMP_NUM_THREADS: "1",
            VECLIB_MAXIMUM_THREADS: "1",
            UV_CACHE_DIR: path.join(this.dataDir, "cache"),
            UV_PYTHON_INSTALL_DIR: path.join(this.dataDir, "python"),
            UV_NO_CONFIG: "1",
        };
    }
    async exclusive(work, operation = "fit", signal, deadline) {
        return withCadLock(this.dataDir, { operation, signal, deadline }, work);
    }
    async confined(mode, request, job, readonly, timeoutMs, signal, inputDirectories = []) {
        const python = path.join(this.dataDir, "runtime", "bin", "python");
        const sandbox = await cadSandbox(this.system.platform, {
            data: this.dataDir,
            job,
            assets: ASSETS,
            python,
            readonly,
            inputs: inputDirectories,
        });
        await fs.mkdir(path.join(job, "tmp"), { recursive: true, mode: 0o700 });
        return this.system.run(sandbox.command, [
            ...sandbox.args,
            python,
            "-I",
            "-B",
            path.join(ASSETS, "worker.py"),
            mode,
            request,
        ], {
            env: this.environment(job),
            cwd: job,
            timeoutMs,
            signal,
        });
    }
    async setup(args, signal) {
        only(args, ["install"]);
        if (args.install !== undefined && typeof args.install !== "boolean")
            throw new Error("install must be a boolean.");
        if (args.install !== true)
            return {
                supported: ["darwin", "linux"].includes(this.system.platform),
                ...(await this.status()),
            };
        if (!["darwin", "linux"].includes(this.system.platform))
            throw new CadRefusal("cad-confinement-unavailable", `CAD confinement is unavailable on ${this.system.platform}.`);
        return this.exclusive(async () => {
            signal?.throwIfAborted();
            const env = this.environment(this.dataDir);
            await this.requireSupportedStorage(env, signal);
            await fs.mkdir(env.TMPDIR, { recursive: true });
            await fs.unlink(path.join(this.dataDir, "ready.json")).catch(() => { });
            const python = path.join(this.dataDir, "runtime", "bin", "python");
            const opts = { env, cwd: this.dataDir, signal, timeoutMs: 600000 };
            try {
                if (!(await fs.stat(python).then((s) => s.isFile(), () => false)))
                    await this.system.run("uv", [
                        "venv",
                        "--managed-python",
                        "--python",
                        "3.12",
                        "--no-config",
                        path.join(this.dataDir, "runtime"),
                    ], opts);
                await this.system.run("uv", [
                    "pip",
                    "sync",
                    "--python",
                    python,
                    "--only-binary",
                    ":all:",
                    "--no-config",
                    path.join(ASSETS, "requirements.lock"),
                ], opts);
            }
            catch (e) {
                if (e.code === "ENOENT")
                    throw new CadRefusal("cad-uv-missing", "uv is not available on the MCP's PATH. Install uv, then run cad_setup again; no model was run.");
                throw e;
            }
            await this.system.run(python, ["-I", "-B", path.join(ASSETS, "worker.py"), "imports"], { ...opts, timeoutMs: 120000 });
            const job = await fs.mkdtemp(path.join(this.dataDir, "verify-"));
            const request = path.join(job, "request.json");
            await fs.writeFile(request, JSON.stringify({ output: job, home: os.homedir() }), { mode: 0o600 });
            const result = JSON.parse((await this.confined("smoke", request, job, [request], 180000, signal)).stdout);
            if (result.build123d !== BUILD123D ||
                !result.watertight ||
                !result.manifold ||
                !result.step_valid ||
                result.solid_count !== 1)
                throw new Error("CAD setup's confined STL/STEP round trip failed.");
            const storage = {
                installed_bytes: await measureEnvironment(this.dataDir),
                measured_at: new Date().toISOString(),
            };
            await fs.writeFile(path.join(this.dataDir, "ready.json"), JSON.stringify({
                build123d: BUILD123D,
                platform: this.system.platform,
                verifiedAt: new Date().toISOString(),
                fingerprint: await this.fingerprint(),
                dataDevice: (await fs.stat(this.dataDir)).dev,
                storage,
            }), { mode: 0o600 });
            return {
                supported: true,
                ...(await this.status()),
                installed: true,
                message: "CAD is ready; confined import, build, STL and STEP round trip passed. No native files were re-signed.",
            };
        }, "setup", signal);
    }
    async fingerprint() {
        const hash = createHash("sha256");
        for (const file of [
            "requirements.lock",
            "worker.py",
            "geometry.py",
            "process.ts",
            "storage.ts",
            "serial.ts",
            "refusal.ts",
            "contracts.ts",
        ])
            hash.update(await fs.readFile(path.join(ASSETS, file)));
        hash.update(await fs.readFile(new URL("../src/cad-engine.ts", import.meta.url)));
        for (const file of [
            "process.js",
            "storage.js",
            "serial.js",
            "refusal.js",
            "contracts.js",
        ])
            hash.update(await fs.readFile(new URL(`./cad/${file}`, import.meta.url)));
        hash.update(await fs.readFile(new URL("./cad-engine.js", import.meta.url)));
        return hash.digest("hex");
    }
    async requireSupportedStorage(env, signal) {
        if (this.system.platform !== "darwin")
            return;
        const error = () => new CadRefusal("cad-data-volume-refused", "Code-CAD on macOS requires an internal disk with file ownership enabled. External and network data volumes are unsupported after measured native-import stalls. Set CAD_DATA_DIR to an internal folder and rerun cad_setup; nothing was installed by this attempt.");
        try {
            const opts = { env, cwd: this.dataDir, timeoutMs: 10000, signal };
            const df = await this.system.run("/bin/df", ["-P", this.dataDir], opts);
            const device = df.stdout
                .trim()
                .split(/\r?\n/)
                .at(-1)
                ?.trim()
                .split(/\s+/)[0];
            if (!device || !/^\/dev\/disk\d+(?:s\d+)*$/.test(device))
                throw error();
            const info = await this.system.run("/usr/sbin/diskutil", ["info", "-plist", device], opts);
            if (!/<key>Internal<\/key>\s*<true\s*\/>/.test(info.stdout) ||
                !/<key>GlobalPermissionsEnabled<\/key>\s*<true\s*\/>/.test(info.stdout))
                throw error();
        }
        catch (e) {
            if (signal?.aborted)
                throw e;
            throw error();
        }
    }
    async inputFile(value, extension) {
        if (typeof value !== "string" ||
            path.extname(value).toLowerCase() !== extension)
            throw new Error(`Expected an allowed ${extension} file.`);
        const file = await fs.realpath(path.resolve(value));
        await this.allowedDirectory(path.dirname(file));
        const st = await fs.stat(file);
        if (!st.isFile() || st.size > 64 * 1024 * 1024)
            throw new Error("CAD input must be a regular file no larger than 64 MiB.");
        return file;
    }
    async run(args, signal) {
        const started = performance.now();
        only(args, [
            "script",
            "script_path",
            "parameters",
            "output_dir",
            "name",
            "timeout_ms",
            "inputs",
            "mode",
            "final",
            "engine",
        ]);
        const engine = engineOf(args);
        const ext = engine === "counterpart" ? ".mjs" : ".py";
        const root = await this.allowedDirectory(args.output_dir);
        const name = plainName(args.name);
        const timeout = milliseconds(args.timeout_ms), deadline = started + timeout;
        if (args.final !== undefined && typeof args.final !== "boolean")
            throw new Error("final must be a boolean.");
        if (root.split(path.sep).includes(".cad-inputs"))
            throw new Error("output_dir cannot be inside the reserved CAD input cache.");
        const remaining = () => {
            const value = Math.floor(deadline - performance.now());
            if (value <= 0)
                throw new Error("CAD run timed out.");
            return value;
        };
        if ((args.script === undefined) === (args.script_path === undefined))
            throw new Error("Supply exactly one of script or script_path.");
        const source = args.script === undefined
            ? await fs.readFile(await this.inputFile(args.script_path, ext), "utf8")
            : args.script;
        if (typeof source !== "string" ||
            !source.trim() ||
            Buffer.byteLength(source) > 256 * 1024)
            throw new Error(`script must be nonempty ${engine === "counterpart" ? "JavaScript module" : "Python"} text no larger than 256 KiB.`);
        const overrides = args.parameters ?? {};
        if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
            throw new Error("parameters must be a JSON object.");
        const mode = args.mode ?? "solid";
        if (mode !== "solid" && mode !== "mesh")
            throw new Error("mode must be solid or mesh.");
        if (engine === "counterpart" && mode !== "solid")
            throw new Error("The counterpart engine builds solids only; load a scan inside build() with loadMesh(name) and cut it with scanPocket.");
        let requestedInputs;
        if (args.inputs !== undefined) {
            if (!Array.isArray(args.inputs) || args.inputs.length > 16)
                throw new Error("inputs must be an array of at most 16 {name, path} files.");
            const named = Object.create(null);
            for (const item of args.inputs) {
                if (!item ||
                    typeof item !== "object" ||
                    Array.isArray(item) ||
                    Object.keys(item).some((k) => k !== "name" && k !== "path") ||
                    typeof item.name !== "string" ||
                    typeof item.path !== "string" ||
                    Object.prototype.hasOwnProperty.call(named, item.name))
                    throw new Error("Each input needs a unique name and an allowed path.");
                named[item.name] = item.path;
            }
            requestedInputs = named;
        }
        if (requestedInputs === undefined && typeof args.script_path === "string") {
            const file = args.script_path.replace(/\.(py|mjs)$/i, ".inputs.json");
            try {
                requestedInputs = JSON.parse(await fs.readFile(await this.inputFile(file, ".json"), "utf8"));
            }
            catch (e) {
                if (e.code !== "ENOENT")
                    throw e;
            }
        }
        const inputs = {};
        if (requestedInputs !== undefined) {
            if (!requestedInputs ||
                typeof requestedInputs !== "object" ||
                Array.isArray(requestedInputs) ||
                Object.keys(requestedInputs).length > 16)
                throw new Error("inputs must name at most 16 local files.");
            for (const [alias, value] of Object.entries(requestedInputs)) {
                if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias) ||
                    typeof value !== "string")
                    throw new Error("Each input needs a plain alias and an allowed file path.");
                const ext = path.extname(value).toLowerCase();
                inputs[alias] = await this.inputFile(value, ext);
            }
        }
        return this.exclusive(async (queueWaitMs) => {
            const status = await this.status();
            if (engine === "build123d" && !status.ready)
                throw new CadRefusal("cad-not-ready", status.error);
            if (engine === "counterpart" && !status.counterpart?.ready)
                throw new CadRefusal("cad-not-ready", status.counterpart?.error ?? "The counterpart engine is unavailable.");
            const job = await fs.mkdtemp(path.join(root, `cad-${name}-`));
            await fs.chmod(job, 0o700);
            const script = path.join(job, `${name}${ext}`), parameters = path.join(job, `${name}.parameters.json`), request = path.join(job, ".cad-request.json");
            const resultManifest = path.join(job, "cad-result.json");
            const lineage = createHash("sha256").update(source).digest("hex");
            await fs.writeFile(script, source, { mode: 0o600 });
            let previous = {};
            if (args.script_path !== undefined) {
                try {
                    previous = JSON.parse(await fs.readFile(await this.inputFile(String(args.script_path).replace(/\.(py|mjs)$/i, ".parameters.json"), ".json"), "utf8"));
                }
                catch (e) {
                    if (e.code !== "ENOENT")
                        throw e;
                }
            }
            await fs.writeFile(parameters, JSON.stringify({ ...previous, ...overrides }), { mode: 0o600 });
            await atomicJson(resultManifest, {
                status: "pending",
                final: args.final === true,
                lineage_id: lineage,
            });
            try {
                remaining();
                signal?.throwIfAborted();
                const snapshot = await snapshotInputs(root, inputs, signal, {
                    directory: path.join(this.dataDir, "input-index"),
                    authorize: (directory) => this.allowedDirectory(directory),
                });
                const snapshots = snapshot.inputs, manifest = path.join(job, `${name}.inputs.json`);
                await fs.writeFile(manifest, JSON.stringify(snapshots, null, 2), {
                    mode: 0o600,
                });
                const base = {
                    output: job,
                    name,
                    script,
                    parameters,
                    mode,
                    inputs: snapshots,
                };
                await fs.writeFile(request, JSON.stringify(base), { mode: 0o600 });
                const protectedFiles = [
                    script,
                    parameters,
                    request,
                    manifest,
                    resultManifest,
                    ...(snapshot.directory ? [snapshot.directory] : []),
                ];
                const readableInputs = snapshot.directory ? [snapshot.directory] : [];
                if (engine === "counterpart") {
                    await fs.mkdir(this.dataDir, { recursive: true });
                    const t = performance.now();
                    const receipt = await counterpartBuild(this.system, {
                        data: this.dataDir,
                        job,
                        name,
                        script,
                        parameters,
                        inputs: snapshots,
                        readonly: protectedFiles,
                        inputDirs: readableInputs,
                        timeoutMs: remaining(),
                        signal,
                    });
                    const out = path.join(job, "out");
                    await fs.copyFile(path.join(out, `${name}.stl`), path.join(job, `${name}.stl`));
                    await fs.copyFile(path.join(out, `${name}.3mf`), path.join(job, `${name}.3mf`));
                    // the kernel validated the overrides against P and wrote the effective values it built with
                    await fs.copyFile(path.join(out, `${name}.params.json`), parameters);
                    const checked = await counterpartInspect(this.system, {
                        data: this.dataDir,
                        job,
                        name,
                        stl: path.join(job, `${name}.stl`),
                        readonly: protectedFiles,
                        timeoutMs: remaining(),
                        signal,
                    });
                    const parts = receipt.parts ?? [];
                    const result = {
                        ...checked,
                        engine: "counterpart",
                        status: "completed",
                        final: args.final === true,
                        completed_at: new Date().toISOString(),
                        lineage_id: lineage,
                        result_manifest: resultManifest,
                        script,
                        parameters,
                        inputs: snapshots,
                        input_manifest: manifest,
                        input_hashes: snapshot.hashes,
                        snapshot_bytes_added: snapshot.added,
                        snapshot_bytes_reused: snapshot.reused,
                        queue_wait_ms: queueWaitMs,
                        stl: path.join(job, `${name}.stl`),
                        step: null,
                        step_unavailable: "The counterpart engine exports STL and 3MF (one object per body); it has no STEP B-rep.",
                        threemf: path.join(job, `${name}.3mf`),
                        // what the parts must do, as the kernel's features stated it, measured and proved in this run
                        requirements_pass: receipt.all_requirements_pass === true,
                        parts: parts.map((p) => ({ name: p.name, failing: p.failing, passing: p.passing, physics: p.physics, sized: p.sized, fits: p.fits })),
                        kernel_receipt: path.join(out, `${name}.result.json`),
                        seconds: (performance.now() - t) / 1000,
                    };
                    await atomicJson(resultManifest, result);
                    return result;
                }
                const effective = JSON.parse((await this.system.run(status.python, [
                    "-I",
                    "-B",
                    path.join(ASSETS, "worker.py"),
                    "parameters",
                    request,
                ], {
                    env: this.environment(job),
                    cwd: job,
                    timeoutMs: Math.min(10000, remaining()),
                    signal,
                })).stdout);
                await fs.writeFile(parameters, JSON.stringify(effective, null, 2), {
                    mode: 0o600,
                });
                const t = performance.now();
                const built = await this.confined("build", request, job, protectedFiles, remaining(), signal, readableInputs);
                await fs.writeFile(path.join(job, "build.log"), (built.stdout + "\n" + (built.stderr ?? "")).slice(-200000), { mode: 0o600, flag: "wx" });
                for (const ext of mode === "solid" ? ["stl", "step"] : ["stl"]) {
                    const st = await fs.lstat(path.join(job, `${name}.${ext}`));
                    if (!st.isFile() || st.size === 0 || st.size > 64 * 1024 * 1024)
                        throw new Error(`CAD ${ext} export is missing, unsafe or too large.`);
                }
                const checked = JSON.parse((await this.confined("inspect", request, job, protectedFiles, remaining(), signal, readableInputs)).stdout);
                const result = {
                    ...checked,
                    status: "completed",
                    final: args.final === true,
                    completed_at: new Date().toISOString(),
                    lineage_id: lineage,
                    result_manifest: resultManifest,
                    script,
                    parameters,
                    inputs: snapshots,
                    input_manifest: manifest,
                    input_hashes: snapshot.hashes,
                    snapshot_bytes_added: snapshot.added,
                    snapshot_bytes_reused: snapshot.reused,
                    queue_wait_ms: queueWaitMs,
                    stl: path.join(job, `${name}.stl`),
                    step: mode === "solid" ? path.join(job, `${name}.step`) : null,
                    ...(mode === "mesh"
                        ? {
                            step_unavailable: "Mesh mode has no parametric B-rep; STEP export is unavailable.",
                        }
                        : {}),
                    seconds: (performance.now() - t) / 1000,
                };
                await atomicJson(resultManifest, result);
                return result;
            }
            catch (e) {
                await atomicJson(resultManifest, {
                    status: "failed",
                    final: false,
                    final_requested: args.final === true,
                    lineage_id: lineage,
                    message: e instanceof Error ? e.message : String(e),
                    script,
                    parameters,
                }).catch(() => { });
                const message = `${e instanceof Error ? e.message : String(e)} Checkpoint retained: ${script} and ${parameters}.`;
                if (e instanceof CadRefusal)
                    throw new CadRefusal(e.code, message);
                throw new Error(message);
            }
        }, "run", signal, deadline);
    }
    async checkFit(args, signal) {
        only(args, [
            "model",
            "reference",
            "transform",
            "clearance_mm",
            "timeout_ms",
            "engine",
        ]);
        const engine = args.engine ?? "build123d";
        if (engine !== "build123d" && engine !== "counterpart")
            throw new Error("engine must be build123d or counterpart.");
        const model = await this.inputFile(args.model, ".stl"), reference = await this.inputFile(args.reference, ".stl");
        const clearance = args.clearance_mm ?? 0;
        if (typeof clearance !== "number" ||
            !Number.isFinite(clearance) ||
            clearance < 0 ||
            clearance > 100)
            throw new Error("clearance_mm must be finite, between 0 and 100.");
        return this.exclusive(async () => {
            const status = await this.status();
            if (engine === "build123d" && !status.ready)
                throw new CadRefusal("cad-not-ready", status.error);
            if (engine === "counterpart" && !status.counterpart?.ready)
                throw new CadRefusal("cad-not-ready", status.counterpart?.error ?? "The counterpart engine is unavailable.");
            await fs.mkdir(this.dataDir, { recursive: true });
            const job = await fs.mkdtemp(path.join(this.dataDir, "fit-"));
            try {
                await fs.copyFile(model, path.join(job, "model.stl"));
                await fs.copyFile(reference, path.join(job, "reference.stl"));
                const request = path.join(job, "request.json");
                await fs.writeFile(request, JSON.stringify({
                    model: path.join(job, "model.stl"),
                    reference: path.join(job, "reference.stl"),
                    transform: args.transform ?? {},
                    clearance_mm: clearance,
                }));
                if (engine === "counterpart")
                    return await counterpartFit(this.system, {
                        data: this.dataDir,
                        job,
                        request,
                        readonly: [request, path.join(job, "model.stl"), path.join(job, "reference.stl")],
                        timeoutMs: milliseconds(args.timeout_ms),
                        signal,
                    });
                return JSON.parse((await this.confined("fit", request, job, [
                    request,
                    path.join(job, "model.stl"),
                    path.join(job, "reference.stl"),
                ], milliseconds(args.timeout_ms), signal)).stdout);
            }
            finally {
                await fs.rm(job, { recursive: true, force: true });
            }
        }, "fit", signal);
    }
}
function only(args, keys) {
    if (Object.keys(args).some((k) => !keys.includes(k)))
        throw new Error(`CAD accepts only ${keys.join(", ")}.`);
}
function plainName(name) {
    if (typeof name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) ||
        name.includes(".."))
        throw new Error("name must be a plain filename stem (up to 64 characters).");
    return name;
}
function milliseconds(value) {
    if (value === undefined)
        return 120000;
    if (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 100 ||
        value > 900000)
        throw new Error("timeout_ms must be an integer from 100 to 900000.");
    return value;
}
async function atomicJson(file, value) {
    const temporary = path.join(path.dirname(file), `.cad-result-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
            flag: "wx",
            mode: 0o600,
        });
        await fs.rename(temporary, file);
    }
    finally {
        await fs.unlink(temporary).catch(() => { });
    }
}
