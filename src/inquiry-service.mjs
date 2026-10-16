import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {collectInquiryEvidence} from './inquiry-evidence.mjs';
import {analyzeInquiry} from './inquiry-analyzer.mjs';

export class InquiryService {
  constructor({model,watcher,runtime,analyze=analyzeInquiry}){
    Object.assign(this,{model,watcher,runtime,analyze});this.sessions=new Map();this.running=0;this.queue=Promise.resolve();
  }
  async load(){
    try{const saved=JSON.parse(await readFile(path.join(this.runtime,'inquiries.json'),'utf8'));
      for(const s of saved)if(s.kind==='status_inquiry'&&typeof s.threadId==='string'&&Array.isArray(s.messages))
        this.sessions.set(s.threadId,{...s,busy:false,error:s.busy?'上次问询未完成，请重新提问':null});
    }catch{}
  }
  session(threadId){
    if(typeof threadId!=='string'||threadId.length>120||!this.model.threads.has(threadId))throw Error('找不到所选任务');
    if(!this.sessions.has(threadId))this.sessions.set(threadId,{id:randomUUID(),kind:'status_inquiry',threadId,title:'状态问询',messages:[],busy:false,error:null});
    return this.sessions.get(threadId);
  }
  snapshot(threadId){return {available:true,session:structuredClone(this.session(threadId))};}
  persist(){
    const data=JSON.stringify([...this.sessions.values()]);
    this.queue=this.queue.catch(()=>{}).then(async()=>{await mkdir(this.runtime,{recursive:true,mode:0o700});await writeFile(path.join(this.runtime,'inquiries.tmp'),data,{mode:0o600});await rename(path.join(this.runtime,'inquiries.tmp'),path.join(this.runtime,'inquiries.json'));});
    return this.queue;
  }
  ask(threadId,question){
    if(typeof question!=='string'||!question.trim()||question.length>4000)throw Error('请填写不超过 4000 字的问题');
    if(this.running>=2)throw Error('已有状态问询正在处理，请稍后重试');
    const s=this.session(threadId);if(s.busy)throw Error('正在检查这个任务的日志，请稍候');
    const history=s.messages.slice(-10);
    s.messages.push({role:'user',text:question.trim(),createdAt:new Date().toISOString()});
    s.busy=true;s.error=null;this.running++;this.persist().catch(()=>{});
    this.run(s,question.trim(),history);return this.snapshot(threadId);
  }
  async run(s,question,history){
    try{
      const evidence=await collectInquiryEvidence({model:this.model,watcher:this.watcher,threadId:s.threadId});
      evidence.metrics=this.watcher.metrics?.snapshot(s.threadId);
      if(evidence.metrics)delete evidence.metrics.points;
      const answer=await this.analyze({evidence,question,history,cwd:path.join(this.runtime,'inquiry-sandbox')});
      s.messages.push({role:'assistant',text:answer,createdAt:new Date().toISOString(),evidenceAt:evidence.capturedAt});
      // Keep bounded conversational context, separately from the original task.
      if(s.messages.length>60)s.messages.splice(0,s.messages.length-60);
    }catch(e){s.error=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'暂时无法分析任务日志，请稍后重试';}
    finally{s.busy=false;this.running--;await this.persist().catch(()=>{});}
  }
}

export async function handleInquiry(req,url,json,service){
  if(url.pathname!=='/api/inquiry')return false;
  try{
    if(req.method==='GET')json(200,service.snapshot(url.searchParams.get('threadId')));
    else if(req.method==='POST'){
      if(!req.headers['content-type']?.startsWith('application/json'))throw Error('请求格式无效');
      let body='',size=0;for await(const part of req){size+=part.length;if(size>20000)throw Error('问题过长');body+=part;}
      const data=JSON.parse(body);json(202,service.ask(data.threadId,data.question));
    }else json(405,{error:'此操作不可用'});
  }catch(e){json(409,{error:/^[\u4e00-\u9fff]/.test(e.message)?e.message:'请求格式无效'});}
  return true;
}
