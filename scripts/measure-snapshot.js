const {execFileSync}=require('node:child_process');
const {randomBytes,createHash,randomUUID}=require('node:crypto');
(async()=>{
 const config=JSON.parse(execFileSync('heroku.cmd',['config','--json','-a','smarthomehub'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const mongo=new(require('mongodb').MongoClient)(config.CONFIG_MONGO_URI);await mongo.connect();
 const db=mongo.db('SmartHomeHubConfig'),token=randomBytes(32).toString('hex'),id=createHash('sha256').update(token).digest('hex');
 try{
 const owner=await db.collection('home_access').findOne({_id:'Home_Germany'});
 await db.collection('sessions').insertOne({_id:id,userId:owner.owner,expiresAt:new Date(Date.now()+600000)});
 for(const transport of ['default','websocket']){
  const start=Date.now();const socket=require('legacy-socket-client')('https://smarthomehub-1aec4600a734.herokuapp.com',{query:{token},forceNew:true,reconnection:false,...(transport==='websocket'?{transports:['websocket']}:{})});
  try{
   await new Promise((res,rej)=>{socket.once('connect',res);socket.once('connect_error',rej);setTimeout(()=>rej(new Error('connect timeout')),15000).unref();});
   console.log(JSON.stringify({transport,connectMs:Date.now()-start}));
   await new Promise(r=>setTimeout(r,500));
   for(let i=0;i<3;i++){
    const requestId=randomUUID(),sent=Date.now();
    const result=await new Promise((res,rej)=>{let timer=setTimeout(()=>rej(new Error('snapshot timeout')),15000);const fn=x=>{if(x.requestId===requestId){clearTimeout(timer);socket.off('GetVariableSnapshot',fn);res(x);}};socket.on('GetVariableSnapshot',fn);socket.emit('GetVariableSnapshot',{homeName:'Home_Germany',requestId});});
    console.log(JSON.stringify({transport,requestId,roundTripMs:Date.now()-sent,status:result.status,count:result.values?.length,actual:socket.io.engine.transport.name}));
   }
  }finally{socket.disconnect();}
 }
 }finally{await db.collection('sessions').deleteOne({_id:id});await mongo.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
