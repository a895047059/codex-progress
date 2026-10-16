import path from 'node:path';
import os from 'node:os';
import { AppServerClient } from './rpc-client.mjs';
import { ApprovalStore } from './approval-store.mjs';
import { editorContexts } from './editor-context.mjs';

// A loaded thread on this exact connection is the authority. Never resume a
// transcript on a different server merely to make it appear controllable.
export class ThreadController {
  constructor(model, {client, onChange = () => {}, socketPath} = {}) {
    this.model = model;
    this.client = client || new AppServerClient({socketPath: socketPath || path.join(os.homedir(), '.codex/app-server-control/app-server-control.sock')});
    this.onChange = onChange;
    this.connected = false;
    this.loaded = new Set();
    this.resumed = new Set();
    this.resuming = new Map();
    this.connectionGeneration = 0;
    this.details = new Map();
    this.checking = new Set();
    this.activeTurns = new Map();
    this.busy = new Set();
    this.closed = false;
    this.nextConnect = 0;
    this.polling = false;
    this.approvals = new ApprovalStore(this.client,this.onChange);
    this.client.on('disconnect', () => {
      this.resetSubscriptions();
      this.connected = false; this.loaded.clear(); this.markKnownChecking(); this.activeTurns.clear();
      this.nextConnect = Date.now() + 3000; this.onChange();
    });
    this.client.on('notification', event => {
      const id = event.params?.threadId;
      if(id&&event.method==='turn/started'&&event.params?.turn?.id)this.activeTurns.set(id,event.params.turn.id);
      if(id&&event.method==='turn/completed'&&this.activeTurns.get(id)===event.params?.turn?.id)this.activeTurns.delete(id);
      if (id && /^(thread\/goal\/|thread\/status\/|turn\/(started|completed))/.test(event.method)) {
        const cached = this.details.get(id); if (cached) cached.checkedAt = 0;
      }
      if (id && (event.method === 'thread/closed' || event.method === 'thread/status/changed' && event.params?.status?.type === 'notLoaded')) {
        this.clearSubscription(id);
        this.loaded.delete(id);this.details.delete(id);this.checking.delete(id);this.onChange();
      }
    });
  }
  clearSubscription(id) {
    this.resumed.delete(id);
    const pending = this.resuming.get(id);
    if (pending) { pending.invalidated = true; this.resuming.delete(id); }
  }
  resetSubscriptions() {
    this.connectionGeneration++;
    this.resumed.clear();
    for (const pending of this.resuming.values()) pending.invalidated = true;
    this.resuming.clear();
  }
  async ensureSubscription(id) {
    if (this.resumed.has(id)) return;
    const generation = this.connectionGeneration;
    const existing = this.resuming.get(id);
    if (existing?.generation === generation) return existing.promise;

    const pending = {generation, invalidated: false, promise: null};
    pending.promise = Promise.resolve().then(async () => {
      const result = await this.client.request('thread/resume', {threadId: id, excludeTurns: true});
      if (result.thread?.id !== id) throw Error('未能确认会话订阅');
      if (pending.invalidated || generation !== this.connectionGeneration || !this.connected || !this.loaded.has(id)) {
        throw Error('当前任务仅支持查看进度');
      }
      this.resumed.add(id);
    });
    this.resuming.set(id, pending);
    try { await pending.promise; }
    finally { if (this.resuming.get(id) === pending) this.resuming.delete(id); }
  }
  markChecking(id) {
    if (this.details.get(id)?.canAcceptDirectInput && !this.checking.has(id)) {
      this.checking.add(id);
      this.onChange();
    }
  }
  markKnownChecking() {
    for (const [id, detail] of this.details) if (detail.canAcceptDirectInput) this.checking.add(id);
  }
  reconcileLoaded(ids) {
    let changed = false;
    for (const id of new Set([...this.details.keys(), ...this.checking, ...this.resumed, ...this.resuming.keys()])) {
      if (!ids.has(id)) {
        changed = this.details.delete(id) || changed;
        changed = this.checking.delete(id) || changed;
        this.clearSubscription(id);
      }
    }
    return changed;
  }
  async loadedNow() {
    const ids = new Set();
    let cursor;
    do {
      const result = await this.client.request('thread/loaded/list', {...(cursor ? {cursor} : {}), limit: 100});
      for (const id of result.data || []) if (typeof id === 'string') ids.add(id);
      cursor = result.nextCursor;
    } while (cursor);
    return ids;
  }
  async poll() {
    if (this.polling || this.closed || Date.now() < this.nextConnect) return;
    this.polling = true;
    try {
      const reconnecting = !this.connected;
      if (reconnecting) { await this.client.connect(); this.connected = true; }
      this.loaded = await this.loadedNow();
      this.reconcileLoaded(this.loaded);
      const id = this.model.activeId;
      const ids = [...this.loaded].filter(key => this.model.threads.has(key));
      if (id && this.loaded.has(id) && !ids.includes(id)) ids.push(id);
      for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(key => this.readDetails(key, reconnecting).catch(() => {})));
      this.onChange();
    } catch {
      this.resetSubscriptions();
      this.connected = false; this.loaded.clear(); this.markKnownChecking();
      this.client.close(); this.nextConnect = Date.now() + 5000; this.onChange();
    } finally { this.polling = false; }
  }
  async readDetails(id, force = false) {
    const cached = this.details.get(id);
    if (!force && !this.checking.has(id) && cached && Date.now() - cached.checkedAt < (id === this.model.activeId ? 2500 : 15000)) return cached;
    const [threadResult, goalResult] = await Promise.all([
      this.client.request('thread/read', {threadId: id, includeTurns: false}),
      this.client.request('thread/goal/get', {threadId: id}).catch(() => null)
    ]).catch(error => { this.markChecking(id); throw error; });
    const thread = threadResult.thread;
    if (!thread || thread.id !== id) {
      const hadDetail = this.details.delete(id);
      const wasChecking = this.checking.delete(id);
      if (hadDetail || wasChecking) this.onChange();
      throw Error('会话已不可接管');
    }
    const goal = goalResult?.goal || null;
    if (goal) this.model.setThreadGoal(id, goal.objective, goal.status, 'control_service');
    const detail = {checkedAt: Date.now(), goal, cwd: thread.cwd, threadStatus: thread.status,
      canAcceptDirectInput: thread.canAcceptDirectInput === true, model: thread.model, effort: thread.reasoningEffort};
    detail.ephemeral = thread.ephemeral === true;
    this.details.set(id, detail);
    if (this.checking.delete(id)) this.onChange();
    return detail;
  }
  capability(id) {
    const d = this.details.get(id);
    const checking = this.checking.has(id);
    const available = !checking && this.connected && this.loaded.has(id) && d?.canAcceptDirectInput === true;
    return {
      available, checking,
      reason: checking ? (this.connected ? '正在确认输入状态' : '正在重新连接') : available ? '可在此继续' : this.connected ? '仅查看进度' : '控制连接未就绪',
      goalControl: available && !!d?.goal,
      goalSetting: available && !d?.ephemeral,
      goalStatus: d?.goal?.status || null,
      busy: this.busy.has(id), waiting: this.approvals.list(id).length, approvalRevision: this.approvals.revision(id),
      model: d?.model || null, effort: d?.effort || null
    };
  }
  decorate(snapshot) {
    return {...snapshot, threads: snapshot.threads.map(t => ({...t, control: this.capability(t.id)}))};
  }
  async guard(id) {
    if (!this.model.threads.has(id)) throw Error('当前任务仅支持查看进度');
    this.markChecking(id);
    if (!this.connected) throw Error('当前任务仅支持查看进度');
    const loaded = await this.loadedNow();
    this.loaded = loaded;
    const changed = this.reconcileLoaded(loaded);
    if (!loaded.has(id)) { this.details.delete(id); this.checking.delete(id); this.onChange(); throw Error('当前任务已不可接管'); }
    if (changed) this.onChange();
    const detail = await this.readDetails(id, true);
    if (!detail.canAcceptDirectInput) throw Error('当前任务不接受直接输入');
    if (!detail.ephemeral) await this.ensureSubscription(id);
    return detail;
  }
  async exclusive(id, action) {
    if (this.busy.has(id)) throw Error('操作正在进行，请稍候');
    this.busy.add(id); this.onChange();
    try { const detail = await this.guard(id); return await action(detail); }
    finally { this.busy.delete(id); const cached=this.details.get(id);if(cached)cached.checkedAt=0;this.onChange(); }
  }
  async setGoal(id, {status, objective}) {
    if (!['active','paused'].includes(status)) throw Error('目标状态无效');
    if (objective !== undefined && (typeof objective !== 'string' || !objective.trim() || objective.length > 10000)) throw Error('请填写目标');
    return this.exclusive(id, async detail => {
      if(detail.ephemeral)throw Error('该临时会话不支持持续目标');
      if (!detail.goal && !objective) throw Error('这个任务尚未设置目标');
      const result = await this.client.request('thread/goal/set', {threadId: id, status, origin: 'user', ...(objective ? {objective: objective.trim()} : {})});
      const goal = result.goal;
      if (!goal || goal.status !== status) throw Error('未能确认目标状态');
      detail.goal = goal;
      this.model.setThreadGoal(id, goal.objective, goal.status, 'control_service');
      return {status: goal.status};
    });
  }
  async options(id) {
    const detail = await this.guard(id);
    const [models, modes, skills, plugins] = await Promise.all([
      this.client.request('model/list', {}).catch(() => ({data: []})),
      this.client.request('collaborationMode/list', {}).catch(() => ({data: []})),
      this.client.request('skills/list', {cwds: detail.cwd ? [detail.cwd] : []}).catch(() => ({data: []})),
      this.client.request('plugin/list', {cwds: detail.cwd ? [detail.cwd] : []}).catch(() => ({data: []}))
    ]);
    return {
      models: models.data || [], modes: modes.data || [],
      skills: (skills.data || []).flatMap(group => group.skills || []),
      plugins: (plugins.marketplaces || []).flatMap(m => m.plugins || []),
      currentModel: detail.model || null, currentEffort: detail.effort || null,
      cwd: detail.cwd || null
    };
  }
  async send(id, data) {
    const input = normalizeInput(data);
    const contexts = editorContexts(data.attachments);
    const additionalContext = Object.keys(contexts).length ? {additionalContext:contexts} : {};
    return this.exclusive(id, async detail => {
      const active = await this.activeTurn(id,detail);
      if (active) {
        if (data.model || data.effort || data.permission || typeof data.plan === 'boolean') throw Error('任务进行中，下一轮才能更改模型或权限');
        const result=await this.client.request('turn/steer', {threadId: id, expectedTurnId: active.id, input,...additionalContext});
        return {kind: 'steered',turnId:result.turnId||active.id};
      }
      const params = {threadId: id, input,...additionalContext};
      if (data.model) params.model = data.model;
      if (data.effort) params.effort = data.effort;
      if (data.permission) Object.assign(params, permissionOptions(data.permission));
      if (typeof data.plan === 'boolean') {
        const model = data.model || detail.model;
        if (!model) throw Error('请先选择计划模式使用的模型');
        params.collaborationMode = {mode: data.plan?'plan':'default', settings: {model, reasoning_effort: data.effort || detail.effort || null, developer_instructions: null}};
      }
      const result = await this.client.request('turn/start', params);
      if (!result.turn?.id) throw Error('未能确认消息已发送');
      return {kind: 'started',turnId:result.turn.id};
    });
  }
  async interrupt(id) {
    return this.exclusive(id, async detail => {
      const active = await this.activeTurn(id,detail);
      if (!active) return {interrupted: false};
      await this.client.request('turn/interrupt', {threadId: id, turnId: active.id});
      return {interrupted: true};
    });
  }
  async activeTurn(id,detail) {
    if(detail?.threadStatus?.type==='idle')return null;
    const known=this.activeTurns.get(id);
    if(known)return {id:known,status:'inProgress'};
    if(detail?.ephemeral)throw Error('暂时无法确认当前执行，请稍后重试');
    const page = await this.client.request('thread/turns/list', {threadId:id,limit:1,sortDirection:'desc'});
    return page.data?.find(t=>t.status==='inProgress') || null;
  }
  close() { this.closed = true; this.resetSubscriptions(); this.client.close(); }
}

export function permissionOptions(value) {
  if (value === 'read') return {approvalPolicy: 'on-request', sandboxPolicy: {type: 'readOnly'}};
  if (value === 'workspace') return {approvalPolicy: 'on-request', sandboxPolicy: {type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false}};
  if (value === 'full') return {approvalPolicy: 'never', sandboxPolicy: {type: 'dangerFullAccess'}};
  throw Error('权限选项无效');
}

export function normalizeInput(data) {
  if (!data || typeof data.text !== 'string' || data.text.length > 100000) throw Error('输入内容无效或过长');
  const input = [];
  if (data.text.trim()) input.push({type: 'text', text: data.text, text_elements: []});
  if (data.model && (typeof data.model !== 'string' || data.model.length > 160)) throw Error('模型无效');
  if (data.effort && !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(data.effort)) throw Error('思考选项无效');
  if (data.plan != null && typeof data.plan !== 'boolean') throw Error('计划模式选项无效');
  if (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.length > 20)) throw Error('附件数量超出限制');
  for (const a of data.attachments || []) {
    if (a.kind === 'image' && typeof a.url === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.url) && a.url.length < 12 * 1024 * 1024) input.push({type: 'image', url: a.url});
    else if (a.kind === 'image' && typeof a.path === 'string' && path.isAbsolute(a.path)) input.push({type: 'localImage', path: a.path});
    else if (['file','folder'].includes(a.kind) && typeof a.path === 'string' && path.isAbsolute(a.path)) input.push({type: 'text', text: `${a.kind === 'folder' ? '目录' : '文件'}：${a.path}`, text_elements: []});
    else if (a.kind === 'skill' && typeof a.name === 'string' && typeof a.path === 'string' && path.isAbsolute(a.path)) input.push({type: 'skill', name: a.name, path: a.path});
    else if (a.kind === 'editor') {
      editorContexts([a]);
      input.push({type:'text',text:`附加 Cursor 上下文：${path.basename(a.path)}，第 ${a.startLine}–${a.endLine} 行。`,text_elements:[]});
    }
    else throw Error('附件格式不受支持');
  }
  if (!input.length) throw Error('请输入内容或添加附件');
  return input;
}
