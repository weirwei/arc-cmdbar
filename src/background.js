// Remembers the URL a tab had when it was pinned, so the command bar can "reset" it (Arc's reset for pinned tabs).
// Stored in chrome.storage.session: survives service worker restarts, cleared when the browser quits.

const KEY = 'homes';

async function getHomes() {
  return (await chrome.storage.session.get(KEY))[KEY] || {};
}

// Serialise read-modify-write so concurrent tab events don't overwrite each other.
let chain = Promise.resolve();
function edit(fn) {
  chain = chain.then(async () => {
    const homes = await getHomes();
    if (fn(homes) !== false) await chrome.storage.session.set({ [KEY]: homes });
  }).catch((e) => console.warn('arc-cmdbar: homes update failed', e));
  return chain;
}

/** Pinned tabs that we have no home for yet (pinned before install / before this browser session). */
async function adoptPinned() {
  const tabs = await chrome.tabs.query({ pinned: true });
  await edit((homes) => {
    let changed = false;
    for (const t of tabs) {
      const url = t.url || t.pendingUrl;
      if (url && !homes[t.id]) { homes[t.id] = url; changed = true; }
    }
    return changed;
  });
}

chrome.runtime.onInstalled.addListener(adoptPinned);
chrome.runtime.onStartup.addListener(adoptPinned);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.pinned === true) edit((h) => { h[tabId] = tab.url || tab.pendingUrl; });
  else if (info.pinned === false) edit((h) => { if (!(tabId in h)) return false; delete h[tabId]; });
});

chrome.tabs.onRemoved.addListener((tabId) => edit((h) => { if (!(tabId in h)) return false; delete h[tabId]; }));

chrome.tabs.onReplaced.addListener((added, removed) => edit((h) => {
  if (!(removed in h)) return false;
  h[added] = h[removed];
  delete h[removed];
}));
