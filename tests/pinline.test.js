import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PINLINE_ID, pinlineItems, applyPinlineTabs, realTab } from '../src/pinline.js';
import { actionItems } from '../src/actions.js';
import { rankItems, dedupe } from '../src/rank.js';

const tab = (tabId, windowId, url, title = url) => ({ kind: 'tab', id: `tab:${tabId}`, tabId, windowId, url, title });
const SLEEP = 'chrome-extension://ebdnmlhdkdijlgjlmnpjjnkejcgonjke/src/sleep.html?url=x';

test('pinlineItems: commands become actions, archive entries become URL items; junk is dropped', () => {
  const items = pinlineItems({
    protocol: 1,
    commands: [
      { id: 'toggle-pin', title: '设为 Pin', keywords: 'pin', kind: 'command' },
      { id: 'space:s2', title: '切到 Space：个人', keywords: 'space 个人', kind: 'space' },
      { id: 'archive:a1', title: 'GitHub', url: 'https://github.com/', at: 7, kind: 'archive' },
      { id: 'archive:a2', title: 'no url', kind: 'archive' },
      { id: 5, title: 'bad id' },
      null,
    ],
  });
  assert.deepEqual(items.map((i) => [i.kind, i.id, i.pinline, i.badge]), [
    ['action', 'pinline:toggle-pin', 'toggle-pin', 'Pinline'],
    ['action', 'pinline:space:s2', 'space:s2', 'Space'],
    ['archive', 'pinline:archive:a1', 'archive:a1', '归档'],
  ]);
  assert.equal(items[2].archivedAt, 7);
  assert.deepEqual(pinlineItems(null), []);
  assert.deepEqual(pinlineItems({ protocol: 2, commands: [{ id: 'x', title: 'x' }] }), [], 'unknown protocol version is ignored');
});

test('applyPinlineTabs: hides the divider, real URLs and names, one row per Fav (this window first)', () => {
  const tabs = [
    tab(1, 1, 'https://mail.google.com/', 'Inbox'), // Fav, window 1
    tab(2, 1, 'chrome-extension://p/src/divider.html'),
    tab(3, 1, SLEEP, 'GitHub'), // sleeping Pin
    tab(4, 1, 'https://a.com/'),
    tab(5, 2, SLEEP, 'Inbox'), // Fav copy, window 2
  ];
  const ann = {
    1: { role: 'fav', id: 'f1', url: 'https://mail.google.com/', name: '' },
    2: { role: 'divider' },
    3: { role: 'pin', id: 'p1', url: 'https://github.com/', name: '代码' },
    5: { role: 'fav', id: 'f1', url: 'https://mail.google.com/', name: '' },
  };
  const out = applyPinlineTabs(tabs, ann, 2);
  assert.deepEqual(out.map((t) => t.tabId), [5, 3, 4], 'divider gone; the Fav copy of window 2 replaces window 1’s');
  assert.equal(out[1].url, 'https://github.com/');
  assert.equal(out[1].title, '代码');
  assert.equal(out[1].role, 'pin');
  assert.equal(out[0].role, 'fav');
  assert.equal(out[0].title, 'Inbox', 'no name → page title');
  assert.equal(applyPinlineTabs(tabs, null, 1), tabs, 'without Pinline nothing changes');
  assert.equal(tabs[2].url, SLEEP, 'input not mutated');
});

test('a sleeping Pin dedupes against its bookmark once it has its real URL', () => {
  const tabs = applyPinlineTabs([tab(3, 1, SLEEP, 'GitHub')], { 3: { role: 'pin', id: 'p1', url: 'https://github.com/' } }, 1);
  const bm = { kind: 'bookmark', id: 'bm:1', title: 'GitHub', url: 'https://github.com/' };
  assert.deepEqual(dedupe([...tabs, bm]).map((i) => i.kind), ['tab']);
});

test('an archived tab beats its recently-closed / bookmark / history copies', () => {
  const url = 'https://junk.example/';
  const items = [
    { kind: 'closed', id: 'closed:1', url, title: 'Junk' },
    { kind: 'bookmark', id: 'bm:1', url, title: 'Junk' },
    { kind: 'history', id: 'h:1', url, title: 'Junk' },
    { kind: 'archive', id: 'pinline:archive:a', url, title: 'Junk' },
  ];
  assert.deepEqual(dedupe(items).map((i) => i.kind), ['archive']);
});

test('realTab swaps in the real URL of a sleeping target', () => {
  const t = { id: 3, url: SLEEP };
  assert.equal(realTab(t, { 3: { url: 'https://github.com/' } }).url, 'https://github.com/');
  assert.equal(realTab(t, {}), t);
  assert.equal(realTab(null, {}), null);
});

test('with Pinline, our pin / reset actions are hidden (Pinline’s Fav / Pin replace them)', () => {
  const ctx = { tab: { id: 1, url: 'https://a.com/', pinned: true }, home: 'https://b.com/' };
  const without = actionItems(ctx).map((a) => a.actionId);
  assert.ok(without.includes('toggle-pin') && without.includes('reset-tab'));
  const withP = actionItems({ ...ctx, pinline: true }).map((a) => a.actionId);
  assert.ok(!withP.includes('toggle-pin') && !withP.includes('reset-tab'));
  assert.ok(withP.includes('copy-url'));
});

test('Pinline items are searchable by pinyin / Space name and archive ranks below open tabs', () => {
  const items = pinlineItems({ protocol: 1, commands: [
    { id: 'space:s2', title: '切到 Space：读书', keywords: 'space switch pinline qiehuan kongjian 读书', kind: 'space' },
    { id: 'archive:a1', title: 'Kiwi', url: 'https://kiwi.example/', at: Date.now(), kind: 'archive' },
  ] });
  assert.equal(rankItems(items, 'qiehuan')[0].item.id, 'pinline:space:s2');
  const res = rankItems([...items, tab(9, 1, 'https://kiwi.example/k2', 'Kiwi')], 'kiwi').filter((r) => r.item.kind !== 'fallback');
  assert.deepEqual(res.map((r) => r.item.kind), ['tab', 'archive']);
});

test('manifest: fixed key; PINLINE_ID matches Pinline’s key', async () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(m.key);
  const pinline = new URL('../../pinline/manifest.json', import.meta.url);
  let other;
  try { other = JSON.parse(readFileSync(pinline, 'utf8')); } catch { return; } // Pinline not checked out next to us
  const { createHash } = await import('node:crypto');
  const id = (key) => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32).replace(/./g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
  assert.equal(id(other.key), PINLINE_ID);
  assert.deepEqual(other.externally_connectable?.ids, [id(m.key)], 'Pinline accepts exactly this extension');
});
