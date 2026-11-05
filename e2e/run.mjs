// End-to-end check in a real Chrome for Testing: load the unpacked extension, open the command bar page,
// drive it with real CDP keyboard input, and check what happened to tabs / bookmarks / history / clipboard.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Branded Chrome ignores --load-extension; use Chrome for Testing or Chromium.
const CHROME = process.env.CHROME_BIN;
if (!CHROME) {
  console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
const EXT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// Local pages with known titles: /p/<name>?t=<title>. No internet needed.
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const title = u.searchParams.get('t') || u.pathname;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title.replace(/[<&]/g, '')}</title><h1>${title.replace(/[<&]/g, '')}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const page = (name, title) => `${ORIGIN}/p/${name}?t=${encodeURIComponent(title)}`;

const profile = mkdtempSync(join(tmpdir(), 'cmdbar-profile-'));
const proc = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, 'about:blank',
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

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  Backspace: { code: 'Backspace', keyCode: 8 },
};
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

let sw;
let popupErrors = [];
try {
  let swTarget;
  for (let i = 0; i < 40 && !swTarget; i++) {
    await sleep(250);
    swTarget = (await targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
  }
  check(!!swTarget, 'service worker loaded');
  if (!swTarget) throw new Error('extension not loaded');
  const extId = new URL(swTarget.url).host;
  sw = await connect(swTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    const r = await sw.send('Runtime.evaluate', { expression: `typeof chrome !== 'undefined' && !!chrome.tabs`, returnByValue: true });
    if (r.result?.result?.value === true) break;
    await sleep(250);
  }
  const evalSW = sw.ev;
  const POPUP = `chrome-extension://${extId}/src/popup.html`;

  // ---------- permissions ----------
  const perms = await evalSW(`const m = chrome.runtime.getManifest(); const p = await chrome.permissions.getAll();
    return { host: m.host_permissions ?? null, cs: m.content_scripts ?? null, origins: p.origins, perms: p.permissions, popup: m.action.default_popup, cmd: m.commands._execute_action.suggested_key };`);
  console.log('  permissions:', perms.perms.join(', '), '| origins:', JSON.stringify(perms.origins));
  check(perms.host === null && perms.cs === null && perms.origins.length === 0, 'no host permissions, no content scripts, no granted origins');
  check(perms.popup === 'src/popup.html', 'UI is the action popup');

  // ---------- data ----------
  const waitTab = async (id, pred, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const tab = await evalSW(`return await chrome.tabs.get(${id}).catch(() => null);`);
      if (pred(tab)) return tab;
      await sleep(100);
    }
    return evalSW(`return await chrome.tabs.get(${id}).catch(() => null);`);
  };
  const create = async (url, active = false) => {
    const id = await evalSW(`return (await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: ${active} })).id;`);
    await waitTab(id, (t) => t?.status === 'complete' && t.url === url);
    return id;
  };
  const T = await create(page('target', 'Target Page'), true);
  const zebra = await create(page('zebra', 'Zebra Notes'));
  await evalSW(`await chrome.bookmarks.create({ parentId: '1', title: 'Kiwi Docs', url: ${JSON.stringify(page('kiwi', 'Kiwi'))} });`);
  const mango = await create(page('mango', 'Mango Smoothie'));
  await evalSW(`await chrome.tabs.remove(${mango});`);
  const papaya = await create(page('papaya', 'Papaya Facts'));
  await evalSW(`await chrome.tabs.update(${papaya}, { url: ${JSON.stringify(page('other', 'Other'))} });`);
  await waitTab(papaya, (t) => t?.url?.includes('/p/other') && t.status === 'complete');
  const P = await create(page('home', 'Pinned Home'));
  await evalSW(`await chrome.tabs.update(${P}, { pinned: true });`);
  await sleep(300);
  await evalSW(`await chrome.tabs.update(${P}, { url: ${JSON.stringify(page('away', 'Away'))} });`);
  await waitTab(P, (t) => t?.url?.includes('/p/away') && t.status === 'complete');
  const homes = await evalSW(`return (await chrome.storage.session.get('homes')).homes;`);
  check(homes?.[P] === page('home', 'Pinned Home'), 'service worker remembered the URL the tab had when pinned');
  await evalSW(`await chrome.tabs.update(${T}, { active: true });`);

  // ---------- helpers for the command bar page ----------
  async function openBar(target) {
    const url = `${POPUP}?target=${target}`;
    await evalSW(`await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: true });`);
    let t;
    for (let i = 0; i < 40 && !t; i++) { await sleep(100); t = (await targets()).find((x) => x.type === 'page' && x.url === url); }
    const p = await connect(t.webSocketDebuggerUrl);
    await p.send('Runtime.enable');
    await p.send('Page.enable');
    await p.send('Page.bringToFront');
    for (let i = 0; i < 50; i++) { if (await p.ev(`return !!window.__cmdbar?.ready;`).catch(() => false)) break; await sleep(50); }
    await p.ev(`await window.__cmdbar.ready;`);
    p.tabId = await p.ev(`return (await chrome.tabs.getCurrent()).id;`);
    p.done = async () => { popupErrors.push(...p.errors, ...(await p.ev(`return window.__cmdbar.errors;`).catch(() => []))); p.close(); await evalSW(`await chrome.tabs.remove(${p.tabId}).catch(() => {});`); };
    return p;
  }
  const key = async (p, k, mods = 0) => {
    const d = KEYS[k];
    await p.send('Page.bringToFront');
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers: mods, ...(d.text && !mods ? { text: d.text } : {}) });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers: mods });
    await sleep(60);
  };
  const type = async (p, text) => {
    await p.send('Page.bringToFront');
    await p.ev(`const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input'));`);
    await p.send('Input.insertText', { text });
    await sleep(250); // render + query-time history search
  };
  const results = (p) => p.ev(`return window.__cmdbar.results.map(r => ({ kind: r.item.kind, id: r.item.id, title: r.item.title, url: r.item.url, mode: r.item.mode, actionId: r.item.actionId }));`);
  const selIndex = (p) => p.ev(`return window.__cmdbar.sel;`);
  /** Move the selection to the first result matching pred using the arrow keys, then return its index. */
  const arrowTo = async (p, pred) => {
    const rs = await results(p);
    const i = rs.findIndex(pred);
    for (let k = 0; k < i; k++) await key(p, 'ArrowDown');
    return i;
  };
  const doneOf = (p) => p.ev(`return window.__cmdbar.done;`);
  const tabsNow = () => evalSW(`return (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url || t.pendingUrl, active: t.active, pinned: t.pinned, index: t.index, windowId: t.windowId }));`);

  // ---------- 1. first look, a11y, keyboard, theme ----------
  let p = await openBar(T);
  const timing = await p.ev(`return [window.__cmdbar.firstRenderMs, window.__cmdbar.loadedMs];`);
  console.log(`  INFO first render ${timing[0]} ms, all sources loaded ${timing[1]} ms (page opened in a tab)`);
  check(await p.ev(`return document.activeElement?.id;`) === 'q', 'search box has focus');
  let rs = await results(p);
  console.log('  empty query:', rs.map((r) => `${r.kind}:${r.title}`).slice(0, 8).join(' | '));
  check(rs[0]?.kind === 'tab' && rs.some((r) => r.kind === 'action') && rs.some((r) => r.kind === 'closed' && r.title === 'Mango Smoothie'), 'empty query: other tabs, commands, recently closed');
  check(!rs.some((r) => r.id === `tab:${T}`) && !rs.some((r) => (r.url || '').startsWith(POPUP)), 'empty query hides the current tab and the bar itself');
  const aria = await p.ev(`const q = document.getElementById('q'); const sel = document.querySelectorAll('[role=option][aria-selected=true]');
    return { role: q.getAttribute('role'), controls: q.getAttribute('aria-controls'), listRole: document.getElementById('list').getAttribute('role'),
      active: q.getAttribute('aria-activedescendant'), selCount: sel.length, selId: sel[0]?.id, label: sel[0]?.getAttribute('aria-label'), status: document.getElementById('status').textContent };`);
  check(aria.role === 'combobox' && aria.controls === 'list' && aria.listRole === 'listbox' && aria.selCount === 1 && aria.active === aria.selId, `ARIA combobox/listbox wiring (${aria.active}, "${aria.label}")`);
  check(/个结果/.test(aria.status), `live region announces the count ("${aria.status}")`);
  await key(p, 'ArrowDown');
  const afterDown = [await selIndex(p), await p.ev(`return document.getElementById('q').getAttribute('aria-activedescendant');`)];
  await key(p, 'ArrowUp');
  await key(p, 'ArrowUp'); // wraps to the last row
  const afterWrap = await selIndex(p);
  check(afterDown[0] === 1 && afterDown[1] === 'opt-1' && afterWrap === rs.length - 1, `arrow keys move the selection and wrap (${afterDown}, ${afterWrap}/${rs.length - 1})`);

  await type(p, 'kiwi');
  rs = await results(p);
  check(rs[0]?.kind === 'bookmark' && rs[0].title === 'Kiwi Docs', `"kiwi" → bookmark first (${rs[0]?.kind}:${rs[0]?.title})`);
  await type(p, 'zbnt');
  rs = await results(p);
  const marks = await p.ev(`return [...document.querySelectorAll('#opt-0 .title mark')].map(m => m.textContent).join('');`);
  check(rs[0]?.id === `tab:${zebra}`, `fuzzy "zbnt" → open tab "Zebra Notes" (${rs[0]?.title})`);
  check(marks.toLowerCase() === 'zbnt', `matched letters highlighted (${marks})`);
  await type(p, 'mango');
  rs = await results(p);
  check(rs[0]?.kind === 'closed' && rs[0].title === 'Mango Smoothie', `"mango" → recently closed tab first, history duplicate hidden (${rs.map((r) => r.kind).join(',')})`);
  await type(p, 'papaya');
  rs = await results(p);
  check(rs[0]?.kind === 'history' && rs[0].title === 'Papaya Facts', `"papaya" → history (${rs[0]?.kind}:${rs[0]?.title})`);
  await type(p, `127.0.0.1:${new URL(ORIGIN).port}/p/typed`);
  rs = await results(p);
  check(rs[0]?.kind === 'fallback' && rs[0].mode === 'url', 'typed address → "open URL" row first');
  await type(p, 'close');
  rs = await results(p);
  check(rs[0]?.actionId === 'close-tab', `"close" → command first (${rs[0]?.title})`);

  const bg = async (scheme) => {
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    return p.ev(`return getComputedStyle(document.body).backgroundColor + ' / ' + getComputedStyle(document.body).color;`);
  };
  const light = await bg('light');
  const dark = await bg('dark');
  check(light.startsWith('rgb(255, 255, 255)') && dark.startsWith('rgb(28, 28, 30)'), `light / dark themes (${light} | ${dark})`);
  await p.send('Emulation.setEmulatedMedia', { features: [] });

  // Enter on an open tab switches to it.
  await type(p, 'zebra');
  await key(p, 'Enter');
  await sleep(300);
  let tabs = await tabsNow();
  check(tabs.find((t) => t.id === zebra)?.active && (await doneOf(p))?.kind === 'tab', 'Enter on a tab result switches to that tab');
  await p.done();

  // ---------- 2. recently closed → restore ----------
  p = await openBar(T);
  await type(p, 'mango');
  await key(p, 'Enter');
  await sleep(800);
  tabs = await tabsNow();
  check(tabs.some((t) => t.url?.includes('/p/mango')), 'Enter on a recently closed tab restores it');
  await p.done();

  // ---------- 3. bookmark → new tab next to the current one ----------
  p = await openBar(T);
  await type(p, 'kiwi');
  await key(p, 'Enter');
  await sleep(500);
  tabs = await tabsNow();
  const tT = tabs.find((t) => t.id === T);
  const kiwiTab = tabs.find((t) => t.url?.includes('/p/kiwi'));
  check(!!kiwiTab && kiwiTab.index === tT.index + 1 && tT.url.includes('/p/target'), 'Enter on a bookmark opens it in a new tab right after the current one');
  await p.done();

  // ---------- 4. Shift+Enter opens history in the current tab ----------
  p = await openBar(T);
  await type(p, 'papaya');
  await key(p, 'Enter', MOD.shift);
  const tP = await waitTab(T, (t) => t?.url?.includes('/p/papaya'));
  check(tP?.url?.includes('/p/papaya'), `Shift+Enter opens the result in the current tab (${tP?.url})`);
  await p.done();

  // ---------- 5. typed URL, 6. web search ----------
  p = await openBar(T);
  await type(p, `127.0.0.1:${new URL(ORIGIN).port}/p/typed`);
  await key(p, 'Enter');
  await sleep(500);
  check((await tabsNow()).some((t) => t.url?.includes('/p/typed')), 'Enter on a typed address opens it');
  await p.done();
  p = await openBar(T);
  await type(p, 'cmdbar e2e search');
  rs = await results(p);
  check(rs.at(-1)?.mode === 'search', 'free text → "search" row');
  await arrowTo(p, (r) => r.mode === 'search');
  await key(p, 'Enter');
  await sleep(800);
  const searchTab = (await tabsNow()).find((t) => /cmdbar(\+|%20)e2e/.test(t.url || ''));
  check(!!searchTab, `search row runs a default-engine search in a new tab (${searchTab?.url?.slice(0, 60)})`);
  if (searchTab) await evalSW(`await chrome.tabs.remove(${searchTab.id});`);
  await p.done();

  // ---------- 7. copy URL ----------
  const browserWs = (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())).webSocketDebuggerUrl;
  const browser = await connect(browserWs);
  await browser.send('Browser.grantPermissions', { origin: `chrome-extension://${extId}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  p = await openBar(T);
  await type(p, 'copy url');
  rs = await results(p);
  check(rs[0]?.actionId === 'copy-url', `"copy url" → command first (${rs[0]?.title})`);
  await key(p, 'Enter');
  await sleep(300);
  const clip = await p.ev(`return await navigator.clipboard.readText();`).catch((e) => `ERR ${e.message}`);
  const tUrl = (await tabsNow()).find((t) => t.id === T).url;
  check(clip === tUrl, `copy URL puts the current tab's URL on the clipboard (${clip})`);
  await p.done();

  // ---------- 8. pin (keyboard: arrow to the command) ----------
  p = await openBar(T);
  await type(p, 'pin');
  rs = await results(p);
  const pinIdx = await arrowTo(p, (r) => r.actionId === 'toggle-pin');
  check(pinIdx >= 0 && pinIdx <= 2, `"pin" → pin command in the top 3 (#${pinIdx}: ${rs.slice(0, 3).map((r) => r.title).join(' | ')})`);
  await key(p, 'Enter');
  await sleep(300);
  check((await tabsNow()).find((t) => t.id === T)?.pinned === true, 'pin command pins the current tab');
  await p.done();

  // ---------- 9. reset a pinned tab ----------
  p = await openBar(P);
  await type(p, 'reset');
  rs = await results(p);
  check(rs[0]?.actionId === 'reset-tab', `"reset" on a pinned tab that navigated away → reset command (${rs[0]?.title})`);
  await key(p, 'Enter');
  const back = await waitTab(P, (t) => t?.url === page('home', 'Pinned Home'));
  check(back?.url === page('home', 'Pinned Home'), `reset sends the pinned tab back to where it was pinned (${back?.url})`);
  await p.done();
  p = await openBar(P);
  await type(p, 'reset');
  check(!(await results(p)).some((r) => r.actionId === 'reset-tab'), 'reset is not offered once the tab is home');
  await p.done();

  // ---------- 10. close the selected tab result with ⌘⇧⌫ / Ctrl+Shift+Backspace ----------
  p = await openBar(T);
  await type(p, 'zebra');
  rs = await results(p);
  check(rs[0]?.id === `tab:${zebra}`, 'zebra tab selected');
  const isMac = await p.ev(`return /Mac/i.test(navigator.platform);`);
  await key(p, 'Backspace', MOD.shift | (isMac ? MOD.meta : MOD.ctrl));
  await sleep(300);
  check(!(await tabsNow()).some((t) => t.id === zebra), `${isMac ? '⌘⇧⌫' : 'Ctrl+Shift+Backspace'} closes the selected tab`);
  check(!(await results(p)).some((r) => r.id === `tab:${zebra}`), 'closed tab disappears from the list');
  await p.done();

  // ---------- 11. new tab command ----------
  const before = (await tabsNow()).length;
  p = await openBar(T);
  await type(p, 'new tab');
  await arrowTo(p, (r) => r.actionId === 'new-tab');
  await key(p, 'Enter');
  await sleep(500);
  const after = await tabsNow();
  check(after.length === before + 2 /* + this page */ && after.some((t) => /^chrome:\/\/newtab/.test(t.url || '')), 'new tab command opens a new tab');
  await p.done();

  // ---------- 12. the real toolbar popup ----------
  await evalSW(`await chrome.tabs.update(${T}, { active: true });`);
  const kiwiId = (await tabsNow()).find((t) => t.url?.includes('/p/kiwi')).id;
  // A window must be focused for openPopup(); CfT may start in the background on macOS.
  {
    const tt = (await targets()).find((x) => x.type === 'page' && x.url.includes('/p/papaya'));
    if (tt) { const c = await connect(tt.webSocketDebuggerUrl); await c.send('Page.bringToFront'); c.close(); }
  }
  const tryOpen = () => evalSW(`const w = (await chrome.tabs.get(${T})).windowId; await chrome.windows.update(w, { focused: true });
    await new Promise(r => setTimeout(r, 300));
    try { await chrome.action.openPopup({ windowId: w }); return 'ok'; } catch (e) { return e.message; }`);
  const opened = await tryOpen();
  let popupTarget;
  for (let i = 0; i < 40 && !popupTarget && opened === 'ok'; i++) { await sleep(100); popupTarget = (await targets()).find((x) => x.url === POPUP); }
  /** Drive a command bar page that runs in normal (non-test) mode: type, Enter, expect it to close itself. */
  async function normalMode(t, label) {
    const rp = await connect(t.webSocketDebuggerUrl);
    await rp.send('Runtime.enable');
    for (let i = 0; i < 50; i++) { if (await rp.ev(`return !!window.__cmdbar?.ready;`).catch(() => false)) break; await sleep(50); }
    await rp.ev(`await window.__cmdbar.ready;`);
    const info = await rp.ev(`return { focus: document.activeElement?.id, first: window.__cmdbar.firstRenderMs, all: window.__cmdbar.loadedMs, w: innerWidth, h: innerHeight };`);
    console.log(`  INFO ${label}: first render ${info.first} ms, all sources ${info.all} ms, ${info.w}×${info.h}`);
    check(info.focus === 'q', `${label}: search box focused`);
    await rp.send('Input.insertText', { text: 'kiwi' });
    await sleep(250);
    await rp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await sleep(800);
    const gone = !(await targets()).some((x) => x.id === t.id);
    check(gone && (await tabsNow()).find((x) => x.id === kiwiId)?.active, `${label}: Enter switches to the tab and the bar closes itself`);
    popupErrors.push(...rp.errors);
    rp.close();
  }
  if (opened === 'ok' && popupTarget) {
    check(true, 'chrome.action.openPopup() shows the real popup');
    await normalMode(popupTarget, 'real popup');
  } else {
    // macOS refuses to focus a window of an app started from a background shell; this is an environment limit.
    console.log(`SKIP real toolbar popup not openable here (${opened}) — UNVERIFIED`);
    const id = await evalSW(`return (await chrome.tabs.create({ url: ${JSON.stringify(POPUP)}, active: true })).id;`);
    let t;
    for (let i = 0; i < 40 && !t; i++) { await sleep(100); t = (await targets()).find((x) => x.type === 'page' && x.url === POPUP); }
    await normalMode(t, 'popup.html without ?target (tab)');
    await evalSW(`await chrome.tabs.remove(${id}).catch(() => {});`);
  }

  // ---------- 13. close tab command (last: removes the target) ----------
  p = await openBar(T);
  await type(p, 'close');
  await key(p, 'Enter');
  await sleep(300);
  check(!(await tabsNow()).some((t) => t.id === T), 'close tab command closes the current tab');
  await p.done();

  browser.close();
  check(popupErrors.length === 0, `no errors in the command bar${popupErrors.length ? ': ' + popupErrors.join(' | ') : ''}`);
  check(sw.errors.length === 0, `no service worker errors${sw.errors.length ? ': ' + sw.errors.join(' | ') : ''}`);
} catch (err) {
  console.log('FAIL', err.message, err.stack?.split('\n').slice(1, 3).join(' '));
  failures++;
} finally {
  sw?.close();
  proc.kill();
  server.close();
  await sleep(1500);
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} failure(s)` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
