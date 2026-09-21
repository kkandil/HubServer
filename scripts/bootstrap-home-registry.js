'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {MongoClient}=require('mongodb');
const {DatabaseSync}=require('node:sqlite');
const {randomBytes}=require('node:crypto');
const privateDir=path.resolve(__dirname,'../../Migration/private');
const cli=(...args)=>execFileSync(process.platform==='win32'?'heroku.cmd':'heroku',args,{encoding:'utf8',shell:process.platform==='win32',stdio:['ignore','pipe','pipe']});
async function main(){
  const source=JSON.parse(cli('config','--json','-a','smarthome'));
  if(!source.MONGO_URI)throw new Error('Existing Mongo connection unavailable');
  const keysFile=path.join(privateDir,'gateway-keys.json'), keys=JSON.parse(fs.readFileSync(keysFile));
  keys.EGYPT_HUB_TOKEN=keys.EGYPT_HUB_TOKEN||randomBytes(32).toString('hex');fs.writeFileSync(keysFile,JSON.stringify(keys),{mode:0o600});
  const mongo=new MongoClient(source.MONGO_URI,{serverSelectionTimeoutMS:20000});await mongo.connect();
  try {
    const db=mongo.db('SmartHomeHubConfig');
    const sql=new DatabaseSync(path.join(privateDir,'before-multi-home.sqlite'),{readOnly:true});
    let maxId=1000;
    for(const {db:home} of sql.prepare("SELECT db FROM collections WHERE name='Devices'").all()){
      const sourceDevices=sql.prepare("SELECT body FROM documents WHERE db=? AND collection='Devices'").all(home).map(r=>JSON.parse(r.body));
      const devices=sourceDevices.map(d=>{
        maxId=Math.max(maxId,d.id);return {id:d.id,Name:d.Name,variables:sql.prepare('SELECT body FROM documents WHERE db=? AND collection=?').all(home,'Var_'+d.Name).map(r=>JSON.parse(r.body))};
      });
      const events=sql.prepare('SELECT body FROM conditional_events WHERE home=?').all(home).map(r=>JSON.parse(r.body));
      await db.collection('homes').updateOne({_id:home},{$setOnInsert:{revision:1,appliedRevision:0,devices,events,lastSeen:null,receipts:[]}},{upsert:true});
      await db.collection('homes').updateOne({_id:home,runtime:{$exists:false}},{$set:{runtime:{homeName:home,devices:sourceDevices,events:sql.prepare('SELECT id,last_run FROM conditional_events WHERE home=?').all(home).map(r=>({id:r.id,lastRun:r.last_run?JSON.parse(r.last_run):null}))}}});
      if(process.argv.includes('--refresh-seed')) {
        const result=await db.collection('homes').updateOne({_id:home,revision:1,appliedRevision:0},{$set:{devices,events}});
        if(!result.matchedCount)throw new Error('Registry already active; refusing to overwrite '+home);
      }
      console.log('Registry prepared:',home,devices.length,'devices,',events.length,'events');
    }
    sql.close();await db.collection('meta').updateOne({_id:'deviceCounter'},{$max:{value:maxId}},{upsert:true});
    if(process.argv.includes('--configure')){
      const token=cli('auth:token').trim();
      const response=await fetch('https://api.heroku.com/apps/smarthomehub/config-vars',{method:'PATCH',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.heroku+json; version=3','Content-Type':'application/json'},body:JSON.stringify({CONFIG_MONGO_URI:source.MONGO_URI,HUB_BINDINGS:JSON.stringify({Home_Germany:keys.HUB_TOKEN,Home_Egypt:keys.EGYPT_HUB_TOKEN})})});
      if(!response.ok)throw new Error('Gateway configuration failed: '+response.status);
      console.log('Gateway configured for independent home hubs.');
    }
  } finally {await mongo.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
