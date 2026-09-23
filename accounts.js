'use strict';
const {randomBytes, randomUUID, scrypt, timingSafeEqual, createHash} = require('node:crypto');
const derive = require('node:util').promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const emailAddress = value => {
  if (typeof value !== 'string' || value.trim().length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new Error('Enter a valid email address');
  return value.trim().toLowerCase();
};
const permissionKeys = ['home', 'devices', 'events', 'schedules', 'layout'];
const full = Object.fromEntries(permissionKeys.map(k => [k, true]));
class Accounts {
  constructor(db, {legacyToken, ownerEmail = 'khaledmagdy50@gmail.com'} = {}) {
    this.users=db.collection('users'); this.sessions=db.collection('sessions'); this.access=db.collection('home_access');
    this.layouts=db.collection('home_layouts'); this.limits=db.collection('auth_limits');
    this.legacyToken=legacyToken; this.ownerEmail=ownerEmail;
  }
  async init() {
    await this.users.createIndex({email:1},{unique:true});
    await this.sessions.createIndex({expiresAt:1},{expireAfterSeconds:0});
    await this.limits.createIndex({expiresAt:1},{expireAfterSeconds:0});
  }
  async limit(ip) {
    const bucket=Math.floor(Date.now()/900000), id=digest(String(ip))+':'+bucket;
    const r=await this.limits.findOneAndUpdate({_id:id},{$inc:{count:1},$setOnInsert:{expiresAt:new Date(Date.now()+1800000)}},{upsert:true,returnDocument:'after'});
    if(r.count>30) throw new Error('Too many attempts. Try again in 15 minutes');
  }
  async register(input, homes) {
    const email=emailAddress(input.email);
    if(typeof input.password!=='string' || input.password.length<8 || input.password.length>128) throw new Error('Use a password of 8–128 characters');
    const migrating=email===this.ownerEmail;
    if(migrating && (!this.legacyToken || typeof input.claimKey!=='string' || digest(input.claimKey)!==digest(this.legacyToken))) throw new Error('Existing-home setup requires your previous server access key');
    const salt=randomBytes(16).toString('hex');
    const hash=(await derive(input.password,salt,64,{N:32768,maxmem:64*1024*1024})).toString('hex');
    const user={_id:randomUUID(),email,username:migrating?"khaled":"",salt,hash,createdAt:new Date()};
    try {await this.users.insertOne(user);} catch(e) {if(e.code===11000) throw new Error('Email is already registered');throw e;}
    if(migrating) await this.claimLegacy(user,homes);
    return {...await this.session(user),migrated:migrating};
  }
  async claimLegacy(user, homes) {
    if(user.email!==this.ownerEmail)return;
    for(const h of await homes.all()) if(['Home_Germany','Home_Egypt'].includes(h._id)) await this.access.updateOne({_id:h._id},{$setOnInsert:{owner:user._id,members:{}}},{upsert:true});
  }
  async login(input, homes) {
    const email=emailAddress(input.email);
    if(typeof input.password!=='string'||input.password.length>128)throw new Error('Incorrect email or password');
    const user=await this.users.findOne({email});
    const hash=await derive(input.password,user?.salt||'00000000000000000000000000000000',64,{N:32768,maxmem:64*1024*1024});
    if(!user || !timingSafeEqual(hash,Buffer.from(user.hash,'hex')))throw new Error('Incorrect email or password');
    await this.claimLegacy(user,homes);
    return {...await this.session(user),migrated:user.email===this.ownerEmail};
  }
  async session(user) {
    const token=randomBytes(32).toString('hex');
    await this.sessions.insertOne({_id:digest(token),userId:user._id,expiresAt:new Date(Date.now()+90*86400000)});
    return {token,user:{id:user._id,username:user.username,email:user.email}};
  }
  async authenticate(token) {
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new Error('Sign in required');
    const s=await this.sessions.findOne({_id:digest(token),expiresAt:{$gt:new Date()}});
    if(!s)throw new Error('Sign in required');
    const user=await this.users.findOne({_id:s.userId}); if(!user)throw new Error('Sign in required');
    // Sliding expiry means regular users stay signed in; unused sessions expire.
    await this.sessions.updateOne({_id:s._id},{$max:{expiresAt:new Date(Date.now()+90*86400000)}});
    return {id:user._id,username:user.username,email:user.email};
  }
  async logout(token) {await this.sessions.deleteOne({_id:digest(token)});}
  async profile(user,input) {
    if(typeof input.nickname!=='string'||!input.nickname.trim()||input.nickname.trim().length>40)throw new Error('Enter a nickname of 1–40 characters');
    await this.users.updateOne({_id:user.id},{$set:{username:input.nickname.trim()}});
    return {...user,username:input.nickname.trim()};
  }
  async permissions(user,home) {
    const a=await this.access.findOne({_id:home});
    if(!a)return null;
    if(a.owner===user.id)return {owner:true,...full};
    return a.members?.[user.id] ? {owner:false,...a.members[user.id]} : null;
  }
  async require(user,home,permission) {
    const p=await this.permissions(user,home);
    if(!p || (permission && !p[permission]))throw new Error('You do not have permission for this home or action');
    return p;
  }
  async own(user,home) {await this.access.updateOne({_id:home},{$set:{owner:user.id,members:{}}},{upsert:true}); await this.layouts.deleteOne({_id:home});}
  async removeHome(home) {await this.access.deleteOne({_id:home});await this.layouts.deleteOne({_id:home});}
  async share(user,home,input) {
    await this.require(user,home,'owner');
    const target=await this.users.findOne({email:emailAddress(input.email)});
    if(!target)throw new Error('That user needs to create an account first');
    if(target._id===user.id)throw new Error('You already own this home');
    const field='members.'+target._id;
    const permissions=Object.fromEntries(permissionKeys.map(k=>[k,input.permissions?.[k]===true]));
    await this.access.updateOne({_id:home},input.remove?{$unset:{[field]:''}}:{$set:{[field]:permissions}});
  }
  async members(user,home) {
    await this.require(user,home,'owner');
    const a=await this.access.findOne({_id:home}); const result=[];
    for(const [id,permissions] of Object.entries(a.members||{})) {
      const u=await this.users.findOne({_id:id}); if(u)result.push({username:u.username,email:u.email,permissions});
    }
    return result;
  }
  async layout(user,home) {await this.require(user,home); return await this.layouts.findOne({_id:home})||{_id:home,revision:0,widgets:null};}
  async saveLayout(user,home,input) {
    await this.require(user,home,'layout');
    if(!Number.isSafeInteger(input.revision)||input.revision<0 || !Array.isArray(input.widgets)||input.widgets.length>200 || Buffer.byteLength(JSON.stringify(input.widgets))>500000)throw new Error('Invalid widget layout');
    const ids=new Set();
    for(const w of input.widgets) {
      if(!w || typeof w.id!=='string'||w.id.length>128||ids.has(w.id)||!['BUTTON','TEXTBOX','TEXTBOX_UNIT','CHECKBOX','SLIDER','TEXT_INPUT'].includes(w.type))throw new Error('Invalid widget');
      if(['x','y','width','height'].some(k=>!Number.isSafeInteger(w[k])||w[k]<0||w[k]>100000)||typeof w.label!=='string'||w.label.length>1024|| (w.binding!=null&&(typeof w.binding!=='object'||Array.isArray(w.binding))))throw new Error('Invalid widget dimensions or settings');
      ids.add(w.id);
      delete w.currentValue; delete w.lastUpdateTimestamp; delete w.buttonPreviewOn;
    }
    const rooms=input.rooms===undefined?(await this.layouts.findOne({_id:home}))?.rooms||[]:input.rooms;
    if(!Array.isArray(rooms)||rooms.length>50||rooms.some(r=>typeof r!=='string'||!r.trim()||r.length>40)||new Set(rooms).size!==rooms.length)throw new Error('Invalid rooms');
    const doc={_id:home,revision:input.revision+1,widgets:input.widgets,rooms};
    if(input.revision===0) {try {await this.layouts.insertOne(doc);} catch(e){if(e.code===11000)throw new Error('Layout changed on another phone. Reload before editing');throw e;}}
    else if(!(await this.layouts.replaceOne({_id:home,revision:input.revision},doc)).matchedCount)throw new Error('Layout changed on another phone. Reload before editing');
    return doc;
  }
}
function attachAccountRoutes(app,accounts,store,notify) {
  app.use('/api',require('express').json({limit:'600kb'}));
  app.use('/api',(_q,r,next)=>{r.set('Cache-Control','no-store');next();});
  const route=fn=>async(q,r)=>{try{r.json({status:'OK',...await fn(q)});}catch(e){r.status(e.message==='Sign in required'?401:400).json({status:'Error',message:e.message});}};
  for(const method of ['register','login']) app.post('/api/'+method,route(async q=>{await accounts.limit(q.ip);return accounts[method](q.body,store.repo);}));
  app.use('/api',async(q,r,next)=>{try{q.token=(q.headers.authorization||'').replace(/^Bearer /,'');q.user=await accounts.authenticate(q.token);next();}catch(e){r.status(401).json({status:'Error',message:'Sign in required'});}});
  app.post('/api/logout',route(async q=>{await accounts.logout(q.token);await notify(null,q.user.id);return {};}));
  app.get('/api/me',route(async q=>({user:q.user})));
  app.post('/api/profile',route(async q=>({user:await accounts.profile(q.user,q.body)})));
  app.get('/api/homes',route(async q=>{
    const homes=[];for(const d of await store.repo.all()){const permissions=await accounts.permissions(q.user,d._id);if(permissions)homes.push({homeName:d._id,permissions,layout:await accounts.layout(q.user,d._id)});}return {homes};
  }));
  app.get('/api/homes/:home/members',route(async q=>({members:await accounts.members(q.user,q.params.home)})));
  app.post('/api/homes/:home/share',route(async q=>{await accounts.share(q.user,q.params.home,q.body);await notify(q.params.home);return {};}));
  app.post('/api/homes/:home/layout',route(async q=>{const layout=await accounts.saveLayout(q.user,q.params.home,q.body);await notify(q.params.home);return {layout};}));
}
module.exports={Accounts,attachAccountRoutes,permissionKeys};
