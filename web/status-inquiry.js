(() => {
  const $ = id => document.getElementById(id);
  const MAX_QUESTION_LENGTH = 4000;
  const POLL_INTERVAL = 1200;
  const dialog = $('status-inquiry-dialog');
  let thread = null;
  let session = null;
  let available = null;
  let loading = false;
  let sending = false;
  let loadError = '';
  let pollError = '';
  let pollTimer = 0;
  let requestVersion = 0;
  let renderedMessagesKey = null;

  function clearPoll() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function requestIsCurrent(id, version) {
    return dialog.open && thread?.id === id && requestVersion === version;
  }

  function localError(error, operation) {
    const message = typeof error === 'string' ? error : error?.message;
    if (message && /[\u3400-\u9fff]/u.test(message)) return message.slice(0, 280);
    return operation === 'send' ? '问题暂时未发送，请稍后重试。' : '状态记录暂时无法读取，请稍后重试。';
  }

  function readTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function addMessage(message) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const article = document.createElement('article');
    article.className = 'status-message';
    article.dataset.role = role;

    const meta = document.createElement('div');
    meta.className = 'status-message-meta';
    const label = document.createElement('strong');
    label.className = 'status-message-role';
    label.textContent = role === 'assistant' ? '状态问询' : '你';
    meta.append(label);

    const createdAt = readTime(message.createdAt);
    if (createdAt) {
      const time = document.createElement('time');
      time.textContent = createdAt;
      if (typeof message.createdAt === 'string') time.dateTime = message.createdAt;
      meta.append(time);
    }
    article.append(meta);

    const content = document.createElement('p');
    content.className = 'status-message-content';
    content.textContent = typeof message.text === 'string' ? message.text : '';
    article.append(content);

    const evidenceAt = role === 'assistant' ? readTime(message.evidenceAt) : '';
    if (evidenceAt) {
      const evidence = document.createElement('small');
      evidence.className = 'status-message-evidence';
      evidence.textContent = `依据日志 · 截至 ${evidenceAt}`;
      article.append(evidence);
    }
    $('status-inquiry-messages').append(article);
  }

  function renderMessages() {
    const list = $('status-inquiry-messages');
    const messages = session?.messages || [];
    const key = JSON.stringify(messages);
    if (key === renderedMessagesKey) return;
    const pinnedToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
    list.replaceChildren();
    for (const message of messages) addMessage(message);
    renderedMessagesKey = key;
    if (pinnedToBottom) list.scrollTop = list.scrollHeight;
  }

  function renderView() {
    const target = $('status-inquiry-target');
    target.textContent = thread?.goal || '当前任务';
    target.title = thread?.goal || '';
    renderMessages();

    const state = $('status-inquiry-state-text');
    const retry = $('status-inquiry-retry');
    let stateMessage = '';
    let canRetry = false;
    if (loading) stateMessage = '正在读取历史问答…';
    else if (loadError) {
      stateMessage = loadError;
      canRetry = true;
    } else if (available === false) {
      stateMessage = '当前任务暂不可用状态问询。';
      canRetry = true;
    } else if (pollError && session?.busy) {
      stateMessage = '暂时无法更新，正在重试。';
      canRetry = true;
    } else if (session?.error) {
      stateMessage = localError(session.error, 'read');
      canRetry = true;
    }
    else if (session?.busy) stateMessage = '正在检查任务日志…';
    else if (!(session?.messages?.length)) stateMessage = '还没有问答。';

    state.textContent = stateMessage;
    state.parentElement.hidden = !stateMessage;
    retry.hidden = !canRetry;

    const question = $('status-inquiry-question');
    const ready = !!thread?.id && available === true && !loading && !sending && !session?.busy;
    question.disabled = !ready;
    $('status-inquiry-send').disabled = !ready || !question.value.trim() || question.value.length > MAX_QUESTION_LENGTH;
    $('status-inquiry-count').textContent = `${question.value.length} / ${MAX_QUESTION_LENGTH}`;
  }

  async function jsonResponse(response, operation) {
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) throw Error(result.error || localError(null, operation));
    return result;
  }

  function acceptSession(result, id) {
    available = result.available === true;
    const next = result.session;
    session = next && next.threadId === id ? next : null;
  }

  function schedulePoll(id, version) {
    clearPoll();
    if (!dialog.open || !session?.busy) return;
    pollTimer = window.setTimeout(() => poll(id, version), POLL_INTERVAL);
  }

  async function load(id) {
    const version = ++requestVersion;
    clearPoll();
    session = null;
    available = null;
    renderedMessagesKey = null;
    loading = true;
    sending = false;
    loadError = '';
    pollError = '';
    renderView();
    try {
      const response = await fetch(`/api/inquiry?threadId=${encodeURIComponent(id)}`);
      const result = await jsonResponse(response, 'read');
      if (!requestIsCurrent(id, version)) return;
      acceptSession(result, id);
      loading = false;
      renderView();
      if (session?.busy) schedulePoll(id, version);
      else if (available && document.activeElement === $('status-inquiry-close')) $('status-inquiry-question').focus();
    } catch (error) {
      if (!requestIsCurrent(id, version)) return;
      loading = false;
      available = false;
      loadError = localError(error, 'read');
      renderView();
    }
  }

  async function poll(id, version) {
    if (!requestIsCurrent(id, version)) return;
    try {
      const response = await fetch(`/api/inquiry?threadId=${encodeURIComponent(id)}`);
      const result = await jsonResponse(response, 'read');
      if (!requestIsCurrent(id, version)) return;
      acceptSession(result, id);
      pollError = '';
      renderView();
      if (session?.busy) schedulePoll(id, version);
    } catch {
      if (!requestIsCurrent(id, version)) return;
      pollError = 'retry';
      renderView();
      schedulePoll(id, version);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const question = $('status-inquiry-question').value.trim();
    const id = thread?.id;
    if (!id || !question || question.length > MAX_QUESTION_LENGTH || available !== true || sending || session?.busy) return;
    const version = requestVersion;
    sending = true;
    renderView();
    try {
      const response = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: id, question })
      });
      const result = await jsonResponse(response, 'send');
      if (!requestIsCurrent(id, version)) return;
      if (!result.session || result.session.threadId !== id) throw Error('状态问询暂时无法读取，请稍后重试。');
      session = result.session;
      available = true;
      sending = false;
      loadError = '';
      pollError = '';
      $('status-inquiry-question').value = '';
      renderView();
      if (session.busy) schedulePoll(id, version);
      $('status-inquiry-question').focus();
    } catch (error) {
      if (!requestIsCurrent(id, version)) return;
      sending = false;
      loadError = localError(error, 'send');
      renderView();
      $('status-inquiry-question').focus();
    }
  }

  $('status-inquiry-toggle').addEventListener('click', () => {
    if (!thread?.id) return;
    renderView();
    dialog.showModal();
    $('status-inquiry-close').focus();
    load(thread.id);
  });
  $('status-inquiry-close').addEventListener('click', () => dialog.close());
  $('status-inquiry-retry').addEventListener('click', () => { if (thread?.id) load(thread.id); });
  $('status-inquiry-form').addEventListener('submit', submit);
  $('status-inquiry-question').addEventListener('input', renderView);
  $('status-inquiry-question').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!$('status-inquiry-send').disabled) $('status-inquiry-form').requestSubmit();
    }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    requestVersion++;
    clearPoll();
    loading = false;
    sending = false;
    pollError = '';
    const opener = $('status-inquiry-toggle');
    if (!opener.disabled) opener.focus();
  });

  function render(next) {
    const changed = thread?.id !== next?.id;
    thread = next || null;
    $('status-inquiry-toggle').disabled = !thread?.id;
    if (changed) {
      requestVersion++;
      clearPoll();
      session = null;
      available = null;
      renderedMessagesKey = null;
      loading = false;
      sending = false;
      loadError = '';
      pollError = '';
      $('status-inquiry-question').value = '';
      if (dialog.open && thread?.id) load(thread.id);
    }
    renderView();
  }

  window.StatusInquiry = { render };
})();
