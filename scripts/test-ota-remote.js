// Explicit physical test: only TestDev_1 (1007) in Home_Germany.
'use strict';
const fs=require('fs'),{execFileSync}=require('child_process'),{randomBytes,createHash}=require('crypto');
(async()=>{
 const binary=process.argv[2];if(!binary)throw Error('Provide the compiled TestDev_1 .bin');
 const config=JSON.parse(execFileSync('heroku.cmd',['config','--json','-a','smarthomehub'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const mongo=new(require('mongodb').MongoClient)(config.CONFIG_MONGO_URI);await mongo.connect();const db=mongo.db('SmartHomeHubConfig');
 const token=randomBytes(32).toString('hex'),id=createHash('sha256').update(token).digest('hex');
 const base='https://smarthomehub-1aec4600a734.herokuapp.com',home='Home_Germany';
 const api=async(path,options={})=>{const r=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});const data=await r.json();if(!r.ok)throw Error(data.error||data.message);return data;};
 try{
  const owner=await db.collection('home_access').findOne({_id:home});await db.collection('sessions').insertOne({_id:id,userId:owner.owner,expiresAt:new Date(Date.now()+600000)});
  const before=await api('/ota/status?home='+home);console.log('Remote status:',JSON.stringify(before.devices.find(d=>d.id===1007)));
  const file=await api('/ota/upload?home='+home+'&version=1.2.0-ota',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:fs.readFileSync(binary)});console.log('Cloud firmware stored:',file.id,file.size);
  const job=await api('/ota/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({home,deviceID:1007,fileId:file.id})});console.log('Remote install started:',job.id);
  for(let i=0;i<60;i++){
   await new Promise(r=>setTimeout(r,2000));const status=await api('/ota/status?home='+home);const j=status.jobs.find(j=>j.id===job.id);
   if(j?.state==='completed'){const d=status.devices.find(d=>d.id===1007);if(d?.version!=='1.2.0-ota')throw Error('Wrong installed version');console.log('Remote OTA verified:',JSON.stringify(d));return;}
   if(j?.state==='failed')throw Error(j.message);
  }
  throw Error('OTA reboot not confirmed');
 }finally{await db.collection('sessions').deleteOne({_id:id});await mongo.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
