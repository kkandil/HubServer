'use strict';
const io = require('socket.io-client');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { APP_TOKEN } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../Migration/private/gateway-keys.json')));
const phone = io('https://smarthomehub-1aec4600a734.herokuapp.com', { query: { token: APP_TOKEN }, transports: ['websocket'], reconnection: false });
const target = { homeName: 'Home_Germany', deviceID: 1007, varName: 'SliderCntrInt' };
function wait(event, predicate = () => true, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { phone.off(event, handler); reject(new Error('Timeout: ' + event)); }, ms);
    function handler(value) { if (predicate(value)) { clearTimeout(timer); phone.off(event, handler); resolve(value); } }
    phone.on(event, handler);
  });
}
async function request(event, data) { const result = wait(event); phone.emit(event, data); return result; }
async function main() {
  let id, original;
  try {
    await wait('HubStatus', x => x.online);
    const value = wait('DeviceWriteVariable', x => x.deviceID === 1007 && x.varName === target.varName);
    assert.equal(await request('RequestVariableValue', target), 'OK'); original = (await value).varValue;
    const at = new Date(Math.ceil((Date.now() + 15000) / 60000) * 60000);
    const fired = wait('DeviceWriteVariable', x => x.deviceID === 1007 && x.varName === 'SliderCtrlInt_State' && x.varValue === '47', 140000);
    const saved = await request('SaveSchedule', { ...target, requestId: 'physical-schedule-save',
      time: at.toISOString().slice(11, 16), timeZone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], varType: 'int', varValue: '47' });
    assert.equal(saved.status, 'OK'); id = saved.schedule.id;
    console.log('Schedule saved for ' + at.toISOString() + '; waiting for the physical device response');
    await fired;
    const listing = await request('GetSchedules', { ...target, requestId: 'physical-schedule-list' });
    assert.equal(listing.schedules.find(x => x.id === id).lastRun.status, 'sent');
    console.log('PASS: Pi schedule fired and ESP12E published SliderCtrlInt_State=47 through Heroku');
  } finally {
    if (id) {
      assert.equal((await request('DeleteSchedule', { ...target, id, requestId: 'physical-schedule-delete' })).status, 'OK');
      console.log('Temporary schedule deleted');
    }
    if (original !== undefined) {
      const restored = wait('DeviceWriteVariable', x => x.deviceID === 1007 && x.varName === 'SliderCtrlInt_State' && Number(x.varValue) === Number(original));
      assert.equal(await request('PhoneWriteVariable', { ...target, varType: 'int', varValue: String(original) }), 'OK');
      await restored; console.log('Original device value restored');
    }
    phone.disconnect();
  }
}
main().catch(error => { console.error(error.message); phone.disconnect(); process.exitCode = 1; });
