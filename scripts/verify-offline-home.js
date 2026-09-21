'use strict';
const {randomUUID}=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {APP_TOKEN}=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../Migration/private/gateway-keys.json')));
const socket=require('socket.io-client')('https://smarthomehub-1aec4600a734.herokuapp.com',{query:{token:APP_TOKEN},transports:['websocket'],reconnection:false});
const wait=(event,predicate=()=>true)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(event,fn);reject(new Error('Timeout: '+event));},15000);const fn=x=>{if(predicate(x)){clearTimeout(timer);socket.off(event,fn);resolve(x);}};socket.on(event,fn);});
const request=async(event,input)=>{const result=wait(event);socket.emit(event,{...input,requestId:randomUUID(),mutationId:randomUUID()});return result;};
async function main(){
  let deviceID,eventID;const home={homeName:'Home_Egypt'};
  try{
    await wait('HubStatus',x=>x.gateway);
    const initial=await request('GetAllHomes');assert.equal(initial.homeStatuses.find(h=>h.homeName==='Home_Egypt').online,false);
    const original=(await request('GetAllDevices',home)).devices.length;
    const added=await request('AddDevice',{...home,deviceName:'_OfflineSyncTest_'+Date.now()});assert.equal(added.status,'OK');deviceID=added.deviceID;assert.equal(added.pending,true);
    for(const varName of ['sensor','output'])assert.equal(await request('AddVariable',{...home,deviceID,varName,varType:'int',varValue:'0'}),'OK');
    const saved=await request('SaveEvent',{...home,name:'Temporary offline verification',enabled:false,conditions:[{deviceID,varName:'sensor',operator:'>=',varValue:'25'}],actions:[{deviceID,varName:'output',varValue:'1'}]});
    assert.equal(saved.status,'OK');eventID=saved.event.id;
    const list=await request('GetEvents',home);assert.equal(list.pending,true);assert.equal(list.events.find(r=>r.id===eventID).conditions[0].operator,'>=');
    assert.equal((await request('GetAllDevices',home)).devices.length,original+1);
    console.log('PASS: offline Egypt home accepts and retains device/event configuration in the gateway.');
  }finally{
    if(eventID)assert.equal((await request('DeleteEvent',{...home,id:eventID})).status,'OK');
    if(deviceID)assert.equal((await request('DeleteDevice',{...home,deviceID})).status,'OK');
    socket.disconnect();console.log('Temporary device and event removed.');
  }
}
main().catch(e=>{console.error(e.message);socket.disconnect();process.exitCode=1;});
