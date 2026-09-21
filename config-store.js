'use strict';
const { DatabaseSync } = require('node:sqlite');
const { EventEngine } = require('./events');
const edits = new Set(['AddNewHome','DeleteHome','AddDevice','DeleteDevice','AddVariable','DeleteDeviceVariable','SaveEvent','DeleteEvent','SetEventEnabled']);
const reads = new Set(['GetAllHomes','GetAllDevices','GetDeviceVariables','GetEventVariables','GetEvents','GetDeviceStatus']);
class MongoHomes {
  constructor(db) { this.homes=db.collection('homes'); this.meta=db.collection('meta'); }
  async all() { return this.homes.find({deleted:{$ne:true}}).toArray(); }
  async get(name) { return this.homes.findOne({_id:name}); }
  async put(doc,revision) {
    if(revision===null) { try { await this.homes.insertOne(doc); return true; } catch(e) { if(e.code===11000) return false; throw e; } }
    return (await this.homes.replaceOne({_id:doc._id,revision},doc)).matchedCount===1;
  }
  async nextId() { const r=await this.meta.findOneAndUpdate({_id:'deviceCounter'},{$inc:{value:1}},{upsert:true,returnDocument:'after'}); return r.value; }
  async runtime(name,runtime) { await this.homes.updateOne({_id:name},{$set:{runtime,lastSeen:new Date().toISOString()}}); }
  async applied(name,revision) { await this.homes.updateOne({_id:name},{$max:{appliedRevision:revision},$set:{lastSeen:new Date().toISOString()}}); }
  async seen(name) { await this.homes.updateOne({_id:name},{$set:{lastSeen:new Date().toISOString()}}); }
}
class ConfigStore {
  constructor(repository) { this.repo=repository; this.queue=Promise.resolve(); }
  edit(event,input) {
    const result=this.queue.then(()=>this.change(event,input)); this.queue=result.catch(()=>{}); return result;
  }
  async change(event,input) {
    if(!input || typeof input.homeName!=='string' || !/^[A-Za-z0-9_-]+$/.test(input.homeName)) throw new Error('Invalid home name');
    const name=input.homeName;
    const old=await this.repo.get(name);
    if(input.mutationId && old?.receipts?.some(r=>r.id===input.mutationId)) return old.receipts.find(r=>r.id===input.mutationId).reply;
    if(event!=='AddNewHome' && (!old || old.deleted)) throw new Error('Home not found');
    if(old && input.baseRevision!==undefined && input.baseRevision!==old.revision) throw new Error('Configuration changed on another client. Reload and review your changes before saving again.');
    const doc=structuredClone(old || {_id:name,revision:0,appliedRevision:0,devices:[],events:[],receipts:[],lastSeen:null});
    let extra={};
    const device=doc.devices.find(d=>d.id===Number(input.deviceID));
    const validName=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    const cascade=(id,variable)=>{doc.events=doc.events.filter(r=>![...r.conditions,...r.actions].some(t=>t.deviceID===id && (variable===undefined || t.varName===variable)));};
    if(event==='AddNewHome') { if(old && !old.deleted) throw new Error('Home already exists'); doc.deleted=false; }
    else if(event==='DeleteHome') { doc.deleted=true; doc.devices=[]; doc.events=[]; }
    else if(event==='AddDevice') {
      if(!validName(input.deviceName)) throw new Error('Use letters, numbers, underscores or hyphens for the device name');
      if(doc.devices.some(d=>d.Name===input.deviceName)) throw new Error('Device name already exists');
      const id=await this.repo.nextId(); if(id>2147483647) throw new Error('Device ID limit reached');
      doc.devices.push({id,Name:input.deviceName,variables:[]}); extra={deviceID:id,deviceName:input.deviceName};
    } else if(event==='DeleteDevice') {
      if(!device) throw new Error('Device not found'); doc.devices=doc.devices.filter(d=>d!==device); cascade(device.id); extra={deviceID:device.id,deviceName:device.Name};
    } else if(event==='AddVariable') {
      if(!device || !validName(input.varName)) throw new Error('Invalid device or variable');
      if(device.variables.some(v=>v.VarName===input.varName)) throw new Error('Variable already exists');
      const db=new DatabaseSync(':memory:');
      try { const engine=new EventEngine(db,{resolveTarget:async()=>({Type:input.varType}),dispatch:async()=>{}}); await engine.validateItem({...input,varValue:String(input.varValue)},name,false,0); } finally {db.close();}
      device.variables.push({VarName:input.varName,DeviceId:device.id,Type:input.varType,Value:String(input.varValue),Scheduled:false,OnTime:'00:00:00',OffTime:'00:00:00',OnValue:1,OffValue:0});
    } else if(event==='DeleteDeviceVariable') {
      if(!device || !device.variables.some(v=>v.VarName===input.varName)) throw new Error('Variable not found');
      device.variables=device.variables.filter(v=>v.VarName!==input.varName); cascade(device.id,input.varName);
    } else if(['SaveEvent','SetEventEnabled','DeleteEvent'].includes(event)) {
      const db=new DatabaseSync(':memory:');
      try {
        const engine=new EventEngine(db,{resolveTarget:async t=>{const d=doc.devices.find(d=>d.id===t.deviceID); const v=d?.variables.find(v=>v.VarName===t.varName); return v?{...v,deviceName:d.Name}:null;},dispatch:async()=>{}});
        for(const r of doc.events) db.prepare('INSERT INTO conditional_events(id,home,body) VALUES(?,?,?)').run(r.id,name,JSON.stringify(r));
        if(event==='SaveEvent') extra.event=await engine.save(input);
        if(event==='SetEventEnabled') extra.event=await engine.toggle(input);
        if(event==='DeleteEvent') await engine.remove(input);
        doc.events=engine.list({homeName:name}).map(({lastRun,...r})=>r);
      } finally {db.close();}
    } else throw new Error('Unsupported configuration operation');
    doc.revision++;
    const reply={status:'OK',homeName:name,revision:doc.revision,pending:true,...extra};
    if(input.mutationId) doc.receipts=[...(doc.receipts||[]),{id:input.mutationId,reply}].slice(-100);
    if(!await this.repo.put(doc,old?old.revision:null)) throw new Error('Configuration changed. Reload before saving again.');
    return reply;
  }
  async read(event,input,online) {
    if(event==='GetAllHomes') {
      const docs=await this.repo.all(); return {homes:docs.map(d=>d._id),homeStatuses:docs.map(d=>this.status(d,online(d._id)))};
    }
    const d=await this.repo.get(input?.homeName); if(!d || d.deleted) throw new Error('Home not found');
    const header={homeName:d._id,revision:d.revision,pending:d.revision>(d.appliedRevision||0)};
    const devices=d.devices.map(device=>{const r=d.runtime?.devices?.find(x=>x.id===device.id)||{}; const status=online(d._id)?(r.Status||'Not_Connected'):'Not_Connected';return {...device,...r,id:device.id,Name:device.Name,Status:status,Time:status==='Connected'?r.ConnectTime||'NA':r.DisconnectTime||r.ConnectTime||'NA'};});
    const device=devices.find(x=>x.id===Number(input.deviceID));
    if(event==='GetAllDevices') return {...header,devices:devices.map(({variables,...d})=>d)};
    if(event==='GetDeviceStatus') return {...header,deviceID:input.deviceID,DeviceStatus:device?.Status||'Not_Connected',Time:device?.Status==='Connected'?device.ConnectTime||d.lastSeen||'NA':device?.DisconnectTime||device?.ConnectTime||d.lastSeen||'NA'};
    if(event==='GetDeviceVariables') { if(!device) throw new Error('Device not found'); return {...header,deviceID:device.id,deviceName:device.Name,variables:device.variables}; }
    if(event==='GetEventVariables') return {...header,devices:d.devices.map(x=>({deviceID:x.id,deviceName:x.Name,variables:x.variables.map(v=>({varName:v.VarName,varType:v.Type}))}))};
    if(event==='GetEvents') return {...header,events:d.events.map(r=>({...r,lastRun:d.runtime?.events?.find(x=>x.id===r.id)?.lastRun||null}))};
  }
  status(d,online) { return {homeName:d._id,online,lastSeen:d.lastSeen||null,revision:d.revision,pending:d.revision>(d.appliedRevision||0)}; }
}
module.exports={MongoHomes,ConfigStore,edits,reads};
