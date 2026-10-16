import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressModel } from '../src/model.mjs';
import { RolloutWatcher } from '../src/watcher.mjs';

test('显式线程 goal 优先于 plan goal 和最新人工输入',()=>{
  const model=new ProgressModel();
  model.addInput('thread','普通输入\n第二行',100,'turn-1');
  model.plan('thread',[{id:'step',title:'执行'}],'计划目标');
  assert.equal(model.snapshot().threads[0].goal,'计划目标');
  model.addInput('thread','新的人工描述',200,'turn-2');
  model.addInput('thread','较早的补录输入',150,'turn-old');
  assert.equal(model.snapshot().threads[0].desc,'新的人工描述');
  assert.deepEqual(model.inputs('thread').map(item=>item.text),['普通输入\n第二行','较早的补录输入','新的人工描述']);
  assert.equal(model.snapshot().threads[0].goal,'计划目标');
  const watcher=new RolloutWatcher(model),file={id:'thread',skip:false};
  watcher.consume(file,{type:'event_msg',payload:{type:'thread_goal_updated',goal:{objective:'线程长期目标',status:'active'}}});
  model.plan('thread',[{id:'step',title:'执行'}],'更新的计划目标');
  let thread=model.snapshot().threads[0];
  assert.equal(thread.goal,'线程长期目标');
  assert.equal(thread.goalObjective,'线程长期目标');
  assert.equal(thread.goalSource,'thread_goal_updated');
  assert.equal(thread.goalStatus,'active');
  for(const status of ['paused','blocked','complete']) {
    watcher.consume(file,{type:'event_msg',payload:{type:'thread_goal_updated',goal:{objective:'线程长期目标',status}}});
    assert.equal(model.snapshot().threads[0].goalStatus,status);
  }
  watcher.consume(file,{type:'event_msg',payload:{type:'thread_goal_updated',goal:{status:'paused'}}});
  assert.equal(model.snapshot().threads[0].goalObjective,'线程长期目标');
  assert.equal(model.snapshot().threads[0].goalStatus,'paused');
  watcher.consume(file,{type:'event_msg',payload:{type:'thread_goal_updated',goal:{objective:'线程长期目标',status:'active'}}});
  watcher.consume(file,{type:'event_msg',payload:{type:'user_message',message:'/goal 命令设置的目标',turn_id:'turn-3'}});
  thread=model.snapshot().threads[0];
  assert.equal(thread.goal,'命令设置的目标');
  assert.equal(thread.desc,'/goal 命令设置的目标');
  assert.equal(thread.goalSource,'slash_command');
  model.setThreadGoal('thread','');
  thread=model.snapshot().threads[0];
  assert.equal(thread.goal,'更新的计划目标');
  assert.equal(thread.goalStatus,null);
});

test('续跑包装只提取 codex_internal_context 的 objective，不进入输入历史',()=>{
  const model=new ProgressModel(),watcher=new RolloutWatcher(model),file={id:'thread',skip:false,turnId:'turn-1'};
  const message=text=>watcher.consume(file,{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
  message('<codex_internal_context source="goal"><objective>可持续目标</objective></codex_internal_context>');
  for(const text of [
    '# AGENTS.md instructions\n自动注入内容',
    '<environment_context>运行环境</environment_context>',
    '<INSTRUCTIONS>开发指令</INSTRUCTIONS>',
    '[System message] 自动注入内容',
    '<turn_aborted>中断续跑包装</turn_aborted>',
    'Another language model summary\n自动生成摘要'
  ])message(text);
  const thread=model.snapshot().threads[0];
  assert.equal(thread.goal,'可持续目标');
  assert.equal(thread.goalObjective,'可持续目标');
  assert.equal(thread.goalSource,'codex_internal_context');
  assert.equal(thread.goalStatus,null);
  assert.equal(thread.desc,'');
  assert.equal(thread.inputCount,0);
  assert.deepEqual(model.inputs('thread'),[]);
});

test('event_msg 和 response_item 同轮去重，下一轮相同输入仍保留',()=>{
  const model=new ProgressModel(),watcher=new RolloutWatcher(model),file={id:'thread',skip:false};
  const start=turnId=>watcher.consume(file,{type:'event_msg',payload:{type:'task_started',turn_id:turnId}});
  const eventInput=text=>watcher.consume(file,{type:'event_msg',payload:{type:'user_message',message:text}});
  const responseInput=text=>watcher.consume(file,{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
  start('turn-1');eventInput('重复输入');responseInput('重复输入');
  assert.equal(model.ensure('thread').inputCount,1);
  start('turn-2');eventInput('重复输入');responseInput('重复输入');
  assert.equal(model.ensure('thread').inputCount,2);
  assert.deepEqual(model.inputs('thread').map(item=>item.text),['重复输入','重复输入']);
  assert.notEqual(model.inputs('thread')[0].id,model.inputs('thread')[1].id);
});

test('snapshot 不展开历史，输入与有效 goal 中的密钥会遮蔽并保留换行',()=>{
  const model=new ProgressModel();
  model.addInput('thread','第一行 <image name="sample">附件</image>\n[Image #1]\n第二行\nsk-proj-123456789ABCDEFG\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz',100,'turn-1');
  model.plan('thread',[{id:'step',title:'复用 sk-proj-123456789ABCDEFG',detail:'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'}]);
  const snapshot=model.snapshot(),thread=snapshot.threads[0],serialized=JSON.stringify(snapshot);
  assert.equal(thread.desc,'第一行\n第二行\n[REDACTED]\nAuthorization: Bearer [REDACTED]');
  assert.equal(thread.goal,thread.desc);
  assert.equal(thread.inputCount,1);
  assert.equal('inputs' in thread,false);
  assert.equal('threadGoal' in thread,false);
  assert.equal('planGoal' in thread,false);
  assert.equal(serialized.includes('123456789ABCDEFG'),false);
  assert.equal(serialized.includes('abcdefghijklmnopqrstuvwxyz'),false);
  assert.deepEqual(Object.keys(model.inputs('thread')[0]).sort(),['id','text','timestamp']);
  assert.equal(model.inputs('thread')[0].text,thread.desc);
});

test('同一轮重复的人工输入保留，跨来源副本去重，长输入历史不截断',()=>{
  const model=new ProgressModel();
  model.addInput('thread','继续',100,'turn','event_msg');
  model.addInput('thread','继续',110,'turn','response_item');
  model.addInput('thread','继续',120,'turn','event_msg');
  model.addInput('thread','继续',130,'turn','response_item');
  assert.equal(model.inputs('thread').length,2);
  const long='长文本'.repeat(1000);
  model.addInput('thread',long,200,'turn','event_msg');
  assert.equal(model.inputs('thread')[2].text,long);
});
