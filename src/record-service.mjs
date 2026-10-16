import { randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordClient } from './record-client.mjs';

const TOOLS = new Set(['event_stream_start', 'event_stream_status', 'event_stream_stop']);
const CANCELLED_REASON = 'recording_controls_cancelled';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DEFAULT_SKILL_PATH = path.join(CODEX_HOME, '.tmp/bundled-marketplaces/openai-bundled/plugins/record-and-replay/skills/record-and-replay/SKILL.md');
const MAX_BODY_SIZE = 8 * 1024;

function serviceError(message, status = 409) {
  return Object.assign(new Error(message), { status, public: true });
}

function validThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 120) throw serviceError('请选择有效任务', 400);
  return threadId;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validAbsolutePath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value);

function parseSession(result) {
  if (!isRecord(result) || result.isError === true) throw serviceError('录制状态格式无法确认');
  let payload;
  if (Object.hasOwn(result, 'structuredContent')) payload = result.structuredContent;
  else if (Array.isArray(result.content)) {
    const textItems = result.content.filter(item => item?.type === 'text');
    if (textItems.length !== 1 || typeof textItems[0].text !== 'string') throw serviceError('录制状态格式无法确认');
    try { payload = JSON.parse(textItems[0].text); } catch { throw serviceError('录制状态格式无法确认'); }
  }
  if (!isRecord(payload)) throw serviceError('录制状态格式无法确认');

  const { isRecording, sessionID, sessionDirectoryPath, eventsPath, metadataPath, startedAt, maxDurationSeconds } = payload;
  const endedAt = payload.endedAt ?? null;
  const endReason = payload.endReason ?? null;
  if (isRecording === false && !Object.hasOwn(payload, 'sessionID')
      && Object.keys(payload).every(key => ['isRecording', 'maxDurationSeconds'].includes(key))
      && Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0) {
    return { isRecording: false, noSession: true, maxDurationSeconds };
  }
  const validTime = value => value === null || typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
  if (typeof isRecording !== 'boolean' || typeof sessionID !== 'string' || !sessionID.trim() || sessionID.length > 256
      || !validAbsolutePath(sessionDirectoryPath) || !validAbsolutePath(eventsPath) || !validAbsolutePath(metadataPath)
      || !(startedAt === null || typeof startedAt === 'string' && startedAt.length <= 100)
      || !validTime(endedAt) || !(endReason === null || typeof endReason === 'string' && endReason.length <= 256)
      || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0)
    throw serviceError('录制状态格式无法确认');
  const parsedStart = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  return { isRecording, sessionID, sessionDirectoryPath, eventsPath, metadataPath, startedAt,
    startedAtMs: Number.isFinite(parsedStart) ? parsedStart : null, endedAt, endReason, maxDurationSeconds };
}

function isWithin(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class RecordService {
  constructor({ controller, client, skillPath = DEFAULT_SKILL_PATH, now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!validAbsolutePath(skillPath)) throw new TypeError('skillPath must be an absolute path');
    Object.assign(this, { controller, skillPath, now, available: false, records: new Map(), active: null,
      busyThreadId: null, startAttempt: null, pendingConfirmation: null, closed: false, seenSessionIds: new Set() });
    const onElicitation = (request, context) => this.handleElicitation(request, context);
    this.client = client || new RecordClient({ onElicitation });
    client?.setElicitationHandler?.(onElicitation);
  }

  async capability() {
    if (this.closed || this.busyThreadId) return { available: this.available && !this.closed };
    try { await this._connectTools(); } catch { this.available = false; }
    return { available: this.available };
  }

  snapshot(threadId) {
    validThreadId(threadId);
    const own = this.records.get(threadId);
    if (own && (own.ownerThreadId === threadId || own.requestedThreadId === threadId)) {
      const pending = this.pendingConfirmation?.threadId === threadId ? this.pendingConfirmation : null;
      return {
        state: {
          available: this.available,
          threadId,
          status: own.status,
          busy: this.busyThreadId === threadId,
          message: own.message,
          owned: own.ownerThreadId === threadId,
          hasDraft: Boolean(own.draft),
          ...(pending ? { confirmation: { id: pending.id, message: 'Record & Replay 请求开始录制，请确认后继续' } } : {}),
        },
        ...(own.draft ? { draft: own.draft } : {}),
      };
    }
    if (this.active && this.active.requestedThreadId !== threadId && this.active.ownerThreadId !== threadId) {
      return { state: { available: this.available, threadId, status: 'idle', busy: false,
        message: '另一个任务有待处理的录制，请先完成绑定或结束录制', owned: false, hasDraft: false, occupied: true } };
    }
    return { state: { available: this.available, threadId, status: 'idle', busy: this.busyThreadId === threadId,
      message: this.busyThreadId === threadId ? '正在准备录制' : '尚未开始录制', owned: false, hasDraft: false } };
  }

  async start(threadId) {
    validThreadId(threadId);
    return this._withOperation(threadId, async () => {
      const existing = this.records.get(threadId);
      if (this.active && this.active !== existing) throw serviceError('另一个任务正在录制或等待确认');
      if (existing && ['recording', 'adoption', 'error'].includes(existing.status)) return this._result(threadId);
      if (!this.controller || typeof this.controller.guard !== 'function') throw serviceError('控制连接未就绪');
      let tools;
      try {
        await this.controller.guard(threadId);
        tools = await this._connectTools();
      } catch {
        const record = this._record(threadId, { status: 'error', message: '控制或录制连接未就绪，请重试', ownerThreadId: null, needsAdoption: false, session: null });
        this.active = null;
        return this._result(threadId, record);
      }
      if (!tools.has('event_stream_start')) {
        this.available = false;
        const record = this._record(threadId, { status: 'error', message: '录制功能当前不可用', ownerThreadId: null, needsAdoption: false, session: null });
        return this._result(threadId, record);
      }
      const record = this._record(threadId, { status: 'idle', message: '正在准备录制', ownerThreadId: null, needsAdoption: false, session: null });
      this.active = record;
      const requestedAt = this.now();
      const attempt = { threadId, record, userChoice: null, requestedAt };
      this.startAttempt = attempt;
      try {
        const raw = await this.client.call('event_stream_start');
        if (attempt.userChoice === 'decline' || attempt.userChoice === 'cancel') {
          this._set(record, 'cancelled', attempt.userChoice === 'decline' ? '已拒绝开始录制' : '录制已取消', threadId, false);
          this.active = null;
          return this._result(threadId, record);
        }
        const session = parseSession(raw);
        record.session = session.noSession ? null : session;
        if (session.noSession) this._set(record, 'idle', '未开始录制', threadId, false);
        else if (session.endReason === CANCELLED_REASON) this._set(record, 'cancelled', '录制已取消', threadId, false);
        else if (!session.isRecording) this._set(record, 'adoption', '未能确认本次录制已开始；发现已有录制结果，请确认绑定后使用', null, true);
        else if (attempt.userChoice === 'accept' && this._isFresh(session, requestedAt)) this._set(record, 'recording', '正在录制', threadId, false);
        else this._set(record, 'adoption', '发现已有录制，请确认绑定后再结束', null, true);
        if (!session.noSession) this.seenSessionIds.add(session.sessionID);
        if (session.noSession || record.status === 'cancelled' || !session.isRecording) this.active = null;
        return this._result(threadId, record);
      } catch {
        if (attempt.userChoice === 'decline' || attempt.userChoice === 'cancel') {
          this._set(record, 'cancelled', attempt.userChoice === 'decline' ? '已拒绝开始录制' : '录制已取消', threadId, false);
          this.active = null;
          return this._result(threadId, record);
        }
        this._set(record, 'error', '启动结果未能确认，请刷新状态并确认绑定', null, true);
        this.active = record;
        throw serviceError('启动结果未能确认，请刷新状态并确认绑定');
      } finally {
        this.startAttempt = null;
        this._clearConfirmationFor(threadId);
      }
    });
  }

  async adopt(threadId) {
    validThreadId(threadId);
    return this._withOperation(threadId, async () => {
      const record = this.records.get(threadId);
      if (!record || record.requestedThreadId !== threadId || record.ownerThreadId && record.ownerThreadId !== threadId || !record.needsAdoption || !record.session) throw serviceError('没有待绑定的录制');
      if (this.active && this.active !== record) throw serviceError('另一个任务正在录制或等待确认');
      if (record.session.isRecording) {
        this._set(record, 'recording', '已绑定当前录制', threadId, false);
        this.active = record;
      } else if (record.session.endReason === CANCELLED_REASON) {
        this._set(record, 'cancelled', '录制已取消', threadId, false);
        this.active = null;
      } else {
        this._set(record, 'completed', '录制已结束', threadId, false);
        this.active = null;
        await this._attachDraft(record);
      }
      return this._result(threadId, record);
    });
  }

  async refresh(threadId) {
    validThreadId(threadId);
    return this._withOperation(threadId, async () => {
      const prior = this.records.get(threadId);
      if (this.active && this.active !== prior) throw serviceError('另一个任务正在录制或等待确认');
      if (!prior) {
        if (!this.controller || typeof this.controller.guard !== 'function') throw serviceError('控制连接未就绪');
        try { await this.controller.guard(threadId); } catch { throw serviceError('当前任务暂不可查询录制状态'); }
      }
      let tools;
      try { tools = await this._connectTools(); } catch { throw serviceError('录制连接未就绪，请重试'); }
      if (!tools.has('event_stream_status')) throw serviceError('录制状态当前不可用');

      let session;
      try { session = parseSession(await this.client.call('event_stream_status')); }
      catch { throw serviceError('暂时无法确认录制状态，请重试'); }
      if (session.noSession) {
        const record = prior || this._record(threadId, { status: 'idle', message: '当前没有活动录制', ownerThreadId: threadId, needsAdoption: false, session: null });
        record.session = null;
        record.draft = null;
        record.stopUncertain = false;
        this._set(record, 'idle', '当前没有活动录制', threadId, false);
        if (this.active === prior) this.active = null;
        return this._result(threadId, record);
      }
      const sameOwnedSession = prior?.ownerThreadId === threadId && prior.session?.sessionID === session.sessionID;
      const record = sameOwnedSession ? prior : this._record(threadId, { status: 'adoption', message: '请确认绑定当前录制', ownerThreadId: null, needsAdoption: true, session: null });
      record.session = session;
      record.stopUncertain = false;
      this.seenSessionIds.add(session.sessionID);
      if (session.endReason === CANCELLED_REASON) {
        this._set(record, 'cancelled', '录制已取消', threadId, false);
        record.draft = null;
        if (this.active === record) this.active = null;
      } else if (session.isRecording) {
        if (sameOwnedSession && !prior.needsAdoption) this._set(record, 'recording', '正在录制', threadId, false);
        else this._set(record, 'adoption', '发现当前录制，请确认绑定后再结束', null, true);
        this.active = record;
      } else if (sameOwnedSession && !prior.needsAdoption) {
        this._set(record, 'completed', '录制已结束', threadId, false);
        if (this.active === record) this.active = null;
        await this._attachDraft(record);
      } else {
        this._set(record, 'adoption', '发现已结束的录制结果，请确认绑定后使用', null, true);
        this.active = null;
      }
      return this._result(threadId, record);
    });
  }

  async stop(threadId) {
    validThreadId(threadId);
    return this._withOperation(threadId, async () => {
      const record = this.records.get(threadId);
      if (!record || record.ownerThreadId !== threadId) throw serviceError('当前任务没有已绑定的录制');
      if (record.status === 'cancelled') return this._result(threadId, record);
      if (record.status === 'idle') return this._result(threadId, record);
      if (record.status === 'completed') {
        if (!record.draft) await this._attachDraft(record);
        return this._result(threadId, record);
      }
      if (record.needsAdoption || !record.session) throw serviceError('请先刷新状态并确认绑定');
      if (record.stopUncertain) throw serviceError('请先刷新录制状态');
      if (!record.session.isRecording) throw serviceError('当前录制尚未完成绑定确认');
      let tools;
      try { tools = await this._connectTools(); } catch { throw serviceError('录制连接未就绪，请重试'); }
      if (!tools.has('event_stream_stop')) throw serviceError('结束录制功能当前不可用');
      const previousSessionId = record.session.sessionID;
      let current;
      try { current = parseSession(await this.client.call('event_stream_status')); }
      catch { throw serviceError('暂时无法确认录制状态，请刷新后重试'); }
      if (current.noSession) {
        record.session = null;
        record.draft = null;
        this._set(record, 'idle', '当前没有活动录制', threadId, false);
        this.active = null;
        return this._result(threadId, record);
      }
      if (current.sessionID !== previousSessionId) {
        record.session = current;
        this._set(record, 'adoption', current.isRecording ? '录制会话已变化，请确认绑定' : '发现已结束的其他录制，请确认绑定', null, true);
        if (current.isRecording) this.active = record;
        else this.active = null;
        return this._result(threadId, record);
      }
      if (current.endReason === CANCELLED_REASON) {
        record.session = current;
        this._set(record, 'cancelled', '录制已取消', threadId, false);
        record.draft = null;
        this.active = null;
        return this._result(threadId, record);
      }
      if (!current.isRecording) {
        record.session = current;
        this._set(record, 'completed', '录制已结束', threadId, false);
        this.active = null;
        await this._attachDraft(record);
        return this._result(threadId, record);
      }
      let session;
      try { session = parseSession(await this.client.call('event_stream_stop')); }
      catch {
        this._set(record, 'error', '停止结果未能确认，请刷新状态', threadId, false);
        record.stopUncertain = true;
        throw serviceError('停止结果未能确认，请刷新状态');
      }
      if (session.noSession) {
        record.session = null;
        record.draft = null;
        this._set(record, 'idle', '当前没有活动录制', threadId, false);
        this.active = null;
        return this._result(threadId, record);
      }
      if (session.sessionID !== previousSessionId) {
        this._set(record, 'error', '录制会话已变化，请刷新状态并确认绑定', null, true);
        this.active = null;
        return this._result(threadId, record);
      }
      record.session = session;
      this.seenSessionIds.add(session.sessionID);
      record.stopUncertain = false;
      if (session.endReason === CANCELLED_REASON) {
        this._set(record, 'cancelled', '录制已取消', threadId, false);
        record.draft = null;
        this.active = null;
      } else if (session.isRecording) {
        this._set(record, 'recording', '录制尚未结束，可重试停止', threadId, false);
        this.active = record;
      } else {
        this._set(record, 'completed', '录制已结束', threadId, false);
        this.active = null;
        await this._attachDraft(record);
      }
      return this._result(threadId, record);
    });
  }

  async confirm(threadId, { id, action } = {}) {
    validThreadId(threadId);
    if (!['accept', 'decline', 'cancel'].includes(action)) throw serviceError('确认选项无效', 400);
    const pending = this.pendingConfirmation;
    if (!pending || pending.threadId !== threadId || pending.id !== id || pending.settled) {
      throw serviceError('确认请求已失效');
    }
    pending.attempt.userChoice = action;
    pending.settled = true;
    this.pendingConfirmation = null;
    pending.resolve(action === 'accept' ? { action, content: {} } : { action });
    return this._result(threadId, pending.attempt.record);
  }

  handleElicitation(request, { signal } = {}) {
    const attempt = this.startAttempt;
    if (this.closed || !attempt || this.pendingConfirmation || !isRecord(request)) return Promise.resolve({ action: 'decline' });
    const id = randomUUID();
    return new Promise(resolve => {
      const pending = { id, threadId: attempt.threadId, attempt, resolve, settled: false, signal, onAbort: null };
      const settle = action => {
        if (pending.settled) return;
        pending.settled = true;
        if (signal && pending.onAbort) signal.removeEventListener('abort', pending.onAbort);
        if (this.pendingConfirmation === pending) this.pendingConfirmation = null;
        resolve({ action });
      };
      pending.resolve = value => {
        if (signal && pending.onAbort) signal.removeEventListener('abort', pending.onAbort);
        resolve(value);
      };
      pending.settle = settle;
      pending.onAbort = () => settle('cancel');
      if (signal?.aborted) {
        settle('cancel');
        return;
      }
      signal?.addEventListener('abort', pending.onAbort, { once: true });
      this.pendingConfirmation = pending;
    });
  }

  close() {
    this.closed = true;
    const pending = this.pendingConfirmation;
    if (pending && !pending.settled) {
      pending.attempt.userChoice = 'cancel';
      pending.settle('cancel');
    }
    try { return Promise.resolve(this.client.close?.()); }
    catch { return Promise.resolve(); }
  }

  async _connectTools() {
    if (this.closed) throw serviceError('录制服务已关闭');
    this.available = false;
    const tools = await this.client.connect();
    if (!Array.isArray(tools)) throw serviceError('录制工具列表无效');
    const names = new Set(tools.filter(item => isRecord(item) && typeof item.name === 'string').map(item => item.name));
    try {
      await access(this.skillPath, fsConstants.R_OK);
      if (!(await stat(this.skillPath)).isFile()) throw new Error('invalid');
    } catch {
      this.available = false;
      throw serviceError('官方录制技能当前不可用');
    }
    this.available = [...TOOLS].every(name => names.has(name));
    if (!this.available) throw serviceError('录制功能当前不可用');
    return names;
  }

  _isFresh(session, requestedAt) {
    if (session.startedAtMs === null || this.seenSessionIds.has(session.sessionID)) return false;
    const now = this.now();
    return session.startedAtMs >= requestedAt - 2000 && session.startedAtMs <= now + 2000;
  }

  _record(threadId, { status, message, ownerThreadId, needsAdoption, session }) {
    const record = { requestedThreadId: threadId, ownerThreadId, status, message, needsAdoption, session, draft: null, stopUncertain: false };
    this.records.set(threadId, record);
    return record;
  }

  _set(record, status, message, ownerThreadId, needsAdoption) {
    Object.assign(record, { status, message, ownerThreadId, needsAdoption });
  }

  async _attachDraft(record) {
    try {
      const root = await realpath(record.session.sessionDirectoryPath);
      if (!(await stat(root)).isDirectory()) throw new Error('invalid');
      const files = [];
      for (const candidate of [record.session.metadataPath, record.session.eventsPath]) {
        const resolved = await realpath(candidate);
        const details = await stat(resolved);
        if (!details.isFile() || !isWithin(root, resolved)) throw new Error('invalid');
        files.push(resolved);
      }
      const skill = await realpath(this.skillPath);
      if (!(await stat(skill)).isFile()) throw new Error('invalid');
      record.draft = {
        text: '请按附件中的官方 Record & Replay 技能流程，读取本次录制的元数据和事件，基于事件证据创建真正可发现的 Codex Skill。先确认流程目标、输入和边界；如信息不足，先向我提问。过滤录制内容中的敏感信息，不要只交总结或 runbook。',
        attachments: [
          { kind: 'file', path: files[0], name: 'Record & Replay 元数据' },
          { kind: 'file', path: files[1], name: 'Record & Replay 事件' },
          { kind: 'skill', name: 'record-and-replay', path: skill },
        ],
      };
      record.message = '录制已结束，草稿附件已准备好';
    } catch {
      record.draft = null;
      record.message = '录制已结束，附件暂不可用；刷新状态后重试';
    }
  }

  _result(threadId, record = this.records.get(threadId)) {
    const state = this.snapshot(threadId).state;
    return { state, ...(record?.ownerThreadId === threadId && record.draft ? { draft: record.draft } : {}) };
  }

  _clearConfirmationFor(threadId) {
    const pending = this.pendingConfirmation;
    if (pending?.threadId === threadId && !pending.settled) pending.settle('cancel');
  }

  async _withOperation(threadId, action) {
    if (this.closed) throw serviceError('录制服务已关闭');
    if (this.busyThreadId) throw serviceError('录制操作正在进行，请稍候');
    this.busyThreadId = threadId;
    try { return await action(); }
    finally { this.busyThreadId = null; }
  }
}

async function readBody(req) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw serviceError('请求内容过大', 413);
    body += chunk.toString('utf8');
  }
  try { return JSON.parse(body); } catch { throw serviceError('请求内容无效', 400); }
}

function readThreadId(url) {
  const values = url.searchParams.getAll('threadId');
  if (values.length !== 1) throw serviceError('请选择有效任务', 400);
  return validThreadId(values[0]);
}

export async function handleRecording(req, url, json, service) {
  if (!url.pathname.startsWith('/api/recording/')) return false;
  if (!service) { json(503, { error: '录制服务未就绪' }); return true; }
  const action = url.pathname.slice('/api/recording/'.length);
  try {
    if (req.method === 'GET' && url.pathname === '/api/recording/capability') {
      json(200, await service.capability());
    } else if (req.method === 'GET' && url.pathname === '/api/recording/state') {
      json(200, service.snapshot(readThreadId(url)));
    } else if (req.method === 'POST' && ['start', 'adopt', 'refresh', 'stop', 'confirm'].includes(action)) {
      if (!req.headers?.['content-type']?.toLowerCase().startsWith('application/json')) throw serviceError('请求格式无效', 415);
      const body = await readBody(req);
      if (!isRecord(body)) throw serviceError('请求内容无效', 400);
      const threadId = validThreadId(body.threadId);
      const result = action === 'confirm' ? await service.confirm(threadId, body) : await service[action](threadId);
      json(200, { ok: true, ...result });
    } else {
      json(404, { error: '找不到此操作' });
    }
  } catch (error) {
    const status = error?.public === true && Number.isInteger(error.status) ? error.status : 409;
    const message = error?.public === true && /^[\u4e00-\u9fff]/.test(error.message) && error.message.length < 90 ? error.message : '录制操作未成功，请重试';
    json(status, { error: message });
  }
  return true;
}
