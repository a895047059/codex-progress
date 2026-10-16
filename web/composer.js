(() => {
  const el=id=>document.getElementById(id), drafts=new Map(), catalogs=new Map();
  let thread=null, open=false, loading=0, pending=false, goalTarget=null;
  const goalLabels={active:'进行中',paused:'已暂停',blocked:'待继续',usageLimited:'额度受限',budgetLimited:'预算已用完',complete:'已完成'};
  const effortLabels={none:'无',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'};
  const bridge=body=>window.webkit?.messageHandlers?.progressComposer?.postMessage(body);
  const draft=id=>{if(!drafts.has(id))drafts.set(id,{text:'',attachments:[],model:'',effort:'',permission:'',plan:null});return drafts.get(id);};
  const current=()=>thread&&draft(thread.id);
  function feedback(message='',error=false){el('compose-feedback').textContent=message;el('compose-feedback').dataset.error=String(error);}
  function closeMenus(){el('compose-menu').hidden=true;el('compose-model-menu').hidden=true;el('compose-add').setAttribute('aria-expanded','false');el('compose-model').setAttribute('aria-expanded','false');}
  function setOpen(value){
    open=!!value&&!!thread?.control?.available;el('composer').hidden=!open;
    el('composer-toggle').setAttribute('aria-expanded',String(open));el('composer-toggle').setAttribute('aria-label',open?'收起输入框':'展开输入框');el('composer-toggle').title=open?'收起输入框':'展开输入框';
    closeMenus();fitWindow();
  }
  function fitWindow(){requestAnimationFrame(()=>Promise.resolve(bridge({action:'resize',expanded:open,contentHeight:document.body.scrollHeight})).catch(()=>{}));}
  async function api(action,data,id=thread?.id){
    const response=await fetch('/api/control/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,threadId:id})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'操作未成功');return result;
  }
  async function catalog(id){
    const response=await fetch('/api/control/options?threadId='+encodeURIComponent(id));
    const result=await response.json();if(!response.ok)throw Error(result.error||'未能读取会话设置');
    catalogs.set(id,result);return result;
  }
  function modelLabel(){
    const d=current(),c=catalogs.get(thread?.id);if(!d)return;
    const model=d.model||thread.control?.model||c?.currentModel,effort=d.effort||thread.control?.effort||c?.currentEffort;
    const label=c?.models?.find(m=>m.model===model)?.displayName||model||'沿用模型';
    el('compose-model').textContent=label+(effort?' '+(effortLabels[effort]||effort):'')+'⌄';
    el('compose-model').title=label;
  }
  function attachments(){
    const list=el('compose-attachments');list.replaceChildren();
    const d=current();if(!d)return;
    for(const item of d.attachments){
      const row=document.createElement('div');row.className='compose-attachment';
      if(item.url?.startsWith('data:image/')){const image=document.createElement('img');image.src=item.url;image.alt='';row.append(image);}
      const name=document.createElement('span');name.textContent=item.name||'附件';name.title=item.path||item.name||'';
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除 '+name.textContent);
      remove.onclick=()=>{d.attachments=d.attachments.filter(a=>a!==item);attachments();updateButtons();};row.append(name,remove);list.append(row);
    }
    if(open)fitWindow();
  }
  function updateButtons(){
    const d=current(),allowed=thread?.control?.available&&!pending;
    for(const id of ['compose-text','compose-add','compose-model','compose-permission'])el(id).disabled=!thread?.control?.available;
    el('compose-send').disabled=!allowed||!d||(!d.text.trim()&&!d.attachments.length);
    el('compose-send').textContent=pending?'…':'↑';
    el('compose-stop').hidden=!open||thread?.status!=='running';el('compose-stop').disabled=!allowed;
    el('compose-plan-badge').hidden=!d?.plan;
    el('compose-permission').dataset.full=String(d?.permission==='full');modelLabel();
  }
  function restore(){
    const d=current();el('compose-text').value=d?.text||'';el('compose-permission').value=d?.permission||'';
    attachments();updateButtons();
  }
  function addAttachments(items){
    const d=current();if(!d||!thread.control?.available)return;
    if(d.attachments.length+items.length>20){feedback('最多添加 20 个附件',true);return;}
    d.attachments.push(...items);attachments();updateButtons();
  }
  function receiveRecording(id,result){
    const d=draft(id),items=result.attachments.filter(item=>!d.attachments.some(existing=>existing.kind===item.kind&&existing.path===item.path));
    if(d.attachments.length+items.length>20){if(thread?.id===id)feedback('附件较多，请移除一些后重新添加录制',true);return false;}
    d.attachments.push(...items);
    if(!d.text.includes(result.text))d.text=[d.text,result.text].filter(Boolean).join('\n\n');
    if(thread?.id===id){restore();feedback('录制已加入输入框，发送后生成技能');}return true;
  }
  async function chooseFiles(){
    closeMenus();
    if(window.webkit?.messageHandlers?.progressComposer){
      const id=thread.id;
      try{const result=await bridge({action:'chooseFiles'});if(thread?.id===id)addAttachments(result.files||[]);}
      catch{feedback('未能选择附件，请重试',true);}
    }else el('compose-files').click();
  }
  async function attachEditor(){
    closeMenus();const id=thread.id;feedback('正在获取 Cursor 内容…');
    try{const item=await window.EditorContext.attach(id);if(thread?.id===id){addAttachments([item]);feedback(item.truncated?'已附加 Cursor，内容过长已截取':'已附加 Cursor');}}
    catch(error){if(thread?.id===id)feedback(error.message,true);}
  }
  async function readImages(files){
    const id=thread?.id,items=[];
    try{
      for(const file of files){
        if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024)throw Error('请添加不超过 8 MB 的 PNG、JPEG 或 WebP 图片');
        const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
        items.push({name:file.name||'粘贴图片',kind:'image',url});
      }
      if(thread?.id===id)addAttachments(items);
    }catch(error){feedback(error.message||'图片未能添加',true);}
  }
  function menuItem(label,action,{description='',disabled=false,selected=false}={}){
    const item=document.createElement('button');item.type='button';item.className='compose-menu-item';item.setAttribute('role','menuitem');item.disabled=disabled;
    const name=document.createElement('span');name.textContent=label;item.append(name);
    if(description){const desc=document.createElement('small');desc.textContent=description;item.append(desc);if(disabled)item.title=description;}
    if(selected)item.setAttribute('aria-pressed','true');item.onclick=action;return item;
  }
  function showGoal(){
    closeMenus();goalTarget=thread.id;el('goal-objective').value=thread.goalObjective||'';el('goal-editor-error').textContent='';el('goal-editor').showModal();el('goal-objective').focus();
  }
  function buildMenu(){
    const menu=el('compose-menu'),d=current(),c=catalogs.get(thread.id);menu.replaceChildren();
    const heading=document.createElement('p');heading.className='compose-menu-heading';heading.textContent='添加';menu.append(heading);
    menu.append(menuItem('♧ 文件和文件夹',chooseFiles));
    menu.append(menuItem('附加 Cursor',attachEditor,{disabled:!window.EditorContext?.available,description:window.EditorContext?.available?'附加当前文件或选区':'Cursor 附加尚未就绪'}));
    menu.append(menuItem('◎ 目标',showGoal,{description:thread.control?.goalSetting?'设置要持续追求的目标':'此会话不支持持续目标',disabled:!thread.control?.goalSetting}));
    menu.append(menuItem('♧ 计划模式',()=>{d.plan=!d.plan;updateButtons();closeMenus();},{description:'开启计划模式',selected:d.plan}));
    menu.append(menuItem('〰 绘图',()=>{closeMenus();window.Drawing.open(image=>addAttachments([image]));},{description:'绘制草图'}));
    const skills=(c?.skills||[]).filter(s=>s.enabled);
    const heading2=document.createElement('p');heading2.className='compose-menu-heading';heading2.textContent='插件与技能';menu.append(heading2);
    const search=document.createElement('input');search.type='search';search.className='compose-skill-search';search.placeholder='搜索插件和技能';search.setAttribute('aria-label','搜索插件和技能');menu.append(search);
    const skillList=document.createElement('div');menu.append(skillList);
    if(!c){const status=document.createElement('p');status.className='compose-menu-heading';status.textContent='正在读取…';menu.append(status);}
    for(const skill of skills){
      const item=menuItem(skill.interface?.displayName||skill.name,()=>{addAttachments([{kind:'skill',name:skill.name,path:skill.path}]);closeMenus();},{description:skill.interface?.shortDescription||skill.shortDescription||''});
      item.dataset.search=[skill.name,skill.interface?.displayName,skill.description,c?.plugins?.find(p=>p.id===skill.pluginId)?.name].join(' ').toLowerCase();skillList.append(item);
    }
    search.oninput=()=>{const query=search.value.trim().toLowerCase();for(const item of skillList.children)item.hidden=!item.dataset.search.includes(query);};
    if(c&&!skills.length){const status=document.createElement('p');status.className='compose-menu-heading';status.textContent='此会话暂无可用插件或技能';menu.append(status);}
  }
  function modelMenu(){
    const menu=el('compose-model-menu'),c=catalogs.get(thread.id),d=current();menu.replaceChildren();
    if(!c){const p=document.createElement('p');p.textContent='正在读取…';menu.append(p);return;}
    function field(label,options,value,change){
      const row=document.createElement('label');row.textContent=label;const select=document.createElement('select');select.setAttribute('aria-label',label);
      for(const [key,name]of options){const option=document.createElement('option');option.value=key;option.textContent=name;select.append(option);}
      select.value=value;select.onchange=()=>change(select.value);row.append(select);menu.append(row);return select;
    }
    field('模型',[['','沿用会话模型'],...(c.models||[]).filter(m=>!m.hidden).map(m=>[m.model,m.displayName])],d.model,value=>{d.model=value;d.effort='';modelMenu();modelLabel();});
    const selected=c.models?.find(m=>m.model===(d.model||c.currentModel));
    field('思考程度',[['','沿用会话设置'],...(selected?.supportedReasoningEfforts||[]).map(e=>[e.reasoningEffort,effortLabels[e.reasoningEffort]||e.reasoningEffort])],d.effort,value=>{d.effort=value;modelLabel();});
  }
  el('composer-toggle').onclick=async()=>{
    if(open){setOpen(false);return;}
    if(!thread?.control?.available)return;
    setOpen(true);restore();el('compose-text').focus();
    const id=thread.id,token=++loading;
    try{await catalog(id);if(token===loading&&thread?.id===id){modelLabel();if(!el('compose-menu').hidden)buildMenu();if(!el('compose-model-menu').hidden)modelMenu();}}
    catch(error){if(thread?.id===id)feedback(error.message,true);}
  };
  el('goal-toggle').onclick=async()=>{
    if(!thread?.control?.goalControl||pending)return;const id=thread.id,status=thread.control.goalStatus==='active'?'paused':'active';
    pending=true;el('goal-toggle').disabled=true;
    try{await api('goal',{status},id);}catch(error){feedback(error.message,true);el('control-hint').textContent=error.message;}
    finally{pending=false;if(thread?.id===id)render(thread);}
  };
  el('compose-text').oninput=()=>{const d=current();if(d)d.text=el('compose-text').value;updateButtons();};
  el('compose-text').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!el('compose-send').disabled)el('compose-send').click();}};
  el('compose-text').addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();readImages(files);}});
  el('compose-files').onchange=()=>{readImages([...el('compose-files').files]);el('compose-files').value='';};
  el('compose-permission').onchange=()=>{const d=current();if(d)d.permission=el('compose-permission').value;updateButtons();};
  el('compose-add').onclick=async()=>{const visible=el('compose-menu').hidden,id=thread?.id;closeMenus();if(visible){await Promise.all([window.EditorContext?.refresh(),window.Recording?.refresh()]);if(thread?.id!==id||!open||!thread?.control?.available)return;buildMenu();el('compose-menu').hidden=false;el('compose-add').setAttribute('aria-expanded','true');}};
  el('compose-model').onclick=()=>{const visible=el('compose-model-menu').hidden;closeMenus();if(visible){modelMenu();el('compose-model-menu').hidden=false;el('compose-model').setAttribute('aria-expanded','true');}};
  el('compose-send').onclick=async()=>{
    if(pending||!thread?.control?.available)return;
    const id=thread.id,d=current(),payload=JSON.parse(JSON.stringify(d));pending=true;updateButtons();feedback('正在发送…');
    try{
      const result=await api('send',payload,id);
      if(JSON.stringify(drafts.get(id))===JSON.stringify(payload))drafts.set(id,{text:'',attachments:[],model:'',effort:'',permission:'',plan:null});
      if(thread?.id===id){restore();feedback(result.kind==='steered'?'已补充给正在运行的任务':'已发送');}
    }catch(error){if(thread?.id===id)feedback(error.message,true);}
    finally{pending=false;updateButtons();}
  };
  el('compose-stop').onclick=async()=>{if(pending||!thread?.control?.available)return;const id=thread.id;pending=true;updateButtons();try{await api('interrupt',{},id);if(thread?.id===id)feedback('已请求停止当前执行');}catch(error){if(thread?.id===id)feedback(error.message,true);}finally{pending=false;updateButtons();}};
  el('goal-save').onclick=async()=>{
    const id=goalTarget;if(!id||id!==thread?.id||!thread.control?.available)return;
    const button=el('goal-save');button.disabled=true;
    try{await api('goal',{objective:el('goal-objective').value,status:'active'},id);el('goal-editor').close();}
    catch(error){el('goal-editor-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#compose-menu,#compose-add,#compose-model-menu,#compose-model'))closeMenus();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape')closeMenus();
    if(!el('compose-menu').hidden&&['ArrowDown','ArrowUp'].includes(event.key)&&event.target.closest('#compose-menu,#compose-add')){
      const items=[...el('compose-menu').querySelectorAll('button:not(:disabled):not([hidden])')],index=items.indexOf(document.activeElement),offset=event.key==='ArrowDown'?1:-1;
      if(items.length){event.preventDefault();items[(index+offset+items.length)%items.length].focus();}
    }
  });
  function render(next){
    const changed=thread?.id!==next?.id;thread=next;
    if(changed){loading++;setOpen(false);feedback();restore();}
    const control=thread?.control,allowed=!!control?.available;
    if(!allowed&&open&&!control?.checking){setOpen(false);feedback('连接已变化，草稿已保留');}
    if(!allowed&&el('goal-editor').open)el('goal-editor').close();
    el('composer-toggle').disabled=(!allowed&&!open)||pending;
    el('composer-toggle').title=open?'收起输入框':allowed?'展开输入框':control?.reason||'仅查看进度';
    el('goal-toggle').disabled=!control?.goalControl||pending;
    const active=control?.goalStatus==='active';
    el('goal-toggle').querySelector('[data-goal-play]').toggleAttribute('hidden',active);el('goal-toggle').querySelector('[data-goal-pause]').toggleAttribute('hidden',!active);
    el('goal-toggle').setAttribute('aria-label',active?'暂停目标':'继续目标');
    el('goal-toggle').title=control?.goalControl?(active?'暂停目标':'继续目标'):(allowed?'从添加菜单设置目标':'当前任务仅可查看进度');
    el('goal-status').textContent=goalLabels[control?.goalStatus||thread?.goalStatus]||'';
    el('control-hint').textContent=control?.reason||'仅查看进度';updateButtons();
  }
  window.Composer={render};
  new ResizeObserver(()=>{if(open)fitWindow();}).observe(el('composer'));
})();
