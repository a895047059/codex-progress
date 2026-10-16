// Browser-only lifecycle fixture. Never starts the official recorder.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {RecordService,handleRecording} from '../src/record-service.mjs';

if(!process.argv.includes('--fixture'))throw Error('Pass --fixture; this host uses a simulated recorder.');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work=await mkdtemp(path.join(root,'work/recording-ui-'));
const sessionDir=path.join(work,'session');await mkdir(sessionDir);
const metadataPath=path.join(sessionDir,'session.json'),eventsPath=path.join(sessionDir,'events.jsonl');
await writeFile(metadataPath,'{}');await writeFile(eventsPath,'');
const calls=[];let session=null,service;
const result=()=>({structuredContent:session});
const client={
  async connect(){return ['start','status','stop'].map(kind=>({name:'event_stream_'+kind}));},
  async call(name){
    calls.push(name);
    if(name==='event_stream_start'){
      const decision=await service.handleElicitation({message:'fixture consent',requestedSchema:{type:'object',properties:{}}});
      if(decision.action!=='accept')throw Error('Fixture recording declined');
      session={isRecording:true,sessionID:'fixture-session',sessionDirectoryPath:sessionDir,eventsPath,metadataPath,startedAt:new Date().toISOString(),endedAt:null,endReason:null,maxDurationSeconds:1800};
    }
    if(name==='event_stream_stop')session={...session,isRecording:false,endedAt:new Date().toISOString(),endReason:'tool_stopped'};
    return result();
  },
  close(){}
};
service=new RecordService({controller:{async guard(id){if(id!=='recording-ui-fixture')throw Error('Unknown fixture');}},client});
const fixtureJS=`window.webkit={messageHandlers:{progressComposer:{postMessage:async()=>({})}}};
window.addEventListener('DOMContentLoaded',()=>{
  const thread={id:'recording-ui-fixture',goal:'录制工作流验收',status:'running',control:{available:true}};
  document.getElementById('goal').textContent=thread.goal;
  document.getElementById('desc').textContent='演示操作并创建可复用技能';
  window.Composer.render(thread);
});`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(value));};
  try{
    if(await handleRecording(req,url,json,service))return;
    if(url.pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(fixtureJS);return;}
    if(url.pathname==='/fixture/report'){json(200,{simulated:true,officialCaptureStarted:false,calls});return;}
    if(url.pathname==='/api/control/options'){json(200,{models:[],skills:[],plugins:[]});return;}
    if(url.pathname==='/api/editor/capability'){json(200,{available:false});return;}
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!/^[a-z-]+\.(?:html|css|js)$/.test(name)){res.writeHead(404).end();return;}
    let body=await readFile(path.join(root,'web',name));
    if(name==='index.html')body=Buffer.from(body.toString().replace('<script src="/app.js"></script>','<script src="/fixture.js"></script>'));
    res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'}).end(body);
  }catch{json(500,{error:'验收服务未完成操作'});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({port:server.address().port,simulated:true,work}));
async function close(){await service.close();server.close();await rm(work,{recursive:true,force:true});process.exit(0);}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,close);
