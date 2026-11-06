// Command list. `title` / `available` only look at the context, so they are unit-testable;
// `run` talks to the chrome.* API passed in.
import { urlKey } from './rank.js';
import { REPLACED_BY_PINLINE } from './pinline.js';

const isWeb = (url) => /^(https?|file|ftp):/i.test(url || '');

/**
 * ctx = { tab, home, hasClosed, clipboard }
 *   tab:       the tab the command acts on (the active tab when the popup opened)
 *   home:      URL the tab had when it was pinned (for "reset"), if known
 *   hasClosed: whether chrome.sessions has something to reopen
 *   pinline:   Pinline is installed (it replaces our pin / reset actions)
 */
export const ACTIONS = [
  {
    id: 'new-tab',
    title: () => '新建标签页',
    keywords: 'new tab xinjian biaoqian',
    available: () => true,
    run: (ctx, c) => c.tabs.create({ windowId: ctx.tab?.windowId }),
  },
  {
    id: 'close-tab',
    title: () => '关闭当前标签页',
    keywords: 'close tab guanbi',
    available: (ctx) => !!ctx.tab,
    run: (ctx, c) => c.tabs.remove(ctx.tab.id),
  },
  {
    id: 'copy-url',
    title: () => '复制当前网址',
    keywords: 'copy url link fuzhi wangzhi lianjie',
    available: (ctx) => !!ctx.tab?.url,
    run: (ctx) => ctx.clipboard(ctx.tab.url),
  },
  {
    id: 'copy-markdown',
    title: () => '复制为 Markdown 链接',
    keywords: 'copy markdown link md fuzhi',
    available: (ctx) => !!ctx.tab?.url,
    run: (ctx) => ctx.clipboard(`[${(ctx.tab.title || ctx.tab.url).replace(/([[\]])/g, '\\$1')}](${ctx.tab.url})`),
  },
  {
    id: 'toggle-pin',
    title: (ctx) => (ctx.tab?.pinned ? '取消固定标签页' : '固定标签页'),
    keywords: 'pin unpin tab guding',
    available: (ctx) => !!ctx.tab,
    run: (ctx, c) => c.tabs.update(ctx.tab.id, { pinned: !ctx.tab.pinned }),
  },
  {
    id: 'reset-tab',
    title: () => '重置标签页（回到固定时的网址）',
    keywords: 'reset tab home pinned chongzhi',
    available: (ctx) => !!(ctx.tab && ctx.home && urlKey(ctx.home) !== urlKey(ctx.tab.url)),
    run: (ctx, c) => c.tabs.update(ctx.tab.id, { url: ctx.home }),
  },
  {
    id: 'duplicate-tab',
    title: () => '创建标签页副本',
    keywords: 'duplicate tab clone fuben',
    available: (ctx) => !!ctx.tab,
    run: (ctx, c) => c.tabs.duplicate(ctx.tab.id),
  },
  {
    id: 'reload-tab',
    title: () => '重新加载',
    keywords: 'reload refresh shuaxin jiazai',
    available: (ctx) => !!ctx.tab,
    run: (ctx, c) => c.tabs.reload(ctx.tab.id),
  },
  {
    id: 'toggle-mute',
    title: (ctx) => (ctx.tab?.mutedInfo?.muted ? '取消静音' : '静音标签页'),
    keywords: 'mute unmute sound jingyin',
    available: (ctx) => !!ctx.tab && isWeb(ctx.tab.url),
    run: (ctx, c) => c.tabs.update(ctx.tab.id, { muted: !ctx.tab.mutedInfo?.muted }),
  },
  {
    id: 'move-to-window',
    title: () => '移到新窗口',
    keywords: 'move tab new window yidong chuangkou',
    available: (ctx) => !!ctx.tab,
    run: (ctx, c) => c.windows.create({ tabId: ctx.tab.id }),
  },
  {
    id: 'reopen-closed',
    title: () => '重新打开刚关闭的标签页',
    keywords: 'reopen restore closed undo dakai',
    available: (ctx) => !!ctx.hasClosed,
    run: (_ctx, c) => c.sessions.restore(),
  },
];

/** Action items for the search pool. */
export function actionItems(ctx) {
  return ACTIONS.filter((a) => a.available(ctx) && !(ctx.pinline && REPLACED_BY_PINLINE.has(a.id))).map((a) => ({
    kind: 'action', id: `action:${a.id}`, actionId: a.id, title: a.title(ctx), keywords: a.keywords,
  }));
}

export function findAction(id) {
  return ACTIONS.find((a) => a.id === id);
}
