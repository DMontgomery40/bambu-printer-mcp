import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Duplex } from 'node:stream';
import { MqttClient } from 'mqtt';
import { BambuClient } from 'bambu-node';
import { BambuImplementation } from '../dist/printers/bambu.js';

for (const heater of [undefined, 'bed', 'nozzle']) {
  test(`expired emergency ${heater ?? 'stop'} discards a genuine MQTT.js queued publish`, async t => {
    const stream = new Duplex({ read() {}, write(_bytes, _encoding, callback) { callback(); } });
    const mqtt = new MqttClient(() => stream, { manualConnect: true, reconnectPeriod: 0, connectTimeout: 1000 });
    mqtt.on('error', () => {});
    mqtt.connect();
    t.after(() => mqtt.end(true));
    let publishes = 0;
    mqtt.on('packetsend', packet => { if (packet.cmd === 'publish') publishes++; });
    const client = new BambuClient({ host: '127.0.0.1', serialNumber: '20PTEST', accessToken: 'DUMMY' });
    // Supply the genuine dependency transport without opening a socket.
    client.mqttClient = mqtt;
    const printer = new BambuImplementation();
    printer.getPrinter = async () => client;
    printer.printerStore.printers.set('fixture-client', client);
    const controller = new AbortController();
    const pending = heater === undefined
      ? printer.sendStopOverMqtt('127.0.0.1', '20PTEST', 'DUMMY', controller.signal)
      : printer.sendHeaterOffOverMqtt('127.0.0.1', '20PTEST', 'DUMMY', heater, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mqtt.queue.length, 1, 'real MQTT.js must have queued the offline publish');
    controller.abort(new Error('expired fixture deadline'));
    // A closed transport cannot reconnect; without cleanup this flushes the queued command.
    const reconnect = setTimeout(() => { if (!stream.destroyed) { mqtt.connected = true; mqtt.emit('connect', {}); } }, 30);
    t.after(() => clearTimeout(reconnect));
    await assert.rejects(pending, /expired fixture deadline/);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(stream.destroyed, true);
    assert.equal(mqtt.disconnecting || mqtt.disconnected, true);
    assert.equal(printer.printerStore.printers.has('fixture-client'), false, 'ended client must not remain cached');
    assert.equal(publishes, 0, 'no expired packet can reach the transport');
  });
}
