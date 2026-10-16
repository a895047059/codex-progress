import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {InquiryService} from '../src/inquiry-service.mjs';

function makeService(runtime,analyze,ids=['task-a','task-b','task-c']){
  const model={threads:new Map(ids.map(id=>[id,{id,status:'running',goal:'',desc:'',tasks:[]}]))};
  const watcher={files:new Map()};
  return {model,service:new InquiryService({model,watcher,runtime,analyze})};
}

async function waitForIdle(service){
  const until=Date.now()+2000;
  while(service.running&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(service.running,0,'问询应在验证期限内结束');
  await service.queue;
}

async function withRuntime(run){
  const runtime=await mkdtemp(path.join(os.tmpdir(),'inquiry-service-'));
  try{return await run(runtime);}finally{await rm(runtime,{recursive:true,force:true});}
}

test('不同原任务拥有独立 status_inquiry 会话并单独持久化',async()=>withRuntime(async runtime=>{
  const {model,service}=makeService(runtime,async()=> '回答');
  await service.load();
  const first=service.snapshot('task-a').session;
  const second=service.snapshot('task-b').session;
  assert.equal(first.kind,'status_inquiry');
  assert.equal(second.kind,'status_inquiry');
  assert.notEqual(first.id,second.id);
  first.messages.push({role:'user',text:'只属于任务 A'});
  assert.deepEqual(second.messages,[]);
  await service.persist();
  const saved=JSON.parse(await readFile(path.join(runtime,'inquiries.json'),'utf8'));
  assert.deepEqual(saved.map(item=>item.threadId),['task-a','task-b']);
  assert.ok(saved.every(item=>item.kind==='status_inquiry'));
  assert.deepEqual([...model.threads.keys()],['task-a','task-b','task-c']);
  assert.equal(await readFile(path.join(runtime,'plans.json'),'utf8').then(()=>true,()=>false),false);
}));

test('分析失败时保留用户问题并持久化错误状态',async()=>withRuntime(async runtime=>{
  const {service}=makeService(runtime,async()=>{throw Error('provider unavailable');});
  await service.load();
  service.ask('task-a','刚才失败了吗？');
  await waitForIdle(service);
  const session=service.snapshot('task-a').session;
  assert.deepEqual(session.messages.map(message=>message.role),['user']);
  assert.equal(session.messages[0].text,'刚才失败了吗？');
  assert.equal(session.error,'暂时无法分析任务日志，请稍后重试');
  const saved=JSON.parse(await readFile(path.join(runtime,'inquiries.json'),'utf8'));
  assert.equal(saved[0].messages[0].text,'刚才失败了吗？');
}));

test('重启加载时把未完成问询恢复为空闲并保留原问题',async()=>withRuntime(async runtime=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const first=makeService(runtime,()=>pending);
  await first.service.load();
  first.service.ask('task-a','当前是什么状态？');
  await first.service.queue;
  const restored=makeService(runtime,async()=> '新回答');
  await restored.service.load();
  const session=restored.service.snapshot('task-a').session;
  assert.equal(session.busy,false);
  assert.equal(session.error,'上次问询未完成，请重新提问');
  assert.equal(session.messages[0].text,'当前是什么状态？');
  release('迟到回答');
  await waitForIdle(first.service);
}));

test('全局最多运行两条问询，超限请求不会留下空会话',async()=>withRuntime(async runtime=>{
  const pending=[];
  const {service}=makeService(runtime,()=>new Promise(resolve=>pending.push(resolve)));
  await service.load();
  service.ask('task-a','问题 A');
  service.ask('task-b','问题 B');
  assert.equal(service.running,2);
  assert.throws(()=>service.ask('task-c','问题 C'),/已有状态问询正在处理/);
  assert.equal(service.sessions.has('task-c'),false);
  const until=Date.now()+2000;
  while(pending.length<2&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(pending.length,2);
  for(const resolve of pending)resolve('已完成');
  await waitForIdle(service);
  assert.equal(service.sessions.get('task-a').messages.at(-1).role,'assistant');
  assert.equal(service.sessions.get('task-b').messages.at(-1).role,'assistant');
}));
