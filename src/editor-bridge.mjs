import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TTL_MS=120_000;
const MAX_REQUESTS=64;
const MAX_BODY_BYTES=120*1024;
const REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class EditorBridgeError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}

async function detectExtension(){
  try{
    const root=path.join(os.homedir(),'.cursor','extensions');
    const entries=await readdir(root,{withFileTypes:true});
    for(const entry of entries){
      if(!entry.isDirectory()||!entry.name.startsWith('local.codex-progress-editor-'))continue;
      try{
        const manifest=JSON.parse(await readFile(path.join(root,entry.name,'package.json'),'utf8'));
        if(manifest.publisher==='local'&&manifest.name==='codex-progress-editor'&&
          typeof manifest.version==='string'&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version))return true;
      }catch{}
    }
  }catch{}
  return false;
}

function validThreadId(value){return typeof value==='string'&&value.length>0&&value.length<=120;}
function validRequestId(value){return typeof value==='string'&&REQUEST_ID.test(value);}
function shortChineseError(value){
  return typeof value==='string'&&value.length>0&&value.length<=120&&/[\u3400-\u9fff]/.test(value)&&
    /^[\u3400-\u9fff，。！？；：、（）《》“”‘’\s]+$/u.test(value.replace(/Cursor/g,''));
}

export class EditorBridge {
  constructor({model,controller,extensionAvailable=detectExtension,now=Date.now}={}){
    this.model=model;
    this.controller=controller;
    this.extensionAvailable=extensionAvailable;
    this.now=now;
    this.requests=new Map();
    this.expired=new Map();
    this.pendingByThread=new Map();
  }
  async capability(){
    let available=false;
    try{available=await this.extensionAvailable()===true;}catch{}
    return {available};
  }
  cleanup(){
    const now=this.now();
    for(const [requestId,record] of this.requests){
      if(record.expiresAt>now)continue;
      this.requests.delete(requestId);
      if(this.pendingByThread.get(record.threadId)===requestId)this.pendingByThread.delete(record.threadId);
      this.expired.set(requestId,{threadId:record.threadId,expiresAt:now+TTL_MS});
    }
    for(const [requestId,record] of this.expired)if(record.expiresAt<=now)this.expired.delete(requestId);
    while(this.expired.size>MAX_REQUESTS)this.expired.delete(this.expired.keys().next().value);
  }
  async request(threadId,port){
    if(!validThreadId(threadId))throw new EditorBridgeError('请选择有效任务');
    if(!Number.isInteger(port)||port<1024||port>65535)throw new EditorBridgeError('服务地址无效',503);
    if(!this.controller||typeof this.controller.guard!=='function')throw new EditorBridgeError('控制连接未就绪',503);
    if(!(await this.capability()).available)throw new EditorBridgeError('未检测到 Cursor 扩展',503);
    try{await this.controller.guard(threadId);}catch{throw new EditorBridgeError('当前任务暂不可接管',409);}
    this.cleanup();
    if(this.model?.threads?.has(threadId)!==true)throw new EditorBridgeError('找不到所选任务',404);
    if(this.pendingByThread.has(threadId))throw new EditorBridgeError('这个任务已有编辑器请求待处理',409);
    if(this.requests.size>=MAX_REQUESTS)throw new EditorBridgeError('编辑器请求过多，请稍后重试',429);
    const requestId=randomUUID();
    const record={requestId,threadId,status:'pending',expiresAt:this.now()+TTL_MS};
    this.requests.set(requestId,record);
    this.pendingByThread.set(threadId,requestId);
    const openUrl=new URL('cursor://local.codex-progress-editor/attach');
    openUrl.searchParams.set('requestId',requestId);
    openUrl.searchParams.set('port',String(port));
    return {requestId,openUrl:openUrl.toString()};
  }
  status(requestId,threadId){
    if(!validRequestId(requestId)||!validThreadId(threadId))return null;
    this.cleanup();
    const record=this.requests.get(requestId);
    if(record){
      if(record.threadId!==threadId)return null;
      if(record.status==='ready')return {status:'ready',attachment:structuredClone(record.attachment)};
      if(record.status==='error')return {status:'error',error:record.error};
      return {status:'pending'};
    }
    const expired=this.expired.get(requestId);
    return expired?.threadId===threadId?{status:'expired'}:null;
  }
  receive(data){
    this.cleanup();
    if(!data||!validRequestId(data.requestId))throw new EditorBridgeError('编辑器请求无效');
    const record=this.requests.get(data.requestId);
    if(!record||record.status!=='pending')throw new EditorBridgeError('编辑器请求已失效或已提交',409);
    const hasContext=Object.hasOwn(data,'context'),hasError=Object.hasOwn(data,'error');
    if(hasContext===hasError)throw new EditorBridgeError('提交内容格式无效');
    if(hasError){
      if(!shortChineseError(data.error))throw new EditorBridgeError('错误信息格式无效');
      record.status='error';record.error=data.error;
    }else{
      const context=data.context;
      if(!context||typeof context!=='object'||Array.isArray(context)||context.application!=='Cursor'||
        typeof context.path!=='string'||!path.isAbsolute(context.path)||context.path.length>4000||
        typeof context.language!=='string'||context.language.length>80||
        !Number.isInteger(context.startLine)||context.startLine<1||
        !Number.isInteger(context.endLine)||context.endLine<context.startLine||
        typeof context.text!=='string'||!context.text.trim()||context.text.length>60_000||Buffer.byteLength(context.text,'utf8')>100_000||
        typeof context.truncated!=='boolean')throw new EditorBridgeError('编辑器上下文格式无效');
      record.status='ready';
      record.attachment={kind:'editor',name:`Cursor · ${path.basename(context.path)}:${context.startLine}–${context.endLine}`,path:context.path,language:context.language,
        startLine:context.startLine,endLine:context.endLine,text:context.text,truncated:context.truncated};
    }
    if(this.pendingByThread.get(record.threadId)===record.requestId)this.pendingByThread.delete(record.threadId);
    return {ok:true};
  }
}

async function readJson(req){
  if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new EditorBridgeError('请求格式无效',415);
  const length=Number(req.headers['content-length']);
  if(Number.isFinite(length)&&length>MAX_BODY_BYTES)throw new EditorBridgeError('请求内容过大',413);
  const chunks=[];let size=0;
  for await(const chunk of req){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if(size>MAX_BODY_BYTES)throw new EditorBridgeError('请求内容过大',413);
    chunks.push(bytes);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new EditorBridgeError('请求格式无效');}
}

export async function handleEditor(req,url,json,service,port){
  if(!url.pathname.startsWith('/api/editor/'))return false;
  try{
    if(req.method==='GET'&&url.pathname==='/api/editor/capability'){
      json(200,await service.capability());
    }else if(req.method==='POST'&&url.pathname==='/api/editor/request'){
      const data=await readJson(req);
      json(202,await service.request(data?.threadId,port));
    }else if(req.method==='GET'&&url.pathname==='/api/editor/request'){
      const result=service.status(url.searchParams.get('requestId'),url.searchParams.get('threadId'));
      if(!result)json(404,{error:'找不到编辑器请求'});else json(200,result);
    }else if(req.method==='POST'&&url.pathname==='/api/editor/context'){
      const data=await readJson(req);
      json(202,service.receive(data));
    }else{
      json(url.pathname==='/api/editor/capability'||url.pathname==='/api/editor/request'||url.pathname==='/api/editor/context'?405:404,
        {error:url.pathname.startsWith('/api/editor/')?'此操作不可用':'找不到此操作'});
    }
  }catch(error){
    const status=Number.isInteger(error?.status)?error.status:500;
    const message=status>=500?'编辑器桥接暂不可用':error.message;
    json(status,{error:message});
  }
  return true;
}
