(() => {
  'use strict';

  const PAGE_SIZE = 6;
  const FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'unfinished', label: '未完成' },
    { id: 'completed', label: '已完成' }
  ];
  const STATUS_LABELS = {
    completed: '✓ 已完成',
    running: '○ 进行中',
    in_progress: '○ 进行中',
    blocked: '待处理',
    failed: '失败',
    interrupted: '已暂停',
    pending: '待处理',
    idle: '待处理'
  };

  let trigger;
  let menu;
  let tabs;
  let list;
  let empty;
  let previousButton;
  let nextButton;
  let pageLabel;
  let threads = [];
  let activeId = '';
  let filter = 'all';
  let page = 0;
  let hasOpened = false;
  let initialized = false;

  function makeElement(tag, className, textContent) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textContent !== undefined) element.textContent = textContent;
    return element;
  }

  function compactText(value, limit) {
    const chars = Array.from(String(value || ''));
    return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
  }

  function statusKey(status) {
    return String(status || 'idle').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function isCompleted(thread) {
    return thread.status === 'completed';
  }

  function getFilteredThreads() {
    if (filter === 'completed') return threads.filter(isCompleted);
    if (filter === 'unfinished') return threads.filter(thread => !isCompleted(thread));
    return threads;
  }

  function getThreadId(thread) {
    return String(thread.id ?? '');
  }

  function getActiveThread() {
    return threads.find(thread => getThreadId(thread) === activeId);
  }

  function countValue(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function ensureElements() {
    trigger = document.getElementById('threads');
    menu = document.getElementById('task-picker-menu');
    if (!trigger || trigger.tagName !== 'BUTTON' || !menu) return false;

    if (!initialized) {
      menu.id = menu.id || 'task-picker-menu';
      menu.classList.add('picker-menu');
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-labelledby', 'threads');
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', menu.id);
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.add('picker-trigger');

      const label = makeElement('span', 'picker-trigger-label', '等待任务开始');
      const count = makeElement('span', 'picker-trigger-count', '0/0');
      const chevron = makeElement('span', 'picker-chevron', '▾');
      chevron.setAttribute('aria-hidden', 'true');
      trigger.replaceChildren(label, count, chevron);

      tabs = makeElement('div', 'picker-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', '任务分类');
      FILTERS.forEach(({ id, label: filterLabel }) => {
        const tab = makeElement('button', 'picker-tab', filterLabel);
        tab.type = 'button';
        tab.dataset.pickerFilter = id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', 'task-picker-list');
        tabs.append(tab);
      });

      list = makeElement('div', 'picker-list');
      list.id = 'task-picker-list';
      list.setAttribute('aria-label', '任务列表');
      empty = makeElement('p', 'picker-empty', '暂无任务');
      empty.hidden = true;

      const footer = makeElement('div', 'picker-footer');
      previousButton = makeElement('button', 'picker-page-button picker-prev', '上一页');
      previousButton.type = 'button';
      previousButton.dataset.pickerPage = 'previous';
      previousButton.setAttribute('aria-label', '上一页');
      pageLabel = makeElement('span', 'picker-page-indicator', '0 / 0');
      pageLabel.setAttribute('aria-live', 'polite');
      nextButton = makeElement('button', 'picker-page-button picker-next', '下一页');
      nextButton.type = 'button';
      nextButton.dataset.pickerPage = 'next';
      nextButton.setAttribute('aria-label', '下一页');
      footer.append(previousButton, pageLabel, nextButton);

      menu.replaceChildren(tabs, list, empty, footer);
      bindEvents();
      initialized = true;
    }
    return true;
  }

  function bindEvents() {
    trigger.addEventListener('click', () => {
      if (menu.hidden) openMenu(false);
      else closeMenu();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openMenu(true);
      }
    });

    menu.addEventListener('click', event => {
      const tab = event.target.closest('[data-picker-filter]');
      if (tab && menu.contains(tab)) {
        filter = tab.dataset.pickerFilter;
        page = 0;
        update();
        tab.focus({ preventScroll: true });
        return;
      }

      const pageButton = event.target.closest('[data-picker-page]');
      if (pageButton && menu.contains(pageButton)) {
        const pageCount = Math.ceil(getFilteredThreads().length / PAGE_SIZE);
        page += pageButton.dataset.pickerPage === 'next' ? 1 : -1;
        page = Math.max(0, Math.min(page, Math.max(0, pageCount - 1)));
        update();
        pageButton.focus({ preventScroll: true });
        return;
      }

      const row = event.target.closest('[data-thread-id]');
      if (row && list.contains(row)) selectThread(row.dataset.threadId);
    });

    menu.addEventListener('focusin', event => {
      const row = event.target.closest('[data-thread-id]');
      if (row && list.contains(row)) {
        list.querySelectorAll('[data-thread-id]').forEach(item => {
          item.tabIndex = item === row ? 0 : -1;
        });
      }
    });

    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }

      const tab = event.target.closest('[data-picker-filter]');
      if (tab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const index = FILTERS.findIndex(item => item.id === tab.dataset.pickerFilter);
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const target = tabs.children[(index + offset + FILTERS.length) % FILTERS.length];
        target.focus();
        target.click();
        return;
      }

      const row = event.target.closest('[data-thread-id]');
      if (row && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        moveRowFocus(row, event.key === 'ArrowDown' ? 1 : -1);
      }
    });

    document.addEventListener('click', event => {
      if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => {
      if (!menu.hidden && event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    });
  }

  function moveRowFocus(row, offset) {
    const rows = Array.from(list.querySelectorAll('[data-thread-id]'));
    const index = rows.indexOf(row);
    const nextIndex = index + offset;
    if (rows[nextIndex]) {
      rows[nextIndex].focus();
      return;
    }

    const pageCount = Math.ceil(getFilteredThreads().length / PAGE_SIZE);
    if ((offset > 0 && page + 1 >= pageCount) || (offset < 0 && page === 0)) return;
    page += offset;
    update({ rowIndex: offset > 0 ? 0 : PAGE_SIZE - 1 });
  }

  function openMenu(focusFirstRow) {
    if (menu.hidden && !hasOpened) {
      const visible = getFilteredThreads();
      const activeIndex = visible.findIndex(thread => getThreadId(thread) === activeId);
      page = activeIndex < 0 ? 0 : Math.floor(activeIndex / PAGE_SIZE);
      hasOpened = true;
    }
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    update();
    if (focusFirstRow) {
      const firstRow = list.querySelector('[data-thread-id]');
      (firstRow || tabs.querySelector('[role="tab"]'))?.focus({ preventScroll: true });
    }
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus({ preventScroll: true });
  }

  function selectThread(id) {
    trigger.value = id;
    activeId = id;
    closeMenu();
    trigger.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function update(focusHint) {
    const focused = !menu.hidden && menu.contains(document.activeElement) ? document.activeElement : null;
    const focusKind = focused?.dataset?.threadId ? { rowId: focused.dataset.threadId }
      : focused?.dataset?.pickerFilter ? { filterId: focused.dataset.pickerFilter }
        : focused?.dataset?.pickerPage ? { page: focused.dataset.pickerPage }
          : null;
    const active = getActiveThread();
    const label = trigger.querySelector('.picker-trigger-label');
    const count = trigger.querySelector('.picker-trigger-count');
    const status = active?.status || 'idle';
    const statusClass = `picker-status-${statusKey(status)}`;

    if (label) label.textContent = active ? compactText(active.goal, 30) || 'Codex 任务' : '等待任务开始';
    if (count) count.textContent = `${countValue(active?.completed)}/${countValue(active?.total)}`;
    if (label) label.className = `picker-trigger-label ${statusClass}`;
    trigger.value = activeId;
    trigger.dataset.status = status;

    const counts = {
      all: threads.length,
      unfinished: threads.filter(thread => !isCompleted(thread)).length,
      completed: threads.filter(isCompleted).length
    };
    tabs.querySelectorAll('[data-picker-filter]').forEach(tab => {
      const selected = tab.dataset.pickerFilter === filter;
      tab.textContent = `${FILTERS.find(item => item.id === tab.dataset.pickerFilter).label} ${counts[tab.dataset.pickerFilter]}`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    const filtered = getFilteredThreads();
    const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
    page = pageCount ? Math.max(0, Math.min(page, pageCount - 1)) : 0;
    const start = page * PAGE_SIZE;
    const visible = filtered.slice(start, start + PAGE_SIZE);
    previousButton.disabled = pageCount === 0 || page === 0;
    nextButton.disabled = pageCount === 0 || page >= pageCount - 1;
    pageLabel.textContent = `${pageCount ? page + 1 : 0} / ${pageCount}`;
    empty.hidden = filtered.length > 0;
    list.hidden = filtered.length === 0;
    list.replaceChildren();

    const hintedRow = focusHint && focusHint.rowIndex !== undefined ? visible[focusHint.rowIndex] : null;
    let rovingId = focusHint && focusHint.rowId ? focusHint.rowId : hintedRow ? getThreadId(hintedRow) : null;
    if (!visible.some(thread => getThreadId(thread) === rovingId)) {
      rovingId = visible.find(thread => getThreadId(thread) === activeId)?.id;
      if (rovingId !== undefined && rovingId !== null) rovingId = String(rovingId);
      if (rovingId === undefined || rovingId === null) rovingId = visible[0] ? getThreadId(visible[0]) : null;
    }

    visible.forEach(thread => {
      const id = getThreadId(thread);
      const row = makeElement('button', 'picker-row');
      row.type = 'button';
      row.dataset.threadId = id;
      row.dataset.status = thread.status || 'idle';
      row.tabIndex = id === rovingId ? 0 : -1;
      if (id === activeId) row.setAttribute('aria-current', 'true');

      const rowStatus = makeElement('span', `picker-row-status picker-status-${statusKey(thread.status)}`,
        STATUS_LABELS[thread.status] || '待处理');
      const title = makeElement('span', 'picker-row-title', compactText(thread.goal, 40) || 'Codex 任务');
      const rowCount = makeElement('span', 'picker-row-count',
        `${countValue(thread.completed)}/${countValue(thread.total)}`);
      row.append(rowStatus, title, rowCount);
      if(thread.control?.available){const input=makeElement('span','picker-input-badge','可输入');row.append(input);}
      row.title=thread.control?.available?'可在进度窗口继续这个任务':'仅查看进度';
      list.append(row);
    });

    if (focused) {
      let target = null;
      if (focusHint && focusHint.rowIndex !== undefined) {
        const hintedId = visible[focusHint.rowIndex] ? getThreadId(visible[focusHint.rowIndex]) : null;
        target = Array.from(list.children).find(row => row.dataset.threadId === hintedId);
      } else if (focusKind?.rowId) {
        target = Array.from(list.children).find(row => row.dataset.threadId === focusKind.rowId);
      } else if (focusKind?.filterId) {
        target = Array.from(tabs.children).find(tab => tab.dataset.pickerFilter === focusKind.filterId);
      } else if (focusKind?.page) {
        target = focusKind.page === 'previous' ? previousButton : nextButton;
      }
      if (!target && focusKind?.rowId) target = list.querySelector('[data-thread-id]');
      target?.focus({ preventScroll: true });
    }
  }

  function render(snapshot) {
    if (!ensureElements()) return;
    threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
    activeId = snapshot?.activeId == null ? '' : String(snapshot.activeId);
    update();
  }

  window.TaskPicker = { render };
})();
