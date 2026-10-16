#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const args=process.argv.slice(2), command=args[0];
const option=name=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:undefined;};
const runtime=option('runtime')||process.env.CODEX_PROGRESS_RUNTIME||path.join(os.homedir(),'Library','Application Support','Codex Progress','runtime');
try{
  const {port}=JSON.parse(await readFile(path.join(runtime,'endpoint.json'),'utf8'));
  const host=`http://127.0.0.1:${port}`;
  if(command==='state'){console.log(JSON.stringify(await(await fetch(host+'/api/state')).json(),null,2));process.exit(0);}
  const threadId=option('thread')||process.env.CODEX_THREAD_ID||process.env.CODEX_SESSION_ID;if(!threadId)throw Error('请提供 --thread 会话ID');
  let event={kind:command,threadId};
  if(command==='plan'){
    let text='';for await(const chunk of process.stdin)text+=chunk;
    const data=JSON.parse(text);event={...event,...data,threadId,kind:'plan'};
  }else if(command==='update')event={...event,taskId:option('task'),status:option('status'),detail:option('detail')};
  else if(command==='status')event.status=option('status');
  else if(command!=='finish')throw Error('支持 plan / update / finish / status / state');
  const state=await(await fetch(host+'/api/state',{signal:AbortSignal.timeout(2000)})).json();
  event.turnId ??= state.threads.find(t=>t.id===threadId)?.turnId;
  const response=await fetch(host+'/api/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(2000)});
  const result=await response.json();if(!response.ok)throw Error(result.error);
  console.log(JSON.stringify(result));
}catch(e){console.error(`进度更新失败：${e.message}`);process.exitCode=1;}
