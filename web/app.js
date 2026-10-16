const $=id=>document.getElementById(id);
const taskNames={pending:'待开始',in_progress:'进行中',completed:'已完成',blocked:'待处理',failed:'失败'};
const states={idle:'等待开始',running:'进行中',completed:'全部完成',blocked:'等待处理',interrupted:'已暂停',failed:'未能完成'};
const agentStates={running:'运行中',in_progress:'运行中',completed:'已完成',failed:'失败',blocked:'待处理',interrupted:'已暂停',pending:'待开始',idle:'待开始',waiting:'等待中',active:'运行中',done:'已完成',cancelled:'已停止',error:'失败'};
const groupColors=['oklch(.59 .16 25)','oklch(.58 .14 250)','oklch(.58 .15 145)','oklch(.69 .15 88)','oklch(.59 .15 320)','oklch(.59 .14 205)'];
let state=null, currentThread=null, ws, retry=500, selected=null, tooltipTask=null, gridThread=null;
let subagentAgents=[],selectedSubagentId='',subagentDialogThreadId='',subagentRefreshTimer=null,subagentListRequest=0,subagentListPending=null,subagentDetailRequest=0,subagentDetailPending=null,subagentDetailKey='',subagentDetailAgent=null;
const gridNodes=new Map(),gridFrameNodes=new Map(),subagentRows=new Map();
function text(id,value){$(id).textContent=value;}
function hideTip(){$('tooltip').hidden=true;tooltipTask=null;}
function getTaskGroups(thread){
  const source=Array.isArray(thread?.taskGroups)?thread.taskGroups:[];
  const groups=source.length?[...source]:[{id:'current',title:'当前阶段',tasks:Array.isArray(thread?.tasks)?thread.tasks:[]}];
  if(source.length&&!thread.currentTaskGroupId&&thread.tasks?.length)groups.push({id:'current',title:'当前阶段',tasks:thread.tasks});
  return groups.map((group,index)=>({
    id:String(group?.id??`group-${index+1}`),
    title:String(group?.title||group?.name||`阶段 ${index+1}`),
    color:groupColors[index%groupColors.length],
    tasks:Array.isArray(group?.tasks)?group.tasks:[]
  }));
}
function taskEntries(thread){
  return getTaskGroups(thread).flatMap((group,groupIndex)=>group.tasks.map((task,taskIndex)=>({
    ...task,groupIndex,groupId:group.id,groupTitle:group.title,
    key:`${group.id}:${task.id??taskIndex}:${taskIndex}`
  })));
}
function interruptedTask(task,thread=currentThread){return task.status==='in_progress'&&['interrupted','failed'].includes(thread?.status);}
function taskStatus(task,thread=currentThread){const status=interruptedTask(task,thread)?'failed':task.status;return taskNames[status]?status:'pending';}
function showTip(button,task,index){
  tooltipTask=task.key;text('tip-index',`${index+1} / ${taskEntries(currentThread).length} · ${task.groupTitle} · ${interruptedTask(task)?'已暂停':taskNames[task.status]||'状态未知'}`);
  text('tip-title',task.title);text('tip-detail',task.detail||'');$('tip-detail').hidden=!task.detail;
  const tip=$('tooltip');tip.hidden=false;
  const rect=button.getBoundingClientRect();
  let left=Math.max(12,Math.min(rect.left,innerWidth-tip.offsetWidth-12));
  let top=rect.bottom+9;if(top+tip.offsetHeight>innerHeight-12)top=Math.max(12,rect.top-tip.offsetHeight-9);
  tip.style.left=left+'px';tip.style.top=top+'px';
}
function renderGrid(){
  const groups=getTaskGroups(currentThread),entries=groups.flatMap((group,groupIndex)=>group.tasks.map((task,taskIndex)=>({...task,groupIndex,groupId:group.id,groupTitle:group.title,key:`${group.id}:${task.id??taskIndex}:${taskIndex}`}))),grid=$('grid-cells'),frames=$('grid-frames');
  if(gridThread!==currentThread?.id){gridNodes.clear();gridFrameNodes.clear();grid.replaceChildren();frames.replaceChildren();gridThread=currentThread?.id;}
  const cols=Math.max(1,Math.floor((grid.clientWidth+4)/16)),capacity=cols*4;
  $('grid').style.setProperty('--cols',cols);
  const visible=entries.slice(0,capacity),nodes=[],segments=[];
  const lookup=cell=>{const index=Number(cell.dataset.taskIndex);return {task:taskEntries(currentThread)[index],index};};
  for(let slot=0;slot<capacity;slot++){
    const task=visible[slot],key=task?'task:'+task.key:'empty:'+slot;
    let cell=gridNodes.get(key);
    if(!cell){
      cell=document.createElement(task?'button':'span');gridNodes.set(key,cell);
      if(task){
        cell.type='button';cell.dataset.taskKey=task.key;cell.setAttribute('aria-describedby','tooltip');
        const show=()=>{const found=lookup(cell);if(found.task)showTip(cell,found.task,found.index);};
        cell.addEventListener('mouseenter',show);cell.addEventListener('focus',show);
        cell.addEventListener('mouseleave',()=>{if(selected!==cell.dataset.taskKey)hideTip();});
        cell.addEventListener('blur',()=>{if(selected!==cell.dataset.taskKey)hideTip();});
        cell.addEventListener('click',()=>{selected=selected===cell.dataset.taskKey?null:cell.dataset.taskKey;grid.querySelectorAll('.cell').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.taskKey===selected)));if(selected)show();else hideTip();});
      }else cell.setAttribute('aria-hidden','true');
    }
    if(task){
      const status=taskStatus(task),className='cell '+status;if(cell.className!==className)cell.className=className;
      cell.dataset.taskIndex=slot;cell.dataset.groupIndex=task.groupIndex;cell.style.setProperty('--group-color',groups[task.groupIndex]?.color||'transparent');cell.setAttribute('aria-pressed',String(task.key===selected));
      cell.setAttribute('aria-label',`${task.title}，${interruptedTask(task)?'已暂停':taskNames[task.status]||'状态未知'}`);
      cell.style.setProperty('--phase',`${-slot*.15}s`);
      const row=Math.floor(slot/cols),last=segments.at(-1);
      if(last&&last.groupIndex===task.groupIndex&&last.row===row)last.end=slot;
      else segments.push({groupIndex:task.groupIndex,row,start:slot,end:slot});
    }else cell.className='empty-cell';
    nodes.push(cell);
  }
  nodes.forEach((cell,index)=>{if(grid.children[index]!==cell)grid.insertBefore(cell,grid.children[index]||null);});
  while(grid.children.length>nodes.length)grid.lastElementChild.remove();
  const usedFrames=new Set();
  for(const segment of segments){
    const key=`${segment.groupIndex}:${segment.row}`,first=gridNodes.get('task:'+visible[segment.start].key),last=gridNodes.get('task:'+visible[segment.end].key);
    if(!first||!last)continue;
    let frame=gridFrameNodes.get(key);
    if(!frame){frame=document.createElement('span');frame.className='group-frame';frame.setAttribute('aria-hidden','true');gridFrameNodes.set(key,frame);}
    const color=groups[segment.groupIndex]?.color||'transparent';
    frame.style.setProperty('--group-color',color);frame.style.left=`${first.offsetLeft-2}px`;frame.style.top=`${first.offsetTop-2}px`;
    frame.style.width=`${last.offsetLeft+last.offsetWidth-first.offsetLeft+4}px`;frame.style.height=`${first.offsetHeight+4}px`;
    frames.append(frame);usedFrames.add(key);
  }
  for(const [key,frame] of gridFrameNodes)if(!usedFrames.has(key)){frame.remove();gridFrameNodes.delete(key);}
  $('grid-more').hidden=entries.length<=capacity;
}
function agentStatus(status){return agentStates[status]||'状态未知';}
function formatTimestamp(value){
  if(value===undefined||value===null||value==='')return '';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value);
  return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(date);
}
function renderSubagentRows(){
  const list=$('subagent-list'),used=new Set();
  text('subagent-count',`${subagentAgents.length} 个`);
  $('subagent-toggle').classList.toggle('is-empty',subagentAgents.length===0);
  for(let index=0;index<subagentAgents.length;index++){
    const agent=subagentAgents[index],id=String(agent.id||''),key=id||`agent-${index}`;used.add(key);
    let row=subagentRows.get(key);
    if(!row){
      row=document.createElement('button');row.type='button';row.className='subagent-row';
      const title=document.createElement('span');title.className='subagent-row-title';
      const status=document.createElement('span');status.className='subagent-row-status';
      row.append(title,status);subagentRows.set(key,row);
    }
    row.dataset.agentId=id;row.dataset.status=String(agent.status||'unknown');row.setAttribute('aria-pressed',String(id===selectedSubagentId));
    row.children[0].textContent=String(agent.title||`子代理 ${index+1}`);row.children[0].title=row.children[0].textContent;
    row.children[1].textContent=agentStatus(agent.status);
    if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
  }
  for(const [key,row] of subagentRows)if(!used.has(key)){row.remove();subagentRows.delete(key);}
}
function renderSubagentDetail(agent=null,message=''){
  const panel=$('subagent-detail');
  if(!selectedSubagentId){panel.hidden=true;return;}
  const current=subagentAgents.find(item=>String(item.id)===selectedSubagentId)||{};
  panel.hidden=false;text('subagent-detail-title',String(agent?.title||current.title||'子代理'));
  const status=agent?.status||current.status;text('subagent-detail-status',agentStatus(status));$('subagent-detail-status').dataset.status=String(status||'unknown');
  const times=[];
  if(agent?.startedAt||current.startedAt)times.push(`开始 ${formatTimestamp(agent?.startedAt||current.startedAt)}`);
  if(agent?.updatedAt||current.updatedAt)times.push(`更新 ${formatTimestamp(agent?.updatedAt||current.updatedAt)}`);
  text('subagent-detail-times',times.join(' · '));
  const outputList=$('subagent-outputs');outputList.replaceChildren();
  const outputs=Array.isArray(agent?.outputs)?agent.outputs:[];
  text('subagent-output-message',message||(!outputs.length?'暂无输出记录':agent?.limited?'显示最近的运行记录':''));$('subagent-output-message').hidden=!message&&!!outputs.length&&!agent?.limited;
  for(const item of outputs){
    const entry=document.createElement('article');entry.className='subagent-output';
    const head=document.createElement('div');head.className='subagent-output-head';
    const kind=document.createElement('span');kind.textContent=({final:'完成回复',commentary:'进展更新',tool:'工具执行'})[item?.kind]||'输出';head.append(kind);
    const at=formatTimestamp(item?.at);if(at){const time=document.createElement('time');time.textContent=at;head.append(time);}
    const body=document.createElement('pre');body.textContent=String(item?.text||'');entry.append(head,body);outputList.append(entry);
  }
}
const subagentRequestTimeoutMs=15000;
async function fetchSubagent(url,controller=new AbortController()){
  const timeout=setTimeout(()=>controller.abort(),subagentRequestTimeoutMs);
  try{return await fetch(url,{signal:controller.signal});}finally{clearTimeout(timeout);}
}
function invalidateSubagentList(){
  subagentListRequest++;subagentListPending?.controller.abort();subagentListPending=null;
}
function clearSubagentDetail(){
  subagentDetailRequest++;subagentDetailPending?.controller.abort();subagentDetailPending=null;subagentDetailKey='';subagentDetailAgent=null;
}
async function loadSubagentDetail(id,{refresh=false}={}){
  const threadId=currentThread?.id;if(!threadId||!id)return;
  const key=JSON.stringify([threadId,id]);
  if(subagentDetailPending?.key===key)return subagentDetailPending.promise;
  if(!refresh&&subagentDetailKey===key)return;
  if(subagentDetailPending){subagentDetailPending.controller.abort();subagentDetailPending=null;}
  const request=++subagentDetailRequest,controller=new AbortController(),pending={key,controller,promise:null};
  if(subagentDetailKey!==key)renderSubagentDetail(null,'正在读取运行记录…');
  pending.promise=(async()=>{
    try{
      const params=new URLSearchParams({threadId,agentId:id});
      const response=await fetchSubagent(`/api/subagents/detail?${params}`,controller);
      if(!response.ok)throw new Error('detail unavailable');
      const payload=await response.json();
      if(request!==subagentDetailRequest||!$('subagent-dialog').open||currentThread?.id!==threadId||selectedSubagentId!==id)return;
      subagentDetailKey=key;subagentDetailAgent=payload.agent||null;renderSubagentDetail(subagentDetailAgent);
    }catch{
      if(request===subagentDetailRequest&&$('subagent-dialog').open&&currentThread?.id===threadId&&selectedSubagentId===id){
        if(subagentDetailKey===key&&subagentDetailAgent)renderSubagentDetail(subagentDetailAgent,'暂时无法读取子代理输出');
        else renderSubagentDetail(null,'暂时无法读取子代理输出');
      }
    }
  })();
  subagentDetailPending=pending;
  try{return await pending.promise;}finally{if(subagentDetailPending===pending)subagentDetailPending=null;}
}
async function refreshSubagents(showLoading=false){
  const threadId=currentThread?.id;
  if(!threadId){invalidateSubagentList();clearSubagentDetail();subagentAgents=[];selectedSubagentId='';renderSubagentRows();text('subagent-message','暂无子代理');$('subagent-message').hidden=false;return;}
  if(subagentListPending?.threadId===threadId)return subagentListPending.promise;
  if(subagentListPending){subagentListPending.controller.abort();subagentListPending=null;}
  const request=subagentListRequest,controller=new AbortController(),pending={threadId,controller,promise:null};
  if(showLoading||!subagentAgents.length){text('subagent-message','正在加载子代理…');$('subagent-message').hidden=false;}
  pending.promise=(async()=>{
    try{
      const response=await fetchSubagent(`/api/subagents?${new URLSearchParams({threadId})}`,controller);
      if(!response.ok)throw new Error('list unavailable');
      const payload=await response.json();
      if(request!==subagentListRequest||!$('subagent-dialog').open||currentThread?.id!==threadId)return;
      subagentAgents=Array.isArray(payload.agents)?payload.agents:[];
      if(!subagentAgents.some(agent=>String(agent.id)===selectedSubagentId))selectedSubagentId=String(subagentAgents[0]?.id||'');
      renderSubagentRows();
      if(!subagentAgents.length){selectedSubagentId='';clearSubagentDetail();renderSubagentDetail();text('subagent-message','暂无子代理');$('subagent-message').hidden=false;return;}
      $('subagent-message').hidden=true;
      if(selectedSubagentId){
        const selectedAgent=subagentAgents.find(agent=>String(agent.id)===selectedSubagentId);
        const key=JSON.stringify([threadId,selectedSubagentId]);
        const detailChanged=selectedAgent?.updatedAt!==subagentDetailAgent?.updatedAt;
        await loadSubagentDetail(selectedSubagentId,{refresh:subagentDetailKey===key&&(selectedAgent?.status!=='completed'||detailChanged)});
      }
    }catch{
      if(request===subagentListRequest&&$('subagent-dialog').open&&currentThread?.id===threadId){
        if(!subagentAgents.length){text('subagent-message','暂时无法读取子代理列表');$('subagent-message').hidden=false;}
        else{text('subagent-message','状态暂时无法更新');$('subagent-message').hidden=false;}
      }
    }
  })();
  subagentListPending=pending;
  try{return await pending.promise;}finally{if(subagentListPending===pending)subagentListPending=null;}
}
function openSubagents(){
  const dialog=$('subagent-dialog');if(dialog.open)return;
  invalidateSubagentList();clearSubagentDetail();subagentAgents=[];selectedSubagentId='';subagentDialogThreadId=currentThread?.id||'';subagentRows.clear();$('subagent-list').replaceChildren();$('subagent-toggle').classList.add('is-empty');renderSubagentDetail();
  dialog.showModal();$('subagent-toggle').setAttribute('aria-expanded','true');refreshSubagents(true);
  clearInterval(subagentRefreshTimer);subagentRefreshTimer=setInterval(()=>{if(dialog.open)refreshSubagents();},5000);
}
function renderAllTaskGroups(){
  const container=$('all-task-groups');container.replaceChildren();
  const groups=getTaskGroups(currentThread);
  if(!groups.some(group=>group.tasks.length)){const empty=document.createElement('p');empty.className='detail-message';empty.textContent='暂无任务';container.append(empty);return;}
  groups.forEach((group,groupIndex)=>{
    const section=document.createElement('section');section.className='all-task-group';section.style.setProperty('--group-color',group.color);
    const heading=document.createElement('header');heading.className='all-task-group-heading';
    const title=document.createElement('strong');title.textContent=group.title;
    const count=document.createElement('span');count.textContent=`${group.tasks.length} 项`;heading.append(title,count);
    const cells=document.createElement('div');cells.className='all-task-grid';cells.setAttribute('role','group');cells.setAttribute('aria-label',group.title);
    group.tasks.forEach((task,index)=>{
      const cell=document.createElement('button');cell.type='button';cell.className=`cell ${taskStatus(task)}`;
      cell.style.setProperty('--group-color',group.color);cell.style.setProperty('--phase',`${-(index+groupIndex*groups.length)*.15}s`);
      cell.title=`${task.title} · ${interruptedTask(task)?'已暂停':taskNames[task.status]||'状态未知'}`;
      cell.setAttribute('aria-label',cell.title);cells.append(cell);
    });
    section.append(heading,cells);container.append(section);
  });
}
function render(snapshot){
  const previousTip=tooltipTask,previousThread=currentThread?.id;
  state=snapshot;const threads=state.threads||[];
  currentThread=threads.find(thread=>thread.id===state.activeId)||threads[0]||null;
  if(previousThread!==currentThread?.id)selected=null;
  if($('subagent-dialog').open&&subagentDialogThreadId!==(currentThread?.id||'')){
    invalidateSubagentList();clearSubagentDetail();subagentDialogThreadId=currentThread?.id||'';subagentAgents=[];selectedSubagentId='';subagentRows.clear();$('subagent-list').replaceChildren();$('subagent-toggle').classList.add('is-empty');renderSubagentDetail();refreshSubagents(true);
  }
  window.TaskPicker.render(state);
  text('thread-count',`任务 ${threads.length}`);
  $('follow').setAttribute('aria-pressed',String(!state.pinnedId));text('follow',state.pinnedId?'恢复跟随':'自动跟随');
  hideTip();renderGrid();
  if(previousThread===currentThread?.id&&previousTip){
    const cell=gridNodes.get('task:'+previousTip),task=taskEntries(currentThread).find(x=>x.key===previousTip);
    if(cell?.isConnected&&task)showTip(cell,task,Number(cell.dataset.taskIndex));
  }
  const tasks=currentThread?.tasks||[];
  window.InputHistory?.render(currentThread);
  window.Composer?.render(currentThread);
  window.Approvals?.render(currentThread);
  window.StatusInquiry?.render(currentThread);
  window.TokenChart?.render(currentThread);
  const t=currentThread,done=t?.completed||0,total=t?.total||0,percent=total?Math.round(done/total*100):0;
  text('goal',t?.goal||'等待下一项任务');$('goal').title=t?.goal||'';text('done',done);text('total',total);
  text('state-label',states[t?.status||'idle']);$('state-label').style.color=t?.status==='failed'?'var(--error)':t?.status==='blocked'?'var(--muted)':'';
  const running=tasks.find(x=>x.status==='in_progress'),issue=tasks.find(x=>['failed','blocked'].includes(x.status));
  text('current',t?.status==='completed'?'所有任务已完成':issue?.title||running?.title||(t?.status==='blocked'?'本轮已结束，仍有未完成项':t?.status==='interrupted'?'可在 Codex 中继续':total&&done===total?'正在确认最终结果':'等待下一步'));
  $('bar').style.width=percent+'%';document.querySelector('.track').setAttribute('aria-valuenow',percent);document.querySelector('.track').setAttribute('aria-valuetext',`${done} 项完成，共 ${total} 项`);
  $('issue-legend').hidden=!tasks.some(x=>['blocked','failed'].includes(x.status));text('footnote',t?.explicit?'每格是一项任务':'尚未细分子任务');
  updateElapsed();
  document.documentElement.dataset.tasksReady='true';
  window.dispatchEvent(new Event('tasks-ready'));
}
function updateElapsed(){
  if(!currentThread?.startedAt){text('elapsed','等待任务开始');return;}
  const end=currentThread.status==='running'?Date.now():currentThread.updatedAt;
  const seconds=Math.max(0,Math.floor((end-currentThread.startedAt)/1000));
  text('elapsed',`${currentThread.status==='running'?'已运行':'用时'} ${seconds>=3600?Math.floor(seconds/3600)+' 小时 ':''}${seconds>=60?Math.floor(seconds/60)%60+' 分 ':''}${seconds%60} 秒`);
}
async function selectThread(threadId){
  try{const r=await fetch('/api/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threadId})});if(!r.ok)throw Error();}
  catch{text('connection','切换失败，请重试');if(state)render(state);}
}
$('threads').addEventListener('change',()=>{const threadId=$('threads').value;if(threadId)selectThread(threadId);});
$('follow').addEventListener('click',()=>selectThread(null));
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){selected=null;hideTip();document.querySelectorAll('.cell').forEach(x=>x.setAttribute('aria-pressed','false'));}
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&document.activeElement?.classList.contains('cell')){
    const cells=[...$('grid').querySelectorAll('.cell')],i=cells.indexOf(document.activeElement),cols=Number($('grid').style.getPropertyValue('--cols'));
    const offset={ArrowLeft:-1,ArrowRight:1,ArrowUp:-cols,ArrowDown:cols}[e.key];if(cells[i+offset]){e.preventDefault();cells[i+offset].focus();}
  }
});
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.cell')){selected=null;hideTip();}});window.addEventListener('resize',()=>{hideTip();renderGrid();});
$('grid-more').addEventListener('click',()=>{renderAllTaskGroups();$('grid-more').setAttribute('aria-expanded','true');$('all-tasks-dialog').showModal();});
$('all-tasks-close').addEventListener('click',()=>$('all-tasks-dialog').close());
$('all-tasks-dialog').addEventListener('close',()=>$('grid-more').setAttribute('aria-expanded','false'));
$('subagent-toggle').addEventListener('click',openSubagents);
$('subagent-close').addEventListener('click',()=>$('subagent-dialog').close());
$('subagent-dialog').addEventListener('close',()=>{
  clearInterval(subagentRefreshTimer);subagentRefreshTimer=null;invalidateSubagentList();clearSubagentDetail();
  $('subagent-toggle').setAttribute('aria-expanded','false');
});
$('subagent-list').addEventListener('click',event=>{
  const row=event.target.closest('[data-agent-id]');if(!row)return;
  const previousId=selectedSubagentId;
  selectedSubagentId=row.dataset.agentId;renderSubagentRows();
  const key=JSON.stringify([currentThread?.id,selectedSubagentId]);
  if(previousId!==selectedSubagentId&&subagentDetailKey===key)renderSubagentDetail(subagentDetailAgent);
  const agent=subagentAgents.find(item=>String(item.id)===selectedSubagentId);
  loadSubagentDetail(selectedSubagentId,{refresh:agent?.status!=='completed'});
});
function connect(){
  ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
  ws.onopen=()=>{retry=500;text('connection','实时更新');$('connection').className='connected';};
  ws.onmessage=e=>{try{const snapshot=JSON.parse(e.data);render(snapshot);if(!snapshot.observing){text('connection','暂时无法读取任务');$('connection').className='';}}catch{text('connection','更新暂时不可用');}};
  ws.onclose=()=>{text('connection','正在重新连接');$('connection').className='';setTimeout(connect,retry);retry=Math.min(retry*2,10000);};
  ws.onerror=()=>ws.close();
}
setInterval(updateElapsed,1000);connect();
new ResizeObserver(()=>renderGrid()).observe($('grid'));
