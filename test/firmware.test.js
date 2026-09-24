const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {prepare,mountLocal}=require('../firmware');
const {DatabaseSync}=require('node:sqlite');
test('firmware validates sketch and version and creates an ESP8266 signed image',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const raw=Buffer.alloc(5000);raw[0]=0xe9;
 const f=prepare(raw,'1.2',privateKey);assert.equal(f.body.readUInt32LE(f.body.length-4),256);
 assert(crypto.verify('sha256',raw,publicKey,f.body.subarray(raw.length,-4)));
 assert.equal(f.sketchMD5,crypto.createHash('md5').update(raw).digest('hex'));
 assert.throws(()=>prepare(Buffer.alloc(5000),'1',privateKey));assert.throws(()=>prepare(raw,'',privateKey));
});
test('local OTA rejects unauthenticated upload, offline targets, bad transfers; completion requires matching image',async()=>{
 const sql=new DatabaseSync(':memory:'),app=require('express')(),connections=new Map();let sent;
 const svc=mountLocal({app,sql,connections,home:'Test'});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/ota/files');assert.equal(response.status,401);
  const raw=Buffer.alloc(5000);raw[0]=0xe9;const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const f=prepare(raw,'new',privateKey);
  const command={action:'install',home:'Test',deviceID:1007,file:{...f,body:f.body.toString('base64')}};
  assert.throws(()=>svc.command({...command,home:'Other'}),/Wrong home/);
  assert.throws(()=>svc.command({...command,file:{...command.file,sha256:'wrong'}}),/integrity/);
  assert.throws(()=>svc.command(command),/offline/);
  const d={DeviceId:1007,HomeName:'Test',ota:true,Socket:{connected:true,emit:(event,data)=>sent=data}};connections.set('Test|1007',d);
  assert.throws(()=>svc.command({...command,replaceConfiguration:true}),/First install/);
  const job=svc.command(command);assert.equal(job.state,'installing');assert(sent.path.startsWith('/ota/download/'));
  assert.throws(()=>svc.command(command),/already/);
  svc.connected({...d,sketchMD5:'wrong'});assert.equal(svc.command({action:'status',home:'Test'}).jobs[0].state,'installing');
  svc.connected({...d,sketchMD5:f.sketchMD5});assert.equal(svc.command({action:'status',home:'Test'}).jobs[0].state,'completed');
  d.otaReplaceConfiguration=true;d.hardwareId='aa:bb:cc:dd:ee:ff';
  const replacement=svc.command({...command,replaceConfiguration:true});
  assert.equal(sent.replaceConfiguration,true);assert.equal(sent.sketchMD5,f.sketchMD5);
  const replacementDevice={...d,DeviceId:2000,sketchMD5:f.sketchMD5};
  svc.connected(replacementDevice);
  assert.equal(svc.command({action:'status',home:'Test'}).jobs[0].state,'installing');
  svc.connected({...replacementDevice,otaCompletedJob:replacement.id});
  const done=svc.command({action:'status',home:'Test'}).jobs[0];assert.equal(done.state,'completed');assert.equal(done.newDeviceID,2000);

 }finally{svc.close();await new Promise(r=>server.close(r));sql.close();}
});
