import { readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { TokenMetrics } from './token-metrics.mjs';

const decodeXml = value => value
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&apos;|&#39;/gi, "'").replace(/&amp;/gi, '&');

// Only read local lifecycle, goal and plan records. Never retain tool output or reasoning.
export class RolloutWatcher {
  constructor(model, root = path.join(os.homedir(), '.codex', 'sessions')) {
    this.model=model; this.root=root; this.files=new Map(); this.metrics=new TokenMetrics(); this.busy=false; this.error=null; this.indexedPaths=new Set(); this.lastIndex=0;
  }
  async candidates() {
    const paths=new Set([...this.indexedPaths,...this.files.keys()]);
    // Reopened tasks can keep an older dated rollout, so index every JSONL under root.
    if(Date.now()-this.lastIndex>15000){
      const folders=[this.root],all=[];
      while(folders.length){
        const dir=folders.pop();
        try{for(const item of await readdir(dir,{withFileTypes:true})){
          const file=path.join(dir,item.name);
          if(item.isDirectory())folders.push(file);else if(item.isFile()&&item.name.endsWith('.jsonl'))all.push(file);
        }}catch(e){if(e.code!=='ENOENT')throw e;}
      }
      for(let i=0;i<all.length;i+=128){
        const batch=await Promise.all(all.slice(i,i+128).map(async file=>({file,info:await stat(file).catch(()=>null)})));
        for(const {file,info} of batch)if(info){this.indexedPaths.add(file);paths.add(file);}
      }
      this.lastIndex=Date.now();
    }
    for (const dayOffset of [1,0]) {
      const date=new Date(Date.now()-dayOffset*86400000);
      const dir=path.join(this.root,String(date.getFullYear()),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0'));
      try { for (const name of await readdir(dir)) if (name.endsWith('.jsonl')) paths.add(path.join(dir,name)); }
      catch(e) { if (e.code!=='ENOENT') throw e; }
    }
    const files=await Promise.all([...paths].map(async file=>({file,info:await stat(file).catch(()=>null)})));
    return files.filter(x=>x.info).sort((a,b)=>a.info.mtimeMs-b.info.mtimeMs);
  }
  async poll() {
    if(this.busy)return;this.busy=true;
    try {
      for(const {file,info} of await this.candidates()) {
        let f=this.files.get(file);
        if(!f || info.size<f.offset) {
          if(f?.id) this.metrics.reset(f.id);
          f={offset:0,partial:'',id:null,skip:false,decoder:new StringDecoder('utf8')}; this.files.set(file,f);
        }
        if(info.size===f.offset) continue;
        const handle=await open(file,'r');
        try {
          // Chunk reads preserve partial lines across writes and avoid loading whole transcripts.
          while(f.offset<info.size) {
            const buffer=Buffer.alloc(Math.min(256*1024,info.size-f.offset));
            const {bytesRead}=await handle.read(buffer,0,buffer.length,f.offset);
            if(!bytesRead)break;
            f.offset+=bytesRead;
            const lines=(f.partial+f.decoder.write(buffer.subarray(0,bytesRead))).split('\n');f.partial=lines.pop();
            for(const line of lines) { try { this.consume(f,JSON.parse(line)); } catch {} }
            if(f.partial.length>8*1024*1024) f.partial='';
          }
        } finally { await handle.close(); }
      }
      this.error=null;
    } catch(e) { this.error=e.code||e.message; }
    finally {this.busy=false;}
  }
  consume(f,record) {
    const p=record.payload||{};
    if(record.type==='session_meta') {
      f.id=p.id;
      f.skip=typeof p.source==='object' && !!p.source?.subagent || /subagent|agent-/.test(p.originator||'');
      return;
    }
    if(!f.id||f.skip)return;
    if(this.metrics.consume(f.id,record))this.model.revision++;
    const timestamp=Date.parse(record.timestamp)||Date.now();
    if(record.type==='event_msg') {
      if(['task_complete','task_completed','turn_aborted','task_interrupted','turn_failed'].includes(p.type))this.metrics.endTurn(f.id,timestamp);
      if(p.type==='task_started') {
        if(p.turn_attribution?.initiating_agent_path || p.parent_turn_id)return;
        f.turnId=p.turn_id||String(timestamp);
        this.metrics.beginTurn(f.id,timestamp);
        this.model.start(f.id,f.turnId,timestamp);
      }
      else if(p.type==='user_message') this.recordHumanInput(f,p.message,timestamp,p.turn_id,'event_msg');
      else if(p.type==='thread_goal_updated') {
        this.model.setThreadGoal(f.id,p.goal?.objective,p.goal?.status,'thread_goal_updated');
        if(p.goal?.status==='complete') this.model.end(f.id);
      }
      else if(['task_complete','task_completed'].includes(p.type)) this.model.end(f.id,'completed',false,timestamp);
      else if(['turn_aborted','task_interrupted'].includes(p.type)) this.model.end(f.id,'interrupted',false,timestamp);
      else if(p.type==='turn_failed') this.model.end(f.id,'failed',false,timestamp);
      else if(p.type==='plan_update' && p.plan) this.model.plan(f.id,p.plan,undefined,p.turn_id||f.turnId,timestamp);
    }
    if(record.type==='response_item') {
      if(p.type==='function_call' && /(?:^|\.)update_plan$/.test(p.name||'')) {
        const args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;
        this.model.plan(f.id,args.plan,args.goal,p.turn_id||f.turnId,timestamp);
      }
      // Newer desktop builds persist the user prompt as a response item.
      if(p.type==='message' && p.role==='user') {
        const text=Array.isArray(p.content)
          ? p.content.filter(x=>x.type==='input_text'||x.type==='text').map(x=>x.text).join('\n')
          : typeof p.content==='string' ? p.content : '';
        this.recordHumanInput(f,text,timestamp,p.turn_id,'response_item');
      }
    }
  }
  recordHumanInput(f,text,timestamp,turnId,source) {
    if(typeof text!=='string'||!text.trim())return;
    const goals=[];
    const wrapped=/<codex_internal_context\b([^>]*)>([\s\S]*?)<\/codex_internal_context\s*>/gi;
    let input=text.replace(wrapped,(whole,attributes,body)=>{
      if(/\bsource\s*=\s*(["'])goal\1/i.test(attributes)) {
        const objective=/<objective\b[^>]*>([\s\S]*?)<\/objective\s*>/i.exec(body);
        if(objective)goals.push(decodeXml(objective[1].trim()));
      }
      return '\n';
    });
    for(const goal of goals)this.model.setThreadGoal(f.id,goal,undefined,'codex_internal_context');

    input=input
      .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context\s*>/gi,'\n')
      .replace(/<(?:instructions|developer|system)\b[^>]*>[\s\S]*?<\/(?:instructions|developer|system)\s*>/gi,'\n')
      .replace(/<turn_aborted\b[^>]*>[\s\S]*?<\/turn_aborted\s*>/gi,'\n')
      .trim();
    if(this.isAutomatedInput(input))return;

    if(/^# Files mentioned by the user:/i.test(input)&&input.includes('## My request:'))input=input.split('## My request:').slice(1).join('## My request:').trim();
    const command=/^\/goal(?:\s+([\s\S]*))?$/i.exec(input);
    if(command?.[1]?.trim())this.model.setThreadGoal(f.id,command[1].trim(),undefined,'slash_command');
    this.model.addInput(f.id,input,timestamp,turnId||f.turnId||'',source);
  }
  isAutomatedInput(text) {
    return !text || /^#\s*AGENTS(?:\.md)?\s+instructions\b/i.test(text)
      || /^<codex_internal_context\b/i.test(text)
      || /^<environment_context\b/i.test(text)
      || /^<(?:instructions|developer|system)\b/i.test(text)
      || /^\[(?:system|developer)\b/i.test(text)
      || /^(?:system|developer)\s*(?:prompt|instructions)?\s*:/i.test(text)
      || /^#\s*(?:system|developer)\s+instructions\b/i.test(text)
      || /^<turn_aborted\b/i.test(text)
      || /^another language model summary\b/i.test(text)
      || /^another language model started to solve this problem\b/i.test(text);
  }
}
