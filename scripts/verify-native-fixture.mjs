// Opt-in disposable fixture for checking the real native controls.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppServerClient} from '../src/rpc-client.mjs';
import {nativeTestHost} from './native-test-host.mjs';
if(!process.argv.includes('--live'))throw Error('Pass --live to create a disposable native fixture.');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd=path.join(root,'work','native-fixture');
await mkdir(cwd,{recursive:true});
await writeFile(path.join(cwd,'attachment.txt'),'Codex Progress native attachment verification.\n');
const client=new AppServerClient({timeoutMs:15000});
const report={startedAt:new Date().toISOString(),existingThreadsModified:false,replies:[],turns:[]};
let id,activeTurn,stopping=false,host;
// Keep the creator connection from auto-rejecting requests that the native
// controller is expected to present; no approval decision is made here.
client.on('request', request=>{
  if(request.params?.threadId===id)console.log(JSON.stringify({approvalObserved:request.method}));
});
client.on('notification',event=>{
  if(event.params?.threadId!==id)return;
  if(event.method==='turn/started')activeTurn=event.params.turn.id;
  if(event.method==='turn/completed'){
    if(activeTurn===event.params.turn.id)activeTurn=null;
    report.turns.push({id:event.params.turn.id,status:event.params.turn.status});
  }
  if(event.method==='item/completed'&&event.params.item?.type==='agentMessage'){
    const text=event.params.item.text||'';
    report.replies.push(text.slice(0,1000));
    console.log(JSON.stringify({reply:text.slice(0,300)}));
  }
});
async function stop(){
  if(stopping)return;stopping=true;clearTimeout(deadline);
  try{await client.request('thread/goal/set',{threadId:id,status:'paused',origin:'user'});}catch{}
  if(activeTurn)try{await client.request('turn/interrupt',{threadId:id,turnId:activeTurn});}catch{}
  try{await client.request('thread/archive',{threadId:id});await client.request('thread/delete',{threadId:id});report.fixtureDeleted=true;}catch(e){report.cleanupError=e.message;}
  try{report.cleanup=(await client.request('thread/unsubscribe',{threadId:id})).status;}catch{}
  if(host)await host.stop();
  client.close();report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,'work','native-verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({cleanup:report.cleanup,fixtureDeleted:report.fixtureDeleted}));process.exit(report.fixtureDeleted?0:1);
}
const deadline=setTimeout(stop,60*60*1000);
process.once('SIGTERM',stop);process.once('SIGINT',stop);
try{
  await client.connect();
  const result=await client.request('thread/start',{cwd,ephemeral:false,sandbox:'read-only',approvalPolicy:'on-request'});
  id=result.thread.id;report.threadId=id;
  if(process.argv.includes('--isolated-ui')){
    host=await nativeTestHost(root,result.thread.path);report.nativeHost=host.host;
    console.log(JSON.stringify({isolatedPort:host.port,nativePid:host.nativePid}));
  }
  await client.request('thread/name/set',{threadId:id,name:'Codex Progress · 原生联动验收'});
  await client.request('turn/start',{threadId:id,input:[{type:'text',text:'本会话仅用于 Codex Progress 原生界面验收。请只回复 NATIVE_READY，不使用工具。',text_elements:[]}],effort:'low'});
  await client.request('thread/goal/set',{threadId:id,objective:'原生联动验收：仅在收到输入后按要求简短回复，不自动读写文件。',status:'paused',origin:'user',tokenBudget:2000});
  await writeFile(path.join(root,'work','native-fixture.json'),JSON.stringify({threadId:id,pid:process.pid,cwd}));
  console.log(JSON.stringify({threadId:id,pid:process.pid,ready:true}));
}catch(e){console.log(JSON.stringify({error:e.message}));await stop();}
