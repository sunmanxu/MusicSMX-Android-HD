// 极简 CDP 客户端（零依赖）：连安卓 WebView 的 devtools，做按钮自检
// 用法：node cdp.js '<js表达式>'   或   node cdp.js --run   （跑整套自检）
'use strict';
const net = require('net');
const crypto = require('crypto');
const http = require('http');

const PORT = 9333;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(Number(u.port), u.hostname);
      this.sock = sock;
      let handshaken = false;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!handshaken) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          handshaken = true;
          buf = buf.slice(idx + 4);
          resolve();
        }
        while (true) {
          if (buf.length < 2) return;
          const b1 = buf[1];
          const len0 = b1 & 0x7f;
          let off = 2, len = len0;
          if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len);
          const opcode = buf[0] & 0x0f;
          buf = buf.slice(off + len);
          if (opcode === 1) this._msg(payload.toString('utf8'));
          else if (opcode === 8) { sock.end(); return; }
        }
      });
      sock.on('error', reject);
      sock.write(
        'GET ' + u.pathname + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
  }
  _msg(txt) {
    let o;
    try { o = JSON.parse(txt); } catch (e) { return; }
    if (o.id && this.pending.has(o.id)) {
      const p = this.pending.get(o.id);
      this.pending.delete(o.id);
      p(o);
    } else if (o.method) {
      this.events.push(o);
    }
  }
  _send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(2 + 8);
    head[0] = 0x81;
    const len = data.length;
    let off;
    if (len < 126) { head[1] = 0x80 | len; off = 2; }
    else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); off = 4; }
    else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); off = 10; }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([head.slice(0, off), mask, masked]));
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this._send({ id, method, params: params || {} });
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: !!awaitPromise,
      userGesture: true
    });
    if (r && r.result && r.result.exceptionDetails) {
      return { error: (r.result.exceptionDetails.exception || {}).description || 'exception' };
    }
    return r && r.result ? r.result.result.value : null;
  }
}

async function main() {
  const list = JSON.parse(await httpGet('/json'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const arg = process.argv[2];
  if (arg === '--file') {
    const fs = require('fs');
    const out = await cdp.eval(fs.readFileSync(process.argv[3], 'utf8'), true);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
    process.exit(0);
    return;
  }
  if (arg && arg !== '--run') {
    const out = await cdp.eval(arg, true);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
    process.exit(0);
    return;
  }

  // ---- 整套自检：逐个按钮点一遍，看状态有没有按预期变化 ----
  const steps = require('./cdp-steps.js');
  const results = [];
  for (const st of steps) {
    const before = await cdp.eval(st.probeBefore || 'null', true);
    if (st.click) await cdp.eval(st.click, true);
    await new Promise((r) => setTimeout(r, st.wait || 500));
    const after = await cdp.eval(st.probeAfter || 'null', true);
    results.push({ name: st.name, ok: st.verify ? st.verify(before, after) : true, before, after });
    if (st.undo) await cdp.eval(st.undo, true);
    await new Promise((r) => setTimeout(r, st.undoWait || 300));
  }
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded');
  console.log(JSON.stringify({ results, errors: errs.map(e => e.params && (e.params.exceptionDetails || e.params.entry)) }, null, 1));
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
