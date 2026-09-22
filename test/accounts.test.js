'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Accounts}=require('../accounts');
const {ConfigStore}=require('../config-store');
const {createMultiGateway}=require('../multi-gateway');
// Small Mongo interface for deterministic auth/ACL tests; production uses MongoDB.
class MemoryDB {
  constructor(){this.collections=new Map();}
  collection(name){
    if(this.collections.has(name))return this.collections.get(name);
    const rows=new Map();
    const get=(o,k)=>k.split('.').reduce((v,p)=>v?.[p],o);
    const match=(o,q)=>Object.entries(q).every(([k,v])=>v&&typeof v==='object'&&'$gt'in v?get(o,k)>v.$gt:get(o,k)===v);
    const set=(o,k,v,remove)=>{const parts=k.split('.'),last=parts.pop();for(const p of parts)o=o[p]||(o[p]={});if(remove)delete o[last];else o[last]=structuredClone(v);};
    const api={rows,async createIndex(){},async findOne(q){return structuredClone([...rows.values()].find(o=>match(o,q))||null);},
      async insertOne(o){if(rows.has(o._id)||(name==='users'&&[...rows.values()].some(x=>x.email===o.email))){const e=new Error('duplicate');e.code=11000;throw e;}rows.set(o._id,structuredClone(o));},
      async updateOne(q,u,options={}){let o=[...rows.values()].find(o=>match(o,q));const inserted=!o;if(!o){if(!options.upsert)return {matchedCount:0};o=structuredClone(q);rows.set(o._id,o);}
        for(const [op,fields]of Object.entries(u))for(const [k,v]of Object.entries(fields)){if(op==='$set'||(op==='$setOnInsert'&&inserted))set(o,k,v);if(op==='$inc')set(o,k,(get(o,k)||0)+v);if(op==='$max'&&(!get(o,k)||get(o,k)<v))set(o,k,v);if(op==='$unset')set(o,k,null,true);}return {matchedCount:1};},
      async findOneAndUpdate(q,u,options){await this.updateOne(q,u,options);return this.findOne(q);},
      async replaceOne(q,o){const old=[...rows.values()].find(o=>match(o,q));if(!old)return {matchedCount:0};rows.set(o._id,structuredClone(o));return {matchedCount:1};},
      async deleteOne(q){const o=[...rows.values()].find(o=>match(o,q));if(o)rows.delete(o._id);}
    };this.collections.set(name,api);return api;
  }
}
class Homes {
  constructor(){this.rows=new Map();this.counter=1000;}
  async all(){return structuredClone([...this.rows.values()].filter(d=>!d.deleted));}
  async get(name){return structuredClone(this.rows.get(name));}
  async put(doc,revision){const old=this.rows.get(doc._id);if(revision===null?!!old:old?.revision!==revision)return false;this.rows.set(doc._id,structuredClone(doc));return true;}
  async nextId(){return ++this.counter;}
}
test('accounts hash passwords, protect reserved owner migration, persist and revoke sessions',async()=>{
  const db=new MemoryDB(),accounts=new Accounts(db,{legacyToken:'private'}),homes=new Homes();await accounts.init();
  homes.rows.set('Home_Germany',{_id:'Home_Germany'});homes.rows.set('Home_Egypt',{_id:'Home_Egypt'});
  await assert.rejects(accounts.register({email:'khaledmagdy50@gmail.com',password:'a long password'},homes),/access key/);
  const a=await accounts.register({email:'khaledmagdy50@gmail.com',password:'a long password',claimKey:'private'},homes);
  assert.ok(a.migrated);assert.ok((await accounts.permissions(a.user,'Home_Germany')).owner);
  const row=await accounts.users.findOne({email:'khaledmagdy50@gmail.com'});assert.equal(row.password,undefined);assert.notEqual(row.hash,'a long password');
  await assert.rejects(accounts.login({email:'khaledmagdy50@gmail.com',password:'wrong'},homes),/Incorrect/);
  const b=await accounts.login({email:'KHALEDMAGDY50@GMAIL.COM',password:'a long password'},homes);assert.equal(b.user.id,a.user.id);
  assert.equal((await new Accounts(db).authenticate(b.token)).username,'khaled');
  await accounts.logout(b.token);await assert.rejects(accounts.authenticate(b.token),/Sign in/);await accounts.authenticate(a.token);
  await assert.rejects(accounts.register({email:'khaledmagdy50@gmail.com',password:'a long password',claimKey:'private'},homes),/registered/);
});
test('home permissions, layout conflicts, permission changes and revocation are enforced',async()=>{
  const accounts=new Accounts(new MemoryDB()),homes=new Homes();
  const owner=(await accounts.register({email:'owner@example.test',password:'owner password 123'},homes)).user;
  const member=(await accounts.register({email:'member@example.test',password:'member password 123'},homes)).user;
  await accounts.own(owner,'House');await assert.rejects(accounts.require(member,'House'),/permission/);
  await accounts.share(owner,'House',{email:'member@example.test',permissions:{events:true}});
  await accounts.require(member,'House');await accounts.require(member,'House','events');
  for(const p of ['owner','devices','layout','schedules','home'])await assert.rejects(accounts.require(member,'House',p),/permission/);
  await assert.rejects(accounts.share(member,'House',{email:'owner@example.test'}),/permission/);
  await accounts.saveLayout(owner,'House',{revision:0,widgets:[{id:'one',type:'BUTTON',x:0,y:0,width:100,height:100,label:'Lamp',currentValue:'secret'}]});
  assert.equal((await accounts.layout(member,'House')).widgets[0].currentValue,undefined);
  await assert.rejects(accounts.saveLayout(owner,'House',{revision:0,widgets:[]}),/changed/);
  await accounts.share(owner,'House',{email:'member@example.test',permissions:{layout:true}});
  await accounts.saveLayout(member,'House',{revision:1,widgets:[]});
  await accounts.share(owner,'House',{email:'member@example.test',remove:true});await assert.rejects(accounts.layout(member,'House'),/permission/);
});
test('email is unique regardless of case, nicknames can repeat, and eight-character passwords work',async()=>{
  const accounts=new Accounts(new MemoryDB()),homes=new Homes();
  await assert.rejects(accounts.register({email:'bad',password:'abcdefgh'},homes),/email/);
  await assert.rejects(accounts.register({email:'first@example.test',password:'1234567'},homes),/8–128/);
  const a=await accounts.register({email:'First@example.test',password:'12345678'},homes);
  const b=await accounts.register({email:'second@example.test',password:'abcdefgh'},homes);
  await accounts.profile(a.user,{nickname:'khaled'});await accounts.profile(b.user,{nickname:'khaled'});
  assert.equal((await accounts.login({email:' FIRST@example.test ',password:'12345678'},homes)).user.username,'khaled');
  await assert.rejects(accounts.register({email:'FIRST@example.test',password:'abcdefgh'},homes),/registered/);
  assert.equal(await accounts.permissions(b.user,'Home_Germany'),null);
});
const request=(s,event,payload)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timeout '+event)),3000);s.once(event,r=>{clearTimeout(timer);resolve(r);});s.emit(event,payload);});
test('gateway isolates home lists, rejects legacy keys and checks each edit on an existing connection',{timeout:15000},async t=>{
  const accounts=new Accounts(new MemoryDB()),store=new ConfigStore(new Homes());
  const owner=await accounts.register({email:'owner@example.test',password:'owner password 123'},store.repo);
  const member=await accounts.register({email:'member@example.test',password:'member password 123'},store.repo);
  await store.edit('AddNewHome',{homeName:'Private'});await accounts.own(owner.user,'Private');
  await store.edit('AddNewHome',{homeName:'Shared'});await accounts.own(owner.user,'Shared');
  await accounts.share(owner.user,'Shared',{email:'member@example.test',permissions:{}});
  const gateway=createMultiGateway({accounts,store,appToken:'old-key',bindings:{}});await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+gateway.server.address().port,sockets=[];
  t.after(async()=>{sockets.forEach(s=>s.disconnect());await gateway.close();});
  const connect=token=>{const s=require('legacy-socket-client')(url,{query:{token},transports:['websocket'],forceNew:true,reconnection:false});sockets.push(s);return s;};
  const old=connect('old-key');await new Promise(r=>{old.once('connect_error',r);old.once('error',r);});
  const s=connect(member.token);await new Promise(r=>s.once('connect',r));
  assert.deepEqual((await request(s,'GetAllHomes',{})).homes,['Shared']);
  assert.equal((await request(s,'GetEvents',{homeName:'Private',requestId:'x'})).status,'Error');
  for(const event of ['AddDevice','SaveEvent','SaveSchedule','DeleteSchedule'])assert.equal((await request(s,event,{homeName:'Shared',requestId:event})).status,'Error');
  const control=await request(s,'PhoneWriteVariable',{homeName:'Shared',requestId:'control'});assert.match(control.message,/offline/); // authorization passed
  // A slow catalog request must not block live writes or snapshots. Keep the
  // catalog deliberately unresolved until both live requests have completed.
  const originalRead=store.read.bind(store);
  let releaseCatalog, catalogStarted;
  const started=new Promise(resolve=>{catalogStarted=resolve;});
  const held=new Promise(resolve=>{releaseCatalog=resolve;});
  store.read=async(event,...args)=>{if(event==='GetAllHomes'){catalogStarted();await held;}return originalRead(event,...args);};
  const catalog=request(s,'GetAllHomes',{});
  await started;
  try {
    const live=await Promise.all([
      request(s,'PhoneWriteVariable',{homeName:'Shared',requestId:'unblocked-write'}),
      request(s,'GetVariableSnapshot',{homeName:'Shared',requestId:'unblocked-snapshot'})
    ]);
    for(const response of live)assert.match(response.message,/offline/);
  } finally {releaseCatalog();store.read=originalRead;}
  await catalog;
  await accounts.share(owner.user,'Shared',{email:'member@example.test',permissions:{devices:true}});
  assert.equal((await request(s,'AddDevice',{homeName:'Shared',deviceName:'Lamp'})).status,'OK');
  await accounts.share(owner.user,'Shared',{email:'member@example.test',remove:true});
  assert.deepEqual((await request(s,'GetAllHomes',{})).homes,[]);
  assert.equal((await request(s,'GetAllDevices',{homeName:'Shared',requestId:'d'})).status,'Error');
  const headers={Authorization:'Bearer '+member.token};
  assert.deepEqual((await(await fetch(url+'/api/homes',{headers})).json()).homes,[]);
  assert.equal((await fetch(url+'/api/homes/Private/members',{headers})).status,400);
  await accounts.logout(member.token);
  assert.equal((await fetch(url+'/api/me',{headers})).status,401);
});
