'use strict';
// Only for TestDev_1's in-memory slider variables; restores original values.
const io = require('socket.io-client');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { APP_TOKEN } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../Migration/private/gateway-keys.json')));
const phone = io('https://smarthomehub-1aec4600a734.herokuapp.com', { query: { token: APP_TOKEN }, transports: ['websocket'], reconnection: false });
const home = { homeName: 'Home_Germany' }, target = { ...home, deviceID: 1007 };
function wait(event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { phone.off(event, handler); reject(new Error('Timeout: ' + event)); }, 20000);
    function handler(value) { if (predicate(value)) { clearTimeout(timer); phone.off(event, handler); resolve(value); } }
    phone.on(event, handler);
  });
}
async function request(event, data) { const result = wait(event); phone.emit(event, data); return result; }
async function read(name) {
  const result = wait('DeviceWriteVariable', x => x.deviceID === 1007 && x.varName === name);
  assert.equal(await request('RequestVariableValue', { ...target, varName: name }), 'OK'); return String((await result).varValue);
}
async function write(name,type,value,state) {
  const result = wait('DeviceWriteVariable', x => x.deviceID === 1007 && x.varName === state && Number(x.varValue) === Number(value));
  assert.equal(await request('PhoneWriteVariable', { ...target,varName:name,varType:type,varValue:String(value) }), 'OK'); await result;
}
async function main() {
  let id, integer, decimal;
  try {
    await wait('HubStatus', x => x.online);
    integer = await read('SliderCntrInt'); decimal = await read('SliderCntrFloat');
    const trigger = Number(integer) === 47 ? 48 : 47;
    // Ensure the condition's cached baseline corresponds to the physical state.
    await write('SliderCntrInt','int',integer,'SliderCtrlInt_State');
    const saved = await request('SaveEvent', { ...home,requestId:'physical-event-save',name:'Temporary physical event test',enabled:true,
      conditions:[{ deviceID:1007,varName:'SliderCtrlInt_State',varValue:String(trigger) }],
      actions:[{ deviceID:1007,varName:'SliderCntrFloat',varValue:'12.5' }] });
    assert.equal(saved.status,'OK',saved.message); id=saved.event.id;
    const fired=wait('DeviceWriteVariable',x=>x.deviceID===1007 && x.varName==='SliderCtrlFloat_State' && Number(x.varValue)===12.5);
    await write('SliderCntrInt','int',trigger,'SliderCtrlInt_State'); await fired;
    const listing=await request('GetEvents',{ ...home,requestId:'physical-list' });
    assert.equal(listing.events.find(x=>x.id===id).lastRun.status,'sent');
    console.log('PASS: ESP state triggered a Pi event, and the ESP confirmed the action through Heroku.');
  } finally {
    if(id) assert.equal((await request('DeleteEvent',{ ...home,id,requestId:'physical-delete' })).status,'OK');
    if(integer!==undefined) await write('SliderCntrInt','int',integer,'SliderCtrlInt_State');
    if(decimal!==undefined) await write('SliderCntrFloat','float',decimal,'SliderCtrlFloat_State');
    console.log('Temporary event removed; original slider values restored.'); phone.disconnect();
  }
}
main().catch(error=> { console.error(error.message); phone.disconnect(); process.exitCode=1; });
