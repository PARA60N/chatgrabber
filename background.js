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
    // Check if tab is still valid before proceeding
    if (!tab || !tab.id) {
      throw new Error('Tab is invalid or has been closed');
    }
    
    // 1) Auto-scroll to buffer messages into window.__sf_capturedMessages
    // Parameters: maxMessages (10000 = stop after 10k messages), settleMs (1200ms for better lazy loading), maxNoNew (more lenient), untilTop (true)
    let scrollResult;
    try {
      const results = await chrome.scripting.executeScript({ 
        target: { tabId: tab.id, allFrames: false }, 
        func: autoScrollDiscordHistory, 
        args: [300, 1200, 15, true] 
      });
      scrollResult = results && results[0] ? results[0].result : null;
    } catch (e) {
      if (e.message && e.message.includes('Frame with ID') && e.message.includes('was removed')) {
        throw new Error('Tab was closed or navigated away during capture');
      }
      throw e;
    }
    
    if (scrollResult && !scrollResult.ok) {
      console.warn('[ChatGrabber] Scroll failed, attempting fallback');
    }
    
    // Check tab validity again before continuing
    try {
      await chrome.tabs.get(tab.id);
    } catch (e) {
      throw new Error('Tab was closed or navigated away during capture');
    }
    
    // 2) Merge all cached messages into the DOM (no scrolling - just insert)
    let mergeRes;
    try {
      const results = await chrome.scripting.executeScript({ 
        target: { tabId: tab.id, allFrames: false }, 
        func: mergeBufferedMessagesIntoDiscordPage 
      });
      mergeRes = results && results[0] ? results[0].result : null;
    } catch (e) {
      if (e.message && e.message.includes('Frame with ID') && e.message.includes('was removed')) {
        throw new Error('Tab was closed or navigated away during capture');
      }
      console.warn('[ChatGrabber] Error merging messages:', e);
    }
    
    if (mergeRes) {
      console.log(`[ChatGrabber] Merged ${mergeRes.inserted || 0} messages, total: ${mergeRes.totalMessages || 0}`);
    }
    
    // Check tab validity again
    try {
      await chrome.tabs.get(tab.id);
    } catch (e) {
      throw new Error('Tab was closed or navigated away during capture');
    }
    
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
    
    // Only try fallback if tab is still valid and error isn't about tab being closed
    if (tab && tab.id && !e.message?.includes('Tab was closed') && !e.message?.includes('Frame with ID')) {
      try {
        // Check if we can still access the tab
        await chrome.tabs.get(tab.id);
        await renderTranscriptInExtensionAndCapture(tab);
      } catch (fallbackError) {
        // If fallback also fails (e.g., permission issues), just log it
        if (fallbackError.message?.includes('permission') || fallbackError.message?.includes('Cannot access')) {
          console.warn('[ChatGrabber] Fallback failed due to permissions. Please ensure the extension has access to the page.');
        } else {
          console.error('[ChatGrabber] Fallback also failed:', fallbackError);
        }
      }
    } else {
      console.warn('[ChatGrabber] Cannot use fallback - tab was closed or navigated away');
    }
  }
}

function autoScrollDiscordHistory(maxMessages, settleMs, maxNoNew, untilTop) {
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
      // Priority 1: Extract timestamp from time element (most accurate)
      const t = el.querySelector('time[datetime]');
      if (t && t.getAttribute('datetime')) {
        const timestamp = Date.parse(t.getAttribute('datetime'));
        if (!isNaN(timestamp) && timestamp > 0) {
          return BigInt(timestamp);
        }
      }
      
      // Priority 2: Extract timestamp from Discord message ID (snowflake format)
      const idAttr = el.getAttribute('data-list-item-id') || el.id || el.getAttribute('data-message-id');
      if (idAttr) {
        // Discord message IDs are 17-19 digits and contain timestamp
        const m = String(idAttr).match(/(\d{17,})/);
        if (m) {
          const msgId = BigInt(m[1]);
          // Discord snowflake: (id >> 22) + 1420070400000
          const timestamp = (msgId >> 22n) + 1420070400000n;
          if (timestamp > 0n && timestamp < BigInt(Date.now() + 86400000)) {
            return timestamp;
          }
        }
        // Fallback: use the ID number directly if it's a reasonable timestamp
        const m2 = String(idAttr).match(/(\d{6,})/);
        if (m2) {
          const idNum = BigInt(m2[1]);
          // If it looks like a timestamp (after year 2000), use it
          if (idNum > 946684800000n) { // 2000-01-01
            return idNum;
          }
        }
      }
    } catch {}
    // Fallback: use sequence number with large offset to ensure it's at the end
    return BigInt(Date.now() + idx); // fallback using current time + index
  }
  function isPlaceholder(el) {
    const role = el.getAttribute('role');
    if (role === 'progressbar') return true;
    if (el.getAttribute('aria-busy') === 'true') return true;
    const cls = el.className || '';
    if (/skeleton|placeholder|spinner|loading/i.test(cls)) return true;
    // Check for empty or minimal content
    const textContent = (el.textContent || '').trim();
    if (!textContent && !el.querySelector('img, video, iframe, embed')) return true;
    // Check for Discord skeleton patterns
    const hasContent = !!el.querySelector('img, video, time, a, span, p, article, div[class*="message"], div[class*="content"]');
    if (!hasContent && textContent === '') return true;
    // Check for specific Discord loading indicators
    if (el.querySelector('[class*="skeleton"], [class*="loading"], [class*="spinner"]')) return true;
    return false;
  }
  function scrollToBottom(scroller) {
    try { scroller.scrollTop = scroller.scrollHeight; } catch {}
  }
  function waitForQuiet(msStable, maxWait) {
    return new Promise((resolve) => {
      const start = Date.now();
      let lastMutationTs = Date.now();
      let lastMessageCount = countMessages();
      const obs = new MutationObserver(() => { 
        lastMutationTs = Date.now();
        const currentCount = countMessages();
        if (currentCount !== lastMessageCount) {
          lastMessageCount = currentCount;
          lastMutationTs = Date.now(); // Reset timer when new messages appear
        }
      });
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
  // Intercept console.log to detect Discord batch loading
  let batchLoadDetected = false;
  const originalConsoleLog = console.log;
  const consoleInterceptor = function(...args) {
    const message = args.join(' ');
    if (message.includes('Fetched 50 messages') || message.includes('isBefore:true')) {
      batchLoadDetected = true;
    }
    originalConsoleLog.apply(console, args);
  };
  console.log = consoleInterceptor;
  
  return (async () => {
    try {
      // Initialize persistent cache if it doesn't exist
      if (!window.__sf_capturedMessagesRecords) {
        window.__sf_capturedMessagesRecords = [];
      }
      if (!window.__sf_capturedMessagesCache) {
        window.__sf_capturedMessagesCache = new Map();
      }
      
      let noNew = 0; 
      let noScrollChange = 0;
      const scroller = findScroller(); 
      if (!scroller) {
        return { ok:false };
      }
      
    // Ensure we start from the very bottom (newest)
    scrollToBottom(scroller);
      await waitForQuiet(Math.max(600, settleMs), 5000);
      
      let lastCount = countMessages(); 
      let lastScrollTop = scroller.scrollTop;
      const captured = window.__sf_capturedMessagesCache; // Use persistent cache
      let seq = captured.size; // Continue sequence from existing cache
      
    function harvest() {
        try {
      const nodes = selectVisible();
          let newMessages = 0;
          let topmostNewMessage = null;
          let topmostOrder = null;
          let topmostVisibleMessage = null;
          let topmostVisibleOrder = null;
          
      nodes.forEach((el, idx) => {
            try {
              // Check if element is still valid and connected to DOM
              if (!el || !el.parentNode || (!el.isConnected && !document.contains(el))) {
                return;
              }
              
              const key = getKey(el, idx); 
              const order = getOrderFromEl(el, idx);
              
              // Track the topmost visible message (for scrolling)
              if (!isPlaceholder(el) && (!topmostVisibleOrder || order < topmostVisibleOrder)) {
                topmostVisibleOrder = order;
                topmostVisibleMessage = el;
              }
              
              // Only capture if not already captured and not a placeholder
              if (!key || captured.has(key)) return;
        if (isPlaceholder(el)) return;
              
        const clone = el.cloneNode(true);
              
              // Capture image/GIF URLs directly from attributes (no waiting for load)
              try {
                // Get all media elements from original to extract URLs
                const originalImgs = Array.from(el.querySelectorAll('img'));
                const originalVideos = Array.from(el.querySelectorAll('video'));
                const originalEmbeds = Array.from(el.querySelectorAll('embed, iframe'));
                
                // Handle lazy-loaded images - just grab the URL from data attributes
                clone.querySelectorAll('[data-src]').forEach(n => {
                  const dataSrc = n.getAttribute('data-src');
                  if (dataSrc && !n.getAttribute('src')) {
                    n.setAttribute('src', dataSrc);
                    n.removeAttribute('data-src');
                  }
                });
                
                // Handle lazy-loaded srcset
                clone.querySelectorAll('[data-srcset]').forEach(n => {
                  const dataSrcset = n.getAttribute('data-srcset');
                  if (dataSrcset && !n.getAttribute('srcset')) {
                    n.setAttribute('srcset', dataSrcset);
                    n.removeAttribute('data-srcset');
                  }
                });
                
                // For all img elements, grab URL from any available source
                clone.querySelectorAll('img').forEach((cloneImg, idx) => {
                  // Try to match with original image
                  const originalImg = originalImgs[idx] || 
                                     originalImgs.find(orig => 
                                       orig.alt === cloneImg.getAttribute('alt') ||
                                       orig.getAttribute('data-src') === cloneImg.getAttribute('data-src') ||
                                       orig.className === cloneImg.className
                                     );
                  
                  // Priority: data-src > src > currentSrc > original src
                  let imageUrl = null;
                  
                  if (originalImg) {
                    // Check original's data-src first (lazy-load URL)
                    imageUrl = originalImg.getAttribute('data-src') || 
                              originalImg.getAttribute('data-lazy-src') || 
                              originalImg.getAttribute('data-original') ||
                              originalImg.getAttribute('data-lazy') ||
                              (originalImg.src && originalImg.src !== 'about:blank' ? originalImg.src : null) ||
                              (originalImg.currentSrc || null);
                  }
                  
                  // Fallback: check clone's own attributes
                  if (!imageUrl) {
                    imageUrl = cloneImg.getAttribute('data-src') || 
                              cloneImg.getAttribute('data-lazy-src') || 
                              cloneImg.getAttribute('data-original') ||
                              cloneImg.getAttribute('data-lazy') ||
                              cloneImg.getAttribute('src');
                  }
                  
                  // Set the URL if we found one
                  if (imageUrl && imageUrl !== 'about:blank') {
                    cloneImg.setAttribute('src', imageUrl);
                  }
                  
                  // Also copy srcset if available
                  if (originalImg && originalImg.srcset) {
                    cloneImg.setAttribute('srcset', originalImg.srcset);
                  }
                });
                
                // Handle video elements - grab URLs
                clone.querySelectorAll('video').forEach((cloneVideo, idx) => {
                  const originalVideo = originalVideos[idx] || originalVideos[0];
                  if (originalVideo) {
                    const videoUrl = originalVideo.getAttribute('data-src') || 
                                   originalVideo.src || 
                                   originalVideo.currentSrc;
                    if (videoUrl && !cloneVideo.getAttribute('src')) {
                      cloneVideo.setAttribute('src', videoUrl);
                    }
                    // Copy poster image URL
                    if (originalVideo.poster && !cloneVideo.getAttribute('poster')) {
                      cloneVideo.setAttribute('poster', originalVideo.poster);
                    }
                    // Copy source elements
                    originalVideo.querySelectorAll('source').forEach(origSource => {
                      const cloneSource = cloneVideo.querySelector(`source[type="${origSource.getAttribute('type')}"]`);
                      if (cloneSource) {
                        const sourceUrl = origSource.getAttribute('data-src') || origSource.src;
                        if (sourceUrl) {
                          cloneSource.setAttribute('src', sourceUrl);
                        }
                      }
                    });
                  }
                });
                
                // Handle embed/iframe elements - grab URLs
                clone.querySelectorAll('embed, iframe').forEach((cloneEmbed, idx) => {
                  const originalEmbed = originalEmbeds[idx] || 
                                       originalEmbeds.find(orig => orig.tagName === cloneEmbed.tagName);
                  if (originalEmbed) {
                    const embedUrl = originalEmbed.getAttribute('data-src') || 
                                   originalEmbed.src;
                    if (embedUrl && !cloneEmbed.getAttribute('src')) {
                      cloneEmbed.setAttribute('src', embedUrl);
                    }
                  }
                });
                
                // Handle Discord's attachment containers - grab URLs from nested media
                clone.querySelectorAll('[class*="attachment"], [class*="imageWrapper"], [class*="media"], [class*="embed"]').forEach(container => {
                  const containerClasses = container.className.split(' ').filter(c => c);
                  const originalContainer = containerClasses.length > 0 
                    ? el.querySelector(`.${containerClasses[0]}`) 
                    : null;
                  
                  if (originalContainer) {
                    // Copy image URLs from original container
                    originalContainer.querySelectorAll('img').forEach(origImg => {
                      const cloneImg = container.querySelector('img');
                      if (cloneImg) {
                        const imgUrl = origImg.getAttribute('data-src') || 
                                     (origImg.src && origImg.src !== 'about:blank' ? origImg.src : null) ||
                                     origImg.currentSrc;
                        if (imgUrl && !cloneImg.getAttribute('src')) {
                          cloneImg.setAttribute('src', imgUrl);
                        }
                      }
                    });
                    
                    // Copy background images
                    const bgImage = window.getComputedStyle(originalContainer).backgroundImage;
                    if (bgImage && bgImage !== 'none') {
                      container.style.backgroundImage = bgImage;
                    }
                  }
                });
              } catch (mediaErr) {
                console.warn('[ChatGrabber] Error processing media:', mediaErr);
              }
              
        captured.set(key, { html: clone.outerHTML, seq: seq++, order: order.toString(), key });
              newMessages++;
              
              // Track the topmost (oldest) newly captured message
              if (!topmostOrder || order < topmostOrder) {
                topmostOrder = order;
                topmostNewMessage = el;
              }
            } catch (e) {
              // Skip this element if there's an error processing it
              console.warn('[ChatGrabber] Error processing message element:', e);
            }
          });
          
          // Update persistent cache immediately
          window.__sf_capturedMessagesRecords = Array.from(captured.values());
          window.__sf_capturedMessages = window.__sf_capturedMessagesRecords.map(v=>v.html);
          
          // Return topmost new message if available, otherwise topmost visible message
          return { 
            newMessages, 
            topmostNewMessage: topmostNewMessage || topmostVisibleMessage 
          };
        } catch (e) {
          console.error('[ChatGrabber] Error in harvest function:', e);
          return { newMessages: 0, topmostNewMessage: null };
        }
      }
      
      function isAtTopOfChat() {
        // Check if we can see the "This is the beginning of your direct message history with" text
        try {
          // First check the message container specifically
          const list = document.querySelector('ol[data-list-id="chat-messages"]');
          const log = document.querySelector('[role="log"]');
          const container = list || log;
          
          if (container) {
            // Check first few children of message container
            const children = Array.from(container.children).slice(0, 3);
            for (const child of children) {
              const text = (child.textContent || '').toLowerCase();
              if (text.includes('this is the beginning of your direct message history with') ||
                  text.includes('beginning of your direct message history') ||
                  text.includes('beginning of your direct message')) {
                console.log('[ChatGrabber] Found "beginning" text in message container - at top');
                return true;
              }
            }
            
            // Check all text in container
            const containerText = (container.textContent || '').toLowerCase();
            if (containerText.includes('this is the beginning of your direct message history with') ||
                containerText.includes('beginning of your direct message history')) {
              console.log('[ChatGrabber] Found "beginning" text in container - at top');
              return true;
            }
          }
          
          // Check visible elements in viewport
          const visibleElements = Array.from(document.querySelectorAll('*')).filter(el => {
            try {
              const rect = el.getBoundingClientRect();
              return rect.top >= 0 && rect.top < window.innerHeight && 
                     rect.left >= 0 && rect.left < window.innerWidth &&
                     rect.width > 0 && rect.height > 0;
            } catch {
              return false;
            }
          });
          
          for (const el of visibleElements) {
            const text = (el.textContent || '').toLowerCase();
            if (text.includes('this is the beginning of your direct message history with') ||
                text.includes('beginning of your direct message history') ||
                (text.includes('beginning') && text.includes('direct message'))) {
              console.log('[ChatGrabber] Found "beginning" text in visible element - at top');
              return true;
            }
          }
          
          // Check document body as fallback
          const allText = (document.body.textContent || document.body.innerText || '').toLowerCase();
          if (allText.includes('this is the beginning of your direct message history with') ||
              allText.includes('beginning of your direct message history')) {
            console.log('[ChatGrabber] Found "beginning" text in body - at top');
            return true;
          }
        } catch (e) {
          console.warn('[ChatGrabber] Error checking if at top:', e);
        }
        return false;
      }
      
      function scrollToMessage(messageEl) {
        if (!messageEl) return false;
        
        // Check if element is still in the document
        if (!document.contains(messageEl) && !messageEl.isConnected) {
          return false;
        }
        
        try {
          // Try to get the message's position - this can fail if element is detached
          let messageRect, scrollerRect;
          try {
            messageRect = messageEl.getBoundingClientRect();
            scrollerRect = scroller.getBoundingClientRect();
          } catch (e) {
            // If getBoundingClientRect fails, try alternative approach
            try {
              const currentScrollTop = scroller.scrollTop;
              const messageOffsetTop = messageEl.offsetTop;
              if (messageOffsetTop !== undefined) {
                const targetScrollTop = Math.max(0, messageOffsetTop - 100);
                scroller.scrollTop = targetScrollTop;
                scroller.dispatchEvent(new WheelEvent('wheel', { 
                  deltaY: -150, 
                  bubbles: true, 
                  cancelable: true 
                }));
                return true;
              }
            } catch (e2) {
              return false;
            }
            return false;
          }
          
          // Calculate scroll position to put message near the top of viewport
          const currentScrollTop = scroller.scrollTop;
          const messageOffsetTop = messageEl.offsetTop || (messageRect.top - scrollerRect.top + currentScrollTop);
          const targetScrollTop = Math.max(0, messageOffsetTop - 100); // 100px from top to trigger loading
          
          // Scroll to the message position
          scroller.scrollTop = targetScrollTop;
          
          // Try scrollIntoView, but catch any DOMException
          try {
            messageEl.scrollIntoView({ behavior: 'instant', block: 'start' });
          } catch (scrollError) {
            // scrollIntoView can throw DOMException in some cases, just continue without it
            console.warn('[ChatGrabber] scrollIntoView failed, using scrollTop only:', scrollError);
          }
          
          // Dispatch multiple events to trigger Discord's lazy loading
          try {
            scroller.dispatchEvent(new WheelEvent('wheel', { 
              deltaY: -150, 
              bubbles: true, 
              cancelable: true 
            }));
            
            // Also dispatch scroll event
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch (eventError) {
            // Event dispatch can fail in some contexts, but scrollTop should still work
            console.warn('[ChatGrabber] Event dispatch failed:', eventError);
          }
          
          return true;
        } catch (e) {
          console.warn('[ChatGrabber] Error scrolling to message:', e);
          return false;
        }
      }
      
      // Capture profile header at the beginning
      async function captureProfileHeader() {
        try {
          // Scroll to top first to ensure profile header is visible
          scroller.scrollTop = 0;
          await wait(800);
          
          // Look for profile header with multiple strategies
          let profileElement = null;
          
          // Strategy 1: Check message container first (most reliable)
          const list = document.querySelector('ol[data-list-id="chat-messages"]');
          const log = document.querySelector('[role="log"]');
          const container = list || log;
          
          if (container) {
            // Check first few children of message container
            const children = Array.from(container.children);
            for (const child of children.slice(0, 5)) {
              const text = (child.textContent || '').toLowerCase();
              if (text.includes('this is the beginning of your direct message history with') ||
                  text.includes('beginning of your direct message history') ||
                  text.includes('beginning of your direct message') ||
                  text.includes('this is the beginning')) {
                profileElement = child;
                console.log('[ChatGrabber] Found profile header in message container (first child)');
                break;
              }
              
              // Also check if it has avatar or profile indicators
              if (child.querySelector('img[class*="avatar"], img[alt*="avatar"], img[class*="Avatar"]') ||
                  child.querySelector('[class*="profile"], [class*="empty"], [class*="emptyState"]')) {
                const childText = (child.textContent || '').toLowerCase();
                if (childText.includes('beginning') || childText.includes('mutual') || childText.includes('server')) {
                  profileElement = child;
                  console.log('[ChatGrabber] Found profile header in message container (has avatar/profile)');
                  break;
                }
              }
            }
          }
          
          // Strategy 2: Look for text content "beginning of your direct message" in all elements
          if (!profileElement) {
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes('this is the beginning of your direct message history with') ||
                  text.includes('beginning of your direct message history')) {
                // Find the parent container that likely contains the full profile area
                let parent = el.parentElement;
                let candidate = el;
                for (let i = 0; i < 8 && parent; i++) {
                  if (parent.querySelector('img[class*="avatar"], img[alt*="avatar"], img[class*="Avatar"]') ||
                      parent.querySelector('[class*="profile"], [class*="emptyState"], [class*="empty"]')) {
                    candidate = parent;
                    break;
                  }
                  parent = parent.parentElement;
                }
                profileElement = candidate;
                console.log('[ChatGrabber] Found profile header via text search');
                break;
              }
            }
          }
          
          // Strategy 3: Look for empty state containers
          if (!profileElement) {
            const emptySelectors = [
              '[class*="emptyState"]',
              '[class*="emptyChannel"]',
              '[class*="emptyStateWrapper"]',
              '[class*="emptyChannelIcon"]',
              'div[class*="empty"]',
              'section[class*="empty"]'
            ];
            
            for (const selector of emptySelectors) {
              const elements = document.querySelectorAll(selector);
              for (const el of elements) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('beginning') || 
                    text.includes('direct message') ||
                    el.querySelector('img[class*="avatar"], img[alt*="avatar"], img[class*="Avatar"]')) {
                  profileElement = el;
                  console.log('[ChatGrabber] Found profile header via empty state selector');
                  break;
                }
              }
              if (profileElement) break;
            }
          }
          
          // Strategy 4: Look for large avatar/profile images at the top
          if (!profileElement) {
            const largeAvatars = Array.from(document.querySelectorAll('img[class*="avatar"], img[alt*="avatar"], img[class*="Avatar"]'))
              .filter(img => {
                try {
                  const rect = img.getBoundingClientRect();
                  return rect.width > 80 && rect.height > 80; // Large avatar
                } catch {
                  return false;
                }
              });
            
            if (largeAvatars.length > 0) {
              const largeAvatar = largeAvatars[0];
              let parent = largeAvatar.parentElement;
              for (let i = 0; i < 15 && parent; i++) {
                const text = (parent.textContent || '').toLowerCase();
                if (text.includes('beginning') || 
                    text.includes('direct message') || 
                    text.includes('mutual') ||
                    text.includes('server')) {
                  profileElement = parent;
                  console.log('[ChatGrabber] Found profile header via large avatar');
                  break;
                }
                parent = parent.parentElement;
              }
            }
          }
          
          if (profileElement) {
            const clone = profileElement.cloneNode(true);
            // Ensure profile images have URLs
            clone.querySelectorAll('img').forEach(img => {
              const originalImg = profileElement.querySelector(`img[alt="${img.getAttribute('alt')}"]`) ||
                                Array.from(profileElement.querySelectorAll('img')).find(orig => 
                                  orig.className === img.className ||
                                  orig.getAttribute('src') === img.getAttribute('src')
                                );
              if (originalImg) {
                const imgUrl = originalImg.getAttribute('data-src') || 
                              originalImg.getAttribute('src') ||
                              originalImg.currentSrc;
                if (imgUrl && imgUrl !== 'about:blank') {
                  img.setAttribute('src', imgUrl);
                }
              }
            });
            const profileKey = 'sf-profile-header';
            if (!captured.has(profileKey)) {
              captured.set(profileKey, { 
                html: clone.outerHTML, 
                seq: -1, // Special sequence for profile header
                order: '0', // Oldest order
                key: profileKey 
              });
              console.log('[ChatGrabber] Successfully captured profile header:', profileElement.className);
            } else {
              console.log('[ChatGrabber] Profile header already captured');
            }
          } else {
            console.warn('[ChatGrabber] Could not find profile header element - tried all strategies');
          }
        } catch (e) {
          console.warn('[ChatGrabber] Error capturing profile header:', e);
        }
      }
      
      // Capture profile header before starting
      await captureProfileHeader();
      
      // Initial harvest
      const initialHarvest = harvest();
      let topmostMessage = initialHarvest.topmostNewMessage;
      let prevCachedCount = captured.size;
      let noChangeCount = 0;
      let topCheckCount = 0; // Track how many times we've checked at top
      
      // Main loop: scroll to last captured message to trigger next batch
      const maxMsgLimit = maxMessages && maxMessages > 0 ? maxMessages : Infinity;
      let iterations = 0;
      
      while (captured.size < maxMsgLimit) {
        iterations++;
        batchLoadDetected = false;
        
        const prevScrollTop = scroller.scrollTop;
        const prevMessageCount = countMessages();
        const currentCachedCount = captured.size;
        
        // Check if we're actually at the top of the chat
        const isAtTop = scroller.scrollTop <= 1 || isAtTopOfChat();
        
        // Scroll to the topmost captured message to force Discord to load next batch
        try {
          if (isAtTop) {
            // If we're at the top, capture profile header and scroll to absolute top
            await captureProfileHeader();
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles:true, cancelable:true }));
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            console.log(`[ChatGrabber] At top of chat, scrolling to absolute top`);
          } else if (topmostMessage) {
            const scrolled = scrollToMessage(topmostMessage);
            if (scrolled) {
              console.log(`[ChatGrabber] Scrolled to topmost message to trigger next batch`);
            }
          } else {
            // Fallback: scroll up a small amount
            try {
              const step = Math.min(200, Math.max(100, Math.floor(scroller.clientHeight * 0.3)));
        scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -step, bubbles:true, cancelable:true }));
            } catch (scrollErr) {
              console.warn('[ChatGrabber] Fallback scroll failed:', scrollErr);
            }
          }
        } catch (scrollError) {
          console.warn('[ChatGrabber] Error during scroll operation:', scrollError);
          // Continue with the loop even if scroll fails
        }
        
        // Wait for messages to load, with detection for batch loading
        await waitForQuiet(Math.max(600, settleMs), 5000);
        
        // If we detected a batch load, wait a bit more for it to fully render
        if (batchLoadDetected) {
          await wait(300);
        }
        
        // Harvest new messages (no need to wait for media to load - we grab URLs directly)
        const harvestResult = harvest();
        const newMessages = harvestResult.newMessages;
      const now = countMessages();
        const currentScrollTop = scroller.scrollTop;
        
        // Update topmost message if we captured new ones
        if (harvestResult.topmostNewMessage) {
          topmostMessage = harvestResult.topmostNewMessage;
        }
        
        // Check if cached message count stayed the same (stuck)
        if (captured.size === prevCachedCount && !isAtTop) {
          noChangeCount++;
          if (noChangeCount >= 2) {
            // Give it a "bump" - do a normal scroll up
            console.log(`[ChatGrabber] Message count unchanged (${captured.size}), giving a scroll bump`);
            try {
              const bumpStep = Math.min(300, Math.max(150, Math.floor(scroller.clientHeight * 0.5)));
              scroller.scrollTop = Math.max(0, scroller.scrollTop - bumpStep);
              scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -bumpStep, bubbles:true, cancelable:true }));
              scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
              await wait(500); // Wait a bit longer after the bump
              const bumpHarvest = harvest(); // Harvest again after bump
              if (bumpHarvest.newMessages > 0) {
                noChangeCount = 0; // Reset if bump worked
                if (bumpHarvest.topmostNewMessage) {
                  topmostMessage = bumpHarvest.topmostNewMessage;
                }
              } else if (noChangeCount >= 5) {
                // If we've tried 5 times with no change, check if we're at the top
                const atTopText = isAtTopOfChat();
                if (atTopText) {
                  console.log(`[ChatGrabber] Found "beginning of direct message" text - we're at the top. Captured ${captured.size} messages.`);
                  // Scroll to top and do final harvest
                  scroller.scrollTop = 0;
                  await wait(500);
                  harvest();
                  // Normal scroll up
                  scroller.scrollTop = 0;
                  await wait(200);
                  break;
                } else {
                  // If we've tried 5 times with no change and not at top, we're truly stuck - break
                  console.log(`[ChatGrabber] Stuck after ${noChangeCount} attempts, breaking. Captured ${captured.size} messages.`);
                  break;
                }
              }
            } catch (bumpErr) {
              console.warn('[ChatGrabber] Bump scroll failed:', bumpErr);
              if (noChangeCount >= 5) {
                // Check if we're at top before breaking
                const atTopText = isAtTopOfChat();
                if (atTopText) {
                  console.log(`[ChatGrabber] Found "beginning of direct message" text - we're at the top. Captured ${captured.size} messages.`);
                  scroller.scrollTop = 0;
                  await wait(500);
                  harvest();
                  scroller.scrollTop = 0;
                  await wait(200);
                  break;
                } else {
                  console.log(`[ChatGrabber] Too many failed attempts, breaking. Captured ${captured.size} messages.`);
                  break;
                }
              }
            }
          }
        } else {
          noChangeCount = 0; // Reset counter if we got new messages
        }
        prevCachedCount = captured.size;
        
        // Check if scroll position changed
        if (Math.abs(currentScrollTop - prevScrollTop) < 1) {
          noScrollChange++;
        } else {
          noScrollChange = 0;
        }
        
        // Check if new messages appeared
        if (now <= lastCount && newMessages === 0) {
          noNew++;
        } else {
          noNew = 0;
          lastCount = now;
        }
        
        // Progress logging
        if (iterations % 5 === 0) {
          console.log(`[ChatGrabber] Progress: ${captured.size}/${maxMsgLimit !== Infinity ? maxMsgLimit : '∞'} messages cached, scroll: ${Math.round(currentScrollTop)}, new: ${newMessages}, at top: ${isAtTop}`);
          
          // Send progress message with all currently cached elements
          try {
            const cachedArray = Array.from(captured.values()).map(rec => ({
              key: rec.key,
              order: rec.order,
              seq: rec.seq,
              html: rec.html
            }));
            
            chrome.runtime.sendMessage({
              type: 'SF_CHATGRABBER_PROGRESS',
              progress: {
                cached: captured.size,
                total: maxMsgLimit !== Infinity ? maxMsgLimit : null,
                scroll: Math.round(currentScrollTop),
                new: newMessages,
                atTop: isAtTop,
                iterations: iterations
              },
              cachedMessages: cachedArray
            }).catch(() => {
              // Ignore errors if background script isn't listening
            });
          } catch (e) {
            // Ignore errors sending progress message
          }
        }
        
        // Check if we've reached the message limit
        if (captured.size >= maxMsgLimit) {
          console.log(`[ChatGrabber] Reached message limit: ${captured.size} messages`);
          break;
        }
        
      if (untilTop) {
          // At top and no new messages for multiple iterations, and scroll hasn't changed
          if (isAtTop) {
            topCheckCount++;
            console.log(`[ChatGrabber] At top - check ${topCheckCount}/2`);
            
            // Capture profile header when at top
            await captureProfileHeader();
            
            // Try scrolling to absolute top
            scroller.scrollTop = 0;
            await wait(1000);
            const topHarvest = harvest();
            
            if (topHarvest.newMessages > 0) {
              // Got new messages, reset counters
              topCheckCount = 0;
              noNew = 0;
              noScrollChange = 0;
              lastCount = countMessages();
            } else if (topCheckCount >= 2) {
              // Checked 2 times at top with no new messages - do final check then break
              console.log(`[ChatGrabber] Checked at top 2 times, doing final check`);
              await wait(1000);
              const finalHarvest = harvest(); // Final harvest
              if (finalHarvest.topmostNewMessage) {
                topmostMessage = finalHarvest.topmostNewMessage;
              }
              const finalCount = countMessages();
              if (finalCount === lastCount && finalHarvest.newMessages === 0) {
                console.log(`[ChatGrabber] Confirmed at top with all messages (${captured.size} total)`);
                // Do a normal scroll up before breaking
                scroller.scrollTop = 0;
                await wait(200);
                break; // Confirmed at top with all messages
              }
              lastCount = finalCount;
              noNew = 0;
              topCheckCount = 0; // Reset for next iteration
            }
          } else {
            // Not at top, reset top check count
            topCheckCount = 0;
            
            if (noChangeCount >= 3 && Math.abs(currentScrollTop - prevScrollTop) < 5) {
              // If we're not at top but haven't made progress in scroll or messages, we might be stuck
              // Try scrolling to absolute top to see if there are more messages
              console.log(`[ChatGrabber] Appears stuck, trying scroll to absolute top`);
              scroller.scrollTop = 0;
              await wait(1500);
              const stuckHarvest = harvest();
              if (stuckHarvest.newMessages === 0) {
                console.log(`[ChatGrabber] No messages found at top, breaking. Captured ${captured.size} messages.`);
                // Do a normal scroll up before breaking
                scroller.scrollTop = 0;
                await wait(200);
                break;
              } else {
                noChangeCount = 0; // Reset if we found messages
              }
            }
          }
      } else {
        if (noNew >= maxNoNew) break; // stopped growing
      }
        
        lastScrollTop = currentScrollTop;
    }
      
      // Final harvest to catch any remaining messages
    harvest();
      
      // Try to capture profile header one more time at the end
      scroller.scrollTop = 0;
      await wait(500);
      captureProfileHeader();
      await wait(300);
      // Harvest again in case profile header triggered any new messages
      harvest();
      
      // Sort all cached messages chronologically
    const records = Array.from(captured.values()).sort((a,b)=>{
        try { 
          const orderA = BigInt(a.order);
          const orderB = BigInt(b.order);
          if (orderA < orderB) return -1;
          if (orderA > orderB) return 1;
          return 0;
        } catch { return a.seq - b.seq; }
      });
      
      // Update final cache
    window.__sf_capturedMessagesRecords = records;
      window.__sf_capturedMessages = records.map(v=>v.html);
      
      console.log(`[ChatGrabber] Complete: ${records.length} messages cached`);
      
      // Just scroll normally to top (no message loading attempts)
      try {
        scroller.scrollTop = 0;
      } catch {}
      
    return { ok:true, loaded: records.length };
    } catch (error) {
      console.error('[ChatGrabber] Error during scroll:', error);
      return { ok: false, error: String(error) };
    } finally {
      // Always restore original console.log
      console.log = originalConsoleLog;
    }
  })();
}

function ensureAllMessagesInDOM() {
  // Just scroll normally to top - no message loading attempts
  return (async () => {
    try {
      function findScroller() {
        const cands = [
          document.querySelector('.messagesWrapper__36d07 .scroller__36d07'),
          document.querySelector('div[class*="messagesWrapper"] div[class*="scroller"]'),
          document.querySelector('[data-list-id="chat-messages"]'),
          document.querySelector('[role="log"]'),
          document.querySelector('main div[class*="scroller"]')
        ].filter(Boolean);
        for (const el of cands) {
          const cs = getComputedStyle(el);
          const canY = /(auto|scroll)/.test(cs.overflowY);
          if (canY && el.scrollHeight > el.clientHeight) return el;
        }
        if (document.scrollingElement && document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight) {
          return document.scrollingElement;
        }
        return document.documentElement;
      }
      
      function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
      
      const scroller = findScroller();
      if (!scroller) return;
      
      // Just scroll normally to top (no loading attempts)
      scroller.scrollTop = 0;
      await wait(200);
    } catch (e) {
      console.warn('[ChatGrabber] Error scrolling to top:', e);
    }
  })();
}

function mergeBufferedMessagesIntoDiscordPage() {
  return (async () => {
    try {
    // Replace the entire message container with all cached messages
    // This ensures all messages are in the DOM as if Discord loaded them all at once
    
    // First, capture the profile/header area at the beginning of the chat
    function captureProfileHeader() {
      try {
        // Scroll to top to ensure profile header is visible
        const scroller = document.querySelector('[data-list-id="chat-messages"]')?.closest('[class*="scroller"]') ||
                        document.querySelector('[role="log"]')?.closest('[class*="scroller"]') ||
                        document.querySelector('main div[class*="scroller"]');
        if (scroller) {
          scroller.scrollTop = 0;
        }
        
        // Look for profile header with multiple strategies
        let profileElement = null;
        
        // Strategy 1: Look for text content "beginning of your direct message"
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = (el.textContent || '').toLowerCase();
          if (text.includes('beginning of your direct message') || 
              text.includes('this is the beginning')) {
            // Find the parent container that likely contains the full profile area
            let parent = el.parentElement;
            let candidate = el;
            for (let i = 0; i < 5 && parent; i++) {
              if (parent.querySelector('img[class*="avatar"], img[alt*="avatar"]') ||
                  parent.querySelector('[class*="profile"], [class*="emptyState"]')) {
                candidate = parent;
                break;
              }
              parent = parent.parentElement;
            }
            profileElement = candidate;
            break;
          }
        }
        
        // Strategy 2: Look for empty state containers
        if (!profileElement) {
          const emptySelectors = [
            '[class*="emptyState"]',
            '[class*="emptyChannel"]',
            '[class*="emptyStateWrapper"]',
            '[class*="emptyChannelIcon"]',
            'div[class*="empty"]',
            'section[class*="empty"]'
          ];
          
          for (const selector of emptySelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes('beginning') || 
                  text.includes('direct message') ||
                  el.querySelector('img[class*="avatar"], img[alt*="avatar"]')) {
                profileElement = el;
                break;
              }
            }
            if (profileElement) break;
          }
        }
        
        // Strategy 3: Check message container first child
        if (!profileElement) {
          const list = document.querySelector('ol[data-list-id="chat-messages"]');
          const log = document.querySelector('[role="log"]');
          const container = list || log;
          if (container) {
            // Check first few children
            const children = Array.from(container.children);
            for (const child of children.slice(0, 5)) {
              const text = (child.textContent || '').toLowerCase();
              if (text.includes('beginning') || 
                  text.includes('direct message') ||
                  child.querySelector('img[class*="avatar"], img[alt*="avatar"]') ||
                  child.querySelector('[class*="profile"], [class*="empty"]')) {
                profileElement = child;
                break;
              }
            }
          }
        }
        
        // Strategy 4: Look for large avatar/profile images at the top
        if (!profileElement) {
          const largeAvatars = Array.from(document.querySelectorAll('img[class*="avatar"], img[alt*="avatar"], img[class*="Avatar"]'))
            .filter(img => {
              const rect = img.getBoundingClientRect();
              return rect.width > 80 && rect.height > 80; // Large avatar
            });
          
          if (largeAvatars.length > 0) {
            const largeAvatar = largeAvatars[0];
            let parent = largeAvatar.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const text = (parent.textContent || '').toLowerCase();
              if (text.includes('beginning') || text.includes('direct message') || text.includes('mutual')) {
                profileElement = parent;
                break;
              }
              parent = parent.parentElement;
            }
          }
        }
        
        if (profileElement) {
          const clone = profileElement.cloneNode(true);
          // Ensure profile images have their URLs
          clone.querySelectorAll('img').forEach(img => {
            const originalImg = profileElement.querySelector(`img[alt="${img.getAttribute('alt')}"]`) ||
                              Array.from(profileElement.querySelectorAll('img')).find(orig => 
                                orig.className === img.className ||
                                orig.getAttribute('src') === img.getAttribute('src')
                              );
            if (originalImg) {
              const imgUrl = originalImg.getAttribute('data-src') || 
                            originalImg.getAttribute('src') ||
                            originalImg.currentSrc;
              if (imgUrl && imgUrl !== 'about:blank') {
                img.setAttribute('src', imgUrl);
              }
            }
          });
          return clone.outerHTML;
        }
      } catch (e) {
        console.warn('[ChatGrabber] Error capturing profile header:', e);
      }
      return null;
    }
    
    const profileHeaderHtml = captureProfileHeader();
    
    const list = document.querySelector('ol[data-list-id="chat-messages"]');
    const log = document.querySelector('[role="log"]');
    const container = list || log || document.querySelector('main');
    if (!container) return { ok: false, inserted: 0, title: document.title };
    
    // Use the complete cached message set
    const records = Array.isArray(window.__sf_capturedMessagesRecords) ? window.__sf_capturedMessagesRecords : (window.__sf_capturedMessages || []).map((html, i)=>({ html, key: `k${i}`, order: String(1e15+i) }));
    
    if (records.length === 0) {
      console.warn('[ChatGrabber] No cached messages to merge');
      return { ok: false, inserted: 0, title: document.title };
    }
    
    // Sort cached records by absolute time (oldest first)
    // Extract actual timestamps from HTML to ensure proper chronological sorting
    function extractTimestamp(rec) {
      try {
        // Try to parse the order field first (should be timestamp or message ID)
        const orderNum = BigInt(rec.order);
        // If order is a reasonable timestamp (after 2000-01-01), use it
        const year2000 = BigInt(Date.parse('2000-01-01'));
        if (orderNum > year2000) {
          return Number(orderNum);
        }
      } catch {}
      
      // Try to extract timestamp from the HTML itself
      try {
        const parser = document.createElement('template');
        parser.innerHTML = rec.html.trim();
        const node = parser.content.firstElementChild;
        if (node) {
          // Look for time element with datetime attribute
          const timeEl = node.querySelector('time[datetime]');
          if (timeEl) {
            const datetime = timeEl.getAttribute('datetime');
            if (datetime) {
              const timestamp = Date.parse(datetime);
              if (!isNaN(timestamp)) {
                return timestamp;
              }
            }
          }
          
          // Look for message ID in data attributes
          const idAttr = node.getAttribute('data-list-item-id') || node.id || node.getAttribute('data-message-id');
          if (idAttr) {
            const m = String(idAttr).match(/(\d{17,})/); // Discord message IDs are 17-19 digits
            if (m) {
              const msgId = BigInt(m[1]);
              // Discord message IDs contain timestamp in the high bits
              // Extract approximate timestamp (snowflake ID format)
              const timestamp = Number((msgId >> 22n) + 1420070400000n); // Discord epoch
              if (timestamp > 0 && timestamp < Date.now() + 86400000) { // Sanity check
                return timestamp;
              }
            }
          }
        }
      } catch {}
      
      // Fallback to sequence number (not ideal, but better than nothing)
      return rec.seq * 1000;
    }
    
    // Sort by absolute timestamp (oldest first)
    const sorted = records.slice().sort((a,b)=>{ 
      const timeA = extractTimestamp(a);
      const timeB = extractTimestamp(b);
      return timeA - timeB; // Oldest first (ascending order)
    });
    
    console.log(`[ChatGrabber] Merging ${sorted.length} messages into Discord structure (inverted: oldest first)`);
    
    // Remove all existing messages and placeholders from container
    const existingChildren = Array.from(container.children);
    existingChildren.forEach((child) => {
      const role = child.getAttribute && child.getAttribute('role');
      const cls = child.className || '';
      const ariaBusy = child.getAttribute('aria-busy');
      if (role === 'progressbar' || ariaBusy === 'true' || /skeleton|placeholder|spinner|loading/i.test(cls)) {
        child.remove();
      } else {
        // Remove existing messages to replace with cached ones
        child.remove();
      }
    });
    
    // Insert profile header at the beginning if we captured it
    const parser = document.createElement('template');
    let inserted = 0;
    const seenKeys = new Set();
    
    if (profileHeaderHtml) {
      try {
        parser.innerHTML = profileHeaderHtml.trim();
        const profileNode = parser.content.firstElementChild;
        if (profileNode) {
          container.insertBefore(profileNode.cloneNode(true), container.firstChild);
          inserted++;
          console.log('[ChatGrabber] Inserted profile header at beginning');
        }
      } catch (e) {
        console.warn('[ChatGrabber] Error inserting profile header:', e);
      }
    }
    
    // Insert all cached messages in reverse chronological order (oldest first)
    for (const rec of sorted) {
      // Skip duplicates
      if (rec.key && seenKeys.has(rec.key)) continue;
      
      parser.innerHTML = rec.html.trim();
      const node = parser.content.firstElementChild;
      if (!node) continue;
      
      // Skip if it's a placeholder
      const role = node.getAttribute && node.getAttribute('role');
      const cls = node.className || '';
      if (role === 'progressbar' || node.getAttribute('aria-busy') === 'true' || /skeleton|placeholder|spinner|loading/i.test(cls)) {
        continue;
      }
      
      // Append to container (oldest messages first, newest at bottom)
        container.appendChild(node.cloneNode(true));
      
      if (rec.key) seenKeys.add(rec.key);
      inserted++;
    }
    
    // Add a buffer/spacer at the bottom for extra scroll space
    try {
      const buffer = document.createElement('div');
      buffer.style.height = '50px';
      buffer.style.width = '100%';
      buffer.style.flexShrink = '0';
      buffer.setAttribute('data-sf-buffer', 'true');
      container.appendChild(buffer);
      console.log('[ChatGrabber] Added 50px buffer at bottom');
  } catch (e) {
      console.warn('[ChatGrabber] Error adding buffer:', e);
    }
    
    // Find the scroller and ensure it can scroll to show all messages
    const scroller = container.closest('[class*="scroller"]') || 
                     document.querySelector('[data-list-id="chat-messages"]')?.closest('[class*="scroller"]') ||
                     document.querySelector('[role="log"]')?.closest('[class*="scroller"]') ||
                     document.querySelector('main div[class*="scroller"]');
    
    if (scroller) {
      try {
        // Ensure container and scroller allow full scrolling
        // Remove any max-height or overflow restrictions that might clip content
        const scrollerStyle = window.getComputedStyle(scroller);
        if (scrollerStyle.overflowY === 'hidden' || scrollerStyle.overflowY === 'clip') {
          scroller.style.overflowY = 'auto';
        }
        
        // Ensure the container has proper height
        if (container) {
          const containerStyle = window.getComputedStyle(container);
          if (containerStyle.maxHeight && containerStyle.maxHeight !== 'none') {
            container.style.maxHeight = 'none';
          }
        }
        
        // Force a layout recalculation to ensure all messages are rendered
        void container.offsetHeight;
        void scroller.offsetHeight;
        
        // Wait a moment for layout to settle
        await new Promise(r => setTimeout(r, 100));
        
        // Calculate final scroll position to show newest messages
        const finalScrollHeight = scroller.scrollHeight;
        const finalClientHeight = scroller.clientHeight;
        
        // Scroll to bottom so newest messages are visible when .mhtml opens
        // Scrolling up will show older messages (inverted behavior)
        scroller.scrollTop = finalScrollHeight;
        
        // Double-check we can actually scroll to the bottom
        // Sometimes scrollHeight needs a moment to update
        await new Promise(r => setTimeout(r, 100));
        if (scroller.scrollHeight > finalScrollHeight) {
          scroller.scrollTop = scroller.scrollHeight;
        }
        
        // Verify we can scroll all the way down
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        if (scroller.scrollTop < maxScroll - 10) {
          // If we're not at the bottom, try again
          scroller.scrollTop = scroller.scrollHeight;
        }
        
        console.log(`[ChatGrabber] Scroll setup complete: scrollHeight=${scroller.scrollHeight}, clientHeight=${scroller.clientHeight}, scrollTop=${scroller.scrollTop}`);
      } catch (e) {
        console.warn('[ChatGrabber] Error setting up scroll:', e);
      }
    }
    
    console.log(`[ChatGrabber] Successfully inserted ${inserted} messages into Discord structure`);
    
    return { ok: true, inserted, title: document.title, totalMessages: records.length };
    } catch (e) {
      console.error('[ChatGrabber] Error merging messages:', e);
    return { ok: false, error: String(e), title: document.title };
  }
  })();
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
      if (message?.type === 'SF_CHATGRABBER_PROGRESS') {
        // Handle progress updates from chat grabber
        const { progress, cachedMessages } = message;
        console.log(`[ChatGrabber] Progress update: ${progress.cached} messages cached`, {
          progress,
          cachedMessagesCount: cachedMessages?.length || 0,
          cachedMessages: cachedMessages
        });
        sendResponse({ ok: true });
        return;
      }
      
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


