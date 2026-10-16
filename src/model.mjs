export const taskStatuses = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed']);
const goalStatuses = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const redactSecrets = s => s
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
  .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s<>"']+/gi, 'Authorization: Bearer [REDACTED]');
const clean = (s, n = 1800) => typeof s === 'string' ? redactSecrets(s.replace(/\u0000/g, '')).slice(0, n) : '';
const cleanText = (s, n = 1800) => {
  if (typeof s !== 'string') return '';
  return redactSecrets(s.replace(/\u0000/g, '')
    .replace(/<(image|attachment|file|audio|video)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:image|attachment|file|audio|video)\b[^>]*\/\s*>/gi, '')
    .replace(/(?:^|\n)[\t ]*\[Image\s*#\d*\][\t ]*(?=\n|$)/gi, '')
    .replace(/\[Image\s*#\d*\]/gi, '')
    .replace(/\r\n?/g, '\n'))
    .split('\n').map(line => line.replace(/[\t ]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, n).trim();
};
const cleanGoal = s => cleanText(s);
const isAutomaticTaskId = id => /^step-\d+$/.test(id);
const taskIdentity = task => JSON.stringify(isAutomaticTaskId(task.id) ? [task.id, task.title] : [task.id]);
const taskShape = tasks => JSON.stringify(tasks.map(taskIdentity).sort());
const sameTaskIdentitySet = (left, right) => {
  const leftIds = left.map(taskIdentity).sort(), rightIds = right.map(taskIdentity).sort();
  return leftIds.length === rightIds.length && leftIds.every((identity, index) => identity === rightIds[index]);
};
const sameNamedTaskSet = (left, right) => {
  const namedIds = tasks => tasks.filter(task => !isAutomaticTaskId(task.id)).map(task => task.id).sort();
  const leftIds = namedIds(left), rightIds = namedIds(right);
  return leftIds.length > 0 && leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index])
    && sameTaskIdentitySet(left.filter(task => isAutomaticTaskId(task.id)), right.filter(task => isAutomaticTaskId(task.id)));
};

function mergeStageTasks(previous, incoming) {
  const oldByIdentity = new Map(previous.map(task => [taskIdentity(task), task]));
  const incomingIdentities = new Set(incoming.map(taskIdentity));
  const merged = incoming.map(task => {
    const old = oldByIdentity.get(taskIdentity(task));
    return {
      ...task,
      status: old?.status === 'completed' ? 'completed' : task.status,
      detail: task.detail || old?.detail || ''
    };
  });
  for (const task of previous) {
    if (task.status === 'completed' && !incomingIdentities.has(taskIdentity(task))) merged.push({ ...task });
  }
  return merged;
}

export class ProgressModel {
  constructor() {
    this.threads = new Map(); this.inputHistory = new Map(); this.inputKeys = new Map();
    this.activeId = null; this.pinnedId = null; this.revision = 0; this.sequence = 0; this.inputSequence = 0;
  }
  ensure(id) {
    if (!this.threads.has(id)) this.threads.set(id, {
      id, turnId: '', goal: '', goalSource: null, goalStatus: null,
      threadGoal: '', threadGoalSource: null, planGoal: '', desc: '', descTimestamp: 0, inputCount: 0,
      status: 'idle', tasks: [], taskGroups: [], currentTaskGroupId: null,
      currentTaskGroupShape: null, explicit: false, updatedAt: Date.now(), startedAt: 0
    });
    return this.threads.get(id);
  }
  touch(t) { t.updatedAt = Date.now(); this.revision++; }
  start(id, turnId, timestamp = Date.now()) {
    const t = this.ensure(id);
    if (t.turnId === turnId && t.status === 'running') return;
    Object.assign(t, { turnId, status: 'running', tasks: [{ id: 'overall', title: '完成本次任务', status: 'in_progress', detail: '' }], currentTaskGroupId: null, currentTaskGroupShape: null, explicit: false, startedAt: timestamp, startOrder: ++this.sequence });
    t.planGoal = '';
    this.refreshGoal(t);
    if (!this.pinnedId && (!this.activeId || timestamp >= this.ensure(this.activeId).startedAt)) this.activeId = id;
    this.touch(t);
  }
  refreshGoal(t) {
    const next = t.threadGoal || t.planGoal || t.desc;
    const source = t.threadGoal ? t.threadGoalSource : t.planGoal ? 'plan' : t.desc ? 'input' : null;
    if (t.goal === next && t.goalSource === source) return false;
    t.goal = next;
    t.goalSource = source;
    if (!t.explicit && t.tasks[0] && next) t.tasks[0].title = clean(next, 500);
    return true;
  }
  setThreadGoal(id, goal, status, source = 'goal_api') {
    const hasObjective = typeof goal === 'string';
    if (!hasObjective && !goalStatuses.has(status)) return;
    const t = this.ensure(id), next = hasObjective ? cleanGoal(goal) : t.threadGoal;
    let changed = false;
    if (hasObjective && t.threadGoal !== next) {
      t.threadGoal = next;
      t.threadGoalSource = next ? source : null;
      t.goalStatus = goalStatuses.has(status) ? status : null;
      changed = true;
    } else if (hasObjective && next && t.threadGoalSource !== source) {
      t.threadGoalSource = source;
      changed = true;
    }
    if (goalStatuses.has(status) && t.goalStatus !== status) { t.goalStatus = status; changed = true; }
    if (this.refreshGoal(t)) changed = true;
    if (!changed) return;
    this.touch(t);
  }
  // Keep the original API as the explicit thread-goal setter.
  goal(id, goal) { this.setThreadGoal(id, goal, undefined, 'legacy_api'); }
  addInput(id, text, timestamp = Date.now(), turnId = '', source = '') {
    const value = cleanText(text, Infinity);
    if (!value) return false;
    const t = this.ensure(id);
    const currentTurn = typeof turnId === 'string' ? clean(turnId, 120) : '';
    const fingerprint = value.replace(/\s+/g, ' ').trim();
    const time = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.parse(timestamp) || Date.now();
    if (source && currentTurn) {
      let keys = this.inputKeys.get(id);
      if (!keys) { keys = new Map(); this.inputKeys.set(id, keys); }
      const key = `${currentTurn}\u0000${fingerprint}`, pending = keys.get(key) || [];
      const duplicate = pending.findIndex(item => item.source !== source && Math.abs(item.time - time) < 2000);
      if (duplicate >= 0) { pending.splice(duplicate, 1); return false; }
      pending.push({ source, time }); keys.set(key, pending);
    }
    const order = ++this.inputSequence;
    const item = { id: `input-${order}`, text: value, timestamp: time, turnId: currentTurn, order };
    const history = this.inputHistory.get(id) || [];
    history.push(item);
    this.inputHistory.set(id, history);
    t.inputCount = history.length;
    if (time >= t.descTimestamp) { t.desc = value.slice(0, 1800); t.descTimestamp = time; }
    this.refreshGoal(t);
    this.touch(t);
    return true;
  }
  inputs(id) {
    return (this.inputHistory.get(id) || []).slice().sort((a,b)=>a.timestamp-b.timestamp || a.order-b.order)
      .map(({ id: inputId, text, timestamp }) => ({ id: inputId, text, timestamp }));
  }
  plan(id, tasks, goal, turnId, timestamp = Date.now()) {
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 500) throw Error('任务列表须包含 1–500 项');
    const t = this.ensure(id);
    if (turnId && t.turnId && t.turnId !== turnId) return;
    const ids = new Set();
    const next = tasks.map((task, i) => {
      const title = clean(task.title ?? task.step, 500), taskId = clean(task.id || `step-${i + 1}`, 120);
      if (!title || ids.has(taskId) || !taskStatuses.has(task.status ?? 'pending')) throw Error('任务标题、标识或状态无效');
      ids.add(taskId);
      return { id: taskId, title, status: task.status ?? 'pending', detail: clean(task.detail, 1000) };
    });
    if (goal) t.planGoal = cleanGoal(goal);
    this.refreshGoal(t);
    const shape = taskShape(next);
    const createdAt = typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? timestamp
      : typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : Date.now();
    const currentGroup = t.taskGroups.find(group => group.id === t.currentTaskGroupId);
    const previousGroup = currentGroup || t.taskGroups.at(-1);
    const previousShape = currentGroup ? t.currentTaskGroupShape : previousGroup ? taskShape(previousGroup.tasks) : null;
    const previousComplete = previousGroup?.tasks.every(task => task.status === 'completed') === true;
    const previousIdentities = new Set(previousGroup?.tasks.map(taskIdentity) || []);
    const overlapsPrevious = next.some(task => previousIdentities.has(taskIdentity(task)));
    const startsNewGroup = previousGroup && shape !== previousShape
      && (currentGroup ? previousComplete : previousComplete || !overlapsPrevious);
    if (previousGroup && !startsNewGroup) {
      const merged = mergeStageTasks(previousGroup.tasks, next);
      previousGroup.tasks = merged;
      t.currentTaskGroupId = previousGroup.id;
      t.currentTaskGroupShape = taskShape(merged);
      t.tasks = merged;
    } else {
      const existingGroupIds = new Set(t.taskGroups.map(group => group.id));
      let groupNumber = t.taskGroups.length + 1;
      while (existingGroupIds.has(`phase-${groupNumber}`)) groupNumber++;
      const group = {
        id: `phase-${groupNumber}`,
        createdAt,
        title: `阶段 ${t.taskGroups.length + 1}`,
        tasks: next
      };
      const insertionIndex = t.taskGroups.findIndex(item => item.createdAt > createdAt);
      if (insertionIndex < 0) t.taskGroups.push(group);
      else t.taskGroups.splice(insertionIndex, 0, group);
      t.taskGroups.forEach((item, index) => { item.title = `阶段 ${index + 1}`; });
      t.currentTaskGroupId = group.id;
      t.currentTaskGroupShape = taskShape(next);
      t.tasks = next;
    }
    t.explicit = true; t.status = 'running';
    this.touch(t);
  }
  update(id, taskId, status, detail) {
    const t = this.ensure(id), task = t.tasks.find(x => x.id === taskId);
    if (!task || !taskStatuses.has(status)) throw Error('找不到任务或状态无效');
    task.status = status;
    if (detail !== undefined) task.detail = clean(detail, 1000);
    t.status = t.tasks.some(x => x.status === 'failed') ? 'failed' : t.tasks.some(x => x.status === 'blocked') ? 'blocked' : 'running';
    this.touch(t);
  }
  restoreTaskGroups(id, groups, currentTaskGroupId = null) {
    if (!Array.isArray(groups) || groups.length > 5000) throw Error('阶段历史无效');
    const groupIds = new Set();
    const restored = groups.map((group, index) => {
      const groupId = clean(group?.id, 120);
      const createdAt = typeof group?.createdAt === 'number' && Number.isFinite(group.createdAt)
        ? group.createdAt
        : typeof group?.createdAt === 'string' && Number.isFinite(Date.parse(group.createdAt)) ? Date.parse(group.createdAt) : null;
      if (!groupId || groupIds.has(groupId) || createdAt === null || !Array.isArray(group?.tasks) || !group.tasks.length || group.tasks.length > 500) {
        throw Error('阶段历史无效');
      }
      groupIds.add(groupId);
      const taskIds = new Set();
      const tasks = group.tasks.map((task, taskIndex) => {
        const taskId = clean(task?.id || `step-${taskIndex + 1}`, 120);
        const title = clean(task?.title ?? task?.step, 500);
        const status = task?.status ?? 'pending';
        if (!taskId || !title || taskIds.has(taskId) || !taskStatuses.has(status)) throw Error('阶段任务无效');
        taskIds.add(taskId);
        return { id: taskId, title, status, detail: clean(task?.detail, 1000) };
      });
      return {
        id: groupId, createdAt, title: clean(group?.title, 500) || `阶段 ${index + 1}`,
        tasks, order: index
      };
    }).sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
    if (currentTaskGroupId !== null && currentTaskGroupId !== '' && typeof currentTaskGroupId !== 'string') {
      throw Error('当前阶段引用无效');
    }
    const currentId = currentTaskGroupId === null || currentTaskGroupId === '' ? null : clean(currentTaskGroupId, 120);
    if (currentId && !restored.some(group => group.id === currentId)) throw Error('当前阶段不在历史记录中');
    if (currentTaskGroupId && !currentId) throw Error('当前阶段引用无效');

    const mergedGroupIds = new Map(), normalized = [];
    for (const group of restored) {
      const previous = normalized.at(-1);
      if (previous && !previous.tasks.every(task => task.status === 'completed') && sameNamedTaskSet(previous.tasks, group.tasks)) {
        previous.tasks = mergeStageTasks(previous.tasks, group.tasks);
        mergedGroupIds.set(group.id, previous.id);
      } else normalized.push(group);
    }
    if (normalized.length !== restored.length) {
      normalized.forEach((group, index) => {
        if (/^阶段 \d+$/.test(group.title)) group.title = `阶段 ${index + 1}`;
      });
    }

    const t = this.ensure(id);
    t.taskGroups = normalized.map(({ order, ...group }) => group);
    t.currentTaskGroupId = currentId ? mergedGroupIds.get(currentId) || currentId : null;
    const current = t.currentTaskGroupId ? t.taskGroups.find(group => group.id === t.currentTaskGroupId) : null;
    t.currentTaskGroupShape = current ? taskShape(current.tasks) : null;
    if (current) { t.tasks = current.tasks; t.explicit = true; }
    this.touch(t);
  }
  end(id, status = 'completed', strict = false, timestamp = Date.now()) {
    const t = this.ensure(id);
    if (strict && t.tasks.some(x => x.status !== 'completed')) throw Error('仍有未完成任务，不能标记全部完成');
    if (status === 'completed' && !t.explicit) t.tasks.forEach(x => x.status = 'completed');
    t.status = status === 'completed' && t.tasks.some(x => x.status !== 'completed') ? 'blocked' : status;
    this.touch(t);
    t.updatedAt = timestamp;
  }
  select(id) { if (id !== null && !this.threads.has(id)) throw Error('找不到会话'); this.pinnedId = id; this.activeId = id ?? [...this.threads.values()].sort((a,b)=>b.startedAt-a.startedAt || b.startOrder-a.startOrder)[0]?.id ?? null; this.revision++; }
  snapshot() {
    const threads = [...this.threads.values()].sort((a,b)=>b.startedAt-a.startedAt || b.startOrder-a.startOrder).map(t=>({
      id: t.id, turnId: t.turnId, goal: t.goal, goalObjective: t.threadGoal || null,
      goalSource: t.goalSource, goalStatus: t.goalStatus, desc: t.desc, inputCount: t.inputCount,
      status: t.status, tasks: t.tasks.map(task => ({ ...task })),
      taskGroups: t.taskGroups.map(group => ({
        id: group.id, createdAt: group.createdAt, title: group.title,
        tasks: group.tasks.map(task => ({ ...task }))
      })), currentTaskGroupId: t.currentTaskGroupId, explicit: t.explicit,
      updatedAt: t.updatedAt, startedAt: t.startedAt, startOrder: t.startOrder,
      completed: t.taskGroups.reduce((sum, group) => sum + group.tasks.filter(task => task.status === 'completed').length, 0)
        + (t.currentTaskGroupId ? 0 : t.tasks.filter(task => task.status === 'completed').length),
      total: t.taskGroups.reduce((sum, group) => sum + group.tasks.length, 0)
        + (t.currentTaskGroupId ? 0 : t.tasks.length)
    }));
    return { activeId: this.activeId, pinnedId: this.pinnedId, threads, revision: this.revision };
  }
  event(e) {
    if (!e || typeof e.threadId !== 'string' || e.threadId.length > 120) throw Error('缺少会话标识');
    const id=e.threadId;
    if(e.turnId && this.threads.has(id) && this.ensure(id).turnId !== e.turnId) throw Error('这项进度属于已结束的上一轮');
    if (e.kind === 'plan') this.plan(id, e.tasks, e.goal, e.turnId, e.timestamp);
    else if (e.kind === 'update') this.update(id, e.taskId, e.status, e.detail);
    else if (e.kind === 'finish') this.end(id, 'completed', true);
    else if (e.kind === 'status' && ['running','blocked','failed','interrupted'].includes(e.status)) { const t=this.ensure(id); t.status=e.status; this.touch(t); }
    else throw Error('不支持的进度事件');
    if (!this.activeId) this.activeId=id;
  }
}
