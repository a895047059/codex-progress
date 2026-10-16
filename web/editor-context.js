(() => {
  let available = false, checkedAt = 0, checking = null;
  async function json(url, data) {
    const response = await fetch(url, data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '未能附加 Cursor，请重试');
    return result;
  }
  async function refresh() {
    if (!window.webkit?.messageHandlers?.progressComposer) return false;
    if (Date.now() - checkedAt < 15000) return available;
    if (checking) return checking;
    checking = json('/api/editor/capability').then(result => {
      available = result.available === true;
      checkedAt = Date.now();
      return available;
    }).catch(() => false).finally(() => { checking = null; });
    return checking;
  }
  async function attach(threadId) {
    if (!await refresh()) throw Error('Cursor 附加尚未就绪');
    const request = await json('/api/editor/request', {threadId});
    const opened = await window.webkit.messageHandlers.progressComposer.postMessage({action:'openEditor',url:request.openUrl});
    if (!opened?.opened) throw Error('未能打开 Cursor，请确认应用已安装');
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      const result = await json(`/api/editor/request?requestId=${encodeURIComponent(request.requestId)}&threadId=${encodeURIComponent(threadId)}`);
      if (result.status === 'ready') return result.attachment;
      if (result.status === 'error' || result.status === 'expired') throw Error(result.error || '附加已超时，请重新选择 Cursor 内容');
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    throw Error('附加已超时，请重新选择 Cursor 内容');
  }
  window.EditorContext = {refresh,attach,get available() { return available; }};
  refresh();
})();
