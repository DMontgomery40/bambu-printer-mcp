import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
/** Private, bounded single-writer journal. Never place it inside a repository/package. */
export class EventStore {
    constructor(filename, limit = 1000) {
        var _a, _b;
        this.filename = filename;
        this.limit = limit;
        this.closed = false;
        if (!Number.isInteger(limit) || limit < 1)
            throw new Error("Invalid event history limit");
        this.filename = resolve(filename);
        this.lock = `${this.filename}.lock`;
        // A retained lock fails closed: the operator must confirm the old process exited.
        const fd = openSync(this.lock, "wx", 0o600);
        closeSync(fd);
        try {
            this.data = existsSync(this.filename) ? JSON.parse(readFileSync(this.filename, "utf8")) : {
                version: 1, sequence: 0, history: [],
                observation: { active: false, cancelled: false, terminal: false, problems: [] }, subscriptions: [],
            };
            if (this.data.version !== 1 || !Number.isSafeInteger(this.data.sequence) || this.data.sequence < 0 ||
                !Array.isArray(this.data.history) || !Array.isArray(this.data.subscriptions) ||
                !this.data.observation || !Array.isArray(this.data.observation.problems)) {
                throw new Error("Invalid print event journal");
            }
            (_a = this.data).journalId ?? (_a.journalId = randomUUID());
            (_b = this.data).printerSequences ?? (_b.printerSequences = {});
            for (const event of this.data.history) {
                const printer = event.data.printer;
                const previous = Object.prototype.hasOwnProperty.call(this.data.printerSequences, printer) ? this.data.printerSequences[printer] : 0;
                event.printerCursor ?? (event.printerCursor = printer === "default" ? event.cursor : String(previous + 1));
                this.data.printerSequences[printer] = Math.max(previous, Number(event.printerCursor));
            }
            this.save();
        }
        catch (error) {
            unlinkSync(this.lock);
            throw error;
        }
    }
    observation(printer = "default") {
        var _a;
        if (printer === "default")
            return this.data.observation;
        (_a = this.data).observations ?? (_a.observations = {});
        if (!Object.prototype.hasOwnProperty.call(this.data.observations, printer))
            this.data.observations[printer] = { active: false, cancelled: false, terminal: false, problems: [] };
        return this.data.observations[printer];
    }
    save() {
        if (this.closed)
            throw new Error("Event journal is closed");
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify(this.data));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        try {
            renameSync(temporary, this.filename);
            if (process.platform !== "win32") {
                const directory = openSync(dirname(this.filename), "r");
                try {
                    fsyncSync(directory);
                }
                finally {
                    closeSync(directory);
                }
            }
        }
        finally {
            if (existsSync(temporary))
                unlinkSync(temporary);
        }
    }
    printerHead(printer) {
        return Object.prototype.hasOwnProperty.call(this.data.printerSequences, printer) ? this.data.printerSequences[printer] : 0;
    }
    append(event) {
        const printerSequence = this.printerHead(event.data.printer) + 1;
        this.data.printerSequences[event.data.printer] = printerSequence;
        const saved = { ...event, cursor: String(++this.data.sequence), printerCursor: String(printerSequence) };
        this.data.history.push(saved);
        const removed = this.data.history.slice(0, Math.max(0, this.data.history.length - this.limit));
        for (const subscription of this.data.subscriptions) {
            if (removed.some(item => item.name === subscription.name && item.data.printer === (subscription.printer ?? "default") && Number(item.printerCursor) > subscription.position))
                subscription.stopped = true;
        }
        this.data.history = this.data.history.slice(-this.limit);
        return saved; // Caller commits event and observation atomically with save().
    }
    close() {
        if (!this.closed) {
            this.closed = true;
            unlinkSync(this.lock);
        }
    }
}
