 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PushNotifications,hash}=require('../push-notifications');
function fixture() {
  const tables=new Map();
  const matches=(row,q)=>Object.entries(q).every(([k,v])=>v?.$elemMatch?
    row[k].some(x=>matches(x,v.$elemMatch)):v?.$gt?row[k]>v.$gt:row[k]===v);
  const db={collection(name){
    if(tables.has(name))return tables.get(name);
    const rows=[];
    const api={rows,async createIndex(){},async insertOne(r){if(rows.some(x=>x._id===r._id))throw Object.assign(new Error(),{code:11000});rows.push(structuredClone(r));},
      async updateOne(q,u){let row=rows.find(r=>matches(r,q));if(!row){row={...q};rows.push(row);}Object.assign(row,structuredClone(u.$set));},
      async findOne(q){return rows.find(r=>matches(r,q));},find(q){return {async toArray(){return rows.filter(r=>matches(r,q));}};},
      async deleteOne(q){const i=rows.findIndex(r=>matches(r,q));if(i>=0)rows.splice(i,1);},
      async deleteMany(q){for(let i=rows.length-1;i>=0;i--)if(matches(rows[i],q))rows.splice(i,1);}};
    tables.set(name,api);return api;
  }};
  const members=new Set(['a','b']);
  const accounts={sessions:db.collection('sessions'),async permissions(user,home){return home==='Home'&&members.has(user.id)?{}:null;}};
  const sent=[];
  const manager=new PushNotifications({db,accounts,store:{repo:{async get(home){return home==='Home'?{devices:[{id:1007,Name:'Lamp'}]}:null;}}},messaging:{async send(message){sent.push(message);}}});
  const payload=()=>({homeName:'Home',deviceID:1007,message:'Tank empty',notificationId:randomUUID(),timestamp:Date.now()});
  const register=async(user,token,devices=[{homeName:'Home',deviceID:1007}])=>{
    await accounts.sessions.insertOne({_id:hash(user),userId:user,expiresAt:new Date(Date.now()+10000)});
    await manager.register({id:user},user,{token,devices});
  };
  return {db,accounts,manager,members,sent,payload,register};
}
test('push reaches each opted-in phone without sockets and deduplicates hub events',async()=>{
  const f=fixture();await f.register('a','token_a'.repeat(10));await f.register('b','token_b'.repeat(10));
  const event=f.payload();await Promise.all([f.manager.deliver('Home',event),f.manager.deliver('Home',event)]);
  assert.equal(f.sent.length,2);assert.equal(f.sent[0].data.recipient,'a');assert.equal(f.sent[0].data.sessionId,hash('a'));
  assert.equal(f.sent[0].android.priority,'high');assert.equal(f.sent[0].notification,undefined);
});
test('opt-out, removed sharing, expired session and unregister prevent push',async()=>{
  const f=fixture();await f.register('a','token_a'.repeat(10),[]);await f.register('b','token_b'.repeat(10));
  f.members.delete('b');await f.manager.deliver('Home',f.payload());assert.equal(f.sent.length,0);
  f.members.add('b');await f.accounts.sessions.deleteOne({_id:hash('b')});
  await f.manager.deliver('Home',f.payload());assert.equal(f.sent.length,0);
  assert.equal(f.manager.tokens.rows.length,1);
  await f.manager.unregister({id:'a'},'a');assert.equal(f.manager.tokens.rows.length,0);
});
test('invalid hub home/device/message cannot generate notifications',async()=>{
  const f=fixture();await f.register('a','token_a'.repeat(10));
  await f.manager.deliver('Other',f.payload());
  await f.manager.deliver('Home',{...f.payload(),deviceID:999});
  await f.manager.deliver('Home',{...f.payload(),message:'x'.repeat(513)});
  assert.equal(f.sent.length,0);
});
test('invalid FCM registrations are removed without exposing tokens in logs',async()=>{
  const f=fixture();await f.register('a','token_a'.repeat(10));
  f.manager.messaging.send=async()=>{throw Object.assign(new Error('private token'),{code:'messaging/registration-token-not-registered'});};
  await f.manager.deliver('Home',f.payload());assert.equal(f.manager.tokens.rows.length,0);
});
