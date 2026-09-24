const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {prepare,mountLocal}=require('../firmware');
const {DatabaseSync}=require('node:sqlite');
test('firmware validates sketch and version and creates an ESP8266 signed image',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const raw=Buffer.alloc(5000);raw[0]=0xe9;
 const f=prepare(raw,'TempSens_1.0.1',privateKey);assert.equal(f.body.readUInt32LE(f.body.length-4),256);
 assert(crypto.verify('sha256',raw,publicKey,f.body.subarray(raw.length,-4)));
 assert.equal(f.version,'TempSens_1.0.1');assert.equal(f.sketchMD5,crypto.createHash('md5').update(raw).digest('hex'));
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
  assert.throws(()=>svc.command({...command,newDeviceID:2000}),/First update/);
  d.otaDeviceId=true;
  for(const bad of [0,-1,2.5,'abc',2147483648,true])assert.throws(()=>svc.command({...command,newDeviceID:bad}),/positive device ID/);
  sql.exec("CREATE TABLE documents(db TEXT,collection TEXT,body TEXT)");
  assert.throws(()=>svc.command({...command,newDeviceID:2000}),/Create the new device/);
  sql.prepare("INSERT INTO documents VALUES('Test','Devices',?)").run(JSON.stringify({id:2000,Name:'New'}));
  connections.set('Test|2000',{Socket:{connected:true}});
  assert.throws(()=>svc.command({...command,newDeviceID:2000}),/already connected/);
  connections.delete('Test|2000');
  const assigned=svc.command({...command,newDeviceID:'2000'});assert.equal(sent.newDeviceID,2000);
  svc.connected({...d,otaCompletedJob:assigned.id,sketchMD5:f.sketchMD5});
  assert.equal(svc.command({action:'status',home:'Test'}).jobs[0].state,'installing');
  svc.connected({...d,DeviceId:2000,otaCompletedJob:assigned.id,sketchMD5:f.sketchMD5});
  assert.equal(svc.command({action:'status',home:'Test'}).jobs[0].state,'completed');


 }finally{svc.close();await new Promise(r=>server.close(r));sql.close();}
});
