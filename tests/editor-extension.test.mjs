import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {test} from 'node:test';

const extensionPath = fileURLToPath(new URL('../editor/extension.js', import.meta.url));
const extensionSource = await readFile(extensionPath, 'utf8');
const nonce = '123e4567-e89b-12d3-a456-426614174000';

function loadExtension(getEditor) {
  const errors = [];
  let registeredHandler;
  const vscode = {
    window: {
      get activeTextEditor() {
        return getEditor();
      },
      registerUriHandler(handler) {
        registeredHandler = handler;
        return {dispose() {}};
      },
      async showErrorMessage(message) {
        errors.push(message);
      },
    },
  };
  const module = {exports: {}};
  const sandbox = {
    Buffer,
    URLSearchParams,
    module,
    exports: module.exports,
    require(name) {
      if (name === 'node:http') return http;
      if (name === 'node:path') return path;
      if (name === 'vscode') return vscode;
      throw new Error(`Unexpected require: ${name}`);
    },
  };

  vm.runInNewContext(extensionSource, sandbox, {filename: extensionPath});
  module.exports.activate({subscriptions: []});
  assert.equal(typeof registeredHandler?.handleUri, 'function');
  return {handleUri: uri => registeredHandler.handleUri(uri), errors};
}

async function withReceiver(run) {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(202).end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(server.address().port, received);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function cursorUri(port, {path: uriPath = '/attach', query} = {}) {
  const params = new URLSearchParams(query ?? {requestId: nonce, port: String(port)});
  return {
    scheme: 'cursor',
    authority: 'local.codex-progress-editor',
    path: uriPath,
    query: params.toString(),
    fragment: '',
  };
}

function editor({text, getText, selection = {isEmpty: true}, scheme = 'file', fsPath = '/workspace/fixture.txt', lineCount = 1}) {
  return {
    selection,
    document: {
      uri: {scheme, fsPath},
      languageId: 'plaintext',
      lineCount,
      getText,
    },
  };
}

test('registered Cursor URI handler posts only the active selection or the full document', async () => {
  await withReceiver(async (port, received) => {
    const selection = {isEmpty: false, start: {line: 2}, end: {line: 4}};
    const wholeDocument = 'private prefix\nselected 中文 text\nprivate suffix';
    const reads = [];
    let activeEditor = editor({
      text: wholeDocument,
      selection,
      lineCount: 3,
      getText(range) {
        reads.push(range);
        return range === selection ? 'selected 中文 text' : wholeDocument;
      },
    });
    const extension = loadExtension(() => activeEditor);

    await extension.handleUri(cursorUri(port));
    activeEditor = editor({
      text: wholeDocument,
      lineCount: 3,
      getText(range) {
        reads.push(range);
        return wholeDocument;
      },
    });
    await extension.handleUri(cursorUri(port, {query: {requestId: '123e4567-e89b-12d3-a456-426614174001', port: String(port)}}));

    assert.equal(received.length, 2);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].path, '/api/editor/context');
    assert.equal(received[0].headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(received[0].body.context.text, 'selected 中文 text');
    assert.deepEqual(reads[0], selection);
    assert.equal(received[0].body.context.startLine, 3);
    assert.equal(received[0].body.context.endLine, 5);
    assert.ok(!JSON.stringify(received[0].body).includes('private prefix'));
    assert.ok(!JSON.stringify(received[0].body).includes('private suffix'));
    assert.equal(received[1].body.context.text, wholeDocument);
    assert.deepEqual(reads, [selection, undefined]);
    assert.equal(received[1].body.context.startLine, 1);
    assert.equal(received[1].body.context.endLine, 3);
    assert.equal(extension.errors.length, 0);
  });
});

test('context truncation respects UTF-8 byte and UTF-16 character limits without splitting characters', async () => {
  await withReceiver(async (port, received) => {
    let activeText = '界'.repeat(33_334);
    const extension = loadExtension(() => editor({text: activeText, getText: () => activeText}));

    await extension.handleUri(cursorUri(port));
    activeText = 'a'.repeat(59_998) + '😀z';
    await extension.handleUri(cursorUri(port, {query: {requestId: '123e4567-e89b-12d3-a456-426614174001', port: String(port)}}));

    assert.equal(received.length, 2);
    assert.equal(received[0].body.context.text, '界'.repeat(33_333));
    assert.equal(Buffer.byteLength(received[0].body.context.text, 'utf8'), 99_999);
    assert.equal(received[0].body.context.truncated, true);
    assert.equal(received[1].body.context.text, 'a'.repeat(59_998) + '😀');
    assert.equal(received[1].body.context.text.length, 60_000);
    assert.equal(received[1].body.context.truncated, true);
  });
});

test('invalid routes and duplicate request parameters do not read or send document content', async () => {
  await withReceiver(async (port, received) => {
    let reads = 0;
    const secret = 'LOCAL_EDITOR_SECRET_FIXTURE';
    const extension = loadExtension(() => editor({
      text: secret,
      getText() {
        reads += 1;
        return secret;
      },
    }));

    await extension.handleUri(cursorUri(port, {path: '/wrong-route'}));
    await extension.handleUri(cursorUri(port, {query: [
      ['requestId', nonce],
      ['requestId', '123e4567-e89b-12d3-a456-426614174001'],
      ['port', String(port)],
    ]}));
    await extension.handleUri(cursorUri(port, {query: [
      ['requestId', nonce],
      ['port', String(port)],
      ['port', String(port)],
    ]}));

    assert.equal(reads, 0);
    assert.deepEqual(extension.errors, ['附加链接无效', '附加请求无效', '附加请求无效']);
    assert.deepEqual(received, []);
    assert.ok(!JSON.stringify(received).includes(secret));
  });
});

test('missing editor, unsaved document, and empty document return supported Chinese errors', async () => {
  await withReceiver(async (port, received) => {
    let activeEditor = null;
    let unsavedReads = 0;
    let emptyDocumentReads = 0;
    const extension = loadExtension(() => activeEditor);

    await extension.handleUri(cursorUri(port));
    activeEditor = editor({
      text: 'must not be read',
      scheme: 'untitled',
      getText() {
        unsavedReads += 1;
        return 'must not be read';
      },
    });
    await extension.handleUri(cursorUri(port, {query: {requestId: '123e4567-e89b-12d3-a456-426614174001', port: String(port)}}));
    activeEditor = editor({text: ' \n\t ', getText: () => {
      emptyDocumentReads += 1;
      return ' \n\t ';
    }});
    await extension.handleUri(cursorUri(port, {query: {requestId: '123e4567-e89b-12d3-a456-426614174002', port: String(port)}}));

    const expected = [
      'Cursor 当前没有打开文本编辑器',
      '请先保存当前文件',
      '当前文件没有可附加的内容',
    ];
    assert.deepEqual(extension.errors, expected);
    assert.deepEqual(received.map(item => item.body.error), expected);
    assert.deepEqual(received.map(item => item.body.requestId), [
      nonce,
      '123e4567-e89b-12d3-a456-426614174001',
      '123e4567-e89b-12d3-a456-426614174002',
    ]);
    assert.equal(unsavedReads, 0);
    assert.equal(emptyDocumentReads, 1);
    assert.ok(received.every(item => !Object.hasOwn(item.body, 'context')));
  });
});
