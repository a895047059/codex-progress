// Isolate native verification from the user's live window and other threads.
import {cp,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';

export async function nativeTestHost(root,threadPath) {
  if(!threadPath||!path.isAbsolute(threadPath))throw Error('Fixture rollout path missing');
  const host=path.join(root,'work','native-test-host-'+Date.now());
  const app=path.join(host,'Progress Verification.app'),sessions=path.join(host,'sessions');
  const day=new Date(),dir=path.join(sessions,String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
  await mkdir(dir,{recursive:true});
  await symlink(threadPath,path.join(dir,'fixture.jsonl'));
  await cp(path.join(root,'Codex Progress.app'),app,{recursive:true});
  const plist=path.join(app,'Contents','Info.plist');
  execFileSync('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string','local.codex.progress.verification',plist]);
  execFileSync('/usr/bin/plutil',['-replace','CFBundleName','-string','Progress Verification',plist]);
  const proc=spawn(path.join(app,'Contents','MacOS','CodexProgress'),[],{
    env:{...process.env,CODEX_PROGRESS_SESSIONS:sessions,CODEX_PROGRESS_RUNTIME:path.join(host,'runtime')},stdio:'ignore'
  });
  proc.on('error',error=>console.error('Native host launch failed: '+error.message));
  let endpoint;
  for(let i=0;i<100;i++){
    try{endpoint=JSON.parse(await readFile(path.join(host,'runtime','endpoint.json')));break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!endpoint)throw Error('Isolated native server failed to start');
  await writeFile(path.join(root,'work','native-test-host.json'),JSON.stringify({host,app,pid:proc.pid,...endpoint,nativePid:proc.pid}));
  return {host,app,port:endpoint.port,nativePid:proc.pid,stop:async()=>{
    if(proc.exitCode!==null)return;
    proc.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>proc.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
    if(proc.exitCode===null)proc.kill('SIGKILL');
  }};
}
