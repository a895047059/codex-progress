// Disposable relocated bundle: no developer PATH, no existing Codex sessions.
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const root=process.cwd(),base=await mkdtemp(path.join(os.tmpdir(),'codex-portable-'));
const app=path.join(base,'Relocated Progress.app'),runtime=path.join(base,'user-state'),home=path.join(base,'fresh-user');
let proc,servicePid;
const report={startedAt:new Date().toISOString(),ambientNodeUsedByApp:false};
try{
 await cp(path.join(root,'Codex Progress.app'),app,{recursive:true});await mkdir(home);
 execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier local.codex.progress.portablecheck',path.join(app,'Contents/Info.plist')]);
 execFileSync('/usr/bin/codesign',['--force','--sign','-',app],{stdio:'pipe'});
 const sessions=path.join(base,'empty-sessions');await mkdir(sessions);
 proc=spawn(path.join(app,'Contents/MacOS/CodexProgress'),[],{env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:os.tmpdir(),CODEX_PROGRESS_RUNTIME:runtime,CODEX_PROGRESS_SESSIONS:sessions,CODEX_PROGRESS_DISABLE_CONTROL:'1',CODEX_PROGRESS_SNAPSHOT:path.join(root,'work/distribution/portable-native.png'),CODEX_PROGRESS_VERIFY_THREAD:'portable-fixture'},stdio:'pipe'});
 let stderr='';proc.stderr.on('data',b=>stderr+=b.toString());
 let ep;
 for(let i=0;i<300;i++){
  try{ep=JSON.parse(await readFile(path.join(runtime,'endpoint.json')));break;}catch{}
  if(proc.exitCode!==null)throw Error('Native exited: '+proc.exitCode+' '+stderr);
  await new Promise(r=>setTimeout(r,100));
 }
 if(!ep)throw Error('Service did not start');servicePid=ep.pid;
 const url=`http://127.0.0.1:${ep.port}`;
 const before=await(await fetch(url+'/api/state')).json();
 if(before.threads.length)throw Error('Fresh fixture should have zero threads');
 const event=async data=>{const res=await fetch(url+'/api/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(!res.ok)throw Error(await res.text());};
 await event({kind:'plan',threadId:'portable-fixture',turnId:'test-turn',goal:'可移植安装验收',tasks:[{id:'portable',title:'无需额外环境启动',status:'completed'}]});
 const state=await(await fetch(url+'/api/state')).json();report.service={started:true,port:ep.port,fixtureCount:state.threads.length};
 const command=execFileSync('/bin/ps',['-p',String(servicePid),'-o','command='],{encoding:'utf8'}).trim();
 if(!command.startsWith(path.join(app,'Contents/Resources/runtime/node')))throw Error('Unexpected runtime '+command);
 report.bundledRuntimeConfirmed=true;report.relocatedBundle=true;report.freshUserHome=true;report.minimalPath='/usr/bin:/bin';
 proc.kill('SIGUSR1');
 for(let i=0;i<100;i++){try{await readFile(path.join(root,'work/distribution/portable-native.png'));report.nativeSnapshot=true;break;}catch{}await new Promise(r=>setTimeout(r,100));}
 report.stderr=stderr.slice(-1500);
}finally{
 if(proc&&proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(r=>proc.once('exit',r)),new Promise(r=>setTimeout(r,4000))]);if(proc.exitCode===null)proc.kill('SIGKILL');}
 if(servicePid){try{process.kill(servicePid,0);report.serviceStopped=false;}catch{report.serviceStopped=true;}}
 report.nativeStopped=proc?.exitCode!==null;
 await writeFile(path.join(root,'work/distribution/portable-verification.json'),JSON.stringify(report,null,2));
 if(report.serviceStopped!==false)await rm(base,{recursive:true,force:true});
}
console.log(JSON.stringify(report,null,2));
if(!report.bundledRuntimeConfirmed||!report.serviceStopped)process.exitCode=1;
