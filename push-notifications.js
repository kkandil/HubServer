 'use strict';
const {createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(value).digest('hex');
class PushNotifications {
  constructor({db,accounts,store,messaging}) {
    Object.assign(this,{accounts,store,messaging});
    this.tokens=db.collection('push_installations'); this.receipts=db.collection('push_receipts');
  }
  async init() {
    await this.tokens.createIndex({sessionId:1});
    await this.receipts.createIndex({expiresAt:1},{expireAfterSeconds:0});
  }
  async register(user,sessionToken,input) {
    if(typeof input.token!=='string'||input.token.length<20||input.token.length>4096||
        !Array.isArray(input.devices)||input.devices.length>2000) throw new Error('Invalid notification registration');
    const devices=[];
    for(const target of input.devices) {
      if(!target || typeof target.homeName!=='string'||target.homeName.length>200||!Number.isSafeInteger(target.deviceID))
        throw new Error('Invalid notification device');
      if(await this.accounts.permissions(user,target.homeName)) devices.push({homeName:target.homeName,deviceID:target.deviceID});
    }
    await this.tokens.updateOne({_id:hash(input.token)},{$set:{token:input.token,userId:user.id,
      sessionId:hash(sessionToken),devices,updatedAt:new Date()}},{upsert:true});
    return {configured:!!this.messaging};
  }
  async unregister(user,sessionToken) {
    await this.tokens.deleteMany({userId:user.id,sessionId:hash(sessionToken)});
  }
  async deliver(home,payload) {
    if(!this.messaging) return;
    if(!payload || payload.homeName!==home || typeof payload.message!=='string' || !payload.message.trim() ||
       Buffer.byteLength(payload.message)>512 || typeof payload.notificationId!=='string' ||
       !/^[0-9a-f-]{36}$/.test(payload.notificationId) || !Number.isSafeInteger(payload.deviceID)) return;
    if(payload.kind!==undefined && !['notification','alarm'].includes(payload.kind))return;
    const kind=payload.kind||'notification';
    const doc=await this.store.repo.get(home);
    const device=!doc?.deleted && doc?.devices.find(d=>d.id===payload.deviceID);
    if(!device) return;
    // Each hub event is processed once, independently of the number of open phones.
    try { await this.receipts.insertOne({_id:home+':'+payload.notificationId,expiresAt:new Date(Date.now()+86400000)}); }
    catch(e) { if(e.code===11000)return; throw e; }
    const targets=await this.tokens.find({devices:{$elemMatch:{homeName:home,deviceID:payload.deviceID}}}).toArray();
    let sent=0;
    for(const target of targets) {
      const session=await this.accounts.sessions.findOne({_id:target.sessionId,userId:target.userId,expiresAt:{$gt:new Date()}});
      if(!session) {await this.tokens.deleteOne({_id:target._id,sessionId:target.sessionId});continue;}
      if(!await this.accounts.permissions({id:target.userId},home))continue;
      try {
        await this.messaging.send({token:target.token,android:{priority:'high',ttl:kind==='alarm'?60000:300000},data:{
          kind,homeName:home,deviceID:String(device.id),deviceName:device.Name,message:payload.message,
          notificationId:payload.notificationId,recipient:target.userId,sessionId:target.sessionId,
          timestamp:String(payload.timestamp||Date.now())
        }});
        sent++;
      } catch(e) {
        if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(e.code))
          await this.tokens.deleteOne({_id:target._id,sessionId:target.sessionId});
        console.error('FCM send failed:',e.code||'unknown');
      }
    }
    console.log(`Device push: home=${home} device=${device.id} accepted=${sent}`);
  }
}
function firebaseMessaging() {
  if(!process.env.FIREBASE_SERVICE_ACCOUNT_JSON)return null;
  const {initializeApp,cert}=require('firebase-admin/app');
  const app=initializeApp({credential:cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))});
  return require('firebase-admin/messaging').getMessaging(app);
}
module.exports={PushNotifications,firebaseMessaging,hash};
