(() => {
  const state = {
    id: null,
    count: 0,
    key: null,
    displayKey: null,
    cacheKey: null,
    cachedInputs: null,
    generation: 0,
    controller: null,
    activeKey: null
  };

  let boundDesc = null;
  let boundDialog = null;

  function elements() {
    return {
      desc: document.getElementById('desc'),
      dialog: document.getElementById('input-history'),
      close: document.getElementById('history-close'),
      list: document.getElementById('history-list'),
      empty: document.getElementById('history-empty')
    };
  }

  function cancelRequest() {
    state.generation += 1;
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.activeKey = null;
  }

  function showStatus(message) {
    const { list, empty } = elements();
    if (list) {
      list.replaceChildren();
      list.hidden = true;
    }
    if (empty) {
      empty.textContent = message;
      empty.hidden = false;
    }
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return { label: '时间未知', value: '' };
    return {
      label: new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(date),
      value: date.toISOString()
    };
  }

  function showInputs(inputs) {
    const { list, empty } = elements();
    if (!list || !empty) return;
    list.replaceChildren();
    if (!inputs.length) {
      list.hidden = true;
      empty.textContent = '还没有输入记录';
      empty.hidden = false;
      return;
    }

    const ordered = inputs.map((input, index) => {
      const parsed = new Date(input?.timestamp).getTime();
      return { input, index, time: Number.isFinite(parsed) ? parsed : null };
    }).sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
      if (a.time !== null && b.time === null) return -1;
      if (a.time === null && b.time !== null) return 1;
      return a.index - b.index;
    });

    for (const { input } of ordered) {
      const entry = document.createElement('li');
      entry.className = 'history-entry';
      const time = document.createElement('time');
      const formatted = formatTime(input?.timestamp);
      time.textContent = formatted.label;
      if (formatted.value) time.dateTime = formatted.value;
      const text = document.createElement('p');
      text.textContent = typeof input?.text === 'string' ? input.text : '';
      entry.append(time, text);
      list.append(entry);
    }

    empty.hidden = true;
    list.hidden = false;
  }

  function requestIsCurrent(generation, key) {
    const { dialog } = elements();
    return state.generation === generation && state.key === key && Boolean(dialog?.open);
  }

  async function loadInputs(key, id) {
    cancelRequest();
    const controller = new AbortController();
    const generation = ++state.generation;
    state.controller = controller;
    state.activeKey = key;
    showStatus('正在读取输入记录');

    try {
      const response = await fetch(`/api/inputs?threadId=${encodeURIComponent(id)}`, {
        signal: controller.signal
      });
      if (!response.ok) throw new Error('request failed');
      const result = await response.json();
      if (!Array.isArray(result?.inputs)) throw new Error('invalid response');
      if (!requestIsCurrent(generation, key)) return;

      state.controller = null;
      state.activeKey = null;
      state.cacheKey = key;
      state.cachedInputs = result.inputs;
      showInputs(result.inputs);
    } catch {
      if (!requestIsCurrent(generation, key)) return;
      state.controller = null;
      state.activeKey = null;
      showStatus('暂时无法读取，请稍后重试');
    }
  }

  function refreshOpenDialog(force = false) {
    const { dialog } = elements();
    if (!dialog?.open) return;
    if (!force && state.displayKey === state.key) return;
    state.displayKey = state.key;

    if (!state.id || !state.count) {
      cancelRequest();
      showStatus('还没有输入记录');
      return;
    }
    if (state.cacheKey === state.key && state.cachedInputs) {
      showInputs(state.cachedInputs);
      return;
    }
    if (state.activeKey === state.key && state.controller) return;
    loadInputs(state.key, state.id);
  }

  function openHistory() {
    const { dialog } = elements();
    if (!dialog || !state.id || !state.count) return;
    if (!dialog.open) dialog.showModal();
    refreshOpenDialog(true);
  }

  function bind() {
    const { desc, dialog, close } = elements();
    if (!desc || !dialog) return;
    if (boundDesc === desc && boundDialog === dialog) return;
    boundDesc = desc;
    boundDialog = dialog;
    desc.addEventListener('click', openHistory);
    close?.addEventListener('click', () => {
      if (dialog.open) dialog.close();
    });
    dialog.addEventListener('close', () => {
      cancelRequest();
      state.displayKey = null;
    });
  }

  function render(thread) {
    bind();
    const { desc } = elements();
    const id = thread?.id == null || String(thread.id) === '' ? null : String(thread.id);
    const rawCount = Number(thread?.inputCount);
    const count = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0;
    const key = id ? JSON.stringify([id, count]) : null;

    if (desc) {
      desc.textContent = typeof thread?.desc === 'string' && thread.desc ? thread.desc : '尚无输入';
      desc.disabled = !id || count === 0;
      desc.setAttribute('aria-label', '查看输入记录');
      desc.removeAttribute('title');
    }

    if (state.key !== key) {
      const idChanged = state.id !== id;
      state.id = id;
      state.count = count;
      state.key = key;
      state.displayKey = null;
      state.cacheKey = null;
      state.cachedInputs = null;
      if (idChanged) cancelRequest();
    } else {
      state.id = id;
      state.count = count;
    }

    refreshOpenDialog();
  }

  window.InputHistory = { render };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
