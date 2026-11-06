import assert from "node:assert/strict";
import net from "node:net";
import { Readable } from "node:stream";
import { test } from "node:test";
import { Client } from "basic-ftp";
import { uploadBytes } from "../dist/printers/ftp-upload.js";

const RATE = 4 * 1024 * 1024; // bytes/s the fake printer drains, like an SD card behind Wi-Fi
const SIZE = 12 * 1024 * 1024; // larger than loopback socket buffers, so writes must wait for the drain
const TIMEOUT_MS = 1500; // basic-ftp stall timeout; the whole upload takes ~3 s

/** A passive-mode FTP server whose data connection drains at RATE, or stops after its first read. */
async function slowPrinter(t, { stall = false } = {}) {
  const received = [];
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); };
  const data = net.createServer(socket => {
    track(socket);
    const parts = [];
    socket.on("data", chunk => {
      parts.push(chunk);
      socket.pause();
      if (!stall) setTimeout(() => socket.resume(), Math.ceil(chunk.length / RATE * 1000));
    });
    socket.on("end", () => { received.push(Buffer.concat(parts)); data.emit("stored"); });
  });
  const control = net.createServer(socket => {
    track(socket);
    socket.write("220 fake printer\r\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "USER") socket.write("331 \r\n");
        else if (verb === "PASS") socket.write("230 \r\n");
        else if (verb === "PASV") {
          const port = data.address().port;
          socket.write(`227 (127,0,0,1,${port >> 8},${port & 255})\r\n`);
        } else if (verb === "STOR") {
          socket.write("150 \r\n");
          data.once("stored", () => socket.write("226 \r\n"));
        } else if (verb === "EPSV" || verb === "FEAT") socket.write("502 \r\n");
        else socket.write("200 \r\n");
      }
    });
  });
  await Promise.all([control, data].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([control, data].map(server => new Promise(resolve => server.close(resolve))));
  });
  const client = new Client(TIMEOUT_MS);
  t.after(() => client.close());
  await client.access({ host: "127.0.0.1", port: control.address().port, user: "bblp", password: "DUMMY", secure: false });
  return { client, received };
}

const job = () => Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31 + 7) & 255));

test("a single-write upload of a multi-megabyte job hits the data-socket timeout while bytes still flow", async t => {
  // What ftpUpload did through 1.1.73: Readable.from(buffer) yields the whole file as one write.
  const { client } = await slowPrinter(t);
  await assert.rejects(client.uploadFrom(Readable.from(job()), "/cache/job.3mf"), /Timeout \(data socket\)/);
});

test("uploadBytes stores a multi-megabyte job on a slow printer within the same inactivity timeout", async t => {
  const { client, received } = await slowPrinter(t);
  const bytes = job();
  const started = Date.now();
  await uploadBytes(client, bytes, "/cache/job.3mf");
  assert.ok(Date.now() - started > TIMEOUT_MS * 1.5, "the transfer must outlast the timeout for this test to mean anything");
  assert.equal(received.length, 1);
  assert.ok(received[0].equals(bytes), "the printer receives the exact bytes");
});

test("uploadBytes still times out when the printer stops taking data", async t => {
  const { client } = await slowPrinter(t, { stall: true });
  await assert.rejects(uploadBytes(client, job(), "/cache/job.3mf"), /Timeout \(data socket\)/);
});
