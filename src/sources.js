// Map chrome.* API results to search items. Pure functions (the popup does the API calls).

export function tabItem(tab, currentTabId, selfPrefix = '') {
  if (selfPrefix && (tab.url || tab.pendingUrl || '').startsWith(selfPrefix)) return null;
  return {
    kind: 'tab',
    id: `tab:${tab.id}`,
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || tab.url || '',
    url: tab.url || tab.pendingUrl || '',
    pinned: !!tab.pinned,
    audible: !!tab.audible,
    lastAccessed: tab.lastAccessed,
    current: tab.id === currentTabId,
  };
}

/** Flatten a bookmarks tree into URL items, with the folder path as extra searchable text. */
export function bookmarkItems(tree) {
  const out = [];
  const walk = (node, path) => {
    if (node.url) {
      out.push({ kind: 'bookmark', id: `bm:${node.id}`, title: node.title || node.url, url: node.url, folder: path.join(' / '), keywords: path.join(' ') });
      return;
    }
    const next = node.title ? [...path, node.title] : path;
    for (const child of node.children || []) walk(child, next);
  };
  for (const root of Array.isArray(tree) ? tree : [tree]) walk(root, []);
  return out;
}

export function historyItem(h) {
  if (!h.url) return null;
  return { kind: 'history', id: `h:${h.id}`, title: h.title || h.url, url: h.url, lastVisitTime: h.lastVisitTime, visitCount: h.visitCount };
}

/** chrome.sessions.getRecentlyClosed() → items (closed tabs, and closed windows as one item each). */
export function closedItems(sessions) {
  const out = [];
  for (const s of sessions || []) {
    const closedAt = s.lastModified ? s.lastModified * 1000 : undefined; // seconds → ms
    if (s.tab?.sessionId && s.tab.url) {
      out.push({ kind: 'closed', id: `closed:${s.tab.sessionId}`, sessionId: s.tab.sessionId, title: s.tab.title || s.tab.url, url: s.tab.url, closedAt });
    } else if (s.window?.sessionId) {
      const tabs = s.window.tabs || [];
      out.push({
        kind: 'closed', id: `closed:${s.window.sessionId}`, sessionId: s.window.sessionId,
        title: `窗口（${tabs.length} 个标签页）：${tabs.map((t) => t.title).filter(Boolean).slice(0, 3).join('、')}`,
        keywords: tabs.map((t) => `${t.title || ''} ${t.url || ''}`).join(' '),
        closedAt,
      });
    }
  }
  return out;
}

/** What Enter does with a URL: reuse the current tab if it is a blank / new tab page (or the user asked), else open a new one. */
export function openDisposition(currentTab, forceCurrent) {
  if (forceCurrent) return 'current';
  const u = currentTab?.url || currentTab?.pendingUrl || '';
  if (!currentTab || /^(chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|about:blank)$/i.test(u)) return currentTab ? 'current' : 'new';
  return 'new';
}
