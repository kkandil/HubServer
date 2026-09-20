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
  const offline = waitEvent(remote, 'HubStatus', x => !x.online);
  bridge.close(); await offline;
  assert.equal(await request(remote, 'PhoneWriteVariable', { ...target, varType: 'int', varValue: 'BAD' }), 'Hub_Offline');
  assert.equal(await request(device, 'DeviceWriteVariable', { ...target, varType: 'int', varValue: '4' }), 'OK');
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
  assert.equal((await request(remote, 'DeleteDeviceVariable', target)).status, 'OK');
  assert.equal((await request(remote, 'DeleteDevice', target)).status, 'OK');
  assert.equal(await request(remote, 'DeleteHome', { homeName: 'TestHome' }), 'OK');
});
