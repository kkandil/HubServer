'use strict';
// TestDev_1 only manipulates in-memory slider values; no actuator pins are used.
const connect = require('socket.io-client');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { APP_TOKEN } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../Migration/private/gateway-keys.json')));
const phone = connect('https://smarthomehub-1aec4600a734.herokuapp.com', {
  query: { token: APP_TOKEN }, transports: ['websocket'], reconnection: false
});
const target = { homeName: 'Home_Germany', deviceID: 1007 };
function wait(event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { phone.off(event, handler); reject(new Error('Timeout: ' + event)); }, 15000);
    function handler(value) {
      if (predicate(value)) { clearTimeout(timer); phone.off(event, handler); resolve(value); }
    }
    phone.on(event, handler);
  });
}
async function request(event, payload, response = event) {
  const result = wait(response); phone.emit(event, payload); return result;
}
async function readDevice(varName) {
  const result = wait('DeviceWriteVariable', v => v.deviceID === target.deviceID && v.varName === varName);
  const ack = await request('RequestVariableValue', { ...target, varName });
  assert.equal(ack, 'OK');
  return (await result).varValue;
}
async function write(varName, stateName, varType, value) {
  const state = wait('DeviceWriteVariable', v => v.deviceID === target.deviceID && v.varName === stateName);
  assert.equal(await request('PhoneWriteVariable', { ...target, varName, varType, varValue: String(value) }), 'OK');
  assert.equal(Number((await state).varValue), Number(value));
  assert.equal(Number(await readDevice(varName)), Number(value));
}
async function main() {
  try {
    await wait('HubStatus', v => v.online);
    const status = await request('GetDeviceStatus', target, 'DeviceStatus');
    console.log('Device 1007:', status.DeviceStatus);
    assert.equal(status.DeviceStatus, 'Connected');
    for (const [control, state, type, sample] of [
      ['SliderCntrInt', 'SliderCtrlInt_State', 'int', '37'],
      ['SliderCntrFloat', 'SliderCtrlFloat_State', 'float', '12.50']
    ]) {
      const original = await readDevice(control);
      try {
        await write(control, state, type, sample);
        console.log(`PASS: ${control}=${sample}; physical response and fresh read received through Heroku`);
      } finally { await write(control, state, type, original); }
      console.log(`Restored ${control}=${original}`);
    }
  } finally { phone.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
