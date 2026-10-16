// Opt-in integration check using a disposable ephemeral thread and isolated server.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppServerClient } from '../src/rpc-client.mjs';

if (!process.argv.includes('--live')) throw Error('Pass --live for the disposable integration check.');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = path.join(root, 'work', `editor-live-${Date.now()}`);
await mkdir(path.join(work, 'sessions'), { recursive: true });
const client = new AppServerClient({ timeoutMs: 15000 });
const report = { startedAt: new Date().toISOString(), existingThreadsModified: false, checks: {} };
const completed = new Map();
const replies = new Map();
let threadId, activeTurn, server, host;
client.on('notification', event => {
  if (event.params?.threadId !== threadId) return;
  if (event.method === 'turn/started') activeTurn = event.params.turn.id;
  if (event.method === 'turn/completed') {
    completed.set(event.params.turn.id, event.params.turn);
    if (activeTurn === event.params.turn.id) activeTurn = null;
  }
  if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') {
    replies.set(event.params.item.id, event.params.item.text || '');
  }
});

async function waitFor(get, label, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await get();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timeout: ${label}`);
}

async function api(route, data) {
  const response = await fetch(host + route, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || `HTTP ${response.status}`);
  return body;
}

try {
  await client.connect();
  const result = await client.request('thread/start', {
    ephemeral: true, cwd: work, sandbox: 'read-only', approvalPolicy: 'never'
  });
  threadId = result.thread.id;
  if (!result.thread.ephemeral) throw Error('Expected an ephemeral fixture');
  report.threadId = threadId;
  server = spawn(process.execPath, [path.join(root, 'src/server.mjs'), '--runtime', path.join(work, 'runtime')], {
    cwd: root, env: { ...process.env, CODEX_PROGRESS_RUNTIME: path.join(work, 'runtime'),
      CODEX_PROGRESS_SESSIONS: path.join(work, 'sessions'), CODEX_PROGRESS_DISABLE_CONTROL: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverError = '';
  server.stderr.on('data', chunk => { serverError = (serverError + chunk).slice(-2000); });
  const endpoint = await waitFor(async () => {
    if (server.exitCode !== null) throw Error(`Server exited: ${serverError}`);
    try { return JSON.parse(await readFile(path.join(work, 'runtime/endpoint.json'))); }
    catch { return null; }
  }, 'isolated server');
  host = `http://127.0.0.1:${endpoint.port}`;
  await api('/api/event', { kind: 'plan', threadId, goal: '验证编辑器上下文传递',
    tasks: [{ id: 'context', title: '读取主动附加的文本', status: 'in_progress' }] });
  await waitFor(async () => (await api('/api/state')).threads.find(t => t.id === threadId)?.control?.available, 'control capability');
  report.checks.extensionDetected = (await api('/api/editor/capability')).available === true;
  const request = await api('/api/editor/request', { threadId });
  const marker = `EDITOR_CONTEXT_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  await api('/api/editor/context', { requestId: request.requestId, context: {
    application: 'Cursor', path: path.join(work, 'context.txt'), language: 'plaintext',
    startLine: 1, endLine: 1, text: `PROBE=${marker}`, truncated: false
  } });
  // No context file is created. The model can only obtain the marker through
  // the attachment's additionalContext; the ordinary prompt never contains it.
  const attachment = await api(`/api/editor/request?requestId=${request.requestId}&threadId=${threadId}`);
  if (attachment.status !== 'ready') throw Error('Editor attachment is not ready');
  report.checks.bridgeAttachmentReady = true;
  const sent = await api('/api/control/send', { threadId, text:
    '这是编辑器上下文传递验收。请从本轮附加的 Cursor 内容中读取 PROBE 的值，只回复该值。不使用任何工具，不读取文件；如果看不到附加内容，只回复 NO_CONTEXT。',
    attachments: [attachment.attachment], effort: 'low' });
  const turn = await waitFor(() => completed.get(sent.turnId), 'model response', 60000);
  const reply = [...replies.values()].join('\n').trim();
  report.checks.turnCompleted = turn.status === 'completed';
  report.checks.modelReadAdditionalContext = reply === marker;
  report.reply = reply.slice(0, 300);
  if (turn.status !== 'completed' || reply !== marker) throw Error('The real model did not return the context-only marker');
  console.log(JSON.stringify({ checks: report.checks }));
} catch (error) {
  report.error = error.message;
  console.log(JSON.stringify({ error: error.message, checks: report.checks }));
  process.exitCode = 1;
} finally {
  if (activeTurn) try { await client.request('turn/interrupt', { threadId, turnId: activeTurn }); } catch {}
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (threadId) try {
    report.cleanup = (await client.request('thread/unsubscribe', { threadId })).status;
  } catch (error) { report.cleanupError = error.message; }
  await client.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'work/editor-live-verification.json'), JSON.stringify(report, null, 2));
  await rm(work, { recursive: true, force: true });
  console.log(JSON.stringify({ report: 'work/editor-live-verification.json', cleanup: report.cleanup }));
}
