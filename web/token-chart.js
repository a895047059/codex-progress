(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const states = new Map();
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const smallNumberFormat = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 3 });
  const millionsFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
  let section = null;
  let svg = null;
  let visual = null;
  let tooltip = null;
  let readout = null;
  let empty = null;
  let totalValue = null;
  let consumptionRateValue = null;
  let outputRateValue = null;
  let currentThread = null;
  let currentThreadId = null;
  let points = [];
  let geometry = null;
  let activeIndex = -1;
  let focused = false;
  let hovering = false;
  let pinned = false;
  let resizeObserver = null;
  let trendWindowMs = 60_000;

  function windowLabel() {
    const minutes = Math.round(trendWindowMs / 60_000);
    return minutes >= 60 ? `${numberFormat.format(minutes / 60)} 小时` : `${minutes} 分钟`;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function svgNode(tag, className) {
    const element = document.createElementNS(SVG_NS, tag);
    if (className) element.setAttribute('class', className);
    return element;
  }

  function finiteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function formatMillions(value) {
    const tokens = finiteNonNegative(value);
    return tokens === null ? '— M' : `${millionsFormat.format(tokens / 1_000_000)} M`;
  }

  function formatRate(value) {
    const rate = finiteNonNegative(value);
    return rate === null ? '— tok/s' : `${numberFormat.format(rate)} tok/s`;
  }

  function formatAxis(value) {
    return smallNumberFormat.format(value);
  }

  function formatTime(at, includeDate = false, includeSeconds = true) {
    const date = new Date(at);
    const options = includeDate
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit', ...(includeSeconds ? { second: '2-digit' } : {}) };
    return new Intl.DateTimeFormat('zh-CN', options).format(date);
  }

  function formatFullTime(at) {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(at));
  }

  function setTooltipVisible(visible) {
    if (!tooltip) return;
    tooltip.hidden = !visible;
  }

  function ensureDom() {
    if (!section) section = document.getElementById('token-chart');
    if (!section) return false;
    if (section.dataset.tokenChartReady === 'true') return true;

    section.classList.add('token-chart');
    const head = node('div', 'tc-head');
    const totalSeries = node('div', 'tc-series tc-summary');
    totalSeries.setAttribute('aria-label', '累计 Token 消耗，单位 M');
    totalSeries.append(node('span', 'tc-name', '累计'));
    totalValue = node('strong', 'tc-value', '— M');
    totalSeries.append(totalValue);

    const consumptionSeries = node('div', 'tc-series tc-consumption');
    consumptionSeries.setAttribute('aria-label', '近一段时间的总 Token 平均消耗速率，单位 tok/s');
    consumptionSeries.append(node('i', 'tc-swatch'), node('span', 'tc-name', '消耗均速'));
    consumptionRateValue = node('strong', 'tc-value', '— tok/s');
    consumptionSeries.append(consumptionRateValue);

    const rateSeries = node('div', 'tc-series tc-rate');
    rateSeries.setAttribute('aria-label', '近一段时间的输出 Token 平均速率，单位 tok/s，包含等待时间');
    rateSeries.title = '最近一段时间的平均输出速率，包含工具和等待时间。';
    rateSeries.append(node('i', 'tc-swatch'), node('span', 'tc-name', '输出均速'));
    outputRateValue = node('strong', 'tc-value', '— tok/s');
    rateSeries.append(outputRateValue);
    head.append(totalSeries, consumptionSeries, rateSeries);

    visual = node('div', 'tc-visual');
    svg = svgNode('svg', 'tc-svg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-describedby', 'token-chart-readout');
    svg.setAttribute('aria-label', '总 Token 平均消耗速率与输出 Token 平均速率双纵轴曲线图，单位 tok/s，包含工具和等待时间。');
    tooltip = node('div', 'tc-tooltip');
    tooltip.id = 'token-chart-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    readout = node('span', 'tc-sr-only');
    readout.id = 'token-chart-readout';
    readout.setAttribute('aria-live', 'off');
    empty = node('div', 'tc-empty', '暂无 Token 记录');
    empty.hidden = true;
    visual.append(svg, tooltip, empty);
    section.replaceChildren(head, visual, readout);
    section.dataset.tokenChartReady = 'true';

    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerleave', () => {
      hovering = false;
      if (!focused && !pinned) {
        clearCursor();
        setTooltipVisible(false);
      }
    });
    svg.addEventListener('focus', () => {
      focused = true;
      readout.setAttribute('aria-live', 'polite');
      if (!points.length) return;
      if (activeIndex < 0) activeIndex = points.length - 1;
      showActivePoint();
    });
    svg.addEventListener('blur', () => {
      focused = false;
      readout.setAttribute('aria-live', 'off');
      if (!pinned && !hovering) {
        clearCursor();
        setTooltipVisible(false);
      }
    });
    svg.addEventListener('keydown', onKeyDown);
    svg.addEventListener('click', () => {
      if (!points.length) return;
      if (activeIndex < 0) activeIndex = points.length - 1;
      pinned = !pinned;
      saveSelection();
      if (pinned) showActivePoint();
      else if (!focused && !hovering) {
        clearCursor();
        setTooltipVisible(false);
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (currentThread) draw();
      });
      resizeObserver.observe(section);
    }
    return true;
  }

  function normalizePoints(metrics) {
    if (!metrics || metrics.available !== true || !Array.isArray(metrics.points)) return [];
    const source = metrics.points
      .map((point, index) => {
        if (!point || typeof point.at !== 'number' || !Number.isFinite(point.at)) return null;
        const totalTokens = finiteNonNegative(point.totalTokens);
        const outputTokens = finiteNonNegative(point.outputTokens);
        if (totalTokens === null && outputTokens === null) return null;
        return { at: point.at, totalTokens, outputTokens, estimated: point.estimated === true, sourceIndex: index };
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at || a.sourceIndex - b.sourceIndex);
    const width = visual?.clientWidth || section?.clientWidth || 320;
    const trend = window.TokenTrend.build(source, { maxPoints: Math.max(24, Math.min(64, Math.floor((width - 67) / 9))) });
    trendWindowMs = trend.windowMs;
    return trend.points;
  }

  function svgText(x, y, text, className, anchor) {
    const element = svgNode('text', className);
    element.setAttribute('x', String(x));
    element.setAttribute('y', String(y));
    if (anchor) element.setAttribute('text-anchor', anchor);
    element.textContent = text;
    return element;
  }

  function addLine(x1, y1, x2, y2, className) {
    const line = svgNode('line', className);
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    svg.append(line);
    return line;
  }

  function xFor(point, index, width, left, right) {
    if (points.length < 2) return (left + right) / 2;
    const first = points[0].at;
    const last = points[points.length - 1].at;
    if (last === first) return (left + right) / 2;
    return left + ((point.at - first) / (last - first)) * (right - left);
  }

  function yFor(value, max, top, bottom) {
    return bottom - (value / (max || 1)) * (bottom - top);
  }

  function addSeries(className, key, max, top, bottom, left, right, width) {
    const coords = points.map((point, index) => {
      const value = point[key];
      if (value === null) return null;
      const x = xFor(point, index, width, left, right);
      const y = yFor(value, max, top, bottom);
      return { x, y };
    });
    const path = window.TokenTrend.path(coords);
    if (!path) return;
    const line = svgNode('path', `tc-line ${className}`);
    line.setAttribute('d', path);
    svg.append(line);
    if (points.length === 1 && coords[0]) {
      const dot = svgNode('circle', `tc-dot ${className}`);
      dot.setAttribute('cx', String(coords[0].x));
      dot.setAttribute('cy', String(coords[0].y));
      dot.setAttribute('r', '1.35');
      svg.append(dot);
    }
  }

  function geometryFor(width) {
    const left = 31;
    const right = width - 36;
    const top = 4;
    const bottom = 34;
    const maxTotalRate = points.reduce((max, point) => Math.max(max, point.totalRate || 0), 0);
    const maxOutputRate = points.reduce((max, point) => Math.max(max, point.outputRate || 0), 0);
    return { width, height: 48, left, right, top, bottom, maxTotalRate, maxOutputRate };
  }

  function draw() {
    if (!svg || !visual) return;
    const metrics = currentThread?.metrics;
    const isAvailable = metrics?.available === true;
    const rawTotal = isAvailable ? finiteNonNegative(metrics.totalTokens) : null;
    points = normalizePoints(metrics);
    const latest = points.at(-1);
    const rawTotalRate = latest?.totalRate ?? null;
    const rawOutputRate = latest?.outputRate ?? null;
    section.querySelector('.tc-rate').title = `最近 ${windowLabel()} 的平均输出速率，包含工具和等待时间。`;
    section.querySelector('.tc-consumption').title = `最近 ${windowLabel()} 的总 Token 平均消耗速率，包含工具和等待时间。`;
    totalValue.textContent = formatMillions(rawTotal);
    const estimated = latest?.estimated || metrics?.rateEstimated;
    consumptionRateValue.textContent = `${estimated ? '≈ ' : ''}${formatRate(rawTotalRate)}`;
    outputRateValue.textContent = `${estimated ? '≈ ' : ''}${formatRate(rawOutputRate)}`;

    if (!points.length) {
      svg.setAttribute('hidden', '');
      empty.hidden = false;
      svg.replaceChildren();
      geometry = null;
      activeIndex = -1;
      readout.textContent = '';
      setTooltipVisible(false);
      return;
    }

    svg.removeAttribute('hidden');
    empty.hidden = true;
    const width = Math.max(220, Math.round(visual.clientWidth || section.clientWidth || 320));
    geometry = geometryFor(width);
    const { height, left, right, top, bottom, maxTotalRate, maxOutputRate } = geometry;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', `近 ${windowLabel()} 双纵轴速率图。左轴为总 Token 平均消耗速率，范围 0 至 ${formatAxis(maxTotalRate)} tok/s；右轴为输出 Token 平均速率，范围 0 至 ${formatAxis(maxOutputRate)} tok/s。两项速率都按经过时间计算，包含工具和等待时间。可用左右方向键查看各时点。`);
    svg.replaceChildren();

    addLine(left, top, left, bottom, 'tc-axis tc-axis-total');
    addLine(right, top, right, bottom, 'tc-axis tc-axis-rate');
    addLine(left, bottom, right, bottom, 'tc-grid');
    addLine(left, top, right, top, 'tc-grid');
    svg.append(
      svgText(2, 8, formatAxis(maxTotalRate), 'tc-axis-label tc-total-text', 'start'),
      svgText(2, bottom + 3, '0', 'tc-axis-label tc-total-text', 'start'),
      svgText(width - 2, 8, formatAxis(maxOutputRate), 'tc-axis-label tc-rate-text', 'end'),
      svgText(width - 2, bottom + 3, '0', 'tc-axis-label tc-rate-text', 'end')
    );

    const first = points[0];
    const last = points[points.length - 1];
    const includeDate = new Date(first.at).toDateString() !== new Date(last.at).toDateString();
    const startLabel = formatTime(first.at, includeDate, !includeDate);
    const endLabel = formatTime(last.at, includeDate, !includeDate);
    if (first.at === last.at) {
      svg.append(svgText((left + right) / 2, height - 2, startLabel, 'tc-time', 'middle'));
    } else {
      svg.append(
        svgText(left, height - 2, startLabel, 'tc-time', 'start'),
        svgText(right, height - 2, endLabel, 'tc-time', 'end')
      );
    }

    addSeries('tc-rate-stroke', 'outputRate', maxOutputRate, top, bottom, left, right, width);
    addSeries('tc-total-stroke', 'totalRate', maxTotalRate, top, bottom, left, right, width);
    if (activeIndex >= points.length) activeIndex = points.length - 1;
    if (activeIndex < 0) activeIndex = points.length - 1;
    if (focused || hovering || pinned) showActivePoint();
  }

  function saveSelection() {
    if (!currentThreadId || activeIndex < 0 || !points[activeIndex]) return;
    states.set(currentThreadId, { at: points[activeIndex].at, pinned });
  }

  function selectedIndexFor(threadId, nextPoints) {
    const saved = threadId ? states.get(threadId) : null;
    if (!saved || !nextPoints.length) return nextPoints.length - 1;
    return nearestIndex(nextPoints, saved.at);
  }

  function nearestIndex(nextPoints, at) {
    return nextPoints.reduce((closest, point, index) =>
      Math.abs(point.at - at) < Math.abs(nextPoints[closest].at - at) ? index : closest, 0);
  }

  function clearCursor() {
    if (!svg) return;
    svg.querySelectorAll('.tc-cursor').forEach(element => element.remove());
  }

  function pointDescription(point) {
    const total = point.totalTokens === null
      ? '累计 Token 未记录'
      : `累计${point.interpolated ? '约' : ''} ${numberFormat.format(Math.round(point.totalTokens))} token（${formatMillions(point.totalTokens)}）`;
    const totalRate = point.totalRate === null
      ? '总消耗速率未记录'
      : `近 ${windowLabel()} 总消耗 ${point.estimated ? '≈ ' : ''}${formatRate(point.totalRate)}（含等待）`;
    const outputRate = point.outputRate === null
      ? '输出速率未记录'
      : `近 ${windowLabel()} 输出均速 ${point.estimated ? '≈ ' : ''}${formatRate(point.outputRate)}（含等待）`;
    return `${formatFullTime(point.at)} · ${total} · ${totalRate} · ${outputRate}`;
  }

  function showTooltip(point, x, y) {
    if (!geometry || !visual || !tooltip) return;
    const text = pointDescription(point);
    tooltip.textContent = text;
    readout.textContent = text;
    tooltip.hidden = false;
    const visualWidth = visual.clientWidth || geometry.width;
    const visualHeight = visual.clientHeight || geometry.height;
    const left = Math.max(4, Math.min((x / geometry.width) * visualWidth, visualWidth - tooltip.offsetWidth - 4));
    const top = Math.max(0, Math.min(y - tooltip.offsetHeight - 4, visualHeight - tooltip.offsetHeight));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showActivePoint() {
    if (!geometry || activeIndex < 0 || !points[activeIndex]) return;
    clearCursor();
    const point = points[activeIndex];
    const { width, left, right, top, bottom, maxTotalRate, maxOutputRate } = geometry;
    const x = xFor(point, activeIndex, width, left, right);
    addLine(x, top, x, bottom, 'tc-cursor');
    if (point.totalRate !== null) {
      const dot = svgNode('circle', 'tc-cursor tc-cursor-total');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(yFor(point.totalRate, maxTotalRate, top, bottom)));
      dot.setAttribute('r', '3');
      svg.append(dot);
    }
    if (point.outputRate !== null) {
      const dot = svgNode('circle', 'tc-cursor tc-cursor-rate');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(yFor(point.outputRate, maxOutputRate, top, bottom)));
      dot.setAttribute('r', '3');
      svg.append(dot);
    }
    showTooltip(point, x, (top + bottom) / 2);
  }

  function activatePoint(index, persist = false) {
    if (!points.length) return;
    activeIndex = Math.max(0, Math.min(points.length - 1, index));
    if (persist) saveSelection();
    showActivePoint();
  }

  function onPointerMove(event) {
    if (!geometry || points.length === 0) return;
    readout.setAttribute('aria-live', 'off');
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const pointerX = ((event.clientX - rect.left) / rect.width) * geometry.width;
    let closest = 0;
    let distance = Infinity;
    points.forEach((point, index) => {
      const nextDistance = Math.abs(xFor(point, index, geometry.width, geometry.left, geometry.right) - pointerX);
      if (nextDistance < distance) {
        distance = nextDistance;
        closest = index;
      }
    });
    hovering = true;
    activatePoint(closest);
  }

  function onKeyDown(event) {
    if (!points.length) return;
    readout.setAttribute('aria-live', 'polite');
    let nextIndex = activeIndex < 0 ? points.length - 1 : activeIndex;
    if (event.key === 'ArrowLeft') nextIndex--;
    else if (event.key === 'ArrowRight') nextIndex++;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = points.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pinned = !pinned;
      saveSelection();
      if (!pinned && !hovering) {
        clearCursor();
        setTooltipVisible(false);
      }
      return;
    } else if (event.key === 'Escape') {
      pinned = false;
      saveSelection();
      clearCursor();
      setTooltipVisible(false);
      return;
    } else return;
    event.preventDefault();
    activatePoint(nextIndex, true);
  }

  function render(thread) {
    if (!ensureDom()) return;
    const nextThreadId = typeof thread?.id === 'string' ? thread.id : null;
    const changedThread = nextThreadId !== currentThreadId;
    const wasFocused = document.activeElement === svg;
    const oldAt = activeIndex >= 0 ? points[activeIndex]?.at : null;
    currentThread = thread || null;
    currentThreadId = nextThreadId;
    if (changedThread) {
      hovering = false;
      clearCursor();
      setTooltipVisible(false);
      readout.textContent = '';
      const saved = currentThreadId ? states.get(currentThreadId) : null;
      pinned = Boolean(saved?.pinned);
    }

    const nextPoints = normalizePoints(currentThread?.metrics);
    const savedAt = changedThread ? states.get(currentThreadId)?.at : oldAt;
    const restoredIndex = savedAt === undefined || savedAt === null
      ? -1
      : nextPoints.length ? nearestIndex(nextPoints, savedAt) : -1;
    points = nextPoints;
    activeIndex = restoredIndex >= 0 ? restoredIndex : selectedIndexFor(currentThreadId, points);
    draw();
    if (wasFocused && points.length) svg.focus({ preventScroll: true });
  }

  window.TokenChart = { render };
})();
