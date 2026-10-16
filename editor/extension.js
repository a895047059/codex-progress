'use strict';

const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_AUTHORITY = 'local.codex-progress-editor';
const MAX_UTF8_BYTES = 100_000;
const MAX_CHARACTERS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidPort(value) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function parseRequest(uri) {
  if (uri.scheme !== 'cursor' || uri.authority !== EXTENSION_AUTHORITY || uri.path !== '/attach' || uri.fragment) {
    return { routeValid: false };
  }

  const params = new URLSearchParams(uri.query);
  const requestIds = params.getAll('requestId');
  const ports = params.getAll('port');
  const requestId = requestIds.length === 1 ? requestIds[0] : undefined;
  const portValue = ports.length === 1 ? ports[0] : undefined;
  const callbackTarget = UUID_PATTERN.test(requestId || '') && isValidPort(portValue)
    ? { requestId, port: Number(portValue) }
    : undefined;
  const valid = Array.from(params).length === 2 && callbackTarget !== undefined;

  return {
    routeValid: true,
    valid,
    callbackTarget,
  };
}

function boundText(text) {
  const parts = [];
  let bytes = 0;
  let characters = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (characters + character.length > MAX_CHARACTERS || bytes + characterBytes > MAX_UTF8_BYTES) {
      return { text: parts.join(''), truncated: true };
    }
    parts.push(character);
    bytes += characterBytes;
    characters += character.length;
  }

  return { text, truncated: false };
}

function postPayload(port, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/editor/context',
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error('HTTP request failed'));
        }
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

async function showFailure(target, message) {
  if (target) {
    try {
      await postPayload(target.port, { requestId: target.requestId, error: message });
    } catch {
      // The UI message is still useful when the progress app is unavailable.
    }
  }
  await vscode.window.showErrorMessage(message);
}

async function handleUri(uri) {
  const request = parseRequest(uri);
  if (!request.routeValid) {
    await vscode.window.showErrorMessage('附加链接无效');
    return;
  }
  if (!request.valid) {
    await showFailure(request.callbackTarget, '附加请求无效');
    return;
  }

  const { requestId, port } = request.callbackTarget;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await showFailure(request.callbackTarget, 'Cursor 当前没有打开文本编辑器');
    return;
  }

  try {
    const document = editor.document;
    const filePath = document.uri.fsPath;
    if (document.uri.scheme !== 'file' || !path.isAbsolute(filePath)) {
      await showFailure(request.callbackTarget, '请先保存当前文件');
      return;
    }

    const hasSelection = !editor.selection.isEmpty;
    const sourceText = hasSelection ? document.getText(editor.selection) : document.getText();
    const bounded = boundText(sourceText);
    if (!bounded.text.trim()) {
      await showFailure(request.callbackTarget, '当前文件没有可附加的内容');
      return;
    }
    const context = {
      application: 'Cursor',
      path: filePath,
      language: document.languageId,
      startLine: hasSelection ? editor.selection.start.line + 1 : 1,
      endLine: hasSelection ? editor.selection.end.line + 1 : document.lineCount,
      text: bounded.text,
      truncated: bounded.truncated,
    };

    await postPayload(port, { requestId, context });
  } catch {
    await showFailure(request.callbackTarget, '无法发送当前编辑内容');
  }
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));
}

function deactivate() {}

module.exports = { activate, deactivate };
