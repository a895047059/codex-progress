(() => {
  let available=false,checkedAt=0,checking=null,target=null,onDraft=null,busy=false,confirming=false,state=null;
  const dialog=document.createElement('dialog');
  dialog.id='recording-dialog';dialog.setAttribute('aria-labelledby','recording-title');
  dialog.innerHTML='<div class="history-header"><strong id="recording-title">录制技能</strong><button type="button" aria-label="关闭录制面板">×</button></div><p class="recording-intro">记录操作并整理成可复用技能，最长 30 分钟。开始前会请求确认。</p><p id="recording-target"></p><p id="recording-message" role="status"></p><div class="recording-actions"><button id="recording-start" type="button">开始录制</button><button id="recording-adopt" type="button" hidden>使用当前录制</button><button id="recording-refresh" type="button">查看录制状态</button><button id="recording-stop" type="button" hidden>结束并添加到输入框</button><button id="recording-attach" type="button" hidden>添加到输入框</button></div><p class="recording-intro">结束后会将录制加入当前任务的输入框，发送后生成技能。</p>';
  document.body.append(dialog);
  const resume=document.createElement('button');resume.type='button';resume.id='recording-resume';resume.hidden=true;
  document.querySelector('.continue-row').append(resume);
  resume.onclick=()=>{if(!dialog.open)dialog.showModal();};
  const el=id=>document.getElementById(id);
  const consent=document.createElement('section');consent.id='recording-consent';consent.hidden=true;
  consent.innerHTML='<strong>允许录制操作？</strong><p>将记录你在 Mac 上的点击、键入内容及交互窗口内容，直到你停止或取消，最长 30 分钟。</p><div class="recording-actions"><button id="recording-allow" type="button">允许并开始录制</button><button id="recording-decline" type="button">暂不录制</button></div>';
  el('recording-message').after(consent);
  dialog.querySelector('[aria-label="关闭录制面板"]').onclick=()=>dialog.close();
  async function api(path,data){
    const response=await fetch('/api/recording/'+path,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});
    const result=await response.json();if(!response.ok)throw Error(result.error||'录制操作未成功，请重试');return result;
  }
  async function refresh(){
    if(!window.webkit?.messageHandlers?.progressComposer)return false;
    if(Date.now()-checkedAt<15000)return available;
    if(checking)return checking;
    checking=api('capability').then(result=>{available=result.available===true;checkedAt=Date.now();return available;}).catch(()=>{available=false;return false;}).finally(()=>{checking=null;});
    return checking;
  }
  function render(){
    const status=state?.status||'idle',owned=state?.owned===true;
    el('recording-message').textContent=busy?'等待确认或录制结果…':state?.message||'准备好演示操作后，点击开始录制。';
    el('recording-start').hidden=!!target?.draft||!!state?.occupied||!['idle','completed','cancelled'].includes(status);
    el('recording-adopt').hidden=status!=='adoption';
    el('recording-stop').hidden=status!=='recording'||!owned;
    el('recording-attach').hidden=!target?.draft;
    resume.hidden=!target||(!busy&&!['recording','adoption','error'].includes(status)&&!target.draft);
    resume.textContent=status==='recording'?'录制中 · 查看':'查看录制';
    for(const button of dialog.querySelectorAll('.recording-actions button'))button.disabled=busy;
    consent.hidden=!state?.confirmation;
    el('recording-allow').disabled=confirming||!state?.confirmation;el('recording-decline').disabled=confirming||!state?.confirmation;
  }
  async function action(kind){
    if(busy||!target)return;const current=target;busy=true;render();
    let checkingState=false,waiting=true;
    // During consent only, inspect our pending request. Never poll the recorder.
    const timer=kind==='start'?setInterval(async()=>{if(checkingState)return;checkingState=true;try{const result=await api('state?threadId='+encodeURIComponent(current.id));if(waiting&&target===current){state=result.state||result;render();}}catch{}finally{checkingState=false;}},500):null;
    try{
      const result=await api(kind,{threadId:current.id});
      if(target!==current)return;
      state=result.state;
      if(result.draft){current.draft=result.draft;deliver();return;}
    }catch(error){
      let latest;try{latest=await api('state?threadId='+encodeURIComponent(current.id));}catch{}
      if(target===current)state={...state,...latest?.state,message:error.message};
    }
    finally{waiting=false;clearInterval(timer);busy=false;if(target===current)render();}
  }
  async function confirm(action){
    const request=state?.confirmation,current=target;if(!request||!current||confirming)return;confirming=true;
    el('recording-allow').disabled=true;el('recording-decline').disabled=true;
    try{const result=await api('confirm',{threadId:current.id,id:request.id,action});if(target===current){state=result.state||result;render();}}
    catch(error){if(target===current)state={...state,message:error.message};}
    finally{confirming=false;if(target===current)render();}
  }
  function deliver(){
    if(!target?.draft)return;
    if(onDraft?.(target.id,target.draft)===false){state={...state,message:'附件较多，请移除一些后重新添加录制。'};render();return;}
    target.draft=null;dialog.close();render();
  }
  async function open(thread,receiveDraft){
    if(busy||(target?.id!==thread.id&&!state?.occupied&&['recording','adoption','error'].includes(state?.status))){if(!dialog.open)dialog.showModal();return;}
    target={id:thread.id};onDraft=receiveDraft;state=null;
    el('recording-target').textContent='当前任务：'+(thread.goalObjective||thread.goal||thread.latestInput||'所选任务');
    render();if(!dialog.open)dialog.showModal();
    const current=target;busy=true;render();
    try{const result=await api('state?threadId='+encodeURIComponent(thread.id));if(target===current){state=result.state||result;if(result.draft)target.draft=result.draft;}}
    catch(error){if(target===current)state={message:error.message};}
    finally{busy=false;if(target===current)render();}
  }
  el('recording-start').onclick=()=>action('start');
  el('recording-adopt').onclick=()=>action('adopt');
  el('recording-refresh').onclick=()=>action('refresh');
  el('recording-stop').onclick=()=>action('stop');
  el('recording-attach').onclick=deliver;
  el('recording-allow').onclick=()=>confirm('accept');el('recording-decline').onclick=()=>confirm('decline');
  window.Recording={refresh,open,get available(){return available;}};
})();
