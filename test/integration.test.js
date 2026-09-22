'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const connect = require('legacy-socket-client');
const { createGateway } = require('../gateway');
const { startBridge } = require('../bridge');

function waitEvent(socket, event, predicate = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error('Timeout: ' + event)); }, timeout);
    function listener(value) { if (predicate(value)) { clearTimeout(timer); socket.off(event, listener); resolve(value); } }
    socket.on(event, listener);
  });
}
async function request(socket, event, payload, predicate) {
  const reply = waitEvent(socket, event, predicate); socket.emit(event, payload); return reply;
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function socket(url, token) {
  return connect(url, { forceNew: true, transports: ['websocket'], query: token ? { token } : {}, reconnection: false });
}

test('legacy protocol works locally and through gateway; outages, auth, persistence, isolation', { timeout: 45000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smarthome-test-'));
  const localPort = await freePort();
  const localUrl = 'http://127.0.0.1:' + localPort;
  const children = [], sockets = [];
  let bridge;
  const gateway = createGateway({ hubToken: 'hub-test-secret', appToken: 'app-test-secret' });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = 'http://127.0.0.1:' + gateway.server.address().port;
  t.after(async () => {
    for (const s of sockets) s.disconnect();
    if (bridge) bridge.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function boot() {
    const child = spawn(process.execPath, [path.join(__dirname, '../local-server.js')], {
      env: { ...process.env, PORT: String(localPort), DATA_FILE: path.join(dir, 'db.sqlite'), GATEWAY_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local startup timeout')), 8000);
      child.stdout.on('data', data => { if (data.toString().includes('Local SmartHome server listening')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Local startup exit ' + code)); });
    });
    return child;
  }
  const local = await boot();
  const bad = require('socket.io-client')(gatewayUrl, { query: { token: 'wrong' }, transports: ['websocket'], reconnection: false }); sockets.push(bad);
  assert.match(String(await waitEvent(bad, 'connect_error')), /Unauthorized/);
  bad.disconnect();
  const remote = socket(gatewayUrl, 'app-test-secret'); sockets.push(remote);
  await waitEvent(remote, 'connect');
  assert.equal(await request(remote, 'GetAllHomes'), 'Hub_Offline');
  let ready = waitEvent(remote, 'HubStatus', x => x.online);
  bridge = startBridge({ gatewayUrl, hubToken: 'hub-test-secret', localUrl });
  await ready;
  assert.equal(await request(remote, 'AddNewHome', { homeName: 'TestHome' }), 'OK');
  const added = await request(remote, 'AddDevice', { homeName: 'TestHome', deviceName: 'Lamp' });
  assert.equal(added.status, 'OK');
  const id = added.deviceID;
  const target = { homeName: 'TestHome', deviceID: id, varName: 'power' };
  assert.equal(await request(remote, 'AddVariable', { ...target, varType: 'int', varValue: '0', Scheduled: false,
    OnTime: 0, OffTime: 0, OnValue: 1, OffValue: 0 }), 'OK');
  const scheduled = await request(remote, 'SaveSchedule', { ...target, requestId: 'save-1',
    time: '03:21', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Europe/Berlin', varType: 'int', varValue: '1' });
  assert.equal(scheduled.status, 'OK'); assert.equal(scheduled.requestId, 'save-1');
  assert.equal((await request(remote, 'GetSchedules', { ...target, requestId: 'list-1' })).schedules.length, 1);
  const device = socket(localUrl); sockets.push(device); await waitEvent(device, 'connect');
  assert.equal(await request(device, 'DeviceConnect', target), 'OK');
  // Device registration is verified through status before issuing commands.
  let status;
  for (let i = 0; i < 10; i++) {
    const pending = waitEvent(remote, 'DeviceStatus'); remote.emit('GetDeviceStatus', target); status = await pending;
    if (status.DeviceStatus === 'Connected') break;
  }
  assert.equal(status.DeviceStatus, 'Connected');
  const command = waitEvent(device, 'PhoneWriteVariable');
  assert.equal(await request(remote, 'PhoneWriteVariable', { ...target, varType: 'int', varValue: '1' }), 'OK');
  assert.equal((await command).varValue, '1');
  const update = waitEvent(remote, 'DeviceWriteVariable', x => x.varValue === '2');
  assert.equal(await request(device, 'DeviceWriteVariable', { ...target, varType: 'int', varValue: '2' }), 'OK');
  await update;
  assert.equal((await request(remote, 'GetVariableValueFromServer', target)).Value, '2');
  device.once('GetVariableValueFromDevice', () => device.emit('DeviceWriteVariable', { ...target, varType: 'int', varValue: '3' }));
  const fresh = waitEvent(remote, 'DeviceWriteVariable', x => x.varValue === '3');
  assert.equal(await request(remote, 'RequestVariableValue', target), 'OK'); await fresh;
  const remote2 = socket(gatewayUrl, 'app-test-secret'); sockets.push(remote2);
  await waitEvent(remote2, 'HubStatus', x => x.online);
  const [a, b] = await Promise.all([request(remote, 'GetAllDevices', target), request(remote2, 'GetDeviceVariables', target)]);
  assert.equal(a.devices[0].id, id); assert.equal(b.variables[0].VarName, 'power');
  // A firmware command need not echo back. Phone-originated writes must still
  // reach every other phone, in both directions and for rapid consecutive writes.
  for (let i = 10; i < 20; i++) {
    const writer = i % 2 ? remote2 : remote;
    const value = String(i);
    const notifications = [remote, remote2].map(phone => waitEvent(phone, 'DeviceWriteVariable', x =>
      x.homeName === target.homeName && x.deviceID === id && x.varName === 'power' && x.varValue === value));
    assert.equal(await request(writer, 'PhoneWriteVariable', { ...target, varType: 'int', varValue: value }), 'OK');
    await Promise.all(notifications);
  }
  assert.equal((await request(remote2, 'GetVariableValueFromServer', target)).Value, '19');
  const actionTarget = { ...target, varName: 'eventOutput' };
  assert.equal(await request(remote, 'AddVariable', { ...actionTarget, varType: 'int', varValue: '0', Scheduled: false,
    OnTime: 0, OffTime: 0, OnValue: 1, OffValue: 0 }), 'OK');
  const catalog = await request(remote, 'GetEventVariables', { homeName: 'TestHome', requestId: 'catalog' });
  assert.equal(catalog.status, 'OK'); assert.equal(catalog.devices[0].variables.length, 2);
  const eventInput = { homeName: 'TestHome', requestId: 'save-event', name: 'Automatic output', enabled: true,
    conditions: [{ deviceID: id, varName: 'power', varValue: '4' }],
    actions: [{ deviceID: id, varName: 'eventOutput', varValue: '9' }] };
  const eventSaved = await request(remote, 'SaveEvent', eventInput);
  assert.equal(eventSaved.status, 'OK'); assert.equal(eventSaved.requestId, 'save-event');
  const eventCommand = waitEvent(device, 'PhoneWriteVariable', x => x.varName === 'eventOutput');
  const offline = waitEvent(remote, 'HubStatus', x => !x.online);
  bridge.close(); await offline;
  assert.equal(await request(remote, 'PhoneWriteVariable', { ...target, varType: 'int', varValue: 'BAD' }), 'Hub_Offline');
  assert.equal(await request(device, 'DeviceWriteVariable', { ...target, varType: 'int', varValue: '4' }), 'OK');
  assert.equal((await eventCommand).varValue, '9'); // Runs locally while gateway is disconnected.
  ready = waitEvent(remote, 'HubStatus', x => x.online);
  bridge = startBridge({ gatewayUrl, hubToken: 'hub-test-secret', localUrl }); await ready;
  assert.equal((await request(remote, 'GetVariableValueFromServer', target)).Value, '4');
  bridge.close();
  const exited = new Promise(resolve => local.once('exit', resolve)); local.kill(); await exited;
  await boot();
  ready = waitEvent(remote, 'HubStatus', x => x.online);
  bridge = startBridge({ gatewayUrl, hubToken: 'hub-test-secret', localUrl }); await ready;
  assert.equal((await request(remote, 'GetVariableValueFromServer', target)).Value, '4');
  const persisted = await request(remote, 'GetAllDevices', target);
  assert.equal(persisted.devices[0].Status, 'Not_Connected');
  assert.equal((await request(remote, 'GetSchedules', { ...target, requestId: 'list-2' })).schedules.length, 1);
  const persistedEvents = await request(remote, 'GetEvents', { homeName: 'TestHome', requestId: 'events-list' });
  assert.equal(persistedEvents.events.length, 1); assert.equal(persistedEvents.events[0].lastRun.status, 'sent');
  assert.equal((await request(remote, 'SetEventEnabled', { homeName: 'TestHome', id: eventSaved.event.id, enabled: false })).status, 'OK');
  assert.equal((await request(remote, 'DeleteDeviceVariable', target)).status, 'OK');
  assert.equal((await request(remote, 'GetSchedules', { ...target, requestId: 'list-3' })).schedules.length, 0);
  assert.equal((await request(remote, 'GetEvents', { homeName: 'TestHome' })).events.length, 0);
  assert.equal((await request(remote, 'DeleteDevice', target)).status, 'OK');
  assert.equal(await request(remote, 'DeleteHome', { homeName: 'TestHome' }), 'OK');
});
