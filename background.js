/*
  Background service worker: handles privileged fetches (bypassing page CORS),
  converts fetched resources to data URLs, and triggers the download of the
  final single-file HTML.
*/

const CONTENT_MESSAGE_PORTS = new Map();
const DISABLE_PHOTOS_KEY = 'sf_disable_photos';
const DISABLE_GIFS_KEY = 'sf_disable_gifs';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sf-channel') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  CONTENT_MESSAGE_PORTS.set(tabId, port);
  port.onDisconnect.addListener(() => CONTENT_MESSAGE_PORTS.delete(tabId));
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await captureMHTML(tab);
});

chrome.runtime.onInstalled.addListener(async () => {
  // Migrate old combined key if present
  const legacy = await chrome.storage.local.get('sf_disable_images');
  if (typeof legacy['sf_disable_images'] !== 'undefined') {
    await chrome.storage.local.set({ [DISABLE_PHOTOS_KEY]: !!legacy['sf_disable_images'], [DISABLE_GIFS_KEY]: !!legacy['sf_disable_images'] });
    await chrome.storage.local.remove('sf_disable_images');
  }
  // Defaults: photos OFF (false), GIFs ON (true)
  const current = await chrome.storage.local.get([DISABLE_PHOTOS_KEY, DISABLE_GIFS_KEY]);
  const toSet = {};
  if (typeof current[DISABLE_PHOTOS_KEY] === 'undefined') toSet[DISABLE_PHOTOS_KEY] = false;
  if (typeof current[DISABLE_GIFS_KEY] === 'undefined') toSet[DISABLE_GIFS_KEY] = true;
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  await registerContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  await registerContextMenus();
});

async function registerContextMenus() {
  try { await chrome.contextMenus.removeAll(); } catch {}
  chrome.contextMenus.create({ id: 'sf-save-mhtml', title: 'Save page as MHTML (exact snapshot)', contexts: ['action', 'page'] });
  chrome.contextMenus.create({ id: 'sf-capture-chat-history', title: 'Capture Discord (auto-scroll → MHTML)', contexts: ['action', 'page'] });
  const state = await chrome.storage.local.get([DISABLE_PHOTOS_KEY, DISABLE_GIFS_KEY]);
  chrome.contextMenus.create({ id: 'sf-disable-photos', title: 'Disable photos', type: 'checkbox', checked: !!state[DISABLE_PHOTOS_KEY], contexts: ['action', 'page'] });
  chrome.contextMenus.create({ id: 'sf-disable-gifs', title: 'Disable GIFs', type: 'checkbox', checked: !!state[DISABLE_GIFS_KEY], contexts: ['action', 'page'] });
  const version = chrome.runtime.getManifest().version || '0.0.0';
  chrome.contextMenus.create({ id: 'sf-version', title: `Version ${version}`, enabled: false, contexts: ['action', 'page'] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'sf-save-mhtml') {
    await captureMHTML(tab);
    return;
  }
  if (info.menuItemId === 'sf-capture-chat-history') {
    await captureChatHistory(tab);
    return;
  }
  if (info.menuItemId === 'sf-disable-photos') {
    const newValue = !!info.checked; // checked reflects the new state
    await chrome.storage.local.set({ [DISABLE_PHOTOS_KEY]: newValue });
    await chrome.contextMenus.update('sf-disable-photos', { checked: newValue });
    return;
  }
  if (info.menuItemId === 'sf-disable-gifs') {
    const newValue = !!info.checked; // checked reflects the new state
    await chrome.storage.local.set({ [DISABLE_GIFS_KEY]: newValue });
    await chrome.contextMenus.update('sf-disable-gifs', { checked: newValue });
    return;
  }
});

async function captureMHTML(tab) {
  try {
    const conf = await chrome.storage.local.get([DISABLE_PHOTOS_KEY, DISABLE_GIFS_KEY]);
    const disablePhotos = !!conf[DISABLE_PHOTOS_KEY];
    const disableGifs = !!conf[DISABLE_GIFS_KEY];
    if (disablePhotos || disableGifs) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: stripMediaInPage, args: [disablePhotos, disableGifs] });
    }
    const blob = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
    const { siteName, username } = await getSiteAndUsername(tab.id);
    const filename = buildPreferredFilename(siteName, username) + '.mhtml';
    const bytes = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(bytes);
    const dataUrl = `data:multipart/related;base64,${base64}`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
  } catch (e) {
    console.error('MHTML capture failed', e);
  }
}

function stripMediaInPage(disablePhotos, disableGifs) {
  try {
    const MARK_SRC = 'data-sf-prev-src';
    const MARK_SRCSET = 'data-sf-prev-srcset';
    const isGifUrl = (u) => {
      try { return /\.gif(\?|#|$)/i.test(new URL(u, location.href).pathname); } catch { return /\.gif(\?|#|$)/i.test(String(u)); }
    };
    const shouldRemove = (url) => {
      if (disablePhotos) return true;
      if (disableGifs && isGifUrl(url)) return true;
      return false;
    };
    // Images
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      const srcset = img.getAttribute('srcset');
      const toRemove = disablePhotos || (disableGifs && (isGifUrl(src || '') || (srcset || '').includes('.gif')));
      if (!toRemove) return;
      if (src && !img.hasAttribute(MARK_SRC)) img.setAttribute(MARK_SRC, src);
      if (srcset && !img.hasAttribute(MARK_SRCSET)) img.setAttribute(MARK_SRCSET, srcset);
      img.removeAttribute('src');
      img.removeAttribute('srcset');
    });
    // Picture/source
    document.querySelectorAll('picture source, source').forEach((s) => {
      const src = s.getAttribute('src');
      const srcset = s.getAttribute('srcset');
      const type = s.getAttribute('type');
      const looksGif = (type && /gif/i.test(type)) || (src && isGifUrl(src)) || (srcset && srcset.includes('.gif'));
      const toRemove = disablePhotos || (disableGifs && looksGif);
      if (!toRemove) return;
      if (src && !s.hasAttribute(MARK_SRC)) s.setAttribute(MARK_SRC, src);
      if (srcset && !s.hasAttribute(MARK_SRCSET)) s.setAttribute(MARK_SRCSET, srcset);
      s.removeAttribute('src');
      s.removeAttribute('srcset');
      s.removeAttribute('type');
    });
    // Optional: strip all CSS backgrounds when photos are disabled using a temporary stylesheet
    if (disablePhotos && !document.getElementById('sf-bg-strip-style')) {
      const style = document.createElement('style');
      style.id = 'sf-bg-strip-style';
      style.textContent = '*{background-image:none !important}';
      document.documentElement.appendChild(style);
    }
    // Schedule restore after a tick so background can call it explicitly too
    window.__sf_restoreMedia = function restoreMediaInPage() {
      document.querySelectorAll('img').forEach((img) => {
        if (img.hasAttribute(MARK_SRC)) {
          img.setAttribute('src', img.getAttribute(MARK_SRC));
          img.removeAttribute(MARK_SRC);
        }
        if (img.hasAttribute(MARK_SRCSET)) {
          img.setAttribute('srcset', img.getAttribute(MARK_SRCSET));
          img.removeAttribute(MARK_SRCSET);
        }
      });
      document.querySelectorAll('picture source, source').forEach((s) => {
        if (s.hasAttribute(MARK_SRC)) { s.setAttribute('src', s.getAttribute(MARK_SRC)); s.removeAttribute(MARK_SRC); }
        if (s.hasAttribute(MARK_SRCSET)) { s.setAttribute('srcset', s.getAttribute(MARK_SRCSET)); s.removeAttribute(MARK_SRCSET); }
      });
      const st = document.getElementById('sf-bg-strip-style');
      if (st) st.remove();
    };
  } catch {}
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({ url: offscreenUrl, reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Save MHTML via object URL in MV3' });
  }
}

// -------- Discord transcript capture ---------

async function captureChatHistory(tab) {
  try {
    // 1) Auto-scroll to buffer messages into window.__sf_capturedMessages
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: autoScrollDiscordHistory, args: [0, 900, 12, true] });
    // 2) Merge buffered messages back into the live Discord DOM to preserve layout
    const [{ result: mergeRes }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: mergeBufferedMessagesIntoDiscordPage });
    // 3) Apply media toggles if enabled
    const conf = await chrome.storage.local.get([DISABLE_PHOTOS_KEY, DISABLE_GIFS_KEY]);
    const disablePhotos = !!conf[DISABLE_PHOTOS_KEY];
    const disableGifs = !!conf[DISABLE_GIFS_KEY];
    const didStrip = disablePhotos || disableGifs;
    if (didStrip) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: stripMediaInPage, args: [disablePhotos, disableGifs] }); } catch {}
    }
    // 4) Capture the same tab as MHTML (keeps Discord layout)
    const blob = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
    const { siteName, username } = await getSiteAndUsername(tab.id);
    const filename = buildPreferredFilename(siteName, username) + '.mhtml';
    const bytes = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(bytes);
    const dataUrl = `data:multipart/related;base64,${base64}`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
    // 5) Restore media if we stripped
    if (didStrip) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: restoreMediaInPage }); } catch {}
    }
  } catch (e) {
    console.error('Chat history capture failed', e);
    // Fallback: transcript page flow
    try { await renderTranscriptInExtensionAndCapture(tab); } catch {}
  }
}

function autoScrollDiscordHistory(maxMs, settleMs, maxNoNew, untilTop) {
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function isScrollable(el) {
    if (!el) return false; const cs = getComputedStyle(el); const canY = /(auto|scroll)/.test(cs.overflowY); return canY && el.scrollHeight > el.clientHeight;
  }
  function findScrollableAncestor(el) {
    let n = el; while (n && n !== document.documentElement) { if (isScrollable(n)) return n; n = n.parentElement; } return null;
  }
  function findScroller() {
    const cands = [
      document.querySelector('.messagesWrapper__36d07 .scroller__36d07'),
      document.querySelector('div[class*="messagesWrapper"] div[class*="scroller"]'),
      document.querySelector('[data-list-id="chat-messages"]'),
      document.querySelector('[role="log"]'),
      document.querySelector('main div[class*="scroller"]')
    ].filter(Boolean);
    for (const el of cands) { const s = isScrollable(el) ? el : findScrollableAncestor(el); if (s) return s; }
    if (isScrollable(document.scrollingElement)) return document.scrollingElement;
    return document.documentElement;
  }
  function countMessages() {
    const list = document.querySelector('[data-list-id="chat-messages"]');
    if (list) return list.querySelectorAll('li').length;
    const log = document.querySelector('[role="log"]');
    if (log) return log.querySelectorAll('[id^="chat-messages-"], [data-list-item-id^="chat-messages"], article').length;
    return document.querySelectorAll('article, [data-list-item-id^="chat-messages"]').length;
  }
  function selectVisible() {
    const nodes = [];
    const list = document.querySelector('ol[data-list-id="chat-messages"]'); if (list) nodes.push(...list.querySelectorAll(':scope > li'));
    const log = document.querySelector('[role="log"]'); if (log) nodes.push(...log.querySelectorAll('[id^="chat-messages-"], [data-list-item-id^="chat-messages"], article'));
    if (!list && !log) nodes.push(...document.querySelectorAll('article, [data-list-item-id^="chat-messages"]'));
    return Array.from(new Set(nodes));
  }
  function getKey(el, idx) {
    return el.getAttribute('data-list-item-id') || el.id || el.getAttribute('data-message-id') || el.getAttribute('aria-labelledby') || `sf-key-${idx}-${(el.textContent||'').slice(0,40)}`;
  }
  function getOrderFromEl(el, idx) {
    try {
      const idAttr = el.getAttribute('data-list-item-id') || el.id || el.getAttribute('data-message-id');
      if (idAttr) {
        const m = String(idAttr).match(/(\d{6,})/);
        if (m) return BigInt(m[1]);
      }
      const t = el.querySelector('time[datetime]');
      if (t && t.getAttribute('datetime')) return BigInt(Date.parse(t.getAttribute('datetime')) || 0);
    } catch {}
    return BigInt(1e12 + idx); // fallback monotonic-ish
  }
  function isPlaceholder(el) {
    const role = el.getAttribute('role');
    if (role === 'progressbar') return true;
    if (el.getAttribute('aria-busy') === 'true') return true;
    const cls = el.className || '';
    if (/skeleton|placeholder|spinner|loading/i.test(cls)) return true;
    const hasContent = !!el.querySelector('img, video, time, a, span, p, article, div[class*="message"]');
    if (!hasContent && (el.textContent||'').trim() === '') return true;
    return false;
  }
  function scrollToBottom(scroller) {
    try { scroller.scrollTop = scroller.scrollHeight; } catch {}
  }
  function waitForQuiet(msStable, maxWait) {
    return new Promise((resolve) => {
      const start = Date.now();
      let lastMutationTs = Date.now();
      const obs = new MutationObserver(() => { lastMutationTs = Date.now(); });
      obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      const tick = () => {
        const now = Date.now();
        if (now - lastMutationTs >= msStable) { obs.disconnect(); resolve(); return; }
        if (now - start >= maxWait) { obs.disconnect(); resolve(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }
  return (async () => {
    const start = Date.now(); let noNew = 0; const scroller = findScroller(); if (!scroller) return { ok:false };
    // Ensure we start from the very bottom (newest)
    scrollToBottom(scroller);
    await waitForQuiet(Math.max(400, settleMs), 4000);
    let lastCount = countMessages(); const captured = new Map(); let seq = 0;
    function harvest() {
      const nodes = selectVisible();
      nodes.forEach((el, idx) => {
        const key = getKey(el, idx); if (!key || captured.has(key)) return;
        if (isPlaceholder(el)) return;
        const clone = el.cloneNode(true);
        try { clone.querySelectorAll('[data-src]').forEach(n=>{ if(!n.getAttribute('src')) n.setAttribute('src', n.getAttribute('data-src')); }); } catch {}
        try { clone.querySelectorAll('[data-srcset]').forEach(n=>{ if(!n.getAttribute('srcset')) n.setAttribute('srcset', n.getAttribute('data-srcset')); }); } catch {}
        const order = getOrderFromEl(el, idx);
        captured.set(key, { html: clone.outerHTML, seq: seq++, order: order.toString(), key });
      });
    }
    // Main loop: move upward in small increments and wait for DOM to settle
    const deadline = maxMs && maxMs > 0 ? (start + maxMs) : Infinity;
    while (Date.now() < deadline) {
      try {
        const step = Math.max(150, Math.floor(scroller.clientHeight*0.8));
        scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -step, bubbles:true, cancelable:true }));
      } catch {}
      await waitForQuiet(Math.max(350, settleMs), 3000);
      harvest();
      const now = countMessages();
      noNew = (now <= lastCount) ? noNew+1 : 0; lastCount = now;
      if (untilTop) {
        if ((scroller.scrollTop||0) <= 0 && noNew >= 2) break; // top and stable twice
      } else {
        if (noNew >= maxNoNew) break; // stopped growing
      }
    }
    harvest();
    const records = Array.from(captured.values()).sort((a,b)=>{
      try { return (BigInt(a.order) - BigInt(b.order)); } catch { return a.seq - b.seq; }
    });
    window.__sf_capturedMessagesRecords = records;
    window.__sf_capturedMessages = records.map(v=>v.html); // backward compat
    return { ok:true, loaded: records.length };
  })();
}

function mergeBufferedMessagesIntoDiscordPage() {
  try {
    const records = Array.isArray(window.__sf_capturedMessagesRecords) ? window.__sf_capturedMessagesRecords : (window.__sf_capturedMessages || []).map((html, i)=>({ html, key: `k${i}`, order: String(1e15+i) }));
    const list = document.querySelector('ol[data-list-id="chat-messages"]');
    const log = document.querySelector('[role="log"]');
    const container = list || log || document.querySelector('main');
    if (!container) return { ok: false, inserted: 0, title: document.title };
    // Clean existing placeholders
    Array.from(container.children).forEach((child) => {
      const role = child.getAttribute && child.getAttribute('role');
      const cls = child.className || '';
      if (role === 'progressbar' || child.getAttribute('aria-busy') === 'true' || /skeleton|placeholder|spinner|loading/i.test(cls)) {
        child.remove();
      }
    });
    let inserted = 0;
    const parser = document.createElement('template');
    const existing = Array.from(container.querySelectorAll(':scope > *'));
    function orderOfNode(n) {
      try {
        const idAttr = n.getAttribute('data-list-item-id') || n.id || n.getAttribute('data-message-id');
        const m = idAttr && String(idAttr).match(/(\d{6,})/); if (m) return BigInt(m[1]);
        const t = n.querySelector && n.querySelector('time[datetime]');
        if (t && t.getAttribute('datetime')) return BigInt(Date.parse(t.getAttribute('datetime'))||0);
      } catch {}
      return BigInt(0);
    }
    const existingOrders = existing.map(node => ({ node, order: orderOfNode(node) }));
    const seenKeys = new Set(existing.map(n => n.getAttribute('data-list-item-id') || n.id).filter(Boolean));
    const sorted = records.slice().sort((a,b)=>{ try { return (BigInt(a.order)-BigInt(b.order)); } catch { return 0; } });
    for (const rec of sorted) {
      if (rec.key && seenKeys.has(rec.key)) continue;
      parser.innerHTML = rec.html.trim();
      const node = parser.content.firstElementChild;
      if (!node) continue;
      const newOrder = (()=>{ try { return BigInt(rec.order); } catch { return orderOfNode(node); }})();
      let placed = false;
      for (let i=0;i<existingOrders.length;i++) {
        if (newOrder < existingOrders[i].order) {
          container.insertBefore(node.cloneNode(true), existingOrders[i].node);
          existingOrders.splice(i,0,{ node, order: newOrder });
          placed = true; break;
        }
      }
      if (!placed) {
        container.appendChild(node.cloneNode(true));
        existingOrders.push({ node, order: newOrder });
      }
      if (rec.key) seenKeys.add(rec.key);
      inserted++;
    }
    return { ok: true, inserted, title: document.title };
  } catch (e) {
    return { ok: false, error: String(e), title: document.title };
  }
}

async function renderTranscriptInExtensionAndCapture(activeTab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: false }, func: () => ({ items: Array.isArray(window.__sf_capturedMessages)?window.__sf_capturedMessages:[], title: document.title }) });
    const items = result?.items || []; const sourceTitle = result?.title || 'Chat Transcript';
    const url = chrome.runtime.getURL('transcript.html');
    const created = await chrome.tabs.create({ url, active: false });
    const createdTabId = created.id; if (!createdTabId) throw new Error('Failed to open transcript tab');
    await new Promise(r=>setTimeout(r, 300));
    await chrome.scripting.executeScript({ target: { tabId: createdTabId }, func: (payload) => { window.__sf_payload = payload; }, args: [{ items, title: sourceTitle }] });
    await chrome.scripting.executeScript({ target: { tabId: createdTabId }, files: ['transcript.js'] });
    await new Promise(r=>setTimeout(r, 200));
    const blob = await chrome.pageCapture.saveAsMHTML({ tabId: createdTabId });
    const { siteName, username } = await getSiteAndUsername(activeTab.id);
    const filename = buildPreferredFilename(siteName, username) + '.mhtml';
    const bytes = await blob.arrayBuffer(); const base64 = arrayBufferToBase64(bytes);
    const dataUrl = `data:multipart/related;base64,${base64}`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
    await chrome.tabs.remove(createdTabId);
  } catch (e) {
    console.error('renderTranscriptInExtensionAndCapture failed', e);
    await downloadTranscriptHTMLFallback(activeTab);
  }
}

async function downloadTranscriptHTMLFallback(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: getTranscriptHtmlForDownload });
    if (!result || !result.ok) throw new Error('No transcript HTML available');
    const html = result.html; const { siteName, username } = await getSiteAndUsername(tab.id); const filename = buildPreferredFilename(siteName, username) + '.html';
    const encoder = new TextEncoder(); const bytes = encoder.encode(html); const base64 = arrayBufferToBase64(bytes.buffer);
    const dataUrl = `data:text/html;charset=utf-8;base64,${base64}`; await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
  } catch (e) { console.error('Transcript HTML fallback failed', e); }
}

function getTranscriptHtmlForDownload() {
  try {
    const items = Array.isArray(window.__sf_capturedMessages) ? window.__sf_capturedMessages : [];
    const listItems = items.map(html => `<li style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">${html}</li>`).join('');
    const body = `<div id=\"sf-root\" style=\"min-height:100vh;overflow:auto\"><section id=\"sf-captured-chat\" style=\"max-width:1000px;margin:0 auto;padding:8px\"><div style=\"position:sticky;top:0;background:#111;padding:8px 0;font-weight:bold;z-index:1\">Captured Chat Transcript (combined)</div><ol style=\"list-style:none;padding:0;margin:0\">${listItems}</ol></section></div>`;
    const css = `html,body{min-height:100%;} body{background:#111;color:#ddd;font-family:sans-serif;margin:0;overflow:auto} a{color:#9ab} img{max-width:100%} *{box-sizing:border-box} pre,code{white-space:pre-wrap} ol{margin:0;padding:0}`;
    const title = document.title || 'Chat Transcript';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;
    return { ok: true, html };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'SF_FETCH_AS_DATAURL') {
        const { url, asBinary, timeoutMs } = message;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs || 20000);
        const res = await fetch(url, { credentials: 'include', signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        if (asBinary) {
          const blob = await res.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = arrayBufferToBase64(arrayBuffer);
          sendResponse({ ok: true, dataUrl: `data:${contentType};base64,${base64}` });
        } else {
          const text = await res.text();
          const encoded = encodeURIComponent(text).replace(/%20/g, '+');
          sendResponse({ ok: true, dataUrl: `data:${contentType};charset=utf-8,${encoded}` });
        }
        return;
      }

      if (message?.type === 'SF_DOWNLOAD_HTML') {
        const { filename, html } = message;
        // MV3 service workers may not support URL.createObjectURL; use data URL instead.
        const encoder = new TextEncoder();
        const bytes = encoder.encode(html);
        const base64 = arrayBufferToBase64(bytes.buffer);
        const dataUrl = `data:text/html;charset=utf-8;base64,${base64}`;
        await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'SF_LOG') {
        console.log('[SingleFile]', message.level || 'log', message.args || []);
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function buildSafeFilename(title) {
  const sanitized = String(title).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return sanitized.slice(0, 120) || 'page';
}

async function getSiteAndUsername(tabId) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => {
      try {
        const metaSite = document.querySelector('meta[property="og:site_name"], meta[name="og:site_name"]');
        const ogSite = (metaSite && metaSite.getAttribute('content')) ? metaSite.getAttribute('content').trim() : '';
        const title = document.title || '';
        const titleParts = title.split(' - ').map((s) => s.trim()).filter(Boolean);
        const candidates = titleParts.filter((p) => /[A-Za-z]/.test(p) && !/^\d{4}-\d{2}-\d{2}/.test(p));
        let siteName = (ogSite || candidates[candidates.length - 1] || (location.hostname || 'Website')).replace(/^www\./i, '');
        siteName = siteName.replace(/^#\d+\s*/, '').trim();
        // Canonicalize Chat Avenue naming
        try {
          const host = (location.hostname || '').toLowerCase();
          const t = (title || '').toLowerCase();
          const og = (ogSite || '').toLowerCase();
          const looksChatAvenue = host.includes('chat-avenue') || host.includes('chatavenue') || og.includes('chat avenue') || t.includes('chat avenue');
          if (looksChatAvenue) siteName = 'Chat Avenue';
        } catch {}

        function findUsernameInDocument(doc, maxDepth) {
          try {
            // Discord: prefer channel header aria-label (handle)
            try {
              const headerUser = doc.querySelector('h1 [aria-label]');
              const al = headerUser && headerUser.getAttribute('aria-label');
              if (al && String(al).trim()) return String(al).trim();
            } catch {}
            // Discord profile/sidebar username
            try {
              const tag = doc.querySelector('[class*="userTagUsername"]');
              const t = tag && tag.textContent ? String(tag.textContent).trim() : '';
              if (t) return t;
            } catch {}

            const el = doc.getElementById('private_name');
            if (el) {
              const val = ("value" in el ? el.value : el.textContent) || '';
              const t = String(val).trim();
              if (t) return t;
            }
          } catch {}
          if (!maxDepth || maxDepth <= 0) return '';
          try {
            const frames = doc.querySelectorAll('iframe, frame');
            for (const fr of frames) {
              try {
                const childDoc = fr.contentDocument;
                if (!childDoc) continue;
                const t = findUsernameInDocument(childDoc, maxDepth - 1);
                if (t) return t;
              } catch {}
            }
          } catch {}
          return '';
        }

        const username = findUsernameInDocument(document, 5) || 'username';
        return { siteName, username };
      } catch { return { siteName: location.hostname || 'Website', username: 'username' }; }
    }});
    // Prefer a result that has a non-default username if any
    const best = Array.isArray(results) ? results.map(r=>r.result || {}).find(r => r && r.username && r.username !== 'username') : null;
    return best || (results && results[0] && results[0].result) || { siteName: 'Website', username: 'username' };
  } catch {
    return { siteName: 'Website', username: 'username' };
  }
}

function buildPreferredFilename(siteName, username) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const site = safe((siteName || '').replace(/^www\./i, '')) || 'Website';
  const user = safe(username) || 'username';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const tzMin = -now.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzMin) / 60));
  const tzM = pad(Math.abs(tzMin) % 60);
  const datePart = `${yyyy}-${MM}-${dd}`;
  const timePart = `${hh}-${mm}-${ss}`; // Windows-safe time
  const tz = `UTC${tzSign}${tzH}:${tzM}`;
  const raw = `${site} - ${user} - ${datePart} ${timePart} & ${tz}`;
  return safe(raw).slice(0, 180) || 'page';
}


