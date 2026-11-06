// End-to-end: Arc Cmdbar + Pinline loaded together in a real Chrome for Testing.
// Checks that Pinline's commands show up in the bar, run in Pinline, and that Pinline's tabs are shown right.
// Needs ../pinline checked out next to this extension.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINLINE_ID } from '../src/pinline.js';

const CHROME = process.env.CHROME_BIN;
if (!CHROME) {
  console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
const EXT = fileURLToPath(new URL('..', import.meta.url));
const PINLINE = fileURLToPath(new URL('../../pinline/', import.meta.url));
if (!existsSync(join(PINLINE, 'manifest.json'))) {
  console.log('SKIP ../pinline not found');
  process.exit(0);
}
const CMDBAR_ID = 'khdmkbkpabdmhmhgekdebngpkndpfepc';
const PORT = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const title = (u.searchParams.get('t') || u.pathname).replace(/[<&]/g, '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const page = (name, title) => `${ORIGIN}/p/${name}?t=${encodeURIComponent(title)}`;

const profile = mkdtempSync(join(tmpdir(), 'cmdbar-pinline-'));
const proc = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--load-extension=${EXT},${PINLINE}`, `--disable-extensions-except=${EXT},${PINLINE}`, 'about:blank',
], { stdio: 'ignore' });

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.error) throw new Error(res.error.message);
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
    return res.result.result.value;
  };
  return { send, ev, errors, close: () => ws.close() };
}
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);

async function worker(id, ready) {
  let t;
  for (let i = 0; i < 40 && !t; i++) {
    await sleep(250);
    t = (await targets()).find((x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${id}/`));
  }
  if (!t) return null;
  const c = await connect(t.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    const r = await c.send('Runtime.evaluate', { expression: ready, returnByValue: true });
    if (r.result?.result?.value === true) break;
    await sleep(250);
  }
  return c;
}

const KEYS = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, ArrowDown: { code: 'ArrowDown', keyCode: 40 } };

let bar;
let pin;
const barErrors = [];
try {
  bar = await worker(CMDBAR_ID, `typeof chrome !== 'undefined' && !!chrome.tabs`);
  pin = await worker(PINLINE_ID, `typeof chrome !== 'undefined' && !!chrome.tabs && typeof pinline !== 'undefined'`);
  check(!!bar && !!pin, `both extensions loaded with their fixed ids (cmdbar ${CMDBAR_ID}, pinline ${PINLINE_ID})`);
  if (!bar || !pin) throw new Error('extensions not loaded');
  const evalBar = bar.ev;
  const evalPin = pin.ev;
  // Pinline lays the window out once it has reconciled.
  for (let i = 0; i < 40; i++) { if (await evalPin(`return pinline.state.ready;`)) break; await sleep(250); }

  const waitTab = async (id, pred, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const tab = await evalBar(`return await chrome.tabs.get(${id}).catch(() => null);`);
      if (pred(tab)) return tab;
      await sleep(100);
    }
    return null;
  };
  const W1 = await evalBar(`return (await chrome.windows.getLastFocused()).id;`);
  const create = async (url, windowId = W1, active = false) => {
    const id = await evalBar(`return (await chrome.tabs.create({ url: ${JSON.stringify(url)}, windowId: ${windowId}, active: ${active} })).id;`);
    await waitTab(id, (t) => t?.status === 'complete' && t.url === url);
    return id;
  };
  const T = await create(page('target', 'Target Page'), W1, true);
  const mail = await create(page('mail', 'Mail Box'));
  await sleep(500);

  // The bar runs as a page in its own window: Space switches close the tabs of window 1, the bar must survive them.
  const POPUP = `chrome-extension://${CMDBAR_ID}/src/popup.html`;
  const W2 = await evalBar(`return (await chrome.windows.create({ url: 'about:blank', focused: true })).id;`);
  await sleep(800);
  async function openBar(target) {
    const url = `${POPUP}?target=${target}`;
    await evalBar(`await chrome.tabs.create({ url: ${JSON.stringify(url)}, windowId: ${W2}, active: true });`);
    let t;
    for (let i = 0; i < 40 && !t; i++) { await sleep(100); t = (await targets()).find((x) => x.type === 'page' && x.url === url); }
    const p = await connect(t.webSocketDebuggerUrl);
    await p.send('Runtime.enable');
    await p.send('Page.bringToFront');
    for (let i = 0; i < 50; i++) { if (await p.ev(`return !!window.__cmdbar?.ready;`).catch(() => false)) break; await sleep(50); }
    await p.ev(`await window.__cmdbar.ready; await window.__cmdbar.pinlineReady;`);
    p.tabId = await p.ev(`return (await chrome.tabs.getCurrent()).id;`);
    p.done = async () => {
      barErrors.push(...p.errors, ...(await p.ev(`return window.__cmdbar.errors;`).catch(() => [])));
      p.close();
      await evalBar(`await chrome.tabs.remove(${p.tabId}).catch(() => {});`);
    };
    return p;
  }
  const key = async (p, k) => {
    const d = KEYS[k];
    await p.send('Page.bringToFront');
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, ...(d.text ? { text: d.text } : {}) });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode });
    await sleep(60);
  };
  const type = async (p, text) => {
    await p.send('Page.bringToFront');
    await p.ev(`const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input'));`);
    await p.send('Input.insertText', { text });
    await sleep(250);
  };
  const results = (p) => p.ev(`return window.__cmdbar.results.map(r => ({ kind: r.item.kind, id: r.item.id, title: r.item.title, url: r.item.url, pinline: r.item.pinline, actionId: r.item.actionId, role: r.item.role }));`);
  /** Type, arrow down to the first result matching pred, press Enter. Returns the chosen result. */
  const choose = async (p, text, pred) => {
    await type(p, text);
    const rs = await results(p);
    const i = rs.findIndex(pred);
    for (let k = 0; k < i; k++) await key(p, 'ArrowDown');
    if (i >= 0) await key(p, 'Enter');
    return rs[i];
  };
  const waitFor = async (fn, ms = 5000) => {
    for (let t = 0; t < ms; t += 100) { const v = await fn(); if (v) return v; await sleep(100); }
    return fn();
  };
  const strip = (w = W1) => evalPin(`const S = chrome.runtime.getURL('src/sleep.html'), D = chrome.runtime.getURL('src/divider.html');
    const tabs = (await chrome.tabs.query({ windowId: ${w} })).sort((a, b) => a.index - b.index);
    return tabs.map(t => { const u = t.url || t.pendingUrl || '';
      if (u.startsWith(D)) return '|';
      const real = u.startsWith(S) ? new URL(u).searchParams.get('url') : u;
      return (pinline.state.tabToFav[t.id] ? 'F:' : pinline.state.tabToPin[t.id] ? 'P:' : '') + real.replace(${JSON.stringify(ORIGIN)}, ''); });`);

  // ---------- 1. Pinline's commands are in the bar; ours that it replaces are not; its divider is hidden ----------
  let p = await openBar(T);
  console.log(`  INFO Pinline answered cmdbar:list after ${await p.ev('return window.__cmdbar.pinlineMs;')} ms (warm worker)`);
  let rs = await results(p);
  const hasPinline = await p.ev(`return !!window.__cmdbar.pinline;`);
  check(hasPinline, 'the bar got a command list from Pinline');
  check(rs.some((r) => r.pinline === 'toggle-pin') && rs.some((r) => r.pinline === 'toggle-fav') && rs.some((r) => r.pinline === 'manage-spaces'), 'Pinline commands (设为 Pin / 设为 Fav / 面板) are listed');
  check(!rs.some((r) => r.actionId === 'toggle-pin' || r.actionId === 'reset-tab'), 'our own pin / reset commands are hidden while Pinline is installed');
  check(!rs.some((r) => (r.url || '').includes('/src/divider.html')), 'Pinline divider tabs are not listed');
  console.log('  window 1:', (await strip()).join('  '));

  // ---------- 2. 设为 Pin from the bar ----------
  let chosen = await choose(p, 'guding', (r) => r.pinline === 'toggle-pin');
  check(chosen?.title === '设为 Pin', `"guding" finds Pinline's 设为 Pin (${chosen?.title})`);
  const pinned = await waitFor(async () => (await evalPin(`return pinline.state.pins.map(p => p.url);`)).includes(page('target', 'Target Page')));
  check(pinned, 'Enter makes the target tab a Pin in Pinline');
  check((await p.ev(`return window.__cmdbar.done;`))?.id === 'pinline:toggle-pin' && !(await p.ev(`return window.__cmdbar.errors.length;`)), 'the bar reports the command done, no error');
  await p.done();
  console.log('  window 1:', (await strip()).join('  '));

  // ---------- 3. 设为 Fav on another tab; sleeping copies are listed once with the real URL ----------
  p = await openBar(mail);
  chosen = await choose(p, 'fav', (r) => r.pinline === 'toggle-fav');
  check(chosen?.title === '设为 Fav', `"fav" → 设为 Fav (${chosen?.title})`);
  await waitFor(async () => (await evalPin(`return pinline.state.favs.length;`)) === 1);
  await sleep(800); // other windows get a sleeping copy
  await p.done();
  console.log('  window 2:', (await strip(W2)).join('  '));
  p = await openBar(T);
  await type(p, 'mail box');
  await sleep(300);
  rs = (await results(p)).filter((r) => r.kind === 'tab');
  check(rs.length === 1 && rs[0].role === 'fav' && rs[0].url === page('mail', 'Mail Box'), `the Fav and its sleeping copy are one row with the real URL (${JSON.stringify(rs.map((r) => [r.role, r.url]))})`);
  const badge = await p.ev(`return document.querySelector('#opt-0 .badge')?.textContent;`);
  check(badge === 'Fav', `badge says Fav (${badge})`);
  rs = await results(p);
  await type(p, 'pin');
  rs = await results(p);
  check(rs.some((r) => r.pinline === 'toggle-pin' && r.title === '取消 Pin'), 'for a Pin the bar offers 取消 Pin');
  await p.done();

  // ---------- 4. Spaces: new one, then switch back by name ----------
  await evalPin(`await pinline.newSpace(${W1}, '读书');`);
  await sleep(600);
  const spaces = await evalPin(`return pinline.state.spaces.map(s => ({ id: s.id, name: s.name }));`);
  const shown = () => evalPin(`return pinline.state.windowSpace[${W1}];`);
  check(spaces.length === 2 && (await shown()) === spaces[1].id, `a second Space "读书" is shown in window 1 (${spaces.map((s) => s.name)})`);
  const W1tab = await evalBar(`return (await chrome.tabs.query({ windowId: ${W1}, active: true }))[0].id;`);
  p = await openBar(W1tab);
  chosen = await choose(p, spaces[0].name, (r) => r.pinline === `space:${spaces[0].id}`);
  check(chosen?.title === `切到 Space：${spaces[0].name}`, `typing the Space name finds "${chosen?.title}"`);
  check(await waitFor(async () => (await shown()) === spaces[0].id), 'Enter switches window 1 back to that Space');
  await p.done();
  console.log('  window 1:', (await strip()).join('  '));

  // ---------- 5. archive: clear the unpinned tabs, then search and reopen one ----------
  const junk = await create(page('junk', 'Junk Article'));
  const activeNow = await evalBar(`return (await chrome.tabs.query({ windowId: ${W1}, active: true }))[0].id;`);
  p = await openBar(activeNow);
  chosen = await choose(p, 'guidang', (r) => r.pinline === 'clear-unpinned');
  check(!!chosen, `"guidang" → ${chosen?.title}`);
  check(await waitFor(async () => !(await evalBar(`return await chrome.tabs.get(${junk}).catch(() => null);`))), 'the tab below the divider is archived (closed)');
  await p.done();
  const archived = await evalPin(`return pinline.state.archive.map(e => e.url);`);
  check(archived.includes(page('junk', 'Junk Article')), 'and it is in Pinline’s archive');
  const activeAfter = await evalBar(`return (await chrome.tabs.query({ windowId: ${W1}, active: true }))[0].id;`);
  p = await openBar(activeAfter);
  await type(p, 'junk');
  rs = await results(p);
  check(rs[0]?.kind === 'archive' && rs[0].title === 'Junk Article', `"junk" → archived tab first, its history duplicate hidden (${rs.map((r) => r.kind).join(',')})`);
  const label = await p.ev(`return document.querySelector('#opt-0 .badge')?.textContent;`);
  check(label === '归档', `badge says 归档 (${label})`);
  await key(p, 'Enter');
  check(await waitFor(async () => (await strip()).includes('/p/junk?t=Junk%20Article')), 'Enter reopens it in window 1 below the divider');
  check(!(await evalPin(`return pinline.state.archive.map(e => e.url);`)).includes(page('junk', 'Junk Article')), 'and drops it from the archive');
  await p.done();
  console.log('  window 1:', (await strip()).join('  '));

  // Without Pinline the bar falls back to its own pin / reset commands: covered by e2e/run.mjs (only this extension loaded).

  check(barErrors.length === 0, `no errors in the command bar${barErrors.length ? ': ' + barErrors.join(' | ') : ''}`);
  check(bar.errors.length === 0, `no Arc Cmdbar worker errors${bar.errors.length ? ': ' + bar.errors.join(' | ') : ''}`);
  check(pin.errors.length === 0, `no Pinline worker errors${pin.errors.length ? ': ' + pin.errors.join(' | ') : ''}`);
} catch (err) {
  console.log('FAIL', err.message, err.stack?.split('\n').slice(1, 3).join(' '));
  failures++;
} finally {
  bar?.close();
  pin?.close();
  proc.kill();
  server.close();
  await sleep(1500);
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} failure(s)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
