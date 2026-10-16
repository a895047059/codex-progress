(() => {
  const container=document.getElementById('control-requests');
  let key='',threadId=null,generation=0;
  const titles={command:'执行操作',files:'修改文件',permissions:'临时访问权限',questions:'需要你的回答'};
  const node=(tag,text)=>{const item=document.createElement(tag);if(text)item.textContent=text;return item;};
  function question(q){
    const field=node('fieldset'),title=node('legend',q.question);field.append(title);
    const name='request-'+q.id;
    for(const o of q.options||[]){
      const label=node('label'),input=node('input');input.type='radio';input.name=name;input.value=o.label;
      label.append(input,node('span',o.label));if(o.description)label.append(node('small',o.description));field.append(label);
    }
    const input=node('input');input.type=q.isSecret?'password':'text';input.name=name+'-text';input.placeholder=q.options?.length?'或填写其他答案':'输入回答';input.autocomplete='off';input.setAttribute('aria-label',q.question);field.append(input);
    return {field,read:()=>{const text=input.value.trim(),selected=field.querySelector('input[type=radio]:checked')?.value;return {answers:[text||selected||'']};}};
  }
  function show(requests,id){
    container.replaceChildren();container.hidden=!requests.length;
    for(const r of requests){
      const form=node('form'),title=node('strong',titles[r.kind]||'需要确认');form.className='request-form';form.append(title);
      if(r.reason)form.append(node('p',r.reason));if(r.cwd)form.append(node('p',r.cwd));if(r.command)form.append(node('pre',r.command));
      if(r.permissions){
        if(r.permissions.network)form.append(node('p','网络访问，仅本轮生效'));
        const fs=r.permissions.fileSystem;
        if(fs){for(const [type,label]of [['read','读取'],['write','写入']])for(const path of fs[type]||[])form.append(node('p',label+'：'+path));}
      }
      const readers={};for(const q of r.questions||[]){const item=question(q);readers[q.id]=item.read;form.append(item.field);}
      const error=node('p');error.setAttribute('role','status');error.className='request-error';form.append(error);
      const actions=node('div');actions.className='dialog-actions';form.append(actions);
      const decisions=r.kind==='questions'?[['answer','提交回答']]:r.kind==='permissions'?[['decline','拒绝'],['accept','仅本轮允许']]:[['cancel','停止'],['decline','拒绝'],['accept','允许一次'],['acceptForSession','本会话允许']].filter(([value])=>r.decisions.includes(value));
      for(const [decision,label]of decisions){
        const button=node('button',label);button.type='button';actions.append(button);
        button.onclick=async()=>{
          const body={threadId:id,requestId:r.id,...(decision==='answer'?{answers:Object.fromEntries(Object.entries(readers).map(([k,read])=>[k,read()]))}:{decision})};
          actions.querySelectorAll('button').forEach(b=>b.disabled=true);
          try{const response=await fetch('/api/control/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);form.remove();container.hidden=!container.children.length;}
          catch(e){error.textContent=e.message||'未能提交，请重试';actions.querySelectorAll('button').forEach(b=>b.disabled=false);}
        };
      }
      form.onsubmit=event=>event.preventDefault();container.append(form);
    }
  }
  window.Approvals={async render(thread){
    const next=thread?.id+':'+(thread?.control?.approvalRevision??thread?.control?.waiting??0)+':'+(thread?.control?.waiting||0);if(next===key)return;
    key=next;threadId=thread?.id;const id=threadId,token=++generation;
    container.replaceChildren();container.hidden=true;
    if(!thread?.control?.waiting)return;
    try{const response=await fetch('/api/control/requests?threadId='+encodeURIComponent(id));if(!response.ok)return;const result=await response.json();if(token===generation&&id===threadId)show(result.requests||[],id);}catch{}
  }};
})();
