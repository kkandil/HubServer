'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomBytes}=require('node:crypto'),{execFileSync}=require('node:child_process');
const filename=path.resolve(__dirname,'../../Migration/private/account-live-test.json');
const base='https://smarthomehub-1aec4600a734.herokuapp.com';
async function api(endpoint,body,token) {
  const r=await fetch(base+'/api/'+endpoint,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();if(data.status!=='OK')throw new Error(data.message);return data;
}
async function main(){
  if(process.argv.includes('--update-layout')) {
    const data=JSON.parse(fs.readFileSync(filename)),owner=data.accounts[0];
    const home=(await api('homes',null,owner.token)).homes.find(h=>h.homeName===data.home);
    await api('homes/'+data.home+'/layout',{revision:home.layout.revision,widgets:[{id:'qa-widget',type:'TEXTBOX',x:20,y:20,width:650,height:250,label:'Shared layout updated live'}]},owner.token);
    console.log('Temporary shared layout updated');return;
  }
  if(process.argv.includes('--cleanup')) {
    const data=JSON.parse(fs.readFileSync(filename));if(!/^AccountQA_[a-f0-9]+$/.test(data.home))throw new Error('Unexpected test home');
    const config=JSON.parse(execFileSync('heroku.cmd',['config','--json','-a','smarthomehub'],{encoding:'utf8',shell:true,stdio:['ignore','pipe','pipe']}));
    const client=new(require('mongodb').MongoClient)(config.CONFIG_MONGO_URI);await client.connect();
    try{const db=client.db('SmartHomeHubConfig');for(const a of data.accounts){
      if(!a.email.startsWith('qa_'+data.suffix+'_')||!a.email.endsWith('@example.test'))throw new Error('Unexpected test identity');
      const user=await db.collection('users').findOne({_id:a.user.id,email:a.email});if(!user)continue;
      await db.collection('sessions').deleteMany({userId:user._id});await db.collection('users').deleteOne({_id:user._id,email:a.email});
    }
    for(const col of ['homes','home_access','home_layouts'])await db.collection(col).deleteOne({_id:data.home});
    console.log('Temporary account test data removed');}finally{await client.close();}return;
  }
  const suffix=randomBytes(5).toString('hex'),data={suffix,home:'AccountQA_'+suffix,accounts:[]};
  for(const role of ['owner','member']) {
    const email='qa_'+suffix+'_'+role+'@example.test',password=randomBytes(4).toString('hex');
    const r=await api('register',{email,password});data.accounts.push({email,password,...r});
    fs.writeFileSync(filename,JSON.stringify(data),{mode:0o600});
  }
  const [owner,member]=data.accounts;
  const socket=require('socket.io-client')(base,{query:{token:owner.token},transports:['websocket'],reconnection:false});
  try {
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    const ask=(event,input)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Request timeout')),10000);socket.once(event,x=>{clearTimeout(timer);resolve(x);});socket.emit(event,input);});
    assert.equal(await ask('AddNewHome',{homeName:data.home}),'OK');
    await api('profile',{nickname:'QA Owner'},owner.token);await api('profile',{nickname:'QA Member'},member.token);
    await api('homes/'+data.home+'/share',{email:member.email,permissions:{layout:true,events:true,schedules:true}},owner.token);
    const widget={id:'qa-widget',type:'TEXTBOX',x:20,y:20,width:240,height:120,label:'Shared layout test'};
    await api('homes/'+data.home+'/layout',{revision:0,widgets:[widget]},owner.token);
    const homes=await api('homes',null,member.token);assert.deepEqual(homes.homes.map(h=>h.homeName),[data.home]);assert.equal(homes.homes[0].layout.widgets[0].label,widget.label);
    widget.label='Updated by shared member';await api('homes/'+data.home+'/layout',{revision:1,widgets:[widget]},member.token);
    assert.equal((await api('homes',null,owner.token)).homes[0].layout.revision,2);
    await assert.rejects(api('homes/'+data.home+'/layout',{revision:1,widgets:[]},owner.token),/changed/);
    await assert.rejects(api('homes/'+data.home+'/share',{email:owner.email,permissions:{}},member.token),/permission/);
    console.log('Live registration (8 characters), email login, sharing, layout synchronization, conflicts, and permission isolation verified');
  }finally{socket.disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
