import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProgressModel } from './model.mjs';
import { RolloutWatcher } from './watcher.mjs';
import { ThreadController } from './controller.mjs';
import { handleControl } from './control-http.mjs';
import { InquiryService, handleInquiry } from './inquiry-service.mjs';
import { EditorBridge, handleEditor } from './editor-bridge.mjs';
import { RecordService, handleRecording } from './record-service.mjs';
import { SubagentService } from './subagents.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeIndex=process.argv.indexOf('--runtime');
const runtime=process.env.CODEX_PROGRESS_RUNTIME || (runtimeIndex>=0?process.argv[runtimeIndex+1]:null) || path.join(base,'runtime');
await mkdir(runtime,{recursive:true,mode:0o700});
const model=new ProgressModel(), watcher=new RolloutWatcher(model,process.env.CODEX_PROGRESS_SESSIONS), clients=new Set();
await watcher.poll();
const inquiries=new InquiryService({model,watcher,runtime});
await inquiries.load();
// Explicit updates survive the native app being closed and reopened in the same turn.
try {
  const saved=JSON.parse(await readFile(path.join(runtime,'plans.json'),'utf8'));
  for(const t of saved) {
    const current=model.threads.get(t.id);
    if(current && current.turnId===t.turnId && t.explicit) {
      const status=current.status==='running'?t.status:current.status;
      const endedAt=status===current.status?current.updatedAt:t.updatedAt;
      model.plan(t.id,t.tasks,t.goal,t.turnId);
      if(Array.isArray(t.taskGroups)&&t.taskGroups.length)model.restoreTaskGroups(t.id,t.taskGroups,Object.hasOwn(t,'currentTaskGroupId')?t.currentTaskGroupId:t.taskGroups.at(-1).id);
      if(status!=='running') model.end(t.id,status,false,endedAt);
    }
  }
}catch{}
function frame(data,opcode=1) {
  const body=Buffer.from(data), size=body.length;
  const header=Buffer.alloc(size<126?2:size<65536?4:10);header[0]=0x80|opcode;
  if(size<126)header[1]=size;else if(size<65536){header[1]=126;header.writeUInt16BE(size,2);}else{header[1]=127;header.writeBigUInt64BE(BigInt(size),2);}
  return Buffer.concat([header,body]);
}
let controlRevision=0;
const controller=process.env.CODEX_PROGRESS_DISABLE_CONTROL==='1' ? null : new ThreadController(model,{onChange:()=>{controlRevision++;broadcast().catch(()=>{});}});
const editorBridge=new EditorBridge({model,controller});
const recording=new RecordService({controller});
const subagents=new SubagentService(watcher);
const snapshot=()=>{
  const state=controller?.decorate(model.snapshot())||model.snapshot();
  state.threads=state.threads.map(thread=>{
    const metrics=watcher.metrics?.snapshot(thread.id,Date.now(),{running:thread.status==='running'});
    if(metrics&&thread.id!==state.activeId)metrics.points=[];
    return {...thread,metrics};
  });
  return {...state,observing:!watcher.error};
};
let persistedRevision='';
let persistQueue=Promise.resolve();
async function broadcast() {
  const clock=model.snapshot().threads.some(t=>t.status==='running')?Math.floor(Date.now()/5000):0;
  const revision=`${model.revision}:${controlRevision}:${clock}`;
  if(persistedRevision===revision)return;
  persistedRevision=revision;
  const data=JSON.stringify(snapshot());
  for(const socket of clients) {
    if(socket.writableLength>1024*1024){socket.destroy();continue;}
    socket.write(frame(data));
  }
  const saved=JSON.stringify(model.snapshot().threads.filter(t=>t.explicit));
  persistQueue=persistQueue.catch(()=>{}).then(async()=>{
    await writeFile(path.join(runtime,'plans.tmp'),saved,{mode:0o600});
    await rename(path.join(runtime,'plans.tmp'),path.join(runtime,'plans.json'));
  });
  await persistQueue;
}
let port;
function validOrigin(req) { return !req.headers.origin || [`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin); }
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; img-src 'self' data:; frame-ancestors 'none'`);
  if(!validOrigin(req) || ![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){res.writeHead(403).end();return;}
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  if(await handleRecording(req,url,json,recording))return;
  if(await handleEditor(req,url,json,editorBridge,port))return;
  if(await handleInquiry(req,url,json,inquiries))return;
  if(await handleControl(req,url,json,controller))return;
  if(req.method==='GET'&&url.pathname==='/api/state'){json(200,snapshot());return;}
  if(req.method==='GET'&&['/api/subagents','/api/subagents/detail'].includes(url.pathname)){
    const id=url.searchParams.get('threadId');
    if(!id||!model.threads.has(id)){json(404,{error:'找不到任务'});return;}
    try{
      if(url.pathname==='/api/subagents')json(200,{agents:await subagents.list(id)});
      else {const agent=await subagents.detail(id,url.searchParams.get('agentId'));json(agent?200:404,agent?{agent}:{error:'找不到子代理'});}
    }catch{json(503,{error:'暂时无法读取子代理，请重试'});}return;
  }
  if(req.method==='GET'&&url.pathname==='/api/inputs'){
    const id=url.searchParams.get('threadId');
    if(!id||!model.threads.has(id)){json(404,{error:'找不到任务'});return;}
    json(200,{inputs:model.inputs(id)});return;
  }
  if(req.method==='POST'&&['/api/event','/api/select'].includes(url.pathname)) {
    if(!req.headers['content-type']?.startsWith('application/json')){json(415,{error:'需要 JSON 数据'});return;}
    let body='';
    try {
      for await(const chunk of req){body+=chunk;if(body.length>300000)throw Error('数据过大');}
      const data=JSON.parse(body);
      if(url.pathname==='/api/select') model.select(data.threadId);else model.event(data);
      await broadcast();json(200,{ok:true,revision:model.revision});
    }catch(e){json(400,{error:e.message});}return;
  }
  const names={'/recording.js':'recording.js','/recording.css':'recording.css','/':'index.html','/app.js':'app.js','/task-picker.js':'task-picker.js','/input-history.js':'input-history.js','/composer.js':'composer.js','/editor-context.js':'editor-context.js','/composer.css':'composer.css','/approvals.js':'approvals.js','/drawing.js':'drawing.js','/style.css':'style.css','/status-inquiry.js':'status-inquiry.js','/status-inquiry.css':'status-inquiry.css','/token-trend.js':'token-trend.js','/token-chart.js':'token-chart.js','/token-chart.css':'token-chart.css'};
  if(req.method!=='GET'||!names[url.pathname]){res.writeHead(404).end();return;}
  try{const content=await readFile(path.join(base,'web',names[url.pathname]));res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(content);}catch{res.writeHead(500).end('界面暂时无法加载');}
});
server.on('upgrade',(req,socket)=>{
  if(req.url!=='/ws'||!validOrigin(req)||req.headers['sec-websocket-version']!=='13'||!req.headers['sec-websocket-key']||!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)){socket.destroy();return;}
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);socket.write(frame(JSON.stringify(snapshot())));
  let incoming=Buffer.alloc(0);
  socket.on('data',chunk=>{
    incoming=Buffer.concat([incoming,chunk]);
    if(incoming.length>65536){socket.destroy();return;}
    while(incoming.length>=2){
      const opcode=incoming[0]&15,masked=incoming[1]&128;
      let length=incoming[1]&127,offset=2;
      if(length===126){if(incoming.length<4)return;length=incoming.readUInt16BE(2);offset=4;}
      if(length===127||!masked){socket.destroy();return;}
      if(incoming.length<offset+4+length)return;
      const mask=incoming.subarray(offset,offset+4),body=Buffer.from(incoming.subarray(offset+4,offset+4+length));
      for(let i=0;i<body.length;i++)body[i]^=mask[i%4];
      incoming=incoming.subarray(offset+4+length);
      if(opcode===8){socket.end(frame('',8));return;}
      if(opcode===9)socket.write(frame(body,10));
    }
  });
  socket.on('error',()=>clients.delete(socket));socket.on('close',()=>clients.delete(socket));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
await writeFile(path.join(runtime,'endpoint.json'),JSON.stringify({port,pid:process.pid}),{mode:0o600});
console.log(`Codex Progress listening on 127.0.0.1:${port}`);
let polling=false;
setInterval(async()=>{if(polling)return;polling=true;try{await watcher.poll();await broadcast();}catch(e){console.error(e.message);}finally{polling=false;}},1000);
setInterval(()=>{for(const socket of clients)socket.write(frame('',9));},30000);
controller?.poll();
setInterval(()=>controller?.poll(),2500);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{recording.close();controller?.close();for(const socket of clients)socket.destroy();server.close(()=>process.exit(0));});
