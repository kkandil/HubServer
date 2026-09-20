'use strict';
const connect = require('socket.io-client');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const dir = path.resolve(__dirname, '../../Migration/private');
const snapshot = JSON.parse(readFileSync(path.join(dir, 'source-snapshot.json')));
const keys = JSON.parse(readFileSync(path.join(dir, 'gateway-keys.json')));
const phone = connect('https://smarthomehub-1aec4600a734.herokuapp.com', {
  query: { token: keys.APP_TOKEN }, transports: ['websocket'], reconnection: false
});
function wait(event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { phone.off(event, handler); reject(new Error('Timeout: ' + event)); }, 20000);
    function handler(data) { if (predicate(data)) { clearTimeout(timer); phone.off(event, handler); resolve(data); } }
    phone.on(event, handler);
  });
}
async function request(event, payload) { const reply = wait(event); phone.emit(event, payload); return reply; }
async function main() {
  try {
    await wait('HubStatus', data => data.online);
    let devices = 0, variables = 0;
    for (const db of snapshot.databases.filter(db => db.name !== 'SmartHomeMeta')) {
      const saved = db.collections.find(col => col.name === 'Devices').documents;
      const result = await request('GetAllDevices', { homeName: db.name });
      assert.equal(result.devices.length, saved.length);
      for (const device of saved) {
        assert(result.devices.some(d => d.id === device.id && d.Name === device.Name));
        const actual = await request('GetDeviceVariables', { homeName: db.name, deviceID: device.id });
        const expected = db.collections.find(col => col.name === 'Var_' + device.Name)?.documents || [];
        assert.equal(actual.variables.length, expected.length);
        for (const variable of expected) {
          const found = actual.variables.find(v => v.VarName === variable.VarName);
          assert(found);
          for (const key of ['DeviceId', 'Value', 'Type', 'Scheduled', 'OffTime', 'OnTime', 'OnValue', 'OffValue']) {
            assert.deepEqual(found[key], variable[key], db.name + '/' + device.Name + '/' + variable.VarName + '/' + key);
          }
          variables++;
        }
        devices++;
      }
    }
    console.log(`PASS: ${devices} devices and ${variables} variables match the source snapshot through the deployed gateway`);
  } finally { phone.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
