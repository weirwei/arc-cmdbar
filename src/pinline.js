// Commands from the Pinline extension (Favs, Pins, Spaces, archive), merged into the search pool.
// Pure functions; the popup does the messaging. Pinline answers only this extension (fixed ids via manifest `key`).

export const PINLINE_ID = 'ebdnmlhdkdijlgjlmnpjjnkejcgonjke';
export const PINLINE_PROTOCOL = 1;

/** Our own actions that Pinline does better when it is installed (native pin = Fav there; Pins have a home URL). */
export const REPLACED_BY_PINLINE = new Set(['toggle-pin', 'reset-tab']);

const BADGE = { command: 'Pinline', space: 'Space', archive: '归档' };

/** A cmdbar:list answer → search items. Anything malformed is dropped. */
export function pinlineItems(res) {
  if (!res || res.protocol !== PINLINE_PROTOCOL || !Array.isArray(res.commands)) return [];
  const out = [];
  for (const c of res.commands) {
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') continue;
    const base = { id: `pinline:${c.id}`, pinline: c.id, title: c.title, keywords: typeof c.keywords === 'string' ? c.keywords : '', badge: BADGE[c.kind] ?? 'Pinline' };
    if (c.kind === 'archive') {
      if (typeof c.url !== 'string' || !c.url) continue;
      out.push({ ...base, kind: 'archive', url: c.url, archivedAt: Number.isFinite(c.at) ? c.at : undefined });
    } else out.push({ ...base, kind: 'action' });
  }
  return out;
}

/**
 * Show Pinline's tabs the way Pinline means them: the divider is hidden, sleeping placeholders get their
 * real URL, Favs / Pins get their name and badge, and a Fav (one sleeping copy per window) is listed once,
 * preferring the copy in `windowId`.
 */
export function applyPinlineTabs(tabs, annotations, windowId) {
  if (!annotations || typeof annotations !== 'object') return tabs;
  const out = [];
  const favAt = new Map(); // fav id -> index in out
  for (const t of tabs) {
    const a = annotations[t.tabId];
    if (!a) { out.push(t); continue; }
    if (a.role === 'divider') continue;
    const it = { ...t };
    if (typeof a.url === 'string' && a.url) it.url = a.url;
    if (a.role === 'fav' || a.role === 'pin') {
      it.role = a.role;
      if (typeof a.name === 'string' && a.name) it.title = a.name;
    }
    if (a.role === 'fav' && a.id) {
      const at = favAt.get(a.id);
      if (at !== undefined) {
        if (it.windowId === windowId && out[at].windowId !== windowId) out[at] = it;
        continue;
      }
      favAt.set(a.id, out.length);
    }
    out.push(it);
  }
  return out;
}

/** The target tab with its real URL (a sleeping Pinline placeholder has an extension URL). */
export function realTab(tab, annotations) {
  const url = tab && annotations?.[tab.id]?.url;
  return url ? { ...tab, url } : tab;
}
