 'use strict';
const crypto=require('node:crypto'),express=require('express');
const MAX=1024*1024;
const signingKey=()=>process.env.OTA_SIGNING_PRIVATE_KEY || (process.env.OTA_SIGNING_KEY_FILE?require("node:fs").readFileSync(process.env.OTA_SIGNING_KEY_FILE):process.env.OTA_SIGNING_PRIVATE_KEY_BASE64?Buffer.from(process.env.OTA_SIGNING_PRIVATE_KEY_BASE64,"base64"):null);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function prepare(buffer,version,key){
 if(!Buffer.isBuffer(buffer)||buffer.length<4096||buffer.length>MAX||buffer[0]!==0xe9)throw new Error('Choose a compiled ESP8266 sketch .bin (4 KB–1 MB), not a filesystem image');
 if(typeof version!=='string'||!version.trim()||version.length>60)throw new Error('Enter a firmware version (1–60 characters)');
 if(!key)throw new Error('Firmware signing is not configured');
 const signature=crypto.sign('sha256',buffer,key),length=Buffer.alloc(4);length.writeUInt32LE(signature.length);
 const body=Buffer.concat([buffer,signature,length]);
 return {id:crypto.randomUUID(),version:version.trim(),size:buffer.length,sha256:hash(body),sketchMD5:crypto.createHash('md5').update(buffer).digest('hex'),createdAt:new Date().toISOString(),body};
}
function metadata(file){const {body,...rest}=file;return rest;}
function route(fn){return async(q,r)=>{try{await fn(q,r);}catch(e){r.status(400).json({error:e.message});}};}
function page(app,local){app.get('/firmware',(_q,r)=>r.sendFile(require('node:path').join(__dirname,'firmware.html')));app.get('/ota/mode',(_q,r)=>r.json({local}));}
function mountCloud({app,db,accounts,store,hubs}){
 page(app,false);const files=db.collection('firmware'),key=signingKey();
 const router=express.Router();router.use(async(q,r,next)=>{try{q.user=await accounts.authenticate((q.headers.authorization||'').replace(/^Bearer /,''));next();}catch(e){r.status(401).json({error:'Sign in required'});}});
 const allowed=async(q,home)=>{await accounts.require(q.user,home,'devices');};
 const command=(home,input)=>new Promise((resolve,reject)=>{const h=hubs.get(home);if(!h?.ready)return reject(new Error('Home hub is offline. Upload is saved; install when online.'));h.socket.timeout(20000).emit('FirmwareCommand',input,(error,result)=>error?reject(new Error('Hub did not respond; check status before retrying')):result?.error?reject(new Error(result.error)):resolve(result));});
 router.get('/homes',route(async(q,r)=>{const result=[];for(const h of await store.repo.all()){const p=await accounts.permissions(q.user,h._id);if(p?.devices)result.push({name:h._id,online:!!hubs.get(h._id)?.ready,devices:h.devices.map(d=>({id:d.id,name:d.Name}))});}r.json(result);}));
 router.get('/files',route(async(q,r)=>{await allowed(q,q.query.home);r.json(await files.find({home:q.query.home},{projection:{body:0}}).sort({createdAt:-1}).toArray());}));
 router.post('/upload',express.raw({type:'application/octet-stream',limit:MAX}),route(async(q,r)=>{const home=q.query.home;await allowed(q,home);if(await files.countDocuments({home})>=30)throw new Error('Remove an old firmware file first (30 per home)');const f={...prepare(q.body,q.query.version,key),home};await files.insertOne({...f,body:new (require('mongodb').Binary)(f.body)});r.json(metadata(f));}));
 router.delete('/files/:id',route(async(q,r)=>{const f=await files.findOne({id:q.params.id},{projection:{body:0}});if(!f)throw new Error('Firmware not found');await allowed(q,f.home);await files.deleteOne({id:f.id});r.json({ok:true});}));
 router.get('/status',route(async(q,r)=>{await allowed(q,q.query.home);r.json(await command(q.query.home,{action:'status',home:q.query.home}));}));
 router.post('/install',express.json({limit:'2kb'}),route(async(q,r)=>{const {home,deviceID,fileId}=q.body;await allowed(q,home);const doc=await store.repo.get(home);if(!doc?.devices.some(d=>d.id===Number(deviceID)))throw new Error('Device not found');const f=await files.findOne({home,id:fileId});if(!f)throw new Error('Firmware not found');r.json(await command(home,{action:'install',home,deviceID:Number(deviceID),file:{...metadata(f),body:Buffer.from(f.body.buffer).toString('base64')}}));}));
 app.use('/ota',router);
}
function mountLocal({app,sql,connections,home,hubToken}){
 page(app,true);sql.exec('CREATE TABLE IF NOT EXISTS ota_files(id TEXT PRIMARY KEY,meta TEXT NOT NULL,body BLOB NOT NULL); CREATE TABLE IF NOT EXISTS ota_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 const localKey=process.env.OTA_LOCAL_KEY,signKey=signingKey();
 const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
 function save(f){sql.prepare('INSERT OR REPLACE INTO ota_files VALUES(?,?,?)').run(f.id,JSON.stringify(metadata(f)),f.body);}
 function jobs(){return sql.prepare('SELECT body FROM ota_jobs ORDER BY rowid DESC LIMIT 30').all().map(x=>JSON.parse(x.body));}
 function put(j){sql.prepare('INSERT OR REPLACE INTO ota_jobs VALUES(?,?)').run(j.id,JSON.stringify(j));}
 for(const job of jobs())if(['installing','reconnecting'].includes(job.state))put({...job,state:'unconfirmed',message:'Hub restarted; waiting for device firmware verification'});
 const timers=new Map(),downloads=new Map();
 function status(){return {jobs:jobs(),devices:[...connections.values()].filter(d=>!home||d.HomeName===home).map(d=>({id:d.DeviceId,name:d.Name,version:d.firmwareVersion||'Unknown',ota:!!d.ota,sketchMD5:d.sketchMD5}))};}
 function install(deviceID,f){
 const d=connections.get(home+'|'+deviceID);if(!d?.Socket.connected)throw new Error('Device is offline');if(!d.ota)throw new Error('Install the OTA-enabled SmartSnap firmware by USB first');
 if(jobs().some(j=>j.deviceID===deviceID&&['installing','reconnecting'].includes(j.state)))throw new Error('This device already has an update in progress');
 const id=crypto.randomUUID(),token=crypto.randomBytes(24).toString('hex');const job={id,deviceID,version:f.version,fileId:f.id,sketchMD5:f.sketchMD5,state:'installing',startedAt:new Date().toISOString()};put(job);
 downloads.set(token,{body:f.body,expires:Date.now()+300000});
 d.Socket.emit('DeviceOTA',{jobId:id,path:'/ota/download/'+token,version:f.version});
 timers.set(id,setTimeout(()=>{downloads.delete(token);timers.delete(id);const current=jobs().find(x=>x.id===id);if(current&&current.state!=='completed'&&current.state!=='failed')put({...current,state:'unconfirmed',message:'No verified reboot received. Check the device before retrying.'});},180000));
 return job;
 }
 app.get('/ota/download/:token',(q,r)=>{const d=downloads.get(q.params.token);if(!d||d.expires<Date.now())return r.sendStatus(404);r.set('Content-Type','application/octet-stream');r.set('Cache-Control','no-store');r.send(d.body);});
 const router=express.Router();router.use((q,r,next)=>equal((q.headers.authorization||'').replace(/^Bearer /,''),localKey)?next():r.status(401).json({error:'Enter the local firmware administrator key'}));
 router.get('/homes',route(async(q,r)=>{const devices=sql.prepare("SELECT body FROM documents WHERE db=? AND collection='Devices'").all(home).map(x=>{const d=JSON.parse(x.body);return {id:d.id,name:d.Name};});r.json([{name:home,online:true,devices}]);}));
 router.get('/files',(_q,r)=>r.json(sql.prepare('SELECT meta FROM ota_files ORDER BY rowid DESC').all().map(x=>JSON.parse(x.meta))));
 router.get('/status',(_q,r)=>r.json(status()));
 router.post('/upload',express.raw({type:'application/octet-stream',limit:MAX}),route(async(q,r)=>{if(sql.prepare('SELECT count(*) n FROM ota_files').get().n>=30)throw new Error('Remove an old firmware file first');const f=prepare(q.body,q.query.version,signKey);save(f);r.json(metadata(f));}));
 router.delete('/files/:id',route(async(q,r)=>{sql.prepare('DELETE FROM ota_files WHERE id=?').run(q.params.id);r.json({ok:true});}));
 router.post('/install',express.json({limit:'2kb'}),route(async(q,r)=>{const row=sql.prepare('SELECT * FROM ota_files WHERE id=?').get(q.body.fileId);if(!row)throw new Error('Firmware not found');r.json(install(Number(q.body.deviceID),{...JSON.parse(row.meta),body:Buffer.from(row.body)}));}));
 app.use('/ota',router);
 return {command(data){if(data.home!==home)throw new Error('Wrong home');if(data.action==='status')return status();if(data.action!=='install')throw new Error('Unsupported firmware command');const f={...data.file,body:Buffer.from(data.file.body,'base64')};if(f.body.length>MAX+512||hash(f.body)!==f.sha256)throw new Error('Firmware integrity check failed');save(f);return install(Number(data.deviceID),f);},connected(d){for(const j of jobs())if(j.deviceID===d.DeviceId&&['installing','reconnecting','unconfirmed'].includes(j.state)&&d.sketchMD5===j.sketchMD5){put({...j,state:'completed',completedAt:new Date().toISOString()});}},progress(socket,data){const d=[...connections.values()].find(x=>x.Socket===socket);if(!d)return;const j=jobs().find(x=>x.id===data.jobId&&x.deviceID===d.DeviceId);if(!j||j.state==='completed')return;put({...j,state:data.error?'failed':'reconnecting',message:String(data.error||'Firmware received; waiting for verified reboot').slice(0,200)});},close(){for(const t of timers.values())clearTimeout(t);}};
}
module.exports={prepare,metadata,mountCloud,mountLocal};
