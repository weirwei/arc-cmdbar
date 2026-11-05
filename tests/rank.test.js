import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, tokenize, scoreItem, dedupe, toUrl, rankItems, displayUrl, urlKey, recencyBonus } from '../src/rank.js';

const NOW = Date.UTC(2026, 10, 5);

test('fuzzyScore: subsequence match, case-insensitive, with positions', () => {
  const r = fuzzyScore('gh', 'GitHub');
  assert.ok(r);
  assert.deepEqual(r.positions, [0, 3]); // G…H (camel boundary preferred over nothing)
  assert.equal(fuzzyScore('xyz', 'GitHub'), null);
  assert.equal(fuzzyScore('hubg', 'GitHub'), null); // order matters
  assert.deepEqual(fuzzyScore('', 'abc'), { score: 0, positions: [] });
  assert.equal(fuzzyScore('a', ''), null);
});

test('fuzzyScore: contiguous beats scattered, word start beats middle, prefix beats later', () => {
  const contiguous = fuzzyScore('doc', 'Docs home').score;
  const scattered = fuzzyScore('doc', 'D o c s').score;
  assert.ok(contiguous > scattered, `${contiguous} > ${scattered}`);
  const wordStart = fuzzyScore('not', 'Zebra Notes').score;
  const middle = fuzzyScore('not', 'Zebranotes').score;
  assert.ok(wordStart > middle, `${wordStart} > ${middle}`);
  assert.ok(fuzzyScore('ma', 'Mail').score > fuzzyScore('ma', 'Gmail').score);
});

test('fuzzyScore: prefers word starts for later chars (acronyms)', () => {
  const r = fuzzyScore('zbnt', 'Zebra Notes');
  assert.ok(r);
  assert.deepEqual(r.positions, [0, 2, 6, 8]); // z e(b) … N o(t)
  const acr = fuzzyScore('gcal', 'Google Calendar');
  assert.deepEqual(acr.positions.slice(0, 2), [0, 7]); // G, C of Calendar
});

test('fuzzyScore: a boundary pick never makes a match fail', () => {
  // "ab": the "b" at a word start (index 4) is fine; "abc" still needs the c after it.
  assert.ok(fuzzyScore('abc', 'ab-b c'));
  assert.ok(fuzzyScore('abx', 'a b_x b'));
});

test('fuzzyScore works on CJK text', () => {
  const r = fuzzyScore('文档', '项目文档 - 飞书');
  assert.deepEqual(r.positions, [2, 3]);
});

test('tokenize splits on whitespace and lowercases', () => {
  assert.deepEqual(tokenize('  Git  HUB '), ['git', 'hub']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('displayUrl / urlKey', () => {
  assert.equal(displayUrl('https://www.github.com/pulls/'), 'github.com/pulls');
  assert.equal(displayUrl('chrome://settings/'), 'chrome://settings');
  assert.equal(urlKey('https://a.com/x/#frag'), 'https://a.com/x');
});

test('scoreItem: every token must match title, URL or keywords', () => {
  const item = { kind: 'bookmark', title: 'Pull requests', url: 'https://github.com/pulls' };
  assert.ok(scoreItem(item, ['pull', 'git'], NOW));
  assert.equal(scoreItem(item, ['pull', 'zzz'], NOW), null);
  const act = { kind: 'action', title: '关闭当前标签页', keywords: 'close tab guanbi' };
  assert.ok(scoreItem(act, ['close'], NOW));
  assert.ok(scoreItem(act, ['关闭'], NOW));
});

test('scoreItem: typing the start of a domain gets a bonus and highlights the URL', () => {
  const a = scoreItem({ kind: 'history', title: 'Home', url: 'https://github.com/' }, ['gith'], NOW);
  const b = scoreItem({ kind: 'history', title: 'Home', url: 'https://example.com/?q=github' }, ['gith'], NOW);
  assert.ok(a.score > b.score);
  assert.deepEqual(a.urlPositions, [0, 1, 2, 3]);
  assert.deepEqual(a.titlePositions, []);
});

test('recencyBonus: recent and frequently visited items get more', () => {
  const fresh = recencyBonus({ lastVisitTime: NOW - 60_000 }, NOW);
  const old = recencyBonus({ lastVisitTime: NOW - 30 * 864e5 }, NOW);
  assert.ok(fresh > old);
  assert.ok(recencyBonus({ visitCount: 50 }, NOW) > recencyBonus({ visitCount: 1 }, NOW));
  assert.ok(recencyBonus({ visitCount: 1e9 }, NOW) <= 1.5);
  assert.equal(recencyBonus({}, NOW), 0);
});

test('dedupe keeps the tab over a bookmark / history entry with the same URL', () => {
  const items = [
    { kind: 'history', id: 'h', url: 'https://a.com/#x' },
    { kind: 'bookmark', id: 'b', url: 'https://a.com/' },
    { kind: 'tab', id: 't', url: 'https://a.com' },
    { kind: 'closed', id: 'c', url: 'https://b.com/' },
    { kind: 'history', id: 'h2', url: 'https://b.com/' },
    { kind: 'action', id: 'act' },
  ];
  assert.deepEqual(dedupe(items).map((i) => i.id), ['t', 'c', 'act']);
});

test('toUrl recognises URLs and bare hosts, rejects searches and dangerous schemes', () => {
  assert.equal(toUrl('github.com'), 'https://github.com/');
  assert.equal(toUrl('github.com/pulls?x=1'), 'https://github.com/pulls?x=1');
  assert.equal(toUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(toUrl('127.0.0.1:8080/a'), 'http://127.0.0.1:8080/a');
  assert.equal(toUrl('https://example.org/x'), 'https://example.org/x');
  assert.equal(toUrl('chrome://settings'), 'chrome://settings');
  assert.equal(toUrl('hello world'), null);
  assert.equal(toUrl('github'), null);
  assert.equal(toUrl('readme.md'), 'https://readme.md/'); // .md is a real TLD; Arc does the same
  assert.equal(toUrl('javascript:alert(1)'), null);
  assert.equal(toUrl('data:text/html,hi'), null);
  assert.equal(toUrl('mailto:a@b.com'), null);
  assert.equal(toUrl(''), null);
});

const POOL = [
  { kind: 'action', id: 'action:close-tab', actionId: 'close-tab', title: '关闭当前标签页', keywords: 'close tab guanbi' },
  { kind: 'action', id: 'action:copy-url', actionId: 'copy-url', title: '复制当前网址', keywords: 'copy url link fuzhi' },
  { kind: 'tab', id: 'tab:1', title: 'Zebra Notes', url: 'http://127.0.0.1/zebra', lastAccessed: NOW - 1000 },
  { kind: 'tab', id: 'tab:2', title: 'Current page', url: 'http://127.0.0.1/cur', lastAccessed: NOW, current: true },
  { kind: 'tab', id: 'tab:3', title: 'Older tab', url: 'http://127.0.0.1/old', lastAccessed: NOW - 864e5 },
  { kind: 'bookmark', id: 'bm:1', title: 'Kiwi Docs', url: 'http://127.0.0.1/kiwi' },
  { kind: 'bookmark', id: 'bm:2', title: 'Zebra Notes', url: 'http://127.0.0.1/zebra' },
  { kind: 'history', id: 'h:1', title: 'Zebra crossing rules', url: 'http://127.0.0.1/zebra-x', lastVisitTime: NOW - 5000, visitCount: 3 },
  { kind: 'closed', id: 'closed:9', sessionId: '9', title: 'Mango', url: 'http://127.0.0.1/mango', closedAt: NOW - 2000 },
];

test('rankItems: empty query lists other tabs by recency, then actions, then recently closed', () => {
  const r = rankItems(POOL, '', { now: NOW }).map((x) => x.item.id);
  assert.deepEqual(r, ['tab:1', 'tab:3', 'action:close-tab', 'action:copy-url', 'closed:9']);
  assert.ok(!r.includes('tab:2'), 'current tab is not offered');
});

test('rankItems: open tab ranks above the identical bookmark and above history', () => {
  const r = rankItems(POOL, 'zebra', { now: NOW });
  assert.equal(r[0].item.id, 'tab:1');
  assert.ok(!r.some((x) => x.item.id === 'bm:2'), 'bookmark with the same URL as an open tab is hidden');
  assert.ok(r.findIndex((x) => x.item.id === 'h:1') > 0);
  assert.equal(r.at(-1).item.kind, 'fallback');
  assert.equal(r.at(-1).item.mode, 'search');
});

test('rankItems: fuzzy query, actions by keyword, recently closed', () => {
  assert.equal(rankItems(POOL, 'zbnt', { now: NOW })[0].item.id, 'tab:1');
  assert.equal(rankItems(POOL, 'kiwi', { now: NOW })[0].item.id, 'bm:1');
  assert.equal(rankItems(POOL, 'close', { now: NOW })[0].item.id, 'action:close-tab');
  assert.equal(rankItems(POOL, 'copy url', { now: NOW })[0].item.id, 'action:copy-url');
  assert.equal(rankItems(POOL, '复制', { now: NOW })[0].item.id, 'action:copy-url');
  assert.equal(rankItems(POOL, 'mango', { now: NOW })[0].item.id, 'closed:9');
});

test('rankItems: URL-looking query puts "open URL" first', () => {
  const r = rankItems(POOL, 'example.com', { now: NOW });
  assert.equal(r[0].item.kind, 'fallback');
  assert.equal(r[0].item.mode, 'url');
  assert.equal(r[0].item.url, 'https://example.com/');
});

test('rankItems: nothing matches → only the search row', () => {
  const r = rankItems(POOL, 'qqqqqq', { now: NOW });
  assert.equal(r.length, 1);
  assert.equal(r[0].item.mode, 'search');
  assert.equal(r[0].item.title, 'qqqqqq');
});

test('rankItems respects the limit and stays fast on 5000 items', () => {
  const big = [];
  for (let i = 0; i < 5000; i++) big.push({ kind: 'history', id: `h:${i}`, title: `Page number ${i} about things`, url: `https://site${i % 50}.example.com/path/${i}`, lastVisitTime: NOW - i * 1000, visitCount: i % 7 });
  const t = performance.now();
  const r = rankItems(big, 'page thing', { now: NOW, limit: 50 });
  const ms = performance.now() - t;
  assert.equal(r.length, 50);
  assert.ok(ms < 200, `ranking 5000 items took ${ms.toFixed(1)} ms`);
});
