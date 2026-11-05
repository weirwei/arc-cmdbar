import test from 'node:test';
import assert from 'node:assert/strict';
import { tabItem, bookmarkItems, historyItem, closedItems, openDisposition } from '../src/sources.js';
import { ACTIONS, actionItems, findAction } from '../src/actions.js';

test('tabItem maps a tab, marks the current one, skips our own page', () => {
  const t = tabItem({ id: 5, windowId: 1, title: 'A', url: 'https://a.com/', pinned: true, lastAccessed: 9 }, 5);
  assert.equal(t.kind, 'tab');
  assert.equal(t.current, true);
  assert.equal(t.pinned, true);
  assert.equal(tabItem({ id: 6, url: 'chrome-extension://x/src/popup.html?target=1' }, 5, 'chrome-extension://x/src/popup.html'), null);
  assert.equal(tabItem({ id: 7, pendingUrl: 'https://b.com/' }, 5).url, 'https://b.com/');
});

test('bookmarkItems flattens the tree, keeps the folder path as keywords', () => {
  const tree = [{ id: '0', title: '', children: [
    { id: '1', title: 'Bookmarks bar', children: [
      { id: '10', title: 'Kiwi', url: 'https://kiwi/' },
      { id: '11', title: 'Work', children: [{ id: '12', title: '', url: 'https://w/' }] },
    ] },
  ] }];
  const items = bookmarkItems(tree);
  assert.deepEqual(items.map((i) => i.id), ['bm:10', 'bm:12']);
  assert.equal(items[1].title, 'https://w/'); // untitled → URL
  assert.equal(items[1].folder, 'Bookmarks bar / Work');
});

test('historyItem / closedItems', () => {
  assert.equal(historyItem({ id: '1' }), null);
  assert.equal(historyItem({ id: '1', url: 'https://a/', title: '' }).title, 'https://a/');
  const closed = closedItems([
    { lastModified: 100, tab: { sessionId: 's1', title: 'Mango', url: 'https://m/' } },
    { lastModified: 50, window: { sessionId: 's2', tabs: [{ title: 'A', url: 'https://a/' }, { title: 'B', url: 'https://b/' }] } },
    { lastModified: 10, tab: { sessionId: 's3' } }, // no url → skipped
  ]);
  assert.deepEqual(closed.map((c) => c.sessionId), ['s1', 's2']);
  assert.equal(closed[0].closedAt, 100_000);
  assert.match(closed[1].title, /2 个标签页/);
  assert.match(closed[1].keywords, /https:\/\/b\//);
});

test('openDisposition reuses blank / new tab pages', () => {
  assert.equal(openDisposition({ url: 'chrome://newtab/' }), 'current');
  assert.equal(openDisposition({ url: 'about:blank' }), 'current');
  assert.equal(openDisposition({ url: 'https://a.com/' }), 'new');
  assert.equal(openDisposition({ url: 'https://a.com/' }, true), 'current');
  assert.equal(openDisposition(null), 'new');
});

test('actions: availability and titles follow the target tab', () => {
  const tab = { id: 1, url: 'https://a.com/x', title: 'A [x]', pinned: false, mutedInfo: { muted: false } };
  const ids = (ctx) => actionItems(ctx).map((a) => a.actionId);
  assert.ok(!ids({ tab }).includes('reset-tab'), 'no reset without a home URL');
  assert.ok(!ids({ tab, home: 'https://a.com/x#top' }).includes('reset-tab'), 'no reset when already home');
  assert.ok(ids({ tab, home: 'https://a.com/' }).includes('reset-tab'));
  assert.ok(!ids({ tab }).includes('reopen-closed'));
  assert.ok(ids({ tab, hasClosed: true }).includes('reopen-closed'));
  assert.deepEqual(ids({ tab: null }), ['new-tab']);
  assert.ok(!ids({ tab: { id: 2, url: 'chrome://settings/' } }).includes('toggle-mute'));
  const title = (id, ctx) => actionItems(ctx).find((a) => a.actionId === id).title;
  assert.equal(title('toggle-pin', { tab }), '固定标签页');
  assert.equal(title('toggle-pin', { tab: { ...tab, pinned: true } }), '取消固定标签页');
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length, 'ids are unique');
});

test('actions: run() calls the right chrome API', async () => {
  const calls = [];
  const fake = new Proxy({}, { get: (_, ns) => new Proxy({}, { get: (_, fn) => (...args) => { calls.push([`${ns}.${fn}`, ...args]); } }) });
  const copied = [];
  const tab = { id: 3, windowId: 1, url: 'https://a.com/', title: 'A [b]', pinned: true, mutedInfo: { muted: true } };
  const ctx = { tab, home: 'https://a.com/home', clipboard: (t) => copied.push(t) };
  for (const id of ['close-tab', 'toggle-pin', 'reset-tab', 'toggle-mute', 'duplicate-tab', 'move-to-window', 'copy-url', 'copy-markdown']) {
    await findAction(id).run(ctx, fake);
  }
  assert.deepEqual(calls, [
    ['tabs.remove', 3],
    ['tabs.update', 3, { pinned: false }],
    ['tabs.update', 3, { url: 'https://a.com/home' }],
    ['tabs.update', 3, { muted: false }],
    ['tabs.duplicate', 3],
    ['windows.create', { tabId: 3 }],
  ]);
  assert.deepEqual(copied, ['https://a.com/', '[A \\[b\\]](https://a.com/)']);
});
