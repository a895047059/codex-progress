const actions = new Set(['/api/control/goal','/api/control/send','/api/control/interrupt','/api/control/answer']);
export async function handleControl(req, url, json, controller) {
  if (!url.pathname.startsWith('/api/control/')) return false;
  if (!controller) { json(503,{error:'控制连接未就绪'}); return true; }
  try {
    if (req.method === 'GET' && url.pathname === '/api/control/requests') {
      json(200,{requests:controller.approvals.list(url.searchParams.get('threadId'))});
    } else if (req.method === 'GET' && url.pathname === '/api/control/options') {
      const id = url.searchParams.get('threadId');
      json(200,await controller.options(id));
    } else if (req.method === 'POST' && actions.has(url.pathname)) {
      if (!req.headers['content-type']?.startsWith('application/json')) { json(415,{error:'请求格式无效'}); return true; }
      let body='', size=0;
      for await (const chunk of req) {
        size+=chunk.length;
        if (size > 16 * 1024 * 1024) throw Error('附件过大');
        body+=chunk;
      }
      const data=JSON.parse(body);
      if (typeof data.threadId !== 'string' || data.threadId.length > 120) throw Error('请选择任务');
      const action=url.pathname.split('/').at(-1);
      const result=action==='answer' ? controller.approvals.answer(data.threadId,data.requestId,data) : action==='goal' ? await controller.setGoal(data.threadId,data)
        : action==='send' ? await controller.send(data.threadId,data) : await controller.interrupt(data.threadId);
      json(200,{ok:true,...result});
    } else json(404,{error:'找不到此操作'});
  } catch (error) {
    // RPC errors can contain transcript fragments and paths. Only display our
    // short user-facing validation messages; keep arbitrary server errors out.
    const message = /^[\u4e00-\u9fff]/.test(error.message) && error.message.length < 90 ? error.message : '操作未成功，请重试；输入内容已保留';
    json(409,{error:message});
  }
  return true;
}
