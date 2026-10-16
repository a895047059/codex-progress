import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {analyzeInquiry} from '../src/inquiry-analyzer.mjs';

class FakeClient extends EventEmitter{
  constructor({toolCall=false,noResult=false}={}){super();this.calls=[];this.toolCall=toolCall;this.noResult=noResult;this.closed=false;}
  async connect(){return this;}
  async request(method,params,options){
    this.calls.push({method,params,options});
    if(method==='thread/start')return {thread:{id:'inquiry-thread',ephemeral:true}};
    if(method==='turn/start'){
      const items=this.toolCall
        ?[{type:'commandExecution',id:'tool-1',command:'cat /tmp/private'}]
        :[{type:'agentMessage',id:'answer-1',phase:'final_answer',text:'已核对日志，任务仍在运行。'}];
      if(!this.noResult)queueMicrotask(()=>{
        this.emit('notification',{method:'item/started',params:{threadId:'other-thread',turnId:'turn-1',item:{type:'commandExecution'}}});
        this.emit('notification',{method:'turn/started',params:{threadId:'inquiry-thread',turn:{id:'turn-1',status:'inProgress'}}});
        if(this.toolCall){
          this.emit('notification',{method:'item/started',params:{threadId:'inquiry-thread',turnId:'turn-1',item:items[0]}});
          this.emit('notification',{method:'turn/completed',params:{threadId:'inquiry-thread',turn:{id:'turn-1',status:'interrupted',items}}});
        }else{
          this.emit('notification',{method:'item/completed',params:{threadId:'inquiry-thread',turnId:'turn-1',item:items[0]}});
          this.emit('notification',{method:'turn/completed',params:{threadId:'inquiry-thread',turn:{id:'turn-1',status:'completed',items}}});
        }
      });
      return {turn:{id:'turn-1',status:'inProgress'}};
    }
    return {};
  }
  async close(){this.closed=true;}
}

async function withTempDir(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'inquiry-analyzer-'));
  try{return await run(root);}finally{await rm(root,{recursive:true,force:true});}
}

test('通过 daemon 控制 RPC 创建隔离 ephemeral thread 并返回模型回答',async()=>withTempDir(async root=>{
  const client=new FakeClient();
  const answer=await analyzeInquiry({
    evidence:{threadId:'original-task',status:'running'},question:'现在进行到哪一步？',cwd:path.join(root,'sandbox'),
    clientFactory:()=>client,timeoutMs:500
  });
  assert.equal(answer,'已核对日志，任务仍在运行。');
  const start=client.calls.find(call=>call.method==='thread/start');
  assert.equal(start.params.ephemeral,true);
  assert.equal(start.params.threadSource,'status_inquiry');
  assert.equal(start.params.cwd,path.join(root,'sandbox'));
  assert.equal(start.params.model,undefined);
  assert.equal(start.params.modelProvider,undefined);
  assert.deepEqual(start.params.config.mcp_servers,{});
  assert.equal(start.params.config.web_search,'disabled');
  assert.equal(start.params.config.features.shell_tool,false);
  assert.equal(start.params.config.features.apps,false);
  assert.equal(start.params.config.features.plugins,false);
  assert.equal(start.params.config.features.image_generation,false);
  assert.equal(start.params.config.features.js_repl,false);
  assert.equal(start.params.config.features.mcp_2026_07_28,false);
  assert.equal(start.params.config.tools.experimental_request_user_input.enabled,false);
  assert.equal(start.params.config.tools.update_plan.enabled,false);
  const turn=client.calls.find(call=>call.method==='turn/start');
  assert.equal(turn.params.threadId,'inquiry-thread');
  assert.match(turn.params.input[0].text,/现在进行到哪一步/);
  assert.equal(client.calls.some(call=>call.method==='thread/read'||call.method==='turn/steer'),false);
  assert.equal(client.calls.some(call=>call.method==='thread/unsubscribe'),true);
  assert.equal(client.closed,true);
}));

test('发现被禁用的工具 item 后中断并拒绝生成回答',async()=>withTempDir(async root=>{
  const client=new FakeClient({toolCall:true});
  await assert.rejects(analyzeInquiry({
    evidence:{threadId:'original-task'},question:'检查状态',cwd:path.join(root,'sandbox'),
    clientFactory:()=>client,timeoutMs:500
  }),/禁止的操作/);
  assert.equal(client.calls.some(call=>call.method==='turn/interrupt'),true);
  assert.equal(client.calls.some(call=>call.method==='thread/read'),false);
  assert.equal(client.closed,true);
}));

test('模型未完成 turn 时返回超时，不合成状态回答',async()=>withTempDir(async root=>{
  const client=new FakeClient({noResult:true});
  await assert.rejects(analyzeInquiry({
    evidence:{threadId:'original-task'},question:'检查状态',cwd:path.join(root,'sandbox'),
    clientFactory:()=>client,timeoutMs:10
  }),/状态分析超时/);
  assert.equal(client.calls.some(call=>call.method==='turn/interrupt'),true);
  assert.equal(client.closed,true);
}));
