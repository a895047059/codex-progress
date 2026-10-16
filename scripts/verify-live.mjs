// Explicit, opt-in integration check against the already-running service.
// Creates only disposable fixtures; never resumes an existing thread.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppServerClient} from '../src/rpc-client.mjs';
import {ThreadController} from '../src/controller.mjs';
import {ProgressModel} from '../src/model.mjs';

if(!process.argv.includes('--live'))throw Error('Pass --live to run this opt-in check.');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ephemeral=!process.argv.includes('--stored-fixture');
const fixture=path.join(root,'work','live-fixture');
await mkdir(fixture,{recursive:true});
const report={startedAt:new Date().toISOString(),fixtureType:ephemeral?'ephemeral':'disposable-stored',checks:{},existingThreadsModified:false};
const client=new AppServerClient({timeoutMs:15000});
const model=new ProgressModel(),control=new ThreadController(model,{client});
const turns=new Map(),waiters=new Map();
const texts=new Map();
let threadId;
client.on('notification',event=>{
  if(event.params?.threadId!==threadId)return;
  if(event.method==='item/completed'&&event.params.item?.type==='agentMessage')texts.set(event.params.item.id,event.params.item.text||'');
  if(event.method==='turn/completed'){
    const turn=event.params.turn;turns.set(turn.id,turn);waiters.get(turn.id)?.(turn);
  }
});
async function waitTurn(id,timeoutMs=60000){
  if(turns.has(id))return turns.get(id);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(id);reject(Error('Turn completion timeout'));},timeoutMs);
    waiters.set(id,turn=>{clearTimeout(timer);waiters.delete(id);resolve(turn);});
  });
}
function check(name,value){report.checks[name]=value;console.log(JSON.stringify({check:name,value}));}
try{
  await client.connect();control.connected=true;
  const result=await client.request('thread/start',{ephemeral,cwd:fixture,sandbox:'read-only',approvalPolicy:'never'});
  threadId=result.thread.id;
  if(result.thread.ephemeral!==ephemeral)throw Error('Unexpected test thread persistence');
  if(!ephemeral)await client.request('thread/name/set',{threadId,name:'Codex Progress · 临时验收'});
  model.ensure(threadId);model.activeId=threadId;
  await control.poll();
  if(!control.capability(threadId).available)throw Error('Ephemeral thread does not accept direct input');
  check('fixtureControllable',true);
  if(!process.argv.includes('--approval-only')){
  const sent=await control.send(threadId,{text:'这是一次连接验收。请只回复 PROGRESS_LIVE_OK，不使用任何工具。',effort:'low'});
  const completed=await waitTurn(sent.turnId);
  const replies=[...texts.values()].join('\n');
  check('realMessageCompleted',completed.status==='completed');
  check('expectedReply',replies.includes('PROGRESS_LIVE_OK'));
  if(completed.status!=='completed'||!replies.includes('PROGRESS_LIVE_OK'))throw Error('Live message verification failed');

  if(!ephemeral){
  await control.setGoal(threadId,{status:'paused',objective:'连接验收：仅回复 PROGRESS_GOAL_OK；不要读写文件或运行任何工具。'});
  await client.request('thread/goal/set',{threadId,tokenBudget:1500,status:'paused',origin:'user'});
  check('goalPaused',(await client.request('thread/goal/get',{threadId})).goal?.status==='paused');
  await control.setGoal(threadId,{status:'active'});
  check('goalResumed',(await client.request('thread/goal/get',{threadId})).goal?.status==='active');
  await control.setGoal(threadId,{status:'paused'});
  check('goalPausedAgain',(await client.request('thread/goal/get',{threadId})).goal?.status==='paused');
  await control.interrupt(threadId);
  await client.request('thread/goal/set',{threadId,status:'complete',origin:'user'});
  }
  }

  if(process.argv.includes('--approval')){
    let approvalResolve;
    const approvalReceived=new Promise(resolve=>{approvalResolve=resolve;});
    const handler=request=>{if(request.params?.threadId===threadId)approvalResolve(request);};
    client.on('request',handler);
    try{
      await control.send(threadId,{permission:'read',effort:'low',text:`这是审批拒绝验收。请通过一次工具调用申请向 ${path.join(fixture,'approval-probe.txt')} 写入内容 PROGRESS_APPROVAL_TEST 的权限；不要绕过权限或改用其他路径。若请求被拒绝，立即停止并回复 PROGRESS_APPROVAL_DENIED。`});
      let timer;
      const request=await Promise.race([approvalReceived,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No approval request within 60s')),60000);})]).finally(()=>clearTimeout(timer));
      const pending=control.approvals.list(threadId)[0];
      if(!pending)throw Error('Approval not present in production store');
      check('realApprovalKind',request.method);
      check('availableDecisions',pending.decisions);
      const decision=pending.kind==='permissions'?'decline':pending.decisions.includes('decline')?'decline':pending.decisions.includes('cancel')?'cancel':null;
      if(!decision)throw Error('No supported rejection decision offered by service');
      control.approvals.answer(threadId,pending.id,{decision});
      check('realApprovalDeclined',true);
      try{await readFile(path.join(fixture,'approval-probe.txt'));check('approvalFileAbsent',false);}
      catch(error){if(error.code!=='ENOENT')throw error;check('approvalFileAbsent',true);}
    }finally{client.off('request',handler);}
  }
}catch(error){report.error=error.message;console.log(JSON.stringify({error:error.message}));process.exitCode=1;}
finally{
  if(threadId){
    try{const goal=(await client.request('thread/goal/get',{threadId})).goal;if(goal&&goal.status!=='complete')await client.request('thread/goal/set',{threadId,status:'paused',origin:'user'});}catch{}
    try{await control.interrupt(threadId);}catch{}
    if(!ephemeral){
      try{await client.request('thread/archive',{threadId});await client.request('thread/delete',{threadId});report.fixtureDeleted=true;}
      catch(error){report.fixtureDeleted=false;report.fixtureCleanupError=error.message;process.exitCode=1;}
    }
    try{const result=await client.request('thread/unsubscribe',{threadId});report.cleanup=result.status;}catch(error){report.cleanupError=error.message;}
  }
  await client.close();
  report.finishedAt=new Date().toISOString();
  const reportName=process.argv.includes('--approval-only')?'live-approval-verification.json':'live-verification.json';
  await writeFile(path.join(root,'work',reportName),JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:'work/'+reportName,cleanup:report.cleanup}));
}
