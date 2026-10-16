import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EditorBridge,handleEditor} from '../src/editor-bridge.mjs';

function setup({available=true,now=()=>1000,guard=async()=>{}}={}){
  const model={threads:new Map([['thread-a',{}],['thread-b',{}]])};
  const calls=[];
  const controller={guard:async id=>{calls.push(['guard',id]);return guard(id);},send:async(...args)=>calls.push(['send',...args])};
  return {model,calls,bridge:new EditorBridge({model,controller,extensionAvailable:()=>available,now})};
}

function context(overrides={}){
  return {application:'Cursor',path:'/workspace/src/app.mjs',language:'javascript',startLine:4,endLine:7,text:'const ready = true;',truncated:false,...overrides};
}

function request(method,url,{body,rawBody,headers={}}={}){
  const bytes=rawBody??(body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body)));
  const req=Readable.from(bytes.length?[bytes]:[]);
  req.method=method;
  req.headers={'content-type':body===undefined&&rawBody===undefined?'': 'application/json',...headers};
  const response={status:null,value:null};
  const json=(status,value)=>Object.assign(response,{status,value});
  return {req,url:new URL(url,'http://127.0.0.1'),json,response};
}

async function call(bridge,method,url,options,port=4321){
  const args=request(method,url,options);
  const handled=await handleEditor(args.req,args.url,args.json,bridge,port);
  assert.equal(handled,true);
  return args.response;
}

test('创建前检查可接管状态并生成绑定当前端口的 Cursor URL，不发送任务消息',async()=>{
  const {bridge,calls}=setup();
  const created=await bridge.request('thread-a',4321);
  const url=new URL(created.openUrl);
  assert.deepEqual(calls,[['guard','thread-a']]);
  assert.equal(url.protocol,'cursor:');
  assert.equal(url.hostname,'local.codex-progress-editor');
  assert.equal(url.pathname,'/attach');
  assert.equal(url.searchParams.get('requestId'),created.requestId);
  assert.equal(url.searchParams.get('port'),'4321');
  assert.equal(calls.some(([kind])=>kind==='send'),false);
  assert.equal(bridge.status(created.requestId,'thread-a').status,'pending');
});

test('接管校验拒绝时不创建编辑器请求',async()=>{
  const {bridge,calls}=setup({guard:async()=>{throw Error('不接受输入');}});
  await assert.rejects(bridge.request('thread-a',4321),/当前任务暂不可接管/);
  assert.deepEqual(calls,[['guard','thread-a']]);
  assert.equal(bridge.requests.size,0);
});

test('每个任务最多一个 pending；有效 nonce 只能提交一次并返回编辑器附件',async()=>{
  const {bridge}=setup();
  const created=await bridge.request('thread-a',4321);
  await assert.rejects(bridge.request('thread-a',4321),/已有编辑器请求待处理/);
  assert.deepEqual(bridge.receive({requestId:created.requestId,context:context()}),{ok:true});
  assert.deepEqual(bridge.status(created.requestId,'thread-a'),{status:'ready',attachment:{
    kind:'editor',name:'Cursor · app.mjs:4–7',path:'/workspace/src/app.mjs',language:'javascript',startLine:4,endLine:7,text:'const ready = true;',truncated:false
  }});
  await assert.rejects(Promise.resolve().then(()=>bridge.receive({requestId:created.requestId,context:context({text:'替换内容'})})),/已失效或已提交/);
  const next=await bridge.request('thread-a',4321);
  assert.notEqual(next.requestId,created.requestId);
});

test('请求状态严格绑定 threadId，其他任务不能读取内容',async()=>{
  const {bridge}=setup();
  const created=await bridge.request('thread-a',4321);
  assert.equal(bridge.status(created.requestId,'thread-b'),null);
  const response=await call(bridge,'GET',`/api/editor/request?requestId=${created.requestId}&threadId=thread-b`);
  assert.equal(response.status,404);
  assert.deepEqual(response.value,{error:'找不到编辑器请求'});
  assert.equal(bridge.status(created.requestId,'thread-a').status,'pending');
});

test('TTL 到期后返回 expired 并释放该任务的 pending 槽位',async()=>{
  let clock=10_000;
  const {bridge}=setup({now:()=>clock});
  const created=await bridge.request('thread-a',4321);
  clock+=120_000;
  assert.deepEqual(bridge.status(created.requestId,'thread-a'),{status:'expired'});
  assert.throws(()=>bridge.receive({requestId:created.requestId,context:context()}),/已失效或已提交/);
  assert.ok((await bridge.request('thread-a',4321)).requestId);
});

test('拒绝超大或字段非法的上下文；拒绝体超过 120 KB 的 HTTP 请求',async()=>{
  const {bridge}=setup();
  const created=await bridge.request('thread-a',4321);
  assert.throws(()=>bridge.receive({requestId:created.requestId,context:context({text:'x'.repeat(60_001)})}),/上下文格式无效/);
  assert.throws(()=>bridge.receive({requestId:created.requestId,context:context({text:'界'.repeat(33_334)})}),/上下文格式无效/);
  assert.throws(()=>bridge.receive({requestId:created.requestId,context:context({path:'relative/file.mjs'})}),/上下文格式无效/);
  assert.throws(()=>bridge.receive({requestId:created.requestId,context:context({startLine:0})}),/上下文格式无效/);
  assert.equal(bridge.status(created.requestId,'thread-a').status,'pending');
  const response=await call(bridge,'POST','/api/editor/context',{rawBody:Buffer.alloc(120*1024+1,0x20),headers:{'content-type':'application/json'}});
  assert.equal(response.status,413);
  assert.deepEqual(response.value,{error:'请求内容过大'});
});

test('未安装扩展时不创建请求',async()=>{
  const {bridge,calls}=setup({available:false});
  assert.deepEqual(await bridge.capability(),{available:false});
  await assert.rejects(bridge.request('thread-a',4321),/未检测到 Cursor 扩展/);
  assert.deepEqual(calls,[]);
});

test('HTTP 路由提交错误状态，不接受非中文错误内容',async()=>{
  const {bridge}=setup();
  const created=await bridge.request('thread-a',4321);
  const invalid=await call(bridge,'POST','/api/editor/context',{body:{requestId:created.requestId,error:'ENOENT /private/user/file'}});
  assert.equal(invalid.status,400);
  assert.equal(bridge.status(created.requestId,'thread-a').status,'pending');
  const accepted=await call(bridge,'POST','/api/editor/context',{body:{requestId:created.requestId,error:'无法读取编辑器上下文'}});
  assert.equal(accepted.status,202);
  assert.deepEqual(bridge.status(created.requestId,'thread-a'),{status:'error',error:'无法读取编辑器上下文'});
});
