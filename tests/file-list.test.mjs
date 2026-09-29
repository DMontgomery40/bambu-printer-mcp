import assert from "node:assert/strict";
import { test } from "node:test";
import { Client as FTPClient } from "basic-ftp";
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { BambuImplementation } from "../dist/printers/bambu.js";

const credentials = ["127.0.0.1", "TEST", "DUMMY"];
const directory = name => ({ name, isDirectory: true });
const file = name => ({ name, isDirectory: false });

function ftp(t, entries, { accessError, listErrors = {} } = {}) {
  const calls = [];
  t.mock.method(FTPClient.prototype, "access", async options => {
    calls.push(["access", options]);
    if (accessError) throw accessError;
  });
  t.mock.method(FTPClient.prototype, "list", async path => {
    calls.push(["list", path]);
    if (listErrors[path]) throw listErrors[path];
    assert.ok(Object.hasOwn(entries, path), `unexpected listing: ${path}`);
    return entries[path];
  });
  t.mock.method(FTPClient.prototype, "ensureDir", async () => {
    assert.fail("listing must never create directories or change the working directory");
  });
  t.mock.method(FTPClient.prototype, "close", () => calls.push(["close"]));
  return calls;
}

test("file listing preserves its response and uses shared FTPS options and absolute paths", async t => {
  const calls = ftp(t, {
    "/": [directory("cache"), directory("timelapse"), directory("logs")],
    "/cache": [file("part.3mf")],
    "/timelapse": [file("video.mp4")],
    "/logs": [],
  });
  const result = await new BambuImplementation().getFiles(...credentials);
  assert.deepEqual(result, {
    files: ["cache/part.3mf", "timelapse/video.mp4"],
    directories: { cache: ["part.3mf"], timelapse: ["video.mp4"], logs: [] },
  });
  const options = calls[0][1];
  assert.equal(options.host, credentials[0]);
  assert.equal(options.password, credentials[2]);
  assert.equal(options.user, "bblp");
  assert.equal(options.port, 990);
  assert.equal(options.secure, "implicit");
  assert.equal(options.secureOptions.host, credentials[0]);
  assert.deepEqual(calls.slice(1), [["list", "/"], ["list", "/cache"], ["list", "/timelapse"], ["list", "/logs"], ["close"]]);
});

test("optional directories absent from a successful root listing remain empty without creation", async t => {
  const calls = ftp(t, { "/": [directory("timelapse")], "/timelapse": [] });
  assert.deepEqual(await new BambuImplementation().getFiles(...credentials), {
    files: [], directories: { cache: [], timelapse: [], logs: [] },
  });
  assert.deepEqual(calls.slice(1), [["list", "/"], ["list", "/timelapse"], ["close"]]);
});

for (const code of [522, "ECONNRESET", "ETIMEDOUT", 550]) {
  for (const path of ["/", "/timelapse"]) {
    test(`file listing propagates ${code} from ${path} instead of returning empty or partial success`, async t => {
      const failure = Object.assign(new Error(`simulated ${code}`), { code });
      const calls = ftp(t, {
        "/": [directory("cache"), directory("timelapse"), directory("logs")],
        "/cache": [file("part.3mf")],
      }, { listErrors: { [path]: failure } });
      await assert.rejects(new BambuImplementation().getFiles(...credentials), error => error === failure);
      assert.deepEqual(calls.at(-1), ["close"]);
      assert.equal(calls.some(call => call[0] === "list" && call[1] === "/logs"), false);
    });
  }
}

test("file listing closes the FTP client when authentication fails", async t => {
  const failure = Object.assign(new Error("simulated login failure"), { code: 530 });
  const calls = ftp(t, {}, { accessError: failure });
  await assert.rejects(new BambuImplementation().getFiles(...credentials), error => error === failure);
  assert.deepEqual(calls.slice(1), [["close"]]);
});

test("MCP tool and resource report listing failures instead of successful empty results", async () => {
  // Intercept only the FTP boundary in a fresh server, without printer traffic.
  const preload = `
    import { Client } from ${JSON.stringify(import.meta.resolve("basic-ftp"))};
    Client.prototype.access = async () => {};
    Client.prototype.list = async () => { throw new Error("522 simulated TLS session failure"); };
    Client.prototype.close = () => {};
    Client.prototype.ensureDir = async () => { throw new Error("unexpected directory creation"); };
  `;
  const client = new MCPClient({ name: "file-list-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`, fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { PATH: process.env.PATH || "", MCP_TRANSPORT: "stdio", PRINTER_HOST: credentials[0], BAMBU_SERIAL: credentials[1], BAMBU_TOKEN: credentials[2], BAMBU_MODEL: "p1s" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "list_printer_files", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /522 simulated TLS session failure/);
    await assert.rejects(client.readResource({ uri: "printer://127.0.0.1/files" }), /522 simulated TLS session failure/);
  } finally {
    await client.close();
  }
});
