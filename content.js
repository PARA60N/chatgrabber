/*
  Content script: Clones the DOM, inlines external resources (CSS, images,
  fonts, stylesheets, scripts where possible), rewrites CSS url() references,
  serializes to a single HTML string, and asks the background worker to download it.
  Note: Some script behaviors won't persist offline, but we'll inline script tags
  as text so the captured page renders similarly.
*/

(function () {
  const LOG_PREFIX = '[SingleFile]';

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SF_START') {
      void savePageAsSingleFile();
    }
  });

  async function savePageAsSingleFile() {
    try {
      await log('info', 'Starting capture for', location.href);
      // Allow last-second DOM updates (e.g., chat messages) to settle
      await wait(800);
      // Tag iframes in the live DOM so we can map originals to the clone
      indexIframes(document);
      const clonedDoc = document.documentElement.cloneNode(true);

      // Promote lazy-loaded attributes (e.g., data-src -> src) before inlining
      promoteLazyAttributes(clonedDoc);

      // Inline <link rel="stylesheet"> and <style> with imported URLs
      await inlineStyles(clonedDoc);

      // Inline <img>, <source>, <link rel="icon"/manifest>, etc.
      await inlineMedia(clonedDoc);

      // Inline scripts (best-effort). External scripts become inline text content.
      await inlineScripts(clonedDoc);

      // Inline same-origin iframes recursively using srcdoc
      await inlineIframes(clonedDoc);

      // Remove CSP meta tags that might block inline resources offline
      removeCspMetaTags(clonedDoc);

      const doctype = getDoctypeString(document.doctype);
      const html = doctype + '\n' + clonedDoc.outerHTML;
      const filename = generatePreferredFilename() + '.html';
      await downloadHtml(filename, html);
      await log('info', 'Saved', filename);
    } catch (err) {
      await log('error', err);
      alert('SingleFile save failed: ' + err);
    }
  }

  async function inlineStyles(rootEl) {
    // Inline external stylesheets
    const linkEls = Array.from(rootEl.querySelectorAll('link[rel="stylesheet"]'));
    for (const link of linkEls) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const absUrl = new URL(href, location.href).href;
      try {
        const cssText = await fetchText(absUrl);
        const inlined = await rewriteCssUrls(cssText, absUrl);
        const style = rootEl.ownerDocument.createElement('style');
        style.textContent = inlined;
        link.replaceWith(style);
      } catch {}
    }

    // Process existing <style> tags to inline url() assets
    const styleEls = Array.from(rootEl.querySelectorAll('style'));
    for (const style of styleEls) {
      try {
        style.textContent = await rewriteCssUrls(style.textContent || '', location.href);
      } catch {}
    }
  }

  async function inlineMedia(rootEl) {
    const attrTargets = [
      ['img', 'src'],
      ['img', 'srcset'],
      ['source', 'src'],
      ['source', 'srcset'],
      ['video', 'poster'],
      ['link[rel="icon"]', 'href'],
      ['link[rel="shortcut icon"]', 'href'],
      ['link[rel="apple-touch-icon"]', 'href'],
      ['link[rel="mask-icon"]', 'href'],
      ['link[rel="manifest"]', 'href']
    ];
    for (const [selector, attr] of attrTargets) {
      const nodes = Array.from(rootEl.querySelectorAll(selector));
      for (const node of nodes) {
        const val = node.getAttribute(attr);
        if (!val) continue;
        try {
          if (attr === 'srcset') {
            const newSet = await inlineSrcset(val);
            node.setAttribute('srcset', newSet);
          } else {
            const absUrl = new URL(val, location.href).href;
            // Skip data URLs and blob URLs
            if (absUrl.startsWith('data:') || absUrl.startsWith('blob:')) {
              continue;
            }
            try {
              const dataUrl = await fetchAsDataUrl(absUrl, true);
              node.setAttribute(attr, dataUrl);
            } catch (fetchErr) {
              // If fetch fails, try to get the image from the original element if it's loaded
              if (selector === 'img' && attr === 'src') {
                try {
                  const originalImg = document.querySelector(`img[src="${val}"], img[data-src="${val}"]`);
                  if (originalImg && originalImg.complete && originalImg.naturalWidth > 0) {
                    // Image is loaded, try to get it via canvas
                    const canvas = document.createElement('canvas');
                    canvas.width = originalImg.naturalWidth;
                    canvas.height = originalImg.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(originalImg, 0, 0);
                    try {
                      const dataUrl = canvas.toDataURL('image/png');
                      node.setAttribute(attr, dataUrl);
                      await log('info', 'Inlined image via canvas fallback:', absUrl);
                      continue;
                    } catch (canvasErr) {
                      await log('warn', 'Canvas fallback failed for:', absUrl, canvasErr);
                    }
                  }
                } catch (fallbackErr) {
                  await log('warn', 'Fallback failed for:', absUrl, fallbackErr);
                }
              }
              // Log the error but don't fail completely
              await log('warn', 'Failed to inline media:', absUrl, fetchErr);
            }
          }
        } catch (err) {
          await log('error', 'Error inlining media:', err);
        }
      }
    }
  }

  async function inlineScripts(rootEl) {
    const scriptEls = Array.from(rootEl.querySelectorAll('script'));
    for (const script of scriptEls) {
      const src = script.getAttribute('src');
      const type = script.getAttribute('type') || 'text/javascript';
      if (src) {
        try {
          const absUrl = new URL(src, location.href).href;
          const jsText = await fetchText(absUrl);
          const newScript = rootEl.ownerDocument.createElement('script');
          if (type) newScript.setAttribute('type', type);
          newScript.textContent = jsText;
          // Remove attributes that won't make sense offline
          newScript.removeAttribute('src');
          script.replaceWith(newScript);
        } catch {}
      } else {
        // Keep inline content as-is
        script.textContent = script.textContent || '';
      }
      // Remove integrity/crossorigin which may block offline
      script.removeAttribute('integrity');
      script.removeAttribute('crossorigin');
      script.removeAttribute('referrerpolicy');
    }
  }

  async function inlineIframes(rootEl) {
    const frames = Array.from(rootEl.querySelectorAll('iframe, frame'));
    for (const frame of frames) {
      const idx = frame.getAttribute('data-sf-idx');
      if (!idx) continue;
      const original = document.querySelector(`iframe[data-sf-idx="${idx}"] , frame[data-sf-idx="${idx}"]`);
      if (!original) continue;
      try {
        const childDoc = original.contentDocument;
        if (!childDoc) continue; // cross-origin or not yet loaded
        // Index nested iframes within this child document
        indexIframes(childDoc);
        const clonedChild = childDoc.documentElement.cloneNode(true);
        // Promote lazy attributes and inline assets within the iframe document
        promoteLazyAttributes(clonedChild);
        await inlineStyles(clonedChild);
        await inlineMedia(clonedChild);
        await inlineScripts(clonedChild);
        await inlineIframes(clonedChild);
        removeCspMetaTags(clonedChild);
        const doctype = getDoctypeString(childDoc.doctype);
        const srcdoc = doctype + '\n' + clonedChild.outerHTML;
        frame.removeAttribute('src');
        frame.setAttribute('srcdoc', srcdoc);
        frame.removeAttribute('srcset');
      } catch {
        // cross-origin or access denied; leave as-is (MHTML mode can capture it)
      }
    }
  }

  function indexIframes(doc) {
    try {
      const frames = doc.querySelectorAll('iframe, frame');
      let i = 0;
      for (const f of frames) {
        if (!f.getAttribute('data-sf-idx')) {
          f.setAttribute('data-sf-idx', String(i++));
        }
      }
    } catch {}
  }

  function removeCspMetaTags(rootEl) {
    const metas = Array.from(rootEl.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'));
    for (const m of metas) m.remove();
  }

  function promoteLazyAttributes(rootEl) {
    const candidates = [
      ['img', ['data-src', 'data-original', 'data-lazy', 'data-srcset']],
      ['source', ['data-src', 'data-srcset']],
      ['iframe', ['data-src']]
    ];
    for (const [selector, attrs] of candidates) {
      const nodes = Array.from(rootEl.querySelectorAll(selector));
      for (const node of nodes) {
        for (const attr of attrs) {
          const val = node.getAttribute(attr);
          if (!val) continue;
          if (attr.endsWith('srcset')) node.setAttribute('srcset', val);
          else node.setAttribute('src', val);
        }
      }
    }
  }

  async function rewriteCssUrls(cssText, baseUrl) {
    const urlRegex = /url\(([^)]+)\)/g;
    const promises = [];
    const replacements = [];
    cssText.replace(urlRegex, (match, p1, offset) => {
      let raw = p1.trim().replace(/^['\"]|['\"]$/g, '');
      if (raw.startsWith('data:') || raw.startsWith('blob:')) return match;
      try {
        const absUrl = new URL(raw, baseUrl).href;
        const p = fetchAsDataUrl(absUrl, true)
          .then((dataUrl) => {
            replacements.push({ start: offset, end: offset + match.length, text: `url(${JSON.stringify(dataUrl)})` });
          })
          .catch(() => {});
        promises.push(p);
      } catch {}
      return match;
    });
    await Promise.all(promises);
    // Apply replacements from end to start
    replacements.sort((a, b) => b.start - a.start);
    let out = cssText;
    for (const r of replacements) {
      out = out.slice(0, r.start) + r.text + out.slice(r.end);
    }
    return out;
  }

  async function inlineSrcset(srcsetValue) {
    const parts = srcsetValue.split(',').map((s) => s.trim()).filter(Boolean);
    const outParts = [];
    for (const part of parts) {
      const [urlPart, descriptor] = part.split(/\s+/, 2);
      try {
        const absUrl = new URL(urlPart, location.href).href;
        const dataUrl = await fetchAsDataUrl(absUrl, true);
        outParts.push(descriptor ? `${dataUrl} ${descriptor}` : dataUrl);
      } catch {
        outParts.push(part);
      }
    }
    return outParts.join(', ');
  }

  function getDoctypeString(doctype) {
    if (!doctype) return '<!DOCTYPE html>';
    return `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC \"${doctype.publicId}\"` : ''}${doctype.systemId ? ` \"${doctype.systemId}\"` : ''}>`;
  }

  function generatePreferredFilename() {
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
          // Discord: prefer the aria-label in the channel header (actual username/handle)
          try {
            const headerUser = doc.querySelector('h1 [aria-label]');
            const al = headerUser && headerUser.getAttribute('aria-label');
            if (al && String(al).trim()) return String(al).trim();
          } catch {}
          // Discord profile/sidebar username element
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

      const usernameFound = findUsernameInDocument(document, 5);
      const username = usernameFound || 'username';

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

      // Desired: Chat Avenue - username - Full Date & Time & Timezone
      const raw = `${siteName} - ${username} - ${datePart} ${timePart} & ${tz}`;
      const sanitized = raw
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
      return sanitized || 'page';
    } catch {
      const fallback = (document.title || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'page';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      return `${fallback} - ${ts}`;
    }
  }

  async function fetchText(url) {
    const resp = await sendMessage({ type: 'SF_FETCH_AS_DATAURL', url, asBinary: false });
    if (!resp.ok) throw new Error(resp.error || 'fetchText failed');
    const [, metaAndData] = resp.dataUrl.split(',');
    const decoded = decodeURIComponent(metaAndData.replace(/\+/g, '%20'));
    return decoded;
  }

  async function fetchAsDataUrl(url, asBinary) {
    const resp = await sendMessage({ type: 'SF_FETCH_AS_DATAURL', url, asBinary });
    if (!resp.ok) throw new Error(resp.error || 'fetchAsDataUrl failed');
    return resp.dataUrl;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => resolve(resp));
    });
  }

  async function log(level, ...args) {
    try { await sendMessage({ type: 'SF_LOG', level, args }); } catch {}
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function downloadHtml(filename, html) {
    try {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      const base64 = btoa(unescape(encodeURIComponent(html)));
      const dataUrl = `data:text/html;charset=utf-8;base64,${base64}`;
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
    }
  }
})();


