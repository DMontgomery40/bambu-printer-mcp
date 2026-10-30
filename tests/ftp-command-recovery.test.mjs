import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// The old dependency throws from a socket callback on rejected PASS commands.
// Isolate that crash from the test runner; all credentials and sockets are local.
for (const operation of ["password", "command"]) {
  test(`FTP ${operation} rejection preserves the process, credentials and next command`, () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import net from "node:net";
      import { Client } from "basic-ftp";
      const sockets = new Set();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on("error", error => assert.equal(error.code, "ECONNRESET"));
        socket.on("close", () => sockets.delete(socket));
        socket.write("220 Local test fixture\r\n");
        let buffer = "";
        socket.on("data", chunk => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\r\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            assert.ok(!line.includes("DUMMY_SECRET"));
            socket.write(line.startsWith("USER ") ? "331 Password required\r\n" : "200 OK\r\n");
          }
        });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const client = new Client(2000);
      try {
        await client.connect("127.0.0.1", server.address().port);
        const reject = ${JSON.stringify(operation)} === "password"
          ? () => client.login("fixture", "DUMMY_SECRET\r\nNOOP")
          : () => client.send("NOOP\r\nNOOP");
        await assert.rejects(reject, error => {
          assert.match(error.message, /control characters/i);
          assert.ok(!error.message.includes("DUMMY_SECRET"));
          return true;
        });
        if (${JSON.stringify(operation)} === "password") {
          await client.connect("127.0.0.1", server.address().port);
        }
        assert.equal((await client.send("NOOP")).code, 200);
      } finally {
        client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
  });
}
