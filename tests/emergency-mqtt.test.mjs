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
    // QoS 0 (heater-off) waits in queue; the QoS 1 stop waits in outgoing.
    assert.equal(mqtt.queue.length + Object.keys(mqtt.outgoing).length, 1, 'real MQTT.js must have queued the offline publish');
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

/** A BambuClient whose MQTT.js client records publishes; ack decides whether the PUBACK arrives. */
function recordingClient({ ack = true } = {}) {
  const publishes = [];
  const client = new BambuClient({ host: '127.0.0.1', serialNumber: '01PTEST', accessToken: 'DUMMY' });
  let ended = false;
  client.mqttClient = {
    publish(topic, payload, options, callback) { publishes.push({ topic, payload, options }); if (ack) setImmediate(() => callback()); },
    end(_force, _options, callback) { ended = true; callback?.(); },
  };
  return { client, publishes, ended: () => ended };
}

for (const route of ['cancelJob', 'sendStopOverMqtt']) {
  test(`${route} sends Bambu Studio's stop, {"command":"stop","param":"","sequence_id"} at QoS 1`, async () => {
    const { client, publishes } = recordingClient();
    const printer = new BambuImplementation();
    printer.getPrinter = async () => client;
    const result = await printer[route]('127.0.0.1', '01PTEST', 'DUMMY');
    assert.equal(result.status, 'success');
    assert.match(result.message, /acknowledged/);
    assert.equal(publishes.length, 1);
    const [{ topic, payload, options }] = publishes;
    assert.equal(topic, 'device/01PTEST/request');
    assert.deepEqual(options, { qos: 1 });
    const message = JSON.parse(payload);
    assert.deepEqual(Object.keys(message.print), ['command', 'param', 'sequence_id'], 'MachineObject::command_task_abort (DeviceManager.cpp:1418-1426)');
    assert.equal(message.print.command, 'stop');
    assert.equal(message.print.param, '');
    assert.match(message.print.sequence_id, /^\d+$/);
  });
}

test('a stop the printer never acknowledges fails and closes its client, so it cannot be sent late', async t => {
  const previous = process.env.BAMBU_STOP_ACK_MS;
  process.env.BAMBU_STOP_ACK_MS = '50';
  t.after(() => { if (previous === undefined) delete process.env.BAMBU_STOP_ACK_MS; else process.env.BAMBU_STOP_ACK_MS = previous; });
  const { client, publishes, ended } = recordingClient({ ack: false });
  const printer = new BambuImplementation();
  printer.getPrinter = async () => client;
  printer.printerStore.printers.set('fixture-client', client);
  await assert.rejects(printer.cancelJob('127.0.0.1', '01PTEST', 'DUMMY'), /did not acknowledge the stop within 0.05 s/);
  assert.equal(publishes.length, 1);
  assert.equal(ended(), true);
  assert.equal(printer.printerStore.printers.has('fixture-client'), false);
});
