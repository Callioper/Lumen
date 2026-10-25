// Sends the current tab's rendered page to Lumen, which archives it into Obsidian.
const LUMEN = 'http://127.0.0.1:8780';
const MENU_ID = 'lumen-archive';
const SHARE_MENU_ID = 'lumen-share';
const BADGE_CLEAR_MS = 4000;
const busyTabs = new Set();

// Runs inside the page (async: executeScript hands back what it resolves to). The live DOM has what a server-side fetch misses: logged-in content,
// WeChat's rendered body, the account name and the publish time.
async function collectPage() {
  // Pressed right after the page opened: wait (at most ~3 s) until it has rendered. WeChat fills
  // its body, account name and date by script after the load event.
  const ready = () => document.readyState === 'complete'
    && (!/(^|\.)mp\.weixin\.qq\.com$/.test(location.hostname) || document.querySelector('#js_image_desc')
      || (document.querySelector('#js_content')?.textContent.trim() && document.querySelector('#js_name')));
  for (let i = 0; i < 20 && !ready(); i++) await new Promise((r) => setTimeout(r, 150));
  const q = (s) => document.querySelector(s);
  const meta = (s) => q(s)?.getAttribute('content')?.trim() || '';
  const text = (s) => q(s)?.textContent?.trim() || '';
  // A WeChat image post (贴图) keeps its words in #js_image_desc and its pictures in the carousel at
  // the top; #js_content there holds only the tip panel. Words first, then the pictures. Only the
  // carousel under #page_top_area: a hidden copy above it repeats the first picture.
  const imagePost = () => {
    const desc = q('#js_image_desc');
    if (!/(^|\.)mp\.weixin\.qq\.com$/.test(location.hostname) || !desc) return '';
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const srcOf = (el) => {
      const img = el.matches('img') ? el : el.querySelector('img');
      const src = img?.getAttribute('data-src') || img?.currentSrc || img?.src
        || /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '')?.[1] || '';
      return /^https?:/.test(src) ? src : '';
    };
    const pics = [...new Set([...document.querySelectorAll('#page_top_area .swiper_item_img')].map(srcOf).filter(Boolean))];
    const words = desc.innerText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return `<html><head><title>${esc(document.title)}</title></head><body><article>${words.map((s) => `<p>${esc(s)}</p>`).join('')}`
      + `${pics.map((s) => `<p><img src="${esc(s)}"></p>`).join('')}</article></body></html>`;
  };
  return {
    url: location.href.replace(/#.*$/, ''),
    title: meta('meta[property="og:title"]') || document.title,
    html: imagePost() || document.documentElement.outerHTML,
    selectedText: String(window.getSelection() ?? '').trim(),
    // Shared posts have no #js_name; the account name is only on the follow bar.
    siteName: text('#js_name') || text('#js_wx_follow_nickname') || meta('meta[property="og:site_name"]'),
    author: text('#js_author_name') || meta('meta[name="author"]') || meta('meta[property="article:author"]'),
    published: text('#publish_time') || meta('meta[property="article:published_time"]') || q('time[datetime]')?.getAttribute('datetime') || '',
  };
}

// Runs inside the page: what a share card needs beyond collectPage (cover, blurb, site icon).
// collectPage is not callable from here, so the fields it shares are read again.
async function collectShare() {
  // Pressed right after the page opened: wait (at most ~3 s) until it has rendered. WeChat fills
  // its body, account name and date by script after the load event.
  const ready = () => document.readyState === 'complete'
    && (!/(^|\.)mp\.weixin\.qq\.com$/.test(location.hostname) || (document.querySelector('#js_content')?.textContent.trim() && document.querySelector('#js_name')));
  for (let i = 0; i < 20 && !ready(); i++) await new Promise((r) => setTimeout(r, 150));
  const q = (s) => document.querySelector(s);
  const meta = (s) => q(s)?.getAttribute('content')?.trim() || '';
  const text = (s) => q(s)?.textContent?.trim() || '';
  const bigImage = [...document.images].find((i) => i.naturalWidth >= 400 && i.naturalHeight >= 200)?.currentSrc || '';
  return {
    url: location.href.replace(/#.*$/, ''),
    title: meta('meta[property="og:title"]') || document.title,
    html: document.documentElement.outerHTML,
    selectedText: String(window.getSelection() ?? '').trim(),
    siteName: text('#js_name') || text('#js_wx_follow_nickname') || meta('meta[property="og:site_name"]'),
    author: text('#js_author_name') || meta('meta[name="author"]') || meta('meta[property="article:author"]'),
    published: text('#publish_time') || meta('meta[property="article:published_time"]') || q('time[datetime]')?.getAttribute('datetime') || '',
    image: meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]') || bigImage,
    description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
    favicon: q('link[rel~="icon"]')?.href || '',
  };
}

// Also runs inside the page: a small notice in a shadow root so page styles can't touch it.
function showToast(message, isError) {
  const ID = 'lumen-archive-toast';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;z-index:2147483647;right:20px;bottom:20px;';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.textContent = message;
  box.style.cssText = `max-width:420px;padding:10px 14px;border-radius:10px;font:13px/1.6 system-ui,sans-serif;color:#fff;
    background:${isError ? '#b42318' : '#1f2937'};box-shadow:0 6px 24px rgba(0,0,0,.25);white-space:pre-wrap;`;
  root.append(box);
  document.documentElement.append(host);
  if (message.startsWith('正在')) return;
  setTimeout(() => host.remove(), isError ? 8000 : 5000);
}

async function toast(tabId, message, isError = false) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showToast, args: [message, isError] });
  } catch { /* pages like chrome:// refuse scripts; the badge still reports */ }
}

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  if (text && text !== '…') setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), BADGE_CLEAR_MS);
}

const ANALYSIS_NOTE = { queued: '，AI 分析在后台生成', 'no-key': '（未配置 AI 密钥，跳过分析）', off: '', skipped: '' };

async function archive(tab) {
  if (!tab?.id || busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  badge(tab.id, '…', '#6366f1');
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPage });
    await toast(tab.id, page.selectedText ? '正在存档（选中文字作为摘录）…' : '正在存档到 Obsidian…');
    const res = await fetch(`${LUMEN}/api/clip/page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lumen': '1' },
      body: JSON.stringify(page),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lumen 返回 ${res.status}`);
    badge(tab.id, '✓', '#16a34a');
    await toast(tab.id, data.existed ? `已存档过：${data.relPath}` : `已存入 Obsidian：${data.relPath}${ANALYSIS_NOTE[data.analysis] ?? ''}`);
  } catch (e) {
    const offline = e instanceof TypeError;
    badge(tab.id, '!', '#dc2626');
    await toast(tab.id, offline ? '连不上 Lumen（127.0.0.1:8780），确认它在运行' : `存档失败：${e.message}`, true);
  } finally {
    busyTabs.delete(tab.id);
  }
}

// Lumen reads the page and keeps the card's content; its /share/<id> page renders the picture,
// copies it, and offers other styles. Images go through Lumen's proxy, so no extra permissions.
async function share(tab) {
  if (!tab?.id || busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  badge(tab.id, '…', '#6366f1');
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectShare });
    const res = await fetch(`${LUMEN}/api/share/page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lumen': '1' },
      body: JSON.stringify(page),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lumen 返回 ${res.status}`);
    badge(tab.id, '✓', '#16a34a');
    await chrome.tabs.create({ url: `${LUMEN}/share/${data.id}`, index: tab.index + 1, openerTabId: tab.id });
  } catch (e) {
    const offline = e instanceof TypeError;
    badge(tab.id, '!', '#dc2626');
    await toast(tab.id, offline ? '连不上 Lumen（127.0.0.1:8780），确认它在运行' : `生成分享图失败：${e.message}`, true);
  } finally {
    busyTabs.delete(tab.id);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: '存档到 Obsidian（Lumen）', contexts: ['page', 'selection'] });
  chrome.contextMenus.create({ id: SHARE_MENU_ID, title: '生成分享图（Lumen）', contexts: ['page', 'selection'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void archive(tab);
  if (info.menuItemId === SHARE_MENU_ID) void share(tab);
});
chrome.action.onClicked.addListener((tab) => void archive(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'archive-page') void archive(tab);
  if (command === 'share-page') void share(tab);
});
