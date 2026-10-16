import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editorContexts} from '../src/editor-context.mjs';
import {ThreadController,normalizeInput} from '../src/controller.mjs';
import {ProgressModel} from '../src/model.mjs';
import {EventEmitter} from 'node:events';
const attachment={kind:'editor',path:'/tmp/own-fixture.js',name:'Cursor · own-fixture.js:2',startLine:2,endLine:3,text:'const token = "EDITOR_CONTEXT_OK";',language:'javascript'};

test('Cursor 内容保持为独立非可信上下文，附件本身不执行或读取文件',()=>{
  const contexts=editorContexts([attachment]);
  assert.equal(contexts['cursor-0'].kind,'untrusted');
  assert.equal(JSON.parse(contexts['cursor-0'].value).text,attachment.text);
  const input=normalizeInput({text:'',attachments:[attachment]});
  assert.equal(input.length,1);
  assert.ok(!input[0].text.includes('EDITOR_CONTEXT_OK'));
  for(const item of [{...attachment,path:'relative.js'},{...attachment,startLine:0},{...attachment,text:'中'.repeat(40000)}])assert.throws(()=>editorContexts([item]),/上下文无效/);
});

test('新消息和运行中补充都把附加内容发送给同一原任务，未附加时不改变请求',async()=>{
  class Client extends EventEmitter {async request(method,params){this.calls.push({method,params});if(method==='thread/loaded/list')return {data:['own-task']};if(method==='thread/read')return {thread:{id:'own-task',canAcceptDirectInput:true,status:{type:this.running?'active':'idle'},model:'model'}};if(method==='thread/goal/get')return {};if(method==='thread/resume')return {thread:{id:params.threadId}};if(method==='turn/steer')return {turnId:'own-turn'};if(method==='turn/start')return {turn:{id:'own-turn'}};}constructor(){super();this.calls=[];}}
  const client=new Client(),model=new ProgressModel();model.ensure('own-task');
  const control=new ThreadController(model,{client});control.connected=true;
  await control.send('own-task',{text:'查看附加内容',attachments:[attachment]});
  let request=client.calls.find(c=>c.method==='turn/start');assert.equal(request.params.threadId,'own-task');assert.equal(JSON.parse(request.params.additionalContext['cursor-0'].value).text,attachment.text);
  client.running=true;control.activeTurns.set('own-task','own-turn');
  await control.send('own-task',{text:'补充选区',attachments:[attachment]});
  request=client.calls.find(c=>c.method==='turn/steer');assert.equal(request.params.expectedTurnId,'own-turn');assert.ok(request.params.additionalContext['cursor-0']);
  client.running=false;client.calls=[];await control.send('own-task',{text:'普通消息'});request=client.calls.find(c=>c.method==='turn/start');assert.ok(!('additionalContext' in request.params));
});
