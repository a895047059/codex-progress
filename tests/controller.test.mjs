import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ThreadController, normalizeInput} from '../src/controller.mjs';
import {ProgressModel} from '../src/model.mjs';

class FakeClient extends EventEmitter {
  constructor(){super();this.calls=[];this.ids=['a'];this.accept=true;this.threadReadFailures=0;this.resumeFailures=0;this.resumeResult=null;this.resumeWaits=[];this.active=null;this.ephemeral=false;this.threadStatus={type:'inProgress'};this.goal={objective:'目标',status:'active'};}
  async connect(){}
  close(){}
  async request(method,params){
    this.calls.push({method,params});
    if(method==='thread/loaded/list')return {data:this.ids};
    if(method==='thread/resume'){
      const gate=this.resumeWaits.shift();
      if(gate){gate.started.resolve();await gate.promise;}
      if(this.resumeFailures>0){this.resumeFailures--;throw Error('temporary thread/resume failure');}
      return this.resumeResult||{thread:{id:params.threadId}};
    }
    if(method==='thread/read'){
      if(this.threadReadFailures>0){this.threadReadFailures--;throw Error('temporary thread/read failure');}
      return {thread:{id:params.threadId,canAcceptDirectInput:this.accept,ephemeral:this.ephemeral,status:this.threadStatus,cwd:'/tmp/project',model:'current-model',reasoningEffort:'medium',turns:this.active?[{id:this.active,status:'inProgress'}]:[]}};
    }
    if(method==='thread/turns/list'){
      if(this.ephemeral)throw Error('临时会话不支持 turns/list');
      return {data:this.active?[{id:this.active,status:'inProgress'}]:[]};
    }
    if(method==='thread/goal/get')return {goal:this.goal};
    if(method==='thread/goal/set')return {goal:this.goal={...this.goal,...params}};
    if(method==='turn/start')return {turn:{id:'new'}};
    return {};
  }
}
function setup(){const model=new ProgressModel();model.start('a','old');model.start('b','desktop');model.select('a');const client=new FakeClient();return {model,client,controller:new ThreadController(model,{client})};}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function resumeGate(){return {started:deferred(),...deferred()};}
test('仅接管已加载且明确接受输入的原会话；不恢复其他桌面会话',async()=>{
  const {controller,client}=setup();await controller.poll();
  assert.equal(controller.capability('a').available,true);assert.equal(controller.capability('b').available,false);
  client.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'a'}});assert.equal(controller.capability('a').available,true);
  await assert.rejects(controller.send('b',{text:'禁止发送'}),/不可接管/);
  assert.ok(!client.calls.some(c=>/resume|turn\/start/.test(c.method)));
  client.accept=false;await assert.rejects(controller.send('a',{text:'不能接受输入'}),/不接受/);
  assert.equal(controller.capability('a').available,false);
});
test('control 暴露按 thread 隔离的审批修订号',()=>{
  const {controller,client}=setup();
  client.emit('request',{id:'approval-a',method:'item/commandExecution/requestApproval',params:{threadId:'a',reason:'first'}});
  client.emit('request',{id:'approval-b',method:'item/commandExecution/requestApproval',params:{threadId:'b',reason:'other'}});
  const first=controller.capability('a').approvalRevision;

  client.emit('request',{id:'approval-a',method:'item/commandExecution/requestApproval',params:{threadId:'a',reason:'updated'}});

  assert.equal(controller.capability('a').approvalRevision,first+1);
  assert.equal(controller.capability('b').approvalRevision,1);
});
test('发送前重新核实loaded；卸载和断线立即撤销接管',async()=>{
  const {controller,client}=setup();await controller.poll();client.ids=[];
  await assert.rejects(controller.send('a',{text:'已卸载'}),/不可接管/);
  assert.equal(controller.capability('a').available,false);
  client.ids=['a'];await controller.poll();client.emit('disconnect');
  assert.equal(controller.capability('a').available,false);await assert.rejects(controller.setGoal('a',{status:'active'}),/仅支持查看/);
});
test('仅在guard确认loaded且可输入后懒订阅一次；请求使用最小参数',async()=>{
  const {controller,client}=setup();await controller.poll();
  assert.equal(client.calls.some(c=>c.method==='thread/resume'),false);
  client.calls=[];client.ids=[];
  await assert.rejects(controller.send('a',{text:'未加载'}),/不可接管/);
  client.ids=['a'];client.accept=false;
  await assert.rejects(controller.send('a',{text:'不接受输入'}),/不接受/);
  assert.equal(client.calls.some(c=>c.method==='thread/resume'),false);

  client.accept=true;
  await controller.send('a',{text:'第一次'});
  await controller.send('a',{text:'第二次'});
  const resumes=client.calls.filter(c=>c.method==='thread/resume');
  assert.equal(resumes.length,1);
  assert.deepEqual(resumes[0].params,{threadId:'a',excludeTurns:true});
});
test('断线后新连接会重新订阅',async()=>{
  const {controller,client}=setup();await controller.poll();await controller.send('a',{text:'先订阅'});
  client.emit('disconnect');controller.nextConnect=0;await controller.poll();client.calls=[];
  await controller.send('a',{text:'新连接'});
  assert.equal(client.calls.filter(c=>c.method==='thread/resume').length,1);
});
test('resume失败或返回其他thread ID时不执行turn操作且可重试',async()=>{
  const {controller,client}=setup();await controller.poll();client.calls=[];client.active='active-turn';client.resumeFailures=1;
  await assert.rejects(controller.send('a',{text:'失败时不发送'}),/thread\/resume failure/);
  assert.equal(client.calls.some(c=>['turn/start','turn/steer'].includes(c.method)),false);
  client.resumeResult={thread:{id:'other'}};
  await assert.rejects(controller.send('a',{text:'ID不匹配时不发送'}),/未能确认会话订阅/);
  assert.equal(client.calls.some(c=>['turn/start','turn/steer'].includes(c.method)),false);
  client.resumeResult=null;
  assert.equal((await controller.send('a',{text:'重试'})).kind,'steered');
  assert.equal(client.calls.filter(c=>c.method==='thread/resume').length,3);
});
test('同一thread并发guard共享一个pending resume',async()=>{
  const {controller,client}=setup();await controller.poll();client.calls=[];
  const gate=resumeGate();
  client.resumeWaits.push(gate);
  const first=controller.guard('a');await gate.started.promise;
  const second=controller.guard('a');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(client.calls.filter(c=>c.method==='thread/resume').length,1);
  gate.resolve();await Promise.all([first,second]);
  assert.equal(controller.resumed.has('a'),true);
});
test('断线期间旧resume结果不会覆盖新连接的订阅状态',async()=>{
  const {controller,client}=setup();await controller.poll();
  const oldGate=resumeGate();const newGate=resumeGate();
  client.resumeWaits.push(oldGate,newGate);
  const oldGuard=controller.guard('a');await oldGate.started.promise;
  client.emit('disconnect');controller.nextConnect=0;await controller.poll();
  const newGuard=controller.guard('a');await newGate.started.promise;
  oldGate.resolve();await assert.rejects(oldGuard,/仅支持查看进度/);
  assert.equal(controller.resumed.has('a'),false);
  newGate.resolve();await newGuard;
  assert.equal(controller.resumed.has('a'),true);
  assert.equal(client.calls.filter(c=>c.method==='thread/resume').length,2);
});
test('closed、notLoaded与loaded reconciliation都会清除订阅',async()=>{
  const {controller,client}=setup();await controller.poll();
  await controller.send('a',{text:'初次'});
  client.emit('notification',{method:'thread/status/changed',params:{threadId:'a',status:{type:'notLoaded'}}});
  await controller.send('a',{text:'notLoaded后'});
  client.emit('notification',{method:'thread/closed',params:{threadId:'a'}});
  await controller.send('a',{text:'closed后'});
  client.ids=[];await controller.poll();client.ids=['a'];await controller.poll();
  await controller.send('a',{text:'reconcile后'});
  assert.equal(client.calls.filter(c=>c.method==='thread/resume').length,4);
});
test('thread/read瞬时失败进入checking；恢复后重新开放输入',async()=>{
  const {controller,client}=setup();await controller.poll();
  client.threadReadFailures=1;controller.details.get('a').checkedAt=0;
  await controller.poll();
  assert.deepEqual({available:controller.capability('a').available,checking:controller.capability('a').checking}, {available:false,checking:true});
  assert.equal(controller.capability('a').reason,'正在确认输入状态');

  await controller.poll();
  assert.deepEqual({available:controller.capability('a').available,checking:controller.capability('a').checking}, {available:true,checking:false});
});
test('正常后台刷新不发布临时禁用状态',async()=>{
  const {controller}=setup();await controller.poll();
  const states=[];controller.onChange=()=>states.push(controller.capability('a'));
  controller.details.get('a').checkedAt=0;await controller.poll();
  assert.ok(states.length>0);
  assert.ok(states.every(state=>state.available&&!state.checking));
});
test('断线保留核验态；权威loaded缺失后清除历史能力',async()=>{
  const {controller,client}=setup();await controller.poll();
  client.emit('disconnect');
  assert.deepEqual({available:controller.capability('a').available,checking:controller.capability('a').checking}, {available:false,checking:true});
  assert.equal(controller.capability('a').reason,'正在重新连接');

  client.ids=[];controller.nextConnect=0;await controller.poll();
  assert.deepEqual({available:controller.capability('a').available,checking:controller.capability('a').checking}, {available:false,checking:false});
});
test('重连强制核实能力；确认不接受输入后立即退出checking',async()=>{
  const {controller,client}=setup();await controller.poll();
  client.emit('disconnect');client.accept=false;controller.nextConnect=0;
  await controller.poll();
  assert.deepEqual({available:controller.capability('a').available,checking:controller.capability('a').checking}, {available:false,checking:false});
});
test('重新核实时send仍执行guard，thread/read失败不得发送',async()=>{
  const {controller,client}=setup();await controller.poll();client.calls=[];client.threadReadFailures=1;
  await assert.rejects(controller.send('a',{text:'需重新核实'}),/temporary thread\/read failure/);
  assert.deepEqual({available:controller.capability('a').available,checking:controller.capability('a').checking}, {available:false,checking:true});
  assert.ok(!client.calls.some(c=>['turn/start','turn/steer'].includes(c.method)));
});
test('空闲轮次继承设置；运行轮次按expectedTurnId补充；不偷改权限',async()=>{
  const {controller,client}=setup();await controller.poll();
  assert.equal((await controller.send('a',{text:'继续'})).kind,'started');
  const start=client.calls.find(c=>c.method==='turn/start');assert.deepEqual(Object.keys(start.params).sort(),['input','threadId']);
  client.active='active-turn';assert.equal((await controller.send('a',{text:'补充'})).kind,'steered');
  assert.equal(client.calls.find(c=>c.method==='turn/steer').params.expectedTurnId,'active-turn');
  await assert.rejects(controller.send('a',{text:'补充',permission:'full'}),/下一轮/);
  assert.equal(client.calls.filter(c=>c.method==='turn/start').length,1);
});
test('临时会话空闲时直接开启轮次，不请求不支持的turns/list',async()=>{
  const {controller,client}=setup();client.ephemeral=true;client.threadStatus={type:'idle'};await controller.poll();client.calls=[];
  assert.equal((await controller.send('a',{text:'继续'})).kind,'started');
  assert.ok(client.calls.some(c=>c.method==='turn/start'));
  assert.ok(!client.calls.some(c=>c.method==='thread/turns/list'));
  assert.ok(!client.calls.some(c=>c.method==='thread/resume'));
});
test('临时会话只用已知通知turn ID执行steer和interrupt',async()=>{
  const {controller,client}=setup();client.ephemeral=true;await controller.poll();
  client.emit('notification',{method:'turn/started',params:{threadId:'a',turn:{id:'temporary-turn'}}});
  assert.equal((await controller.send('a',{text:'补充'})).turnId,'temporary-turn');
  assert.deepEqual(client.calls.find(c=>c.method==='turn/steer').params,{threadId:'a',expectedTurnId:'temporary-turn',input:[{type:'text',text:'补充',text_elements:[]}]});
  assert.deepEqual(await controller.interrupt('a'),{interrupted:true});
  assert.deepEqual(client.calls.find(c=>c.method==='turn/interrupt').params,{threadId:'a',turnId:'temporary-turn'});
  assert.ok(!client.calls.some(c=>c.method==='thread/turns/list'));
});
test('临时会话活动状态未知时拒绝steer和interrupt，不查询turns/list',async()=>{
  const {controller,client}=setup();client.ephemeral=true;await controller.poll();client.calls=[];
  await assert.rejects(controller.send('a',{text:'补充'}),/暂时无法确认当前执行/);
  await assert.rejects(controller.interrupt('a'),/暂时无法确认当前执行/);
  assert.ok(!client.calls.some(c=>['thread/turns/list','turn/start','turn/steer','turn/interrupt'].includes(c.method)));
});
test('临时会话禁用持续目标设置并报告goalSetting不可用',async()=>{
  const {controller,client}=setup();client.ephemeral=true;await controller.poll();
  assert.equal(controller.capability('a').available,true);
  assert.equal(controller.capability('a').goalSetting,false);
  await assert.rejects(controller.setGoal('a',{status:'paused'}),/临时会话不支持持续目标/);
  assert.ok(!client.calls.some(c=>c.method==='thread/goal/set'));
});
test('完成通知和断线重连后丢弃临时会话的旧turn ID',async()=>{
  const {controller,client}=setup();client.ephemeral=true;await controller.poll();
  client.emit('notification',{method:'turn/started',params:{threadId:'a',turn:{id:'completed-turn'}}});
  client.emit('notification',{method:'turn/completed',params:{threadId:'a',turn:{id:'completed-turn'}}});
  client.calls=[];
  await assert.rejects(controller.send('a',{text:'补充'}),/暂时无法确认当前执行/);
  assert.ok(!client.calls.some(c=>['thread/turns/list','turn/steer','turn/start'].includes(c.method)));

  client.emit('notification',{method:'turn/started',params:{threadId:'a',turn:{id:'disconnected-turn'}}});
  client.emit('disconnect');
  assert.equal(controller.capability('a').available,false);
  controller.nextConnect=0;await controller.poll();client.calls=[];
  await assert.rejects(controller.interrupt('a'),/暂时无法确认当前执行/);
  assert.ok(!client.calls.some(c=>['thread/turns/list','turn/interrupt'].includes(c.method)));
});
test('目标控制绑定会话并显式记录用户来源；计划模式使用已加载模型',async()=>{
  const {controller,client,model}=setup();await controller.poll();
  await controller.setGoal('a',{status:'paused'});
  const goal=client.calls.find(c=>c.method==='thread/goal/set');assert.deepEqual(goal.params,{threadId:'a',status:'paused',origin:'user'});
  assert.equal(model.ensure('a').goalStatus,'paused');
  await controller.send('a',{text:'先计划',plan:true});
  assert.equal(client.calls.find(c=>c.method==='turn/start').params.collaborationMode.settings.model,'current-model');
  await controller.send('a',{text:'开始执行',plan:false});
  assert.equal(client.calls.filter(c=>c.method==='turn/start').at(-1).params.collaborationMode.mode,'default');
});
test('附件转换为受支持输入；拒绝格式错误或过多的附件',()=>{
  const values=normalizeInput({text:'检查',attachments:[{kind:'image',path:'/tmp/图.png'},{kind:'folder',path:'/tmp/项目'},{kind:'skill',name:'check',path:'/tmp/SKILL.md'}]});
  assert.deepEqual(values.map(x=>x.type),['text','localImage','text','skill']);
  assert.throws(()=>normalizeInput({text:'',attachments:[{kind:'image',url:'https://example.org/image.png'}]}),/格式/);
  assert.throws(()=>normalizeInput({text:'',attachments:Array.from({length:21},()=>({kind:'file',path:'/tmp/a'}))}),/数量/);
});
