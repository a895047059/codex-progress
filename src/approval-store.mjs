import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const kinds = {
  'item/commandExecution/requestApproval':'command',
  'item/fileChange/requestApproval':'files',
  'item/permissions/requestApproval':'permissions',
  'item/tool/requestUserInput':'questions'
};
const display = value => typeof value === 'string' ? value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi,'[REDACTED]').slice(0,8000) : '';

export class ApprovalStore {
  constructor(client,onChange=()=>{}) {
    this.client=client;this.onChange=onChange;this.items=new Map();this.revisions=new Map();
    client.on('request',request=>{
      const kind=kinds[request.method];
      if (!kind) { client.respondError(request.id,-32601,'This client cannot present this request'); return; }
      for(const [id,item] of this.items)if(item.rpcId===request.id){
        if(item.method===request.method&&isDeepStrictEqual(item.params,request.params))return;
        this.items.set(id,{...request,id,rpcId:request.id,kind});this._changed(item.params?.threadId,request.params?.threadId);return;
      }
      const id=randomUUID();this.items.set(id,{...request,id,rpcId:request.id,kind});this._changed(request.params?.threadId);
    });
    client.on('disconnect',()=>{const threadIds=[...this.items.values()].map(item=>item.params?.threadId);this.items.clear();this._changed(...threadIds);});
    client.on('notification',event=>{
      if(event.method!=='serverRequest/resolved')return;
      for(const [id,item]of this.items)if(item.rpcId===event.params?.requestId){this.items.delete(id);this._changed(item.params?.threadId);}
    });
  }
  revision(threadId) { return this.revisions.get(threadId)||0; }
  _changed(...threadIds) {
    for(const threadId of new Set(threadIds))if(typeof threadId==='string')this.revisions.set(threadId,this.revision(threadId)+1);
    this.onChange();
  }
  list(threadId) {
    return [...this.items.values()].filter(i=>i.params?.threadId===threadId).map(i=>({
      id:i.id,kind:i.kind,reason:display(i.params.reason),command:display(i.params.command),
      cwd:display(i.params.cwd||i.params.grantRoot),
      decisions:(i.params.availableDecisions||['accept','acceptForSession','decline','cancel']).filter(x=>typeof x==='string'),
      permissions:i.kind==='permissions'?i.params.permissions:undefined,
      questions:i.kind==='questions'?(i.params.questions||[]).map(q=>({...q,question:display(q.question),options:q.options?.map(o=>({...o,label:display(o.label),description:display(o.description)}))})):undefined
    }));
  }
  answer(threadId,id,data) {
    const item=this.items.get(id);
    if(!item||item.params?.threadId!==threadId)throw Error('这项请求已处理或已失效');
    let result;
    if(item.kind==='questions') {
      if(!data.answers||typeof data.answers!=='object')throw Error('请回答问题');
      const answers={};
      for(const q of item.params.questions||[]){
        const values=data.answers[q.id]?.answers;
        if(!Array.isArray(values)||!values.length||values.some(v=>typeof v!=='string'||!v.trim()||v.length>10000))throw Error('请回答所有问题');
        answers[q.id]={answers:values};
      }
      result={answers};
    } else if(item.kind==='permissions') {
      if(!['accept','decline'].includes(data.decision))throw Error('请选择允许或拒绝');
      // Only grant the exact profile requested, and only for this turn.
      result={permissions:data.decision==='accept'?item.params.permissions:{},scope:'turn'};
    } else {
      const allowed=item.params.availableDecisions||['accept','acceptForSession','decline','cancel'];
      if(!['accept','acceptForSession','decline','cancel'].includes(data.decision)||!allowed.includes(data.decision))throw Error('该选项已不可用');
      result={decision:data.decision};
    }
    this.client.respond(item.rpcId,result);this.items.delete(id);this._changed(threadId);return {ok:true};
  }
}
