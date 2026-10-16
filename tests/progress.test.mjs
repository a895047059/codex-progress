import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProgressModel } from '../src/model.mjs';
import { RolloutWatcher } from '../src/watcher.mjs';

test('未完成项不能随一轮结束变绿；计划增补合并到同一阶段',()=>{
  const m=new ProgressModel();m.start('a','turn');m.plan('a',[{id:'x',title:'实现',status:'completed'},{id:'y',title:'验收'}]);
  assert.throws(()=>m.end('a','completed',true),/未完成/);
  m.end('a');assert.equal(m.snapshot().threads[0].status,'blocked');assert.equal(m.snapshot().threads[0].completed,1);
  m.plan('a',[{id:'x',title:'实现',status:'completed'},{id:'y',title:'验收',status:'completed'},{id:'z',title:'修复验收问题'}]);
  assert.equal(m.snapshot().threads[0].total,3);m.update('a','z','completed');m.end('a','completed',true);assert.equal(m.snapshot().threads[0].completed,3);
});
test('同一目标的后续阶段按时间分组并保留已完成任务',()=>{
  const m=new ProgressModel();m.start('a','turn-1',1000);
  m.plan('a',[{id:'research',title:'调研'},{id:'build',title:'实现'}],'同一目标','turn-1',2000);
  m.update('a','research','completed');m.update('a','build','completed');m.end('a','completed',false,3000);
  m.start('a','turn-2',4000);m.plan('a',[{id:'verify',title:'验收'}],'同一目标','turn-2',5000);
  const thread=m.snapshot().threads[0];
  assert.deepEqual(thread.taskGroups.map(group=>[group.title,group.createdAt,group.tasks.map(task=>task.id)]),[
    ['阶段 1',2000,['research','build']],['阶段 2',5000,['verify']]
  ]);
  assert.deepEqual(thread.tasks.map(task=>task.id),['verify']);
  assert.equal(thread.completed,2);assert.equal(thread.total,3);
});
test('同阶段只更新状态时沿用原分组和创建时间',()=>{
  const m=new ProgressModel();m.start('a','turn');
  m.plan('a',[{id:'one',title:'任务'}],undefined,'turn',1000);
  m.plan('a',[{id:'one',title:'任务',status:'completed'}],undefined,'turn',2000);
  const thread=m.snapshot().threads[0];
  assert.equal(thread.taskGroups.length,1);assert.equal(thread.taskGroups[0].createdAt,1000);
  assert.equal(thread.taskGroups[0].tasks[0].status,'completed');assert.equal(thread.completed,1);
});
test('具名任务跨轮改标题仍合并同一未完成阶段',()=>{
  const m=new ProgressModel();m.start('a','turn-1',1000);
  const oldTasks=Array.from({length:9},(_,i)=>({id:`group_${i}`,title:`旧标题 ${i}`}));
  m.plan('a',oldTasks,undefined,'turn-1',2000);m.update('a','group_0','completed','旧补充');m.end('a','interrupted',false,3000);
  m.start('a','turn-2',4000);
  m.plan('a',oldTasks.map((task,i)=>({id:task.id,title:`新标题 ${i}`,detail:i===1?'当前补充':''})),undefined,'turn-2',5000);
  const thread=m.snapshot().threads[0],tasks=thread.taskGroups[0].tasks;
  assert.equal(thread.taskGroups.length,1);assert.equal(thread.taskGroups[0].createdAt,2000);
  assert.equal(thread.total,9);assert.equal(tasks[0].title,'新标题 0');assert.equal(tasks[0].status,'completed');
  assert.equal(tasks[0].detail,'旧补充');assert.equal(tasks[1].title,'新标题 1');assert.equal(tasks[1].status,'pending');
  assert.equal(tasks[1].detail,'当前补充');
});
test('相同计划重复发布不重复计数',()=>{
  const m=new ProgressModel();m.start('a','turn');
  const plan=[{id:'one',title:'任务'},{id:'two',title:'验收'}];
  m.plan('a',plan,undefined,'turn',1000);m.plan('a',plan,undefined,'turn',2000);
  const thread=m.snapshot().threads[0];
  assert.equal(thread.taskGroups.length,1);assert.equal(thread.total,2);
  assert.deepEqual(thread.taskGroups[0].tasks.map(task=>task.id),['one','two']);
});
test('完成六项后新增三项会形成下一阶段并把总数增至九项',()=>{
  const m=new ProgressModel();m.start('a','turn-1',1000);
  m.plan('a',Array.from({length:6},(_,i)=>({id:`old-${i}`,title:`旧任务 ${i}`})),undefined,'turn-1',2000);
  for(let i=0;i<6;i++)m.update('a',`old-${i}`,'completed');
  m.end('a','completed',true,3000);m.start('a','turn-2',4000);
  m.plan('a',Array.from({length:3},(_,i)=>({id:`new-${i}`,title:`新任务 ${i}`})),undefined,'turn-2',5000);
  const thread=m.snapshot().threads[0];
  assert.equal(thread.taskGroups.length,2);assert.equal(thread.completed,6);assert.equal(thread.total,9);
});
test('已完成计划复用 step ID 但更换标题时新建阶段',()=>{
  const m=new ProgressModel();m.start('a','turn-1',1000);
  m.plan('a',[{id:'step-1',title:'旧任务'}],undefined,'turn-1',2000);
  m.update('a','step-1','completed');m.end('a','completed',true,3000);m.start('a','turn-2',4000);
  m.plan('a',[{id:'step-1',title:'新任务'}],undefined,'turn-2',5000);
  const thread=m.snapshot().threads[0];
  assert.deepEqual(thread.taskGroups.map(group=>group.tasks[0].title),['旧任务','新任务']);
  assert.equal(thread.completed,1);assert.equal(thread.total,2);
});
test('恢复阶段历史按创建时间排序，并验证当前阶段引用',()=>{
  const m=new ProgressModel();m.start('a','turn');
  const groups=[
    {id:'phase-later',createdAt:2000,title:'较晚',tasks:[{id:'new',title:'当前'}]},
    {id:'phase-earlier',createdAt:1000,title:'较早',tasks:[{id:'old',title:'历史',status:'completed'}]}
  ];
  m.restoreTaskGroups('a',groups,'phase-later');
  const before=m.snapshot().threads[0];
  assert.deepEqual(before.taskGroups.map(group=>group.id),['phase-earlier','phase-later']);
  assert.equal(before.currentTaskGroupId,'phase-later');assert.equal(before.tasks[0].id,'new');
  assert.throws(()=>m.restoreTaskGroups('a',groups,'missing'),/当前阶段/);
  assert.throws(()=>m.restoreTaskGroups('a',groups,123),/当前阶段引用无效/);
  assert.deepEqual(m.snapshot().threads[0],before);
});
test('恢复时折叠未完成阶段的同一具名任务集并重定向当前引用',()=>{
  const m=new ProgressModel();m.start('a','turn');m.plan('a',[{id:'live',title:'当前任务'}]);
  const ids=Array.from({length:9},(_,i)=>`group_${i}`);
  const groups=[
    {id:'phase-1',createdAt:1000,title:'阶段 1',tasks:ids.map((id,i)=>({id,title:`旧标题 ${i}`,status:i<6?'completed':'pending',detail:i===0?'旧补充':''}))},
    {id:'phase-2',createdAt:2000,title:'阶段 2',tasks:ids.map((id,i)=>({id,title:`新标题 ${i}`,status:'pending',detail:i===0?'当前补充':''}))},
    {id:'phase-3',createdAt:3000,title:'阶段 3',tasks:[{id:'later',title:'真实新阶段'}]}
  ];
  m.restoreTaskGroups('a',groups,'phase-2');
  const thread=m.snapshot().threads[0];
  assert.deepEqual(thread.taskGroups.map(group=>[group.id,group.title,group.createdAt]),[
    ['phase-1','阶段 1',1000],['phase-3','阶段 2',3000]
  ]);
  assert.equal(thread.currentTaskGroupId,'phase-1');assert.equal(thread.tasks.length,9);
  assert.equal(thread.tasks[0].title,'新标题 0');assert.equal(thread.tasks[0].status,'completed');
  assert.equal(thread.tasks[0].detail,'当前补充');assert.equal(thread.tasks[1].detail,'');
  assert.equal(thread.completed,6);assert.equal(thread.total,10);
  m.start('a','turn-2',4000);m.plan('a',[{id:'next',title:'后续任务'}],undefined,'turn-2',5000);
  const continued=m.snapshot().threads[0];
  assert.deepEqual(continued.taskGroups.map(group=>group.id),['phase-1','phase-3','phase-4']);
  assert.deepEqual(continued.taskGroups.map(group=>group.title),['阶段 1','阶段 2','阶段 3']);
  assert.equal(continued.currentTaskGroupId,'phase-4');
});
test('恢复不会折叠已完成阶段、自动任务改名或具名集合不同的阶段',()=>{
  const m=new ProgressModel();m.start('a','turn');
  const groups=[
    {id:'one',createdAt:1000,tasks:[{id:'shared',title:'任务'},{id:'step-1',title:'自动旧标题'}]},
    {id:'two',createdAt:2000,tasks:[{id:'shared',title:'任务'},{id:'step-1',title:'自动新标题'}]},
    {id:'three',createdAt:3000,tasks:[{id:'completed',title:'已完成',status:'completed'}]},
    {id:'four',createdAt:4000,tasks:[{id:'completed',title:'已完成的新标题'}]},
    {id:'five',createdAt:5000,tasks:[{id:'different',title:'另一任务'}]},
    {id:'six',createdAt:6000,tasks:[{id:'different',title:'另一任务'},{id:'extra',title:'新任务'}]}
  ];
  m.restoreTaskGroups('a',groups,'six');
  assert.deepEqual(m.snapshot().threads[0].taskGroups.map(group=>group.id),groups.map(group=>group.id));
});
test('恢复历史但不指定当前阶段时保留未归组的当前任务',()=>{
  const m=new ProgressModel();m.start('a','turn');
  m.plan('a',[{id:'live',title:'当前任务'}]);
  m.restoreTaskGroups('a',[{id:'history',createdAt:1000,tasks:[{id:'old',title:'历史任务',status:'completed'}]}],null);
  const thread=m.snapshot().threads[0];
  assert.equal(thread.currentTaskGroupId,null);assert.deepEqual(thread.tasks.map(task=>task.id),['live']);
  assert.equal(thread.completed,1);assert.equal(thread.total,2);
});
test('计划校验失败不能破坏已存在的计划；旧轮事件不能覆盖新轮',()=>{
  const m=new ProgressModel();m.start('a','new');m.plan('a',[{id:'x',title:'任务'}]);
  assert.throws(()=>m.plan('a',[{id:'x',title:'一'},{id:'x',title:'二'}]));
  m.plan('a',[{title:'旧任务'}],null,'old');assert.equal(m.snapshot().threads[0].tasks[0].title,'任务');
});
test('锁定会话不会因另一个任务启动跳走；下一轮重置子任务',()=>{
  const m=new ProgressModel();m.start('a','a1');m.select('a');m.start('b','b1');assert.equal(m.activeId,'a');
  m.select(null);assert.equal(m.activeId,'b');m.plan('a',[{title:'已完成',status:'completed'}]);m.start('a','a2');assert.equal(m.ensure('a').explicit,false);assert.equal(m.ensure('a').tasks[0].status,'in_progress');
});
test('重启后按开始时间跟随最新任务，并移除图片附件元信息',()=>{
  const m=new ProgressModel();m.start('new','n',200);m.start('old','o',100);assert.equal(m.activeId,'new');
  m.goal('new','<image name=[Image #1] path="/private/image.png">\n</image>\n[Image #1] 检查排版');
  assert.equal(m.ensure('new').goal,'检查排版');
});
test('超过40个任务也全部保留并可选择',()=>{
  const m=new ProgressModel();for(let i=0;i<85;i++)m.start('task-'+i,'turn-'+i,i+1);
  assert.equal(m.snapshot().threads.length,85);m.select('task-0');assert.equal(m.snapshot().activeId,'task-0');
});
test('追加的半行和 UTF-8 字符可靠恢复；忽略子代理',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-progress-watch-'));
  try{
    const d=new Date(),dir=path.join(root,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));await mkdir(dir,{recursive:true});
    const file=path.join(dir,'rollout-test.jsonl');
    const start=[{type:'session_meta',payload:{id:'a',source:'vscode'}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn'}}].map(JSON.stringify).join('\n')+'\n';
    await writeFile(file,start);const m=new ProgressModel(),w=new RolloutWatcher(m,root);await w.poll();
    const line=Buffer.from(JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'中文任务'}})+'\n'),split=line.indexOf(Buffer.from('中'))+1;
    await appendFile(file,line.subarray(0,split));await w.poll();assert.equal(m.ensure('a').goal,'');
    await appendFile(file,line.subarray(split));await w.poll();assert.equal(m.ensure('a').goal,'中文任务');
    const f={id:null,skip:false};w.consume(f,{type:'session_meta',payload:{id:'child',source:{subagent:{parent_thread_id:'a'}}}});w.consume(f,{type:'event_msg',payload:{type:'task_started',turn_id:'child'}});assert.equal(m.threads.has('child'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('真实 WebSocket 推送、并发更新、Origin 限制和重连快照',async()=>{
  const runtime=await mkdtemp(path.join(os.tmpdir(),'codex-progress-server-')),empty=path.join(runtime,'sessions');await mkdir(empty);
  const date=new Date(),folder=path.join(empty,String(date.getFullYear()),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0'));await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'rollout-test.jsonl'),[{type:'session_meta',payload:{id:'a',source:'exec'}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn'}}].map(JSON.stringify).join('\n')+'\n');
  const launch=()=>spawn(process.execPath,['src/server.mjs','--runtime',runtime],{cwd:new URL('../',import.meta.url),env:{...process.env,CODEX_PROGRESS_SESSIONS:empty,CODEX_PROGRESS_DISABLE_CONTROL:'1'},stdio:['ignore','pipe','pipe']});
  let child=launch();
  let errors='';child.stderr.on('data',c=>errors+=c);
  const ready=new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error(errors)));});
  await ready;
  let ws;
  try{
    const {port}=JSON.parse(await readFile(path.join(runtime,'endpoint.json'),'utf8')),host=`http://127.0.0.1:${port}`;
    const post=(data,origin)=>fetch(host+'/api/event',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});
    ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);const events=[];ws.addEventListener('message',e=>events.push(JSON.parse(e.data)));
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    assert.equal((await post({kind:'plan',threadId:'a',goal:'目标',tasks:Array.from({length:8},(_,i)=>({id:String(i),title:'任务 '+i}))})).status,200);
    const replies=await Promise.all(Array.from({length:8},(_,i)=>post({kind:'update',threadId:'a',taskId:String(i),status:'completed'})));
    assert.ok(replies.every(x=>x.status===200));assert.equal((await post({kind:'finish',threadId:'a'})).status,200);
    assert.equal((await post({kind:'finish',threadId:'a'},'https://untrusted.example')).status,403);
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(events.at(-1).threads[0].completed,8);ws.close();
    ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);const again=await new Promise(resolve=>ws.addEventListener('message',e=>resolve(JSON.parse(e.data)),{once:true}));assert.equal(again.threads[0].status,'completed');
    assert.equal(JSON.parse(await readFile(path.join(runtime,'plans.json'),'utf8'))[0].tasks.filter(t=>t.status==='completed').length,8);
    assert.equal((await post({kind:'plan',threadId:'a',goal:'目标',tasks:Array.from({length:3},(_,i)=>({id:'next-'+i,title:'后续任务 '+i}))})).status,200);
    ws.close();await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
    child=launch();await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('重启失败')));});
    const restarted=JSON.parse(await readFile(path.join(runtime,'endpoint.json'),'utf8'));
    const restored=await(await fetch(`http://127.0.0.1:${restarted.port}/api/state`)).json();
    assert.equal(restored.threads[0].status,'running');assert.equal(restored.threads[0].completed,8);
    assert.equal(restored.threads[0].total,11);assert.equal(restored.threads[0].taskGroups.length,2);
  }finally{
    ws?.close();child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));await rm(runtime,{recursive:true,force:true});
  }
});
