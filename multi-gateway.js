'use strict';
const {timingSafeEqual}=require('node:crypto');
const {requests,responses}=require('./protocol');
const {edits,reads}=require('./config-store');
const same=(a,b)=>typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
function createMultiGateway({store,appToken,bindings,accounts,push,db}) {
  const app=require('express')(), server=require('node:http').createServer(app);
  const io=require('socket.io')(server,{allowEIO3:true,pingTimeout:30000,maxHttpBufferSize:2000000});
  const hubs=new Map(), phones=new Map();
  if(db && accounts)require('./firmware').mountCloud({app,db,accounts,store,hubs});
  const online=name=>!!hubs.get(name)?.ready;
  const safe=fn=>(...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>console.error('Gateway:',e.message));
  async function homesFor(s) {
    const result=await store.read('GetAllHomes',{},online);
    if(!accounts)return result;
    const allowed=[];
    for(const name of result.homes) if(await accounts.permissions(s.user,name))allowed.push(name);
    return {homes:allowed,homeStatuses:result.homeStatuses.filter(h=>allowed.includes(h.homeName))};
  }
  async function broadcast(event,payload) {
    for(const s of phones.values()) if(!accounts || await accounts.permissions(s.user,payload.homeName))s.emit(event,payload);
  }
  async function statuses() { for(const s of phones.values())s.emit('HomeStatuses',await homesFor(s)); }
  if(accounts) {
    app.set('trust proxy',1);
    require('./accounts').attachAccountRoutes(app,accounts,store,async(home,userId)=>{
      for(const s of phones.values()) {
        if(userId===s.user.id) {s.emit('SessionExpired');s.disconnect(true);continue;}
        s.emit('AccountChanged');
      }
      await statuses();
    },push);
  }
  async function sync(name) { const h=hubs.get(name); if(h) { const doc=await store.repo.get(name); if(doc && (!h.ready || doc.revision>(doc.appliedRevision||0))) h.socket.emit('HomeConfig',doc); } }
  app.get('/health',(_q,r)=>r.json({service:'Multi-home gateway',hubOnline:[...hubs.keys()].some(online)})); app.get('/',(_q,r)=>r.json({service:'SmartHome multi-home gateway'}));
  io.use(async(s,next)=>{try {
    if(accounts)s.user=await accounts.authenticate(s.handshake.query.token);
    else if(!same(s.handshake.query.token,appToken))throw new Error('Unauthorized');
    next();
  }catch(e){next(new Error('Sign in required'));}});
  const ns=io.of('/hub');
  ns.use((s,next)=>{const name=Object.keys(bindings).find(name=>same(s.handshake.query.token,bindings[name])); if(!name) return next(new Error('Unauthorized')); s.homeName=name; next();});
  ns.on('connection',s=>{
    const name=s.homeName, old=hubs.get(name); if(old) old.socket.disconnect(true);
    const hub={socket:s,ready:false,phones:new Set()}; hubs.set(name,hub);
    safe(async()=>{await store.repo.seen(name); await sync(name); await statuses();})();
    s.on('ConfigApplied',safe(async data=>{
      if(hubs.get(name)!==hub || data.homeName!==name) return;
      const doc=await store.repo.get(name); if(!doc || data.revision>doc.revision) return;
      await store.repo.applied(name,data.revision); const first=!hub.ready; hub.ready=true;
      if(first) for(const phone of phones.values()) s.emit('PhoneOpen',{id:phone.id});
      await statuses();
    }));
    s.on('ConfigError',data=>{console.error('Hub configuration rejected:',name,data?.message);});
    s.on('LocalUnavailable',safe(async()=>{if(hubs.get(name)===hub){hub.ready=false;hub.phones.clear();await statuses();}}));
    s.on('PhoneReady',data=>{if(hubs.get(name)===hub) hub.phones.add(data.id);});
    s.on('PhoneUnavailable',data=>hub.phones.delete(data.id));
    s.on('HomeRuntime',safe(async data=>{
      if(hubs.get(name)!==hub || data.homeName!==name) return;
      const eventState=JSON.stringify(data.events||[]), changed=hub.eventState!==eventState;
      hub.eventState=eventState;
      await store.repo.runtime(name,data); await statuses();
      if(changed)await broadcast('EventsChanged',{homeName:name});
    }));
    s.on('HubNotification',safe(async data=>{
      if(hubs.get(name)!==hub || data?.homeName!==name)return;
      if(push)await push.deliver(name,data);
    }));
    s.on('PhoneResponse',safe(async data=>{
      if(hubs.get(name)!==hub || !data || !responses.includes(data.event)) return;
      if(data.payload?.homeName && data.payload.homeName!==name) return;
      if(data.event==='GetAllHomes' || edits.has(data.event) || reads.has(data.event)) return;
      const responseAt=Date.now(), trace=data.event==='GetVariableSnapshot';
      const phone=phones.get(data.id);
      if(phone && (!accounts || await accounts.permissions(phone.user,name))) {
        phone.emit(data.event,data.payload);
        if(trace)console.log(`Snapshot response forwarded: requestId=${data.payload?.requestId} responseAuthMs=${Date.now()-responseAt}`);
      }
    }));
    s.on('disconnect',safe(async()=>{if(hubs.get(name)!==hub)return; hubs.delete(name); await store.repo.seen(name); await statuses();}));
  });
  io.on('connection',s=>{
    let editQueue=Promise.resolve(), writeQueue=Promise.resolve(), authentication;
    // Share only an in-flight check, never cache permissions or a revoked session.
    const authenticate=()=>{
      if(!authentication) authentication=accounts.authenticate(s.handshake.query.token).finally(()=>{authentication=null;});
      return authentication;
    };
    const enqueue=(event,work)=>{
      // Live control must not wait behind catalog/database reads. Only mutations
      // in the same lane need FIFO ordering; snapshots carry their own revisions.
      if(event==='PhoneWriteVariable') writeQueue=writeQueue.then(work).catch(e=>console.error('Gateway request:',e.message));
      else if(edits.has(event)) editQueue=editQueue.then(work).catch(e=>console.error('Gateway request:',e.message));
      else safe(work)();
    };
    phones.set(s.id,s); s.emit('HubStatus',{online:true,gateway:true});
    safe(async()=>s.emit('HomeStatuses',await homesFor(s)))();
    for(const h of hubs.values()) if(h.ready) h.socket.emit('PhoneOpen',{id:s.id});
    for(const event of requests) s.on(event,input=>{
      const received=Date.now(), trace=['PhoneWriteVariable','GetVariableSnapshot'].includes(event);
      if(trace)console.log(`Phone request received: event=${event} home=${input?.homeName} requestId=${input?.requestId}`);
      enqueue(event,async()=>{
      try {
        if(accounts) {
          try {await authenticate();}catch(e){s.emit('SessionExpired');s.disconnect(true);return;}
          if(trace)console.log(`Phone authentication complete: event=${event} requestId=${input?.requestId} elapsedMs=${Date.now()-received}`);
          if(!['PhoneConnect','GetAllHomes','AddNewHome'].includes(event)) {
            const permission=event==='DeleteHome'?'home':['AddDevice','RenameDevice','DeleteDevice','AddVariable','DeleteDeviceVariable'].includes(event)?'devices':['SaveEvent','DeleteEvent','SetEventEnabled'].includes(event)?'events':['SaveSchedule','DeleteSchedule'].includes(event)?'schedules':null;
            await accounts.require(s.user,input?.homeName,permission);
          }
        }
        if(event==='PhoneConnect') return s.emit(event,'OK');
        if(event==='GetAllHomes')return s.emit(event,{status:'OK',...await homesFor(s)});
        if(event==='GetSchedules' && !online(input?.homeName))return s.emit(event,{status:'OK',requestId:input?.requestId,...await store.read(event,input,online)});
        if(reads.has(event)) return s.emit(event==='GetDeviceStatus'?'DeviceStatus':event,{status:'OK',requestId:input?.requestId,...await store.read(event,input,online)});
        if(edits.has(event)) {
          const result=await store.edit(event,input);
          if(accounts && event==='AddNewHome')await accounts.own(s.user,input.homeName);
          if(accounts && event==='DeleteHome')await accounts.removeHome(input.homeName);
          s.emit(event,['AddNewHome','DeleteHome','AddVariable'].includes(event)?'OK':{...result,requestId:input?.requestId});
          await broadcast('ConfigChanged',{homeName:input.homeName,revision:result.revision}); await broadcast('EventsChanged',{homeName:input.homeName});
          await statuses(); await sync(input.homeName); return;
        }
        const h=hubs.get(input?.homeName);
        if(!h?.ready || !h.phones.has(s.id)) throw new Error('Home hub is offline; live commands are not queued');
        h.socket.emit('PhoneRequest',{id:s.id,event,payload:input});
        if(trace)console.log(`Phone request forwarded: event=${event} home=${input?.homeName} requestId=${input?.requestId} gatewayMs=${Date.now()-received}`);
      } catch(e) {
        if(trace)console.log(`Phone request rejected: event=${event} requestId=${input?.requestId} gatewayMs=${Date.now()-received} reason=${e.message}`);
        const structured=input?.requestId || ['AddDevice','RenameDevice','DeleteDevice','DeleteDeviceVariable'].includes(event);
        s.emit(event,structured?{status:'Error',requestId:input?.requestId,message:e.message}:e.message);
      }
      });
    });
    s.on('disconnect',()=>{phones.delete(s.id);for(const h of hubs.values()){h.phones.delete(s.id);h.socket.emit('PhoneClose',{id:s.id});}});
  });
  const timer=setInterval(()=>{for(const name of hubs.keys())safe(()=>sync(name))();},15000); timer.unref();
  return {server,close:()=>new Promise(resolve=>{clearInterval(timer);io.close(resolve);})};
}
module.exports={createMultiGateway};
