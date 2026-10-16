import path from 'node:path';

export function editorContexts(attachments = []) {
  const contexts = {};
  for (const [index, item] of attachments.entries()) {
    if (item.kind !== 'editor') continue;
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.path.length > 4000
        || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 60000
        || Buffer.byteLength(item.text) > 100000 || !Number.isSafeInteger(item.startLine)
        || !Number.isSafeInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine) {
      throw Error('编辑器上下文无效，请重新附加');
    }
    contexts[`cursor-${index}`] = {kind:'untrusted', value:JSON.stringify({
      application:'Cursor', path:item.path, language:typeof item.language === 'string' ? item.language.slice(0,80) : '',
      startLine:item.startLine, endLine:item.endLine, text:item.text, truncated:item.truncated === true
    })};
  }
  return contexts;
}
