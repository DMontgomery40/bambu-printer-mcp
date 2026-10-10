import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { printWithBambuNative, sendCommandWithBambuNative } from "../dist/bambu-native.js";

const options = { host: "127.0.0.1", serial: "20PDISPATCH", token: "DUMMY", filePath: "/tmp/dummy.3mf",
  projectName: "test", presetName: "test", plateIndex: 0, bedType: "textured_plate", useAMS: false };
const controlOptions = print => ({ ...options, messageJson: JSON.stringify({ print }) });
const hazardousCommands = [
  { command: "set_bed_temp", sequence_id: "1", temp: 60 },
  { command: "set_nozzle_temp", sequence_id: "1", extruder_index: 0, target_temp: 200 },
  { command: "resume", sequence_id: "1" },
  { command: "clean_print_error", sequence_id: "1" },
];

async function helper(t, { attempts = 1, ignoreTerm = false, noRequest = false, legacy = false, crash = false, printResult = 0 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-native-dispatch-"));
  const events = path.join(directory, "events.jsonl");
  const executable = path.join(directory, "helper.mjs");
  await fs.writeFile(events, "");
  await fs.writeFile(executable, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const record = value => appendFileSync(${JSON.stringify(events)}, JSON.stringify(value)+'\\n');
record({kind:'started',pid:process.pid,mode:process.argv[2]});
if (${ignoreTerm}) process.on('SIGTERM',()=>{});
if (${legacy}) {
  if(!['--print','--command'].includes(process.argv[2])) process.exit(2);
  record({kind:'dispatched',attempt:1});
  process.exit(0);
}
if (['--print-authorized','--command-authorized'].includes(process.argv[2]) && !${noRequest}) {
  const lines = createInterface({input:process.stdin})[Symbol.asyncIterator]();
  for(let attempt=1; attempt<=${attempts}; attempt++) {
    console.log('native_dispatch_request='+attempt);
    const response = await lines.next();
    if(response.value !== 'native_dispatch_authorized='+attempt) process.exit(3);
    record({kind:'dispatched',attempt});
  }
}
console.log('native_print result='+${printResult});
if (${crash}) process.kill(process.pid, 'SIGTERM');
else process.exit(${printResult} === 0 ? 0 : 20);
`, { mode: 0o755 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previous = process.env.BAMBU_NATIVE_HELPER;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.BAMBU_NATIVE_HELPER = executable;
  t.after(async () => {
    Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete process.env.BAMBU_NATIVE_HELPER;
    else process.env.BAMBU_NATIVE_HELPER = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return async () => (await fs.readFile(events, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("native printing requires a fresh-state callback before starting the helper", async t => {
  const events = await helper(t, { noRequest: true });
  await assert.rejects(printWithBambuNative(options), /beforeDispatch|fresh.*state/i);
  assert.deepEqual(await events(), []);
});

test("native print waits for fresh validation at every helper dispatch attempt", async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  const result = await printWithBambuNative(options, undefined, { beforeDispatch: async () => {
    assert.equal((await events()).filter(e => e.kind === "dispatched").length, checks);
    checks++;
  } });
  assert.equal(result.status, "success");
  assert.equal(checks, 2);
  assert.deepEqual((await events()).filter(e => e.kind === "dispatched").map(e => e.attempt), [1, 2]);
});

for (const rejectAt of [1, 2]) test(`native validation failure prevents dispatch attempt ${rejectAt}`, async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  await assert.rejects(printWithBambuNative(options, undefined, { beforeDispatch: async () => {
    if (++checks === rejectAt) throw new Error("Fresh printer state is RUNNING");
  } }), /Fresh printer state is RUNNING/);
  assert.equal(checks, rejectAt);
  assert.equal((await events()).filter(e => e.kind === "dispatched").length, rejectAt - 1);
});

test("native helper cannot report successful printing without dispatch authorization", async t => {
  await helper(t, { noRequest: true });
  await assert.rejects(printWithBambuNative(options, undefined, { beforeDispatch: async () => {} }), /authorization/i);
});

test("a helper built before dispatch authorization rejects printing before dispatch", async t => {
  const events = await helper(t, { legacy: true });
  await assert.rejects(printWithBambuNative(options, undefined, { beforeDispatch: async () => {} }), /failed \(2\)/i);
  assert.equal((await events()).some(e => e.kind === "dispatched"), false);
});

for (const command of hazardousCommands) test(`native ${command.command} requires a fresh-state callback before helper launch`, async t => {
  const events = await helper(t, { noRequest: true });
  await assert.rejects(sendCommandWithBambuNative(controlOptions(command)), /beforeDispatch|fresh.*state/i);
  assert.deepEqual(await events(), []);
});

test("native hazardous command waits for fresh validation before every send attempt", async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  const result = await sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), { beforeDispatch: async () => {
    assert.equal((await events()).filter(e => e.kind === "dispatched").length, checks);
    checks++;
  } });
  assert.equal(result.status, "success");
  assert.equal(checks, 2);
  assert.deepEqual((await events()).filter(e => e.kind === "dispatched").map(e => e.attempt), [1, 2]);
});

for (const rejectAt of [1, 2]) test(`native command validation failure prevents send attempt ${rejectAt}`, async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  await assert.rejects(sendCommandWithBambuNative(controlOptions(hazardousCommands[3]), { beforeDispatch: async () => {
    if (++checks === rejectAt) throw new Error("New printer hardware error requires confirmation");
  } }), /New printer hardware error/);
  assert.equal(checks, rejectAt);
  assert.equal((await events()).filter(e => e.kind === "dispatched").length, rejectAt - 1);
});

test("old helpers reject authorized commands before dispatch", async t => {
  const events = await helper(t, { legacy: true });
  await assert.rejects(sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), { beforeDispatch: async () => {} }), /failed \(2\)/i);
  assert.equal((await events()).some(e => e.kind === "dispatched"), false);
});

test("stop and both heater-off commands remain available without fresh-state authorization", async t => {
  const events = await helper(t);
  for (const command of [{ command: "stop" },
    { command: "set_bed_temp", sequence_id: "1", temp: 0 },
    { command: "set_nozzle_temp", sequence_id: "1", extruder_index: 0, target_temp: 0 }]) {
    assert.equal((await sendCommandWithBambuNative(controlOptions(command))).status, "success");
  }
  assert.deepEqual((await events()).map(e => e.mode), ["--command", "--command", "--command"]);
});

for (const operation of ["print", "command"]) for (const emergency of [false, true]) test(`${emergency ? "stop" : "request cancellation"} interrupts a ${operation} helper waiting for fresh state`, async t => {
  const events = await helper(t, { ignoreTerm: true });
  const controller = new AbortController();
  let reached;
  const checking = new Promise(resolve => { reached = resolve; });
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const execution = { signal: controller.signal, beforeDispatch: async () => { reached(); await wait; } };
  const pending = operation === "print" ? printWithBambuNative(options, undefined, execution)
    : sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), execution);
  const rejected = assert.rejects(pending, /cancelled/i);
  await checking;
  if (emergency) await sendCommandWithBambuNative({ ...options, messageJson: JSON.stringify({print:{command:"stop"}}) });
  else controller.abort();
  await rejected;
  finish();
  const recorded = await events();
  assert.equal(recorded.some(e => e.kind === "dispatched"), false);
  const pid = recorded.find(e => e.mode === `--${operation}-authorized`).pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("compiled native operation requires renewed parent approval after certificate setup and retry", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bambu-native-cpp-dispatch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const driver = path.join(directory, "driver.cpp");
  const executable = path.join(directory, "helper");
  const source = fileURLToPath(new URL("../native/bambu-native-print.cpp", import.meta.url));
  // Exercise the real runOperation, including certificate waits and the retry.
  // Only the proprietary plug-in's function pointers are replaced; no library
  // is loaded and none of these callbacks creates a network connection.
  await fs.writeFile(driver, `
#define main unused_native_main
#include ${JSON.stringify(source)}
#undef main
BBL::OnLocalConnectedFn connected;
int main(int argc, char **argv) {
  NativeApi api;
  api.createAgent = [](std::string) -> void* { return reinterpret_cast<void*>(1); };
  api.destroyAgent = [](void*) { if(boolEnv("STUB_CRASH_TEARDOWN",false)) std::abort(); return 0; };
  api.setConfigDir = [](void*,std::string) { return 0; };
  api.initLog = [](void*) { return 0; };
  api.setCertFile = [](void*,std::string,std::string) { return 0; };
  api.setCountryCode = [](void*,std::string) { return 0; };
  api.start = [](void*) { return 0; };
  api.setQueueOnMain = [](void*,std::function<void(std::function<void()>)>) { return 0; };
  api.setPrinterConnected = [](void*,std::function<void(std::string)>) { return 0; };
  api.setLocalConnect = [](void*,BBL::OnLocalConnectedFn callback) { connected=callback; return 0; };
  api.setMessage = [](void*,std::function<void(std::string,std::string)>) { return 0; };
  api.setLocalMessage = api.setMessage;
  api.updateCert = [](void*) { return 0; };
  api.installDeviceCert = [](void*,std::string,bool) {};
  api.connectPrinter = [](void*,std::string serial,std::string,std::string,std::string,bool) { connected(0,serial,""); return 0; };
  api.sendMessageToPrinter = [](void*,std::string,std::string message,int,int) {
    if(message != envOr("BAMBU_NATIVE_COMMAND_JSON")) return 0;
    static int attempts=0; outputLine("stub_control_dispatch="+std::to_string(++attempts)); return attempts==1 ? -4030 : 0;
  };
  api.startLocalPrint = [](void*,BBL::PrintParams,BBL::OnUpdateStatusFn,BBL::WasCancelledFn) {
    static int attempts=0; outputLine("stub_dispatch="+std::to_string(++attempts)); return attempts==1 ? -4030 : 0;
  };
  setenv("BAMBU_NATIVE_CONFIRM","1",1);
  setenv("BAMBU_NATIVE_COMMAND_CONFIRM","1",1);
  setenv("BAMBU_NATIVE_CERT_RETRY_SECONDS","1",1);
  setenv("BAMBU_NATIVE_CONTROL_RETRY_MS","250",1);
  const auto operation = argc==2 && std::string(argv[1])=="--command-authorized"
    ? NativeOperation::AuthorizedCommand : NativeOperation::Print;
  try { runOperation(api,operation); return 0; }
  catch(const std::exception &error) { std::cerr<<error.what()<<std::endl; return 1; }
}
`);
  const compiled = spawnSync(process.env.CXX || "c++", ["-std=c++17", "-O0", driver, "-o", executable, "-ldl", "-pthread"], { encoding: "utf8", timeout: 60000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  const file = path.join(directory, "test.3mf");
  await fs.writeFile(file, "stub plug-in never reads this fixture");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previous = process.env.BAMBU_NATIVE_HELPER;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.BAMBU_NATIVE_HELPER = executable;
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete process.env.BAMBU_NATIVE_HELPER;
    else process.env.BAMBU_NATIVE_HELPER = previous;
  });
  let checks = 0;
  const updates = [];
  await assert.rejects(printWithBambuNative({ ...options, filePath: file }, line => updates.push(line), {
    beforeDispatch: async () => {
      checks++;
      if (checks === 2) throw new Error("Printer became busy before certificate retry");
    },
  }), /Printer became busy before certificate retry/);
  assert.equal(checks, 2);
  assert.deepEqual(updates.filter(line => line.startsWith("stub_dispatch=")), ["stub_dispatch=1"]);

  const teardownCrash = spawnSync(executable, [], {
    env: {...process.env, STUB_CRASH_TEARDOWN:'1', BAMBU_NATIVE_HOST:'127.0.0.1',
      BAMBU_NATIVE_SERIAL:'20PDISPATCH', BAMBU_NATIVE_ACCESS_CODE:'DUMMY', BAMBU_NATIVE_FILE:file},
    encoding:'utf8', timeout:15000, input:'native_dispatch_authorized=1\nnative_dispatch_authorized=2\n',
  });
  assert.equal(teardownCrash.status,0,teardownCrash.stderr);
  assert.match(teardownCrash.stdout,/native_print result=0/);

  const noParent = spawnSync(executable, [], { env: { ...process.env, BAMBU_NATIVE_HOST: "127.0.0.1",
    BAMBU_NATIVE_SERIAL: "20PDISPATCH", BAMBU_NATIVE_ACCESS_CODE: "DUMMY", BAMBU_NATIVE_FILE: file },
    encoding: "utf8", timeout: 15000, input: "" });
  assert.equal(noParent.status, 1, noParent.error?.message || noParent.stderr);
  assert.match(noParent.stderr, /authorization was missing or rejected/);
  assert.doesNotMatch(noParent.stdout, /stub_dispatch=/);

  let commandChecks = 0;
  const commandResult = await sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), {
    beforeDispatch: async () => { commandChecks++; },
  });
  assert.equal(commandChecks, 2);
  assert.deepEqual(commandResult.updates.filter(line => line.startsWith("stub_control_dispatch=")),
    ["stub_control_dispatch=1", "stub_control_dispatch=2"]);

  // The native retry itself must block without a second parent approval.
  const noRetryApproval = spawnSync(executable, ["--command-authorized"], {
    env: { ...process.env, BAMBU_NATIVE_HOST: "127.0.0.1",
      BAMBU_NATIVE_SERIAL: "20PDISPATCH", BAMBU_NATIVE_ACCESS_CODE: "DUMMY",
      BAMBU_NATIVE_COMMAND_JSON: controlOptions(hazardousCommands[3]).messageJson },
    encoding: "utf8", timeout: 15000, input: "native_dispatch_authorized=1\n",
  });
  assert.equal(noRetryApproval.status, 1, noRetryApproval.error?.message || noRetryApproval.stderr);
  assert.match(noRetryApproval.stderr, /authorization was missing or rejected/);
  assert.match(noRetryApproval.stdout, /stub_control_dispatch=1/);
  assert.doesNotMatch(noRetryApproval.stdout, /stub_control_dispatch=2/);
});

for (const printResult of [0, null]) test(`native crash after authorized dispatch (${printResult}) warns against duplicate printing`, async t => {
  const events = await helper(t, { crash: true, printResult });
  await assert.rejects(printWithBambuNative(options, undefined, {beforeDispatch: async () => {}}), /uncertain.*may.*accepted.*before retrying/i);
  assert.equal((await events()).filter(e => e.kind === 'dispatched').length, 1);
});
test('native crash cannot bypass dispatch authorization even with a success receipt', async t => {
  await helper(t, {crash:true,noRequest:true});
  await assert.rejects(printWithBambuNative(options, undefined, {beforeDispatch:async()=>{}}), /authorization/i);
});
test('explicit native print rejection remains a failure', async t => {
  await helper(t, {printResult:-1});
  await assert.rejects(printWithBambuNative(options, undefined, {beforeDispatch:async()=>{}}), /failed.*20/);
});
