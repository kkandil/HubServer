'use strict';
const connect = require('socket.io-client');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const gateway = 'https://smarthomehub-1aec4600a734.herokuapp.com';
const local = process.env.LOCAL_URL || 'http://192.168.178.89:3000';
const keys = JSON.parse(readFileSync(path.resolve(__dirname, '../../Migration/private/gateway-keys.json')));
function wait(socket, event, match = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error('Timeout: ' + event)); }, 20000);
    function handler(data) { if (match(data)) { clearTimeout(timer); socket.off(event, handler); resolve(data); } }
    socket.on(event, handler);
  });
}
async function request(socket, event, data) { const reply = wait(socket, event); socket.emit(event, data); return reply; }
async function main() {
  const phone = connect(gateway, { query: { token: keys.APP_TOKEN }, transports: ['websocket'], reconnection: false });
  const device = connect(local, { transports: ['websocket'], reconnection: false });
  const homeName = 'MigrationSmoke_' + Date.now();
  let created = false;
  try {
    await Promise.all([wait(phone, 'HubStatus', x => x.online), wait(device, 'connect')]);
    const homes = await request(phone, 'GetAllHomes');
    assert(Array.isArray(homes.homes));
    console.log('Remote homes:', homes.homes.join(', '));
    assert.equal(await request(phone, 'AddNewHome', { homeName }), 'OK'); created = true;
    const added = await request(phone, 'AddDevice', { homeName, deviceName: 'SimulatedLamp' });
    assert.equal(added.status, 'OK');
    const target = { homeName, deviceID: added.deviceID, varName: 'power' };
    assert.equal(await request(phone, 'AddVariable', { ...target, varType: 'int', varValue: '0',
      Scheduled: false, OnTime: 0, OffTime: 0, OnValue: '1', OffValue: '0' }), 'OK');
    const connected = wait(phone, 'DeviceStatus', x => x.DeviceId === added.deviceID && x.DeviceStatus === 'Connected');
    assert.equal(await request(device, 'DeviceConnect', target), 'OK'); await connected;
    const command = wait(device, 'PhoneWriteVariable');
    assert.equal(await request(phone, 'PhoneWriteVariable', { ...target, varType: 'int', varValue: '1' }), 'OK');
    assert.equal((await command).varValue, '1');
    const update = wait(phone, 'DeviceWriteVariable', x => x.deviceID === added.deviceID);
    assert.equal(await request(device, 'DeviceWriteVariable', { ...target, varType: 'int', varValue: '2' }), 'OK');
    assert.equal((await update).varValue, '2');
    assert.equal((await request(phone, 'GetVariableValueFromServer', target)).Value, '2');
    console.log('PASS: remote CRUD, Pi device registration, commands, live updates, persisted reads');
  } finally {
    if (created && phone.connected) {
      assert.equal(await request(phone, 'DeleteHome', { homeName }), 'OK');
      console.log('Temporary smoke-test home removed');
    }
    device.disconnect(); phone.disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
