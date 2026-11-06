// Pure search / ranking logic. No chrome.* here, so it runs under `node --test`.

/** Search result kinds, in the order used to break ties and to dedupe (first wins). */
export const KIND_ORDER = ['action', 'tab', 'archive', 'bookmark', 'closed', 'history'];

/** Base weight per kind: open tabs beat bookmarks beat history, like Arc. */
export const KIND_WEIGHT = { action: 1.0, tab: 1.2, bookmark: 1.0, closed: 0.95, archive: 0.9, history: 0.85, fallback: 0 };

const MAX_TEXT = 300;
const BOUNDARY = /[\s\-_./:?#&=()[\]|,·—–]/;

function isBoundary(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (BOUNDARY.test(prev)) return true;
  // camelCase: "gitHub" → boundary before "H"
  const ch = text[i];
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/**
 * Fuzzy-match `query` as a subsequence of `text`.
 * Returns `{ score, positions }` (positions index into `text`) or null when not every char matches.
 * Scoring favours: contiguous runs, matches at word starts, a match at index 0, and few skipped chars.
 */
export function fuzzyScore(query, text) {
  if (!query) return { score: 0, positions: [] };
  if (!text) return null;
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const q = query.toLowerCase();
  const lt = t.toLowerCase();
  if (q.length > lt.length) return null;

  let best = null;
  // Try every place the first char occurs as a starting point; greedy-forward from there.
  for (let start = lt.indexOf(q[0]); start !== -1; start = lt.indexOf(q[0], start + 1)) {
    const positions = [start];
    let ti = start + 1;
    for (let qi = 1; qi < q.length; qi++) {
      const next = lt.indexOf(q[qi], ti);
      if (next === -1) { positions.length = 0; break; }
      // When the run breaks anyway, prefer a nearby word start ("gh" in "git-hub" → g, h of hub),
      // as long as the rest of the query still fits after it.
      let pick = next;
      if (next !== ti) {
        for (let k = next; k !== -1 && k < next + 24; k = lt.indexOf(q[qi], k + 1)) {
          if (isBoundary(t, k) && isSubsequence(q, qi + 1, lt, k + 1)) { pick = k; break; }
        }
      }
      positions.push(pick);
      ti = pick + 1;
    }
    if (positions.length !== q.length) break; // later starts can't match either
    const score = scorePositions(t, positions);
    if (!best || score > best.score) best = { score, positions };
  }
  if (!best) return null;
  // A literal substring always beats a scattered match of the same query.
  const sub = lt.indexOf(q);
  if (sub !== -1) {
    const positions = Array.from({ length: q.length }, (_, i) => sub + i);
    const score = scorePositions(t, positions) + q.length;
    if (score > best.score) best = { score, positions };
  }
  return best;
}

function isSubsequence(q, qi, lt, ti) {
  for (; qi < q.length; qi++) {
    ti = lt.indexOf(q[qi], ti);
    if (ti === -1) return false;
    ti++;
  }
  return true;
}

function scorePositions(text, positions) {
  let score = 0;
  let run = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    score += 1;
    if (i > 0 && p === positions[i - 1] + 1) { run++; score += 2 + Math.min(run, 6); } else run = 0;
    if (isBoundary(text, p)) score += i === 0 ? 6 : 4;
    if (i > 0) score -= Math.min(p - positions[i - 1] - 1, 10) * 0.15;
  }
  if (positions[0] === 0) score += 4;
  score -= Math.min(positions[0], 30) * 0.05;
  return score;
}

/** Split a query into lowercase tokens. "Git  hub" → ["git", "hub"]. */
export function tokenize(query) {
  return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Host of a URL without "www.", or '' for non-URLs. */
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** URL shown / matched without the scheme noise: "https://www.github.com/x" → "github.com/x". */
export function displayUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/** Key for dedupe: drop the hash and a trailing slash. */
export function urlKey(url) {
  if (!url) return '';
  return url.replace(/#.*$/, '').replace(/\/$/, '');
}

/**
 * Score one item against tokens. Every token must match the title, the URL, or the keywords.
 * Returns `{ score, titlePositions, urlPositions }` or null.
 */
export function scoreItem(item, tokens, now = Date.now()) {
  const title = item.title || '';
  const url = displayUrl(item.url);
  const host = hostOf(item.url);
  const keywords = item.keywords || '';
  let total = 0;
  const titlePositions = new Set();
  const urlPositions = new Set();
  for (const tok of tokens) {
    const ts = fuzzyScore(tok, title);
    const us = url ? fuzzyScore(tok, url) : null;
    const ks = keywords ? fuzzyScore(tok, keywords) : null;
    let s = -Infinity;
    if (ts) s = ts.score;
    if (us) {
      let u = us.score * 0.8;
      if (host.startsWith(tok)) u += 6; // typing the start of a domain
      s = Math.max(s, u);
    }
    if (ks) s = Math.max(s, ks.score * 0.9);
    if (s === -Infinity) return null;
    // Highlight wherever it matched best, but at most one place.
    if (ts && ts.score >= (us ? us.score * 0.8 : -Infinity)) ts.positions.forEach((p) => titlePositions.add(p));
    else if (us) us.positions.forEach((p) => urlPositions.add(p));
    total += s;
  }
  const weight = KIND_WEIGHT[item.kind] ?? 1;
  return {
    score: total * weight + recencyBonus(item, now),
    titlePositions: [...titlePositions].sort((a, b) => a - b),
    urlPositions: [...urlPositions].sort((a, b) => a - b),
  };
}

/** 0..4 bonus for recently used / often visited items. */
export function recencyBonus(item, now = Date.now()) {
  const t = item.lastAccessed ?? item.lastVisitTime ?? item.closedAt ?? item.archivedAt ?? item.dateAdded;
  let bonus = 0;
  if (t) {
    const hours = Math.max(0, (now - t) / 3.6e6);
    bonus += 2.5 / (1 + hours / 24); // ~2.5 now, ~1.25 after a day
  }
  if (item.visitCount) bonus += Math.min(Math.log2(1 + item.visitCount) * 0.3, 1.5);
  return bonus;
}

/** Remove later duplicates of the same URL, keeping the higher-priority kind (tab > archive > bookmark > closed > history).
 * A Pinline archive entry beats the bookmark / closed copy: opening it also takes it out of the archive.. */
export function dedupe(items) {
  const rank = (k) => { const i = KIND_ORDER.indexOf(k); return i === -1 ? 99 : i; };
  const sorted = [...items].sort((a, b) => rank(a.kind) - rank(b.kind));
  const seen = new Set();
  const keep = new Set();
  for (const it of sorted) {
    if (!it.url || it.kind === 'action') { keep.add(it); continue; }
    const k = urlKey(it.url);
    if (seen.has(k)) continue;
    seen.add(k);
    keep.add(it);
  }
  return items.filter((it) => keep.has(it));
}

const ALLOWED_SCHEMES = /^(https?|file|ftp|chrome):\/\//i;
const HOSTLIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,63})(:\d{1,5})?([/?#]\S*)?$/i;

/**
 * Turn typed text into a URL if it looks like one, else null.
 * "github.com" → "https://github.com/", "localhost:3000" → "http://localhost:3000/".
 * javascript:, data: and other schemes are never treated as URLs.
 */
export function toUrl(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  if (ALLOWED_SCHEMES.test(s)) {
    try { return new URL(s).href; } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^localhost:/i.test(s)) return null; // other scheme
  if (!HOSTLIKE.test(s)) return null;
  const local = /^(localhost|(\d{1,3}\.){3}\d{1,3})(:|\/|$)/i.test(s);
  try { return new URL((local ? 'http://' : 'https://') + s).href; } catch { return null; }
}

/**
 * Rank all items for a query.
 * - Empty query: actions are hidden behind tabs; tabs by most recently used, then recently closed, then actions.
 * - Otherwise: fuzzy over title / URL / keywords, deduped by URL, best first, plus a fallback row
 *   ("open URL" or "search the web") which goes first if the query looks like a URL, else last.
 */
export function rankItems(items, query, { limit = 50, now = Date.now() } = {}) {
  const tokens = tokenize(query);
  const pool = dedupe(items.filter((i) => !i.current));
  if (!tokens.length) {
    const byRecent = (a, b) => (b.lastAccessed ?? b.closedAt ?? 0) - (a.lastAccessed ?? a.closedAt ?? 0);
    const tabs = pool.filter((i) => i.kind === 'tab').sort(byRecent);
    const closed = pool.filter((i) => i.kind === 'closed').sort(byRecent).slice(0, 5);
    const actions = pool.filter((i) => i.kind === 'action');
    return [...tabs.slice(0, 8), ...actions, ...closed, ...tabs.slice(8)]
      .slice(0, limit)
      .map((item) => ({ item, score: 0, titlePositions: [], urlPositions: [] }));
  }
  const kindRank = (k) => KIND_ORDER.indexOf(k);
  const scored = [];
  for (const item of pool) {
    const r = scoreItem(item, tokens, now);
    if (r) scored.push({ item, ...r });
  }
  scored.sort((a, b) => b.score - a.score || kindRank(a.item.kind) - kindRank(b.item.kind));
  const out = scored.slice(0, limit - 1);
  const url = toUrl(query);
  const fallback = url
    ? { item: { kind: 'fallback', id: 'fallback', mode: 'url', url, title: url }, score: Infinity, titlePositions: [], urlPositions: [] }
    : { item: { kind: 'fallback', id: 'fallback', mode: 'search', title: String(query).trim() }, score: -Infinity, titlePositions: [], urlPositions: [] };
  return url ? [fallback, ...out] : [...out, fallback];
}
