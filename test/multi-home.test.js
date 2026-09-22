'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const {ConfigStore}=require('../config-store');
const {compare}=require('../events');
const {createMultiGateway}=require('../multi-gateway');
const {startBridge}=require('../bridge');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),path=require('node:path');
const net=require('node:net');
class MemoryHomes {
  constructor(){this.docs=new Map();this.id=1000;}
  async all(){return structuredClone([...this.docs.values()].filter(d=>!d.deleted));}
  async get(name){return structuredClone(this.docs.get(name));}
  async put(doc,revision){const old=this.docs.get(doc._id);if(revision===null?!!old:old?.revision!==revision)return false;this.docs.set(doc._id,structuredClone(doc));return true;}
  async nextId(){return ++this.id;}
  async runtime(name,runtime){this.docs.get(name).runtime=runtime;await this.seen(name);}
  async seen(name){if(this.docs.has(name))this.docs.get(name).lastSeen=new Date().toISOString();}
  async applied(name,revision){this.docs.get(name).appliedRevision=Math.max(revision,this.docs.get(name).appliedRevision);await this.seen(name);}
}
const wait=(socket,event,predicate=()=>true)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(event,fn);reject(new Error('Timeout '+event));},18000);const fn=data=>{if(predicate(data)){clearTimeout(timer);socket.off(event,fn);resolve(data);}};socket.on(event,fn);});
const request=async(socket,event,input)=>{const result=wait(socket,event);socket.emit(event,input);return result;};
test('comparison operators include numeric boundaries; nonnumeric ordering never matches',()=>{
  for(const [op,a,b,result] of [['>',2,1,true],['>',1,1,false],['>=',1,1,true],['<',1,2,true],['<=',1,1,true],['<',2,1,false],['=',1,'1.0',true]])assert.equal(compare(a,String(b),'float',op),result);
  assert.equal(compare('abc','2','float','>'),false);assert.equal(compare('x','y','string','<'),false);
});
test('persistent desired config, idempotency, conflicts, comparator validation, home isolation and tombstones',async()=>{
  const repo=new MemoryHomes(), store=new ConfigStore(repo), h={homeName:'Germany'};
  await store.edit('AddNewHome',h);await store.edit('AddNewHome',{homeName:'Egypt'});
  const a=await store.edit('AddDevice',{...h,deviceName:'Sensor',mutationId:'same'});
  assert.equal((await store.edit('AddDevice',{...h,deviceName:'Sensor',mutationId:'same'})).deviceID,a.deviceID);
  await assert.rejects(store.edit('DeleteDevice',{...h,deviceID:a.deviceID,baseRevision:1}),/changed/);
  await store.edit('AddVariable',{...h,deviceID:a.deviceID,varName:'temperature',varType:'float',varValue:'20'});
  await store.edit('AddVariable',{...h,deviceID:a.deviceID,varName:'output',varType:'string',varValue:'off'});
  const rule={...h,name:'Warm',enabled:true,conditions:[{deviceID:a.deviceID,varName:'temperature',varValue:'25',operator:'>='}],actions:[{deviceID:a.deviceID,varName:'output',varValue:'on'}]};
  const r=await store.edit('SaveEvent',rule);assert.equal(r.event.conditions[0].operator,'>=');
  await assert.rejects(store.edit('SaveEvent',{...rule,conditions:[{deviceID:a.deviceID,varName:'output',varValue:'a',operator:'>'}]}),/numeric/);
  const restarted=new ConfigStore(repo);assert.equal((await restarted.read('GetEvents',h,()=>false)).events.length,1);
  assert.equal((await restarted.read('GetAllDevices',{homeName:'Egypt'},()=>false)).devices.length,0);
  await store.edit('DeleteDevice',{...h,deviceID:a.deviceID});assert.equal((await store.read('GetEvents',h,()=>false)).events.length,0);
  await store.edit('DeleteHome',h);assert.equal((await repo.get('Germany')).deleted,true);assert.deepEqual((await store.read('GetAllHomes',{},()=>false)).homes,['Egypt']);
});
test('two independent hubs, offline edits synchronize before live traffic, reconnect never resurrects deleted config', {timeout:65000},async t=>{
  const repo=new MemoryHomes(),store=new ConfigStore(repo),dir=mkdtempSync(path.join(tmpdir(),'multi-home-'));
  const gateway=createMultiGateway({store,appToken:'app',bindings:{Germany:'germany',Egypt:'egypt'}});
  await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+gateway.server.address().port;
  const sockets=[],children=[],bridges=[];
  t.after(async()=>{sockets.forEach(s=>s.disconnect());bridges.forEach(b=>b.close());for(const c of children)if(c.exitCode===null){const closed=new Promise(r=>c.once('exit',r));c.kill();await closed;}await gateway.close();rmSync(dir,{recursive:true,force:true});});
  await store.edit('AddNewHome',{homeName:'Germany'});await store.edit('AddNewHome',{homeName:'Egypt'});
  const phone=require('legacy-socket-client')(url,{query:{token:'app'},transports:['websocket'],forceNew:true});sockets.push(phone);await wait(phone,'HubStatus',s=>s.gateway);
  const homes=await request(phone,'GetAllHomes');assert.equal(homes.homes.length,2);assert.ok(homes.homeStatuses.every(h=>!h.online));
  const add=await request(phone,'AddDevice',{homeName:'Germany',deviceName:'Offline_created'});assert.equal(add.status,'OK');
  const statusReply=wait(phone,'DeviceStatus');phone.emit('GetDeviceStatus',{homeName:'Germany',deviceID:add.deviceID});assert.equal((await statusReply).DeviceStatus,'Not_Connected');
  for(const varName of ['sensor','output'])assert.equal(await request(phone,'AddVariable',{homeName:'Germany',deviceID:add.deviceID,varName,varType:'int',varValue:'0'}),'OK');
  const rule={homeName:'Germany',name:'Offline event',enabled:true,conditions:[{deviceID:add.deviceID,varName:'sensor',operator:'>',varValue:'5'}],actions:[{deviceID:add.deviceID,varName:'output',varValue:'1'}]};
  const saved=await request(phone,'SaveEvent',rule);assert.equal(saved.status,'OK');
  async function boot(home,token){
    const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
    const child=spawn(process.execPath,[path.join(__dirname,'../local-server.js')],{env:{...process.env,PORT:String(port),DATA_FILE:path.join(dir,home+'.sqlite'),HUB_HOME:home,HUB_TOKEN:token,GATEWAY_URL:''},stdio:['ignore','pipe','pipe']});children.push(child);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);child.stdout.on('data',d=>{if(d.toString().includes('Local SmartHome server listening')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(new Error('startup exit'));});});
    const ready=wait(phone,'HomeStatuses',x=>x.homeStatuses.some(h=>h.homeName===home&&h.online&&!h.pending));
    const b=startBridge({gatewayUrl:url,hubToken:token,localUrl:'http://127.0.0.1:'+port,homeName:home});bridges.push(b);await ready;return {port,b};
  }
  const germany=await boot('Germany','germany');await boot('Egypt','egypt');
  const local=require('legacy-socket-client')('http://127.0.0.1:'+germany.port,{transports:['websocket'],forceNew:true});sockets.push(local);await wait(local,'connect');
  assert.equal((await request(local,'GetAllDevices',{homeName:'Germany'})).devices[0].id,add.deviceID);
  assert.equal((await request(local,'GetEvents',{homeName:'Germany'})).events[0].conditions[0].operator,'>');
  assert.match(await request(local,'GetAllDevices',{homeName:'Egypt'}),/belongs to/);
  const read=store.read.bind(store);
  let release, entered;
  const began=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  store.read=async(event,...args)=>{if(event==='GetAllDevices'){entered();await hold;}return read(event,...args);};
  const blocked=request(phone,'GetAllDevices',{homeName:'Germany'});
  await began;
  try {
    const snapshot=await request(phone,'GetVariableSnapshot',{homeName:'Germany',requestId:'bypass-slow-read'});
    assert.equal(snapshot.status,'OK');assert.equal(snapshot.values.length,2);
    const command=await request(phone,'PhoneWriteVariable',{homeName:'Germany',deviceID:add.deviceID,varName:'output',varType:'int',varValue:'1',requestId:'bypass-command'});
    assert.equal(command.message,'Device_Not_Connected'); // Pi handled it while catalog is still blocked.
  } finally {release();store.read=read;}
  await blocked;
  const offline=wait(phone,'HomeStatuses',x=>!x.homeStatuses.find(h=>h.homeName==='Germany').online);germany.b.close();await offline;
  const disconnected=await request(phone,'GetAllHomes');assert.equal(disconnected.homes.length,2);assert.equal(disconnected.homeStatuses.find(h=>h.homeName==='Egypt').online,true);
  assert.equal((await request(phone,'GetAllDevices',{homeName:'Germany'})).devices.length,1);
  assert.equal((await request(phone,'SetEventEnabled',{homeName:'Germany',id:saved.event.id,enabled:false})).status,'OK');
  assert.equal((await request(phone,'DeleteDevice',{homeName:'Germany',deviceID:add.deviceID})).status,'OK');
  const ready=wait(phone,'HomeStatuses',x=>x.homeStatuses.some(h=>h.homeName==='Germany'&&h.online&&!h.pending));
  const b=startBridge({gatewayUrl:url,hubToken:'germany',localUrl:'http://127.0.0.1:'+germany.port,homeName:'Germany'});bridges.push(b);await ready;
  assert.equal((await request(local,'GetAllDevices',{homeName:'Germany'})).devices.length,0);
});
