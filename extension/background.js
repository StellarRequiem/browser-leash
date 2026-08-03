/**
 * Browser Leash — service worker v0.4.0
 * CDP trusted input for React composers; arm-gated actions.
 * 0.3.6: sticky ARM toggle.
 * 0.3.7: if filled-but-disabled, hard-clear + per-char insertText (React enable path).
 * 0.3.9: short posts (≤280) per-char insertText first; longer enable wait; still human post gate.
 * 0.4.0: x.article_read — full X article / status / thread text extraction (scroll + expand).
 * 0.4.1: article_read via executeScript + sendMessage timeouts (poll loop cannot hang).
 * 0.4.2: hello even when disarmed; hard job timeout; bridge rejects stale extension.
 * 0.4.3: x.article_search — keyword search result cards for posts/articles.
 */

const BRIDGE = "http://127.0.0.1:8756";
const POLL_MS = 800;
const EXT_VERSION = "0.4.3";

let polling = false;

async function helloBridge() {
  try {
    await bridgePost("/v1/hello", {
      extensionVersion: EXT_VERSION,
      hasDebugger: typeof chrome.debugger !== "undefined",
    });
  } catch (_) {}
}

async function bridgeGet(path) {
  const r = await fetch(BRIDGE + path, { method: "GET" });
  if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
  return r.json();
}

async function bridgePost(path, body) {
  const r = await fetch(BRIDGE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
  return r.json();
}

async function report(id, payload) {
  try {
    // strip huge dataUrls from bridge report
    const p = JSON.parse(JSON.stringify(payload));
    if (p?.data?.dataUrl) {
      p.data = { ...p.data, dataUrl: undefined, dataUrl_omitted: true };
    }
    await bridgePost("/v1/result", { id, ...p });
  } catch (e) {
    console.warn("report failed", e);
  }
}

function hostAllowed(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    // Keep in sync with bridge/server.py ALLOWED_HOSTS
    const allow = new Set([
      "x.com",
      "twitter.com",
      "www.x.com",
      "www.twitter.com",
      "github.com",
      "www.github.com",
      "docs.github.com",
      "xclusivexo.com",
      "www.xclusivexo.com",
      "pypi.org",
      "www.pypi.org",
      "localhost",
      "127.0.0.1",
      "privateemail.com",
      "linkedin.com",
      "www.linkedin.com",
      "upwork.com",
      "www.upwork.com",
    ]);
    return allow.has(h);
  } catch {
    return false;
  }
}

async function ensureXTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://x.com/*", "https://twitter.com/*"],
  });
  // Prefer an existing compose tab
  const compose = tabs.find((t) => (t.url || "").includes("compose"));
  if (compose) {
    await chrome.tabs.update(compose.id, { active: true });
    return compose.id;
  }
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, {
      active: true,
      url: "https://x.com/compose/post",
    });
    return tabs[0].id;
  }
  const tab = await chrome.tabs.create({
    url: "https://x.com/compose/post",
    active: true,
  });
  return tab.id;
}

function waitTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    function check(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        chrome.tabs.onUpdated.removeListener(check);
        reject(new Error("tab load timeout"));
      }
    }
    chrome.tabs.onUpdated.addListener(check);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    });
  });
}

async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_x.js"],
    });
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200));
}

async function sendToTab(tabId, msg, timeoutMs = 45000) {
  await injectContent(tabId);
  try {
    const p = chrome.tabs.sendMessage(tabId, msg);
    if (!timeoutMs || timeoutMs <= 0) return await p;
    return await Promise.race([
      p,
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              code: "MSG_TIMEOUT",
              detail: `content script did not respond within ${timeoutMs}ms`,
            }),
          timeoutMs
        )
      ),
    ]);
  } catch (e) {
    return { ok: false, code: "MSG_FAIL", detail: String(e) };
  }
}

/** In-page extractor — runs via chrome.scripting.executeScript (no content-script message hang). */
function pageArticleExtract(opts) {
  const maxScrolls = Math.max(1, Math.min(Number(opts.maxScrolls) || 12, 40));
  const maxChars = Math.max(1000, Math.min(Number(opts.maxChars) || 200000, 500000));
  const scrollPauseMs = Math.max(80, Math.min(Number(opts.scrollPauseMs) || 250, 1500));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function detectXKind(href) {
    const u = href || location.href;
    if (/\/i\/article\//i.test(u) || /\/articles?\//i.test(u)) return "article";
    if (/\/status\/\d+/i.test(u)) return "status";
    if (/x\.com\/[^/]+\/?$/i.test(u) || /twitter\.com\/[^/]+\/?$/i.test(u)) return "profile";
    return "page";
  }

  function clickExpanders() {
    let clicked = 0;
    const re = /show more|show replies|show this thread|read more|see more/i;
    const candidates = document.querySelectorAll(
      'button, div[role="button"], span[role="button"]'
    );
    for (const el of candidates) {
      const t = (el.innerText || el.textContent || "").trim();
      if (!t || t.length > 64 || !re.test(t)) continue;
      try {
        el.click();
        clicked += 1;
        if (clicked >= 10) break;
      } catch (_) {}
    }
    return clicked;
  }

  function extractMeta() {
    const title = document.title || "";
    const url = location.href;
    let author = "";
    let handle = "";
    const userName = document.querySelector('[data-testid="User-Name"]');
    if (userName) {
      const lines = (userName.innerText || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines[0]) author = lines[0];
      const at = lines.find((l) => l.startsWith("@"));
      if (at) handle = at;
    }
    let headline = "";
    const tweetText = document.querySelector('[data-testid="tweetText"]');
    if (tweetText && (tweetText.innerText || "").trim().length > 8) {
      headline = (tweetText.innerText || "").trim().slice(0, 500);
    }
    const og = document.querySelector('meta[property="og:title"]');
    if (!headline && og?.content) headline = og.content;
    return { title, url, author, handle, headline };
  }

  function pickBody(kind) {
    if (kind === "status") {
      const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')]
        .map((el) => {
          const textEl = el.querySelector('[data-testid="tweetText"]');
          return (textEl?.innerText || el.innerText || "").replace(/\u200b/g, "").trim();
        })
        .filter((t) => t.length > 0);
      if (tweets.length) {
        const out = [];
        for (const t of tweets) {
          if (out[out.length - 1] === t) continue;
          out.push(t);
        }
        return out.join("\n\n---\n\n");
      }
    }
    const selectors = [
      '[data-testid="twitterarticle"]',
      '[data-testid="article-viewer"]',
      'article[data-testid="tweet"]',
      'div[data-testid="cellInnerDiv"]',
      'main[role="main"]',
      "article",
    ];
    let best = "";
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.innerText || "").replace(/\u200b/g, "").trim();
        if (text.length > best.length) best = text;
      }
      if (best.length > 800) break;
    }
    if (!best) best = (document.body?.innerText || "").replace(/\u200b/g, "").trim();
    return best;
  }

  return (async () => {
    if (!location.hostname.includes("x.com") && !location.hostname.includes("twitter.com")) {
      return {
        ok: false,
        code: "NOT_X",
        detail: "Active tab is not x.com/twitter.com",
        data: { url: location.href, title: document.title },
      };
    }
    const kind = detectXKind(location.href);
    let expandClicks = clickExpanders();
    let lastHeight = 0;
    let stable = 0;
    for (let i = 0; i < maxScrolls; i++) {
      // Early exit if we already have a solid body
      const early = pickBody(kind);
      if (early.length > 1200 && i >= 2) break;
      window.scrollBy({
        top: Math.floor(window.innerHeight * 0.85),
        left: 0,
        behavior: "instant",
      });
      await sleep(scrollPauseMs);
      if (i % 3 === 2) expandClicks += clickExpanders();
      const h = document.documentElement.scrollHeight || 0;
      if (h <= lastHeight + 8) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
        lastHeight = h;
      }
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    await sleep(150);
    expandClicks += clickExpanders();
    await sleep(200);

    const meta = extractMeta();
    let body = pickBody(kind);
    let truncated = false;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      truncated = true;
    }
    const words = body ? body.split(/\s+/).filter(Boolean).length : 0;
    if (!body || body.length < 20) {
      return {
        ok: false,
        code: "EMPTY_ARTICLE",
        detail: "Could not extract readable body",
        data: { kind, ...meta, expand_clicks: expandClicks, char_count: body.length, word_count: words },
      };
    }
    return {
      ok: true,
      code: "ARTICLE_READ",
      data: {
        kind,
        url: meta.url,
        title: meta.title,
        author: meta.author,
        handle: meta.handle,
        headline: meta.headline,
        body,
        char_count: body.length,
        word_count: words,
        truncated,
        expand_clicks: expandClicks,
        scrolls: maxScrolls,
      },
    };
  })();
}

/**
 * Extract X search result cards (posts + article links) after optional scroll.
 * Runs via executeScript on the active search tab.
 */
function pageSearchExtract(opts) {
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 20, 50));
  const maxScrolls = Math.max(0, Math.min(Number(opts.maxScrolls) || 8, 30));
  const scrollPauseMs = Math.max(80, Math.min(Number(opts.scrollPauseMs) || 300, 1500));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function absUrl(href) {
    if (!href) return "";
    try {
      return new URL(href, location.origin).href;
    } catch (_) {
      return href;
    }
  }

  function parseEngagement(article) {
    const out = { replies: null, reposts: null, likes: null, views: null };
    const map = {
      reply: "replies",
      retweet: "reposts",
      like: "likes",
      analytics: "views",
    };
    for (const [testid, key] of Object.entries(map)) {
      const el = article.querySelector(`[data-testid="${testid}"]`);
      if (!el) continue;
      const aria = el.getAttribute("aria-label") || el.innerText || "";
      const m = aria.replace(/,/g, "").match(/([\d.]+)\s*([KkMm])?/);
      if (!m) continue;
      let n = parseFloat(m[1]);
      if (m[2] && m[2].toLowerCase() === "k") n *= 1000;
      if (m[2] && m[2].toLowerCase() === "m") n *= 1e6;
      out[key] = Math.round(n);
    }
    return out;
  }

  function collectCards() {
    const cards = [];
    const seen = new Set();

    // Long-form article anchors first
    for (const a of document.querySelectorAll('a[href*="/i/article/"], a[href*="/articles/"]')) {
      const href = absUrl(a.getAttribute("href") || "");
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const text = (a.innerText || a.textContent || "").replace(/\u200b/g, "").trim();
      cards.push({
        kind: "article",
        url: href,
        text: text.slice(0, 800),
        author: "",
        handle: "",
        engagement: {},
      });
    }

    // Status / timeline cards
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = (textEl?.innerText || "").replace(/\u200b/g, "").trim();
      let statusUrl = "";
      for (const a of article.querySelectorAll('a[href*="/status/"]')) {
        const h = a.getAttribute("href") || "";
        if (/\/status\/\d+/.test(h) && !h.includes("/analytics") && !h.includes("/photo")) {
          statusUrl = absUrl(h.split("?")[0]);
          break;
        }
      }
      if (!statusUrl) continue;
      if (seen.has(statusUrl)) continue;
      seen.add(statusUrl);

      let author = "";
      let handle = "";
      const userName = article.querySelector('[data-testid="User-Name"]');
      if (userName) {
        const lines = (userName.innerText || "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines[0]) author = lines[0];
        const at = lines.find((l) => l.startsWith("@"));
        if (at) handle = at;
      }

      // Nested article link inside a post
      let articleUrl = "";
      for (const a of article.querySelectorAll('a[href*="/i/article/"], a[href*="/articles/"]')) {
        articleUrl = absUrl(a.getAttribute("href") || "");
        if (articleUrl) break;
      }

      const engagement = parseEngagement(article);
      cards.push({
        kind: articleUrl ? "article_card" : "status",
        url: articleUrl || statusUrl,
        status_url: statusUrl,
        article_url: articleUrl || null,
        text: text.slice(0, 1200),
        author,
        handle,
        engagement,
      });
    }

    return cards;
  }

  return (async () => {
    if (!location.hostname.includes("x.com") && !location.hostname.includes("twitter.com")) {
      return {
        ok: false,
        code: "NOT_X",
        detail: "Active tab is not x.com",
        data: { url: location.href },
      };
    }

    let lastCount = 0;
    let stable = 0;
    for (let i = 0; i < maxScrolls; i++) {
      const cards = collectCards();
      if (cards.length >= maxResults) break;
      if (cards.length <= lastCount) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
        lastCount = cards.length;
      }
      window.scrollBy({
        top: Math.floor(window.innerHeight * 0.9),
        left: 0,
        behavior: "instant",
      });
      await sleep(scrollPauseMs);
    }

    const all = collectCards();
    const results = all.slice(0, maxResults);
    return {
      ok: true,
      code: "ARTICLE_SEARCH",
      data: {
        url: location.href,
        title: document.title,
        count: results.length,
        results,
      },
    };
  })();
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  let attached = false;
  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    } catch (e) {
      if (!String(e.message || e).includes("Already attached")) throw e;
      attached = true;
    }
    return await fn(target);
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_) {}
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Meta/Cmd chord (Mac) or Ctrl on non-Mac — we always send Meta for this host. */
async function cdpMetaKey(target, key, code, vk) {
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 4, // Meta
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 4,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

async function cdpBackspace(target) {
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
}

async function cdpClearComposer(target) {
  await cdpMetaKey(target, "a", "KeyA", 65);
  await sleep(40);
  await cdpBackspace(target);
  await sleep(60);
}

/** Type text with per-character CDP events (updates React / Draft model).
 * Use only type:"char" for printables — keyDown+text AND char doubles glyphs on X.
 */
async function cdpTypeChars(target, text) {
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "char",
        text: "\r",
        unmodifiedText: "\r",
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      continue;
    }
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "char",
      text: ch,
      unmodifiedText: ch,
    });
  }
}

async function cdpReadComposerState(target) {
  const check = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-testid="tweetTextarea_0"]')
        || document.querySelector('div.public-DraftEditor-content[contenteditable="true"]')
        || document.querySelector('div[role="textbox"][contenteditable="true"]');
      const t = (el && (el.innerText || el.textContent) || '').replace(/\\u200b/g,'').trim();
      const btns = [
        ...document.querySelectorAll('[data-testid="tweetButtonInline"]'),
        ...document.querySelectorAll('[data-testid="tweetButton"]'),
      ];
      const isDisabled = (btn) =>
        !btn || btn.getAttribute('aria-disabled') === 'true' || !!btn.disabled
        || (btn.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const enabled = btns.find((b) => !isDisabled(b));
      const anyBtn = enabled || btns[0] || null;
      const first = t.split('\\n')[0] || '';
      return {
        gotLen: t.length,
        firstLine: first.slice(0, 120),
        postDisabled: !enabled,
        startsWithShipped: t.startsWith('Shipped'),
        hasBtn: btns.length > 0,
        enabledBtnTestId: enabled ? (enabled.getAttribute('data-testid') || '') : '',
        btnCount: btns.length,
      };
    })()`,
    returnByValue: true,
  });
  return check?.result?.value || {};
}

/**
 * Type into X composer using CDP (trusted). Multi-strategy because bulk
 * Input.insertText often paints ghost DOM text without enabling Post.
 */
async function cdpFillComposer(tabId, text) {
  return withDebugger(tabId, async (target) => {
    const focus = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const sels = [
          '[data-testid="tweetTextarea_0"]',
          'div.public-DraftEditor-content[contenteditable="true"]',
          'div[role="textbox"][contenteditable="true"]'
        ];
        let el = null;
        for (const s of sels) { el = document.querySelector(s); if (el) break; }
        if (!el) return { ok: false, reason: 'no_composer' };
        el.focus();
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.left + Math.min(20, r.width/2), y: r.top + Math.min(12, r.height/2) };
      })()`,
      returnByValue: true,
    });
    const fv = focus?.result?.value;
    if (!fv?.ok) {
      return { ok: false, code: "NO_COMPOSER", detail: fv?.reason || "no composer", data: fv };
    }

    // Click into the field (trusted mouse)
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fv.x,
      y: fv.y,
      button: "left",
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: fv.x,
      y: fv.y,
      button: "left",
      clickCount: 1,
    });
    await sleep(120);
    await cdpClearComposer(target);

    const intentLen = text.trim().length;
    const looksFilled = (state) => {
      const g = state.gotLen || 0;
      const first = (state.firstLine || "").replace(/\s+/g, " ");
      const want = text.trim().split("\n")[0].slice(0, 40);
      if (intentLen > 0 && g >= intentLen * 1.6) return false;
      if (g >= Math.max(8, Math.floor(intentLen * 0.85)) && first.startsWith(want.slice(0, 12)))
        return true;
      return g >= Math.min(20, intentLen) && g <= intentLen + 5;
    };

    async function perCharInsert(body) {
      for (const ch of body) {
        if (ch === "\n" || ch === "\r") {
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "char",
            text: "\r",
            unmodifiedText: "\r",
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        } else {
          await chrome.debugger.sendCommand(target, "Input.insertText", { text: ch });
        }
        await sleep(6);
      }
    }

    let method = "none";
    let v = { gotLen: 0, postDisabled: true };

    // --- Strategy 0 (0.3.9): short posts — per-char insertText FIRST ---
    if (intentLen > 0 && intentLen <= 280) {
      await perCharInsert(text);
      await sleep(500);
      method = "insertText_per_char_first";
      v = await cdpReadComposerState(target);
      // poll enable up to ~2s
      for (let i = 0; i < 8 && v.postDisabled && looksFilled(v); i++) {
        await sleep(250);
        v = await cdpReadComposerState(target);
      }
      if (looksFilled(v)) {
        // Stop multi-strategy stacking (was doubling text). readyToPost only if enabled.
        v.method = method;
        return {
          ok: true,
          readyToPost: !v.postDisabled,
          code: v.postDisabled ? "CDP_FILLED_BUT_DISABLED" : "CDP_FILLED",
          detail: `cdp method=${method} gotLen=${v.gotLen} postDisabled=${v.postDisabled} first=${JSON.stringify(v.firstLine)}`,
          data: v,
        };
      }
      await cdpClearComposer(target);
      await sleep(80);
    }

    // --- Strategy 1: system clipboard + Cmd+V ---
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
          awaitPromise: true,
        });
      }
      await sleep(80);
      await cdpMetaKey(target, "v", "KeyV", 86);
      await sleep(450);
      method = method === "none" ? "cmd_v" : method + "+cmd_v";
    } catch (e) {
      method = (method === "none" ? "" : method + "+") + "cmd_v_failed:" + String(e).slice(0, 60);
    }

    v = await cdpReadComposerState(target);

    // --- Strategy 2: bulk insertText (fast; may ghost) ---
    if (!looksFilled(v) || (v.postDisabled && (v.gotLen || 0) < 10)) {
      await cdpClearComposer(target);
      await chrome.debugger.sendCommand(target, "Input.insertText", { text });
      await sleep(350);
      method = method + "+insertText";
      v = await cdpReadComposerState(target);
    }

    // --- Strategy 3: key events if still empty/short ---
    if (!looksFilled(v) && (v.gotLen || 0) < Math.min(20, intentLen || 20)) {
      await cdpClearComposer(target);
      await cdpTypeChars(target, ".");
      await sleep(40);
      await cdpClearComposer(target);
      await cdpTypeChars(target, text);
      await sleep(400);
      method = method + "+char_keys";
      v = await cdpReadComposerState(target);
    }

    // Nudge when filled but Post disabled
    if (v.postDisabled && looksFilled(v)) {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "char",
        text: " ",
        unmodifiedText: " ",
      });
      await sleep(40);
      await cdpBackspace(target);
      await sleep(300);
      method = method + "+nudge";
      v = await cdpReadComposerState(target);
    }

    // --- Strategy 4: still disabled → hard clear + per-char ---
    if (v.postDisabled && intentLen > 0 && intentLen <= 500) {
      await cdpClearComposer(target);
      await cdpClearComposer(target);
      await sleep(80);
      await perCharInsert(text);
      await sleep(500);
      method = method + "+insertText_per_char";
      v = await cdpReadComposerState(target);
      for (let i = 0; i < 10 && v.postDisabled && looksFilled(v); i++) {
        await sleep(200);
        v = await cdpReadComposerState(target);
      }
    }

    v.method = method;
    const ready = looksFilled(v) && !v.postDisabled;
    return {
      ok: (v.gotLen || 0) > 0,
      readyToPost: ready,
      code: v.postDisabled ? "CDP_FILLED_BUT_DISABLED" : "CDP_FILLED",
      detail: `cdp method=${method} gotLen=${v.gotLen} postDisabled=${v.postDisabled} first=${JSON.stringify(v.firstLine)}`,
      data: v,
    };
  });
}

async function cdpClickPost(tabId) {
  return withDebugger(tabId, async (target) => {
    // Prefer an enabled Post button; poll briefly for React to enable
    let v = {};
    for (let i = 0; i < 15; i++) {
      const loc = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const btns = [
            ...document.querySelectorAll('[data-testid="tweetButtonInline"]'),
            ...document.querySelectorAll('[data-testid="tweetButton"]'),
          ];
          const isDisabled = (btn) =>
            !btn || btn.getAttribute('aria-disabled') === 'true' || !!btn.disabled;
          const btn = btns.find((b) => !isDisabled(b)) || null;
          if (!btn) {
            return { ok: false, reason: btns.length ? 'disabled' : 'no_btn', btnCount: btns.length };
          }
          btn.scrollIntoView({ block: 'center', inline: 'center' });
          const r = btn.getBoundingClientRect();
          return {
            ok: true,
            x: r.left + r.width/2,
            y: r.top + r.height/2,
            testId: btn.getAttribute('data-testid') || '',
          };
        })()`,
        returnByValue: true,
      });
      v = loc?.result?.value || {};
      if (v.ok) break;
      await sleep(200);
    }
    if (!v.ok) {
      return { ok: false, code: "POST_NOT_READY", detail: v.reason || "no button" };
    }
    // Trusted mouse click
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: v.x,
      y: v.y,
      button: "left",
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: v.x,
      y: v.y,
      button: "left",
      clickCount: 1,
    });
    // Also dispatch DOM click as belt-and-suspenders
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const btns = [
          ...document.querySelectorAll('[data-testid="tweetButtonInline"]'),
          ...document.querySelectorAll('[data-testid="tweetButton"]'),
        ];
        const isDisabled = (btn) =>
          !btn || btn.getAttribute('aria-disabled') === 'true' || !!btn.disabled;
        const btn = btns.find((b) => !isDisabled(b));
        if (btn) { btn.click(); return true; }
        return false;
      })()`,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 1500));
    return {
      ok: true,
      code: "POST_CLICKED",
      detail: `CDP mouse+dom click on Post (${v.testId || "btn"})`,
    };
  });
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function runJob(job) {
  const action = job.action;
  const p = job.payload || {};

  if (action === "tab.list") {
    const tabs = await chrome.tabs.query({});
    return {
      ok: true,
      data: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
    };
  }

  if (action === "page.info") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      ok: true,
      data: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
    };
  }

  if (action === "tab.navigate") {
    const url = p.url || "";
    if (!hostAllowed(url)) {
      return { ok: false, code: "HOST_DENIED", detail: url };
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url });
      await waitTabComplete(tab.id);
      return { ok: true, data: { tabId: tab.id, url } };
    }
    const created = await chrome.tabs.create({ url, active: true });
    await waitTabComplete(created.id);
    return { ok: true, data: { tabId: created.id, url } };
  }

  if (action === "x.compose_draft" || action === "x.post") {
    const text = p.text || "";
    const clickOnly = !!(p.click_only || p.clickOnly);
    if (!clickOnly && !text.trim()) return { ok: false, code: "EMPTY_TEXT" };

    const tabId = await ensureXTab();
    await waitTabComplete(tabId).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));

    // click-only: do not re-fill (prevents double-text after draft)
    if (action === "x.post" && clickOnly) {
      const state = await withDebugger(tabId, async (target) => {
        return cdpReadComposerState(target);
      }).catch(() => ({}));
      if (state.postDisabled) {
        return {
          ok: false,
          code: "POST_DISABLED",
          detail:
            "click-only: Post still disabled (React may not own the draft). " +
            `gotLen=${state.gotLen} first=${JSON.stringify(state.firstLine)}`,
          data: state,
        };
      }
      try {
        const click = await cdpClickPost(tabId);
        return click.ok
          ? { ok: true, code: "POST_CLICKED", detail: click.detail, data: state }
          : { ok: false, code: click.code || "POST_FAILED", detail: click.detail, data: state };
      } catch (e) {
        return { ok: false, code: "POST_CLICK_ERR", detail: String(e), data: state };
      }
    }

    let fill;
    try {
      fill = await cdpFillComposer(tabId, text);
    } catch (e) {
      // fallback content script
      fill = await sendToTab(tabId, { type: "X_COMPOSE", text, post: false });
      fill = {
        ok: !!fill?.ok,
        readyToPost: false,
        code: fill?.code,
        detail: `cdp_error=${e}; cs=${fill?.detail}`,
        data: fill?.data,
      };
    }

    if (!fill.ok) {
      return {
        ok: false,
        code: "FILL_FAILED",
        detail: fill.detail,
        data: fill,
      };
    }

    // Critical: refuse to post if we only have phantom DOM text / disabled button
    if (action === "x.compose_draft") {
      return {
        ok: true,
        code: "DRAFT_FILLED",
        detail: fill.detail,
        data: fill.data,
      };
    }

    if (fill.readyToPost === false || fill.data?.postDisabled) {
      return {
        ok: false,
        code: "POST_DISABLED",
        detail:
          "Editor state did not enable Post after CDP fill. " +
          "Refusing to click (avoids posting a partial/stale draft). " +
          fill.detail,
        data: fill.data,
      };
    }

    if (job.require_post_confirm) {
      await chrome.storage.session.set({
        pendingPost: { id: job.id, text, created: Date.now() },
      });
      await chrome.action.setBadgeText({ text: "POST" });
      await chrome.action.setBadgeBackgroundColor({ color: "#c45c26" });
      const deadline = Date.now() + 120000;
      let approved = false;
      while (Date.now() < deadline) {
        const st = await chrome.storage.session.get(["postConfirm"]);
        if (st.postConfirm && st.postConfirm.id === job.id) {
          approved = !!st.postConfirm.ok;
          await chrome.storage.session.remove(["postConfirm", "pendingPost"]);
          break;
        }
        const arm = await chrome.storage.local.get(["armed", "armUntil"]);
        if (!isArmedLocal(arm)) {
          await chrome.action.setBadgeText({ text: "" });
          return { ok: false, code: "DISARMED" };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      await chrome.action.setBadgeText({ text: "" });
      if (!approved) {
        return { ok: false, code: "POST_NOT_CONFIRMED" };
      }
    }

    try {
      const click = await cdpClickPost(tabId);
      return { ...click, data: { fill: fill.data, click } };
    } catch (e) {
      const cs = await sendToTab(tabId, { type: "X_CLICK_POST" });
      return cs || { ok: false, code: "CLICK_FAIL", detail: String(e) };
    }
  }

  if (action === "page.click") {
    const tabId = p.tabId || (await activeTabId());
    if (!tabId) return { ok: false, code: "NO_TAB" };
    return sendToTab(tabId, { type: "PAGE_CLICK", selector: p.selector || "" });
  }
  if (action === "page.type") {
    const tabId = p.tabId || (await activeTabId());
    if (!tabId) return { ok: false, code: "NO_TAB" };
    return sendToTab(tabId, {
      type: "PAGE_TYPE",
      selector: p.selector || "",
      text: p.text || "",
    });
  }
  if (action === "page.snapshot") {
    const tabId = p.tabId || (await activeTabId());
    if (!tabId) return { ok: false, code: "NO_TAB" };
    return sendToTab(tabId, { type: "PAGE_EVAL_TEXT" });
  }
  if (action === "page.screenshot") {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
      return {
        ok: true,
        code: "SCREENSHOT",
        data: {
          mime: "image/png",
          approxBytes: Math.floor((dataUrl.length * 3) / 4),
          dataUrl,
        },
      };
    } catch (e) {
      return { ok: false, code: "SCREENSHOT_FAIL", detail: String(e) };
    }
  }
  if (action === "page.press") {
    const tabId = p.tabId || (await activeTabId());
    if (!tabId) return { ok: false, code: "NO_TAB" };
    const key = p.key || "Enter";
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (k) => {
          const t = document.activeElement || document.body;
          t.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
          t.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true }));
        },
        args: [key],
      });
      return { ok: true, code: "PRESSED", detail: key };
    } catch (e) {
      return { ok: false, code: "PRESS_FAIL", detail: String(e) };
    }
  }
  if (action === "page.scroll") {
    const tabId = p.tabId || (await activeTabId());
    if (!tabId) return { ok: false, code: "NO_TAB" };
    const dy = Number(p.dy ?? p.y ?? 600);
    const dx = Number(p.dx ?? p.x ?? 0);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => {
          window.scrollBy({ left: x, top: y, behavior: "instant" });
          return { scrollX: window.scrollX, scrollY: window.scrollY };
        },
        args: [dx, dy],
      });
      return { ok: true, code: "SCROLLED", data: { dx, dy } };
    } catch (e) {
      return { ok: false, code: "SCROLL_FAIL", detail: String(e) };
    }
  }

  if (action === "x.article_read") {
    // Full article/post body (T1 observe). Prefer executeScript so a hung content-script
    // channel cannot stall the poll loop.
    let tabId = p.tabId || null;
    const url = (p.url || "").trim();
    if (url) {
      if (!hostAllowed(url)) {
        return { ok: false, code: "HOST_DENIED", detail: url };
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { url });
        tabId = tab.id;
      } else {
        const created = await chrome.tabs.create({ url, active: true });
        tabId = created.id;
      }
      await waitTabComplete(tabId).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      tabId = await activeTabId();
    }
    if (!tabId) return { ok: false, code: "NO_TAB" };

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tabUrl = tab?.url || "";
    if (!/x\.com|twitter\.com/i.test(tabUrl)) {
      return {
        ok: false,
        code: "NOT_X",
        detail: "Active tab is not on x.com — pass url= or navigate first",
        data: { url: tabUrl },
      };
    }

    const maxScrolls = Number(p.max_scrolls ?? p.maxScrolls ?? 12);
    const maxChars = Number(p.max_chars ?? p.maxChars ?? 200000);
    const scrollPauseMs = Number(p.scroll_pause_ms ?? p.scrollPauseMs ?? 250);
    const opts = { maxScrolls, maxChars, scrollPauseMs };

    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageArticleExtract,
        args: [opts],
      });
      const res = injected?.[0]?.result;
      if (res && typeof res === "object" && (res.ok === true || res.code)) return res;
      // Fallback: content-script message path (with hard timeout)
      const cs = await sendToTab(
        tabId,
        {
          type: "X_ARTICLE_READ",
          maxScrolls,
          maxChars,
          scrollPauseMs,
        },
        25000
      );
      return cs || { ok: false, code: "ARTICLE_READ_FAIL", detail: "empty extract result" };
    } catch (e) {
      const cs = await sendToTab(
        tabId,
        {
          type: "X_ARTICLE_READ",
          maxScrolls,
          maxChars,
          scrollPauseMs,
        },
        25000
      );
      if (cs?.ok) return cs;
      return {
        ok: false,
        code: "ARTICLE_READ_FAIL",
        detail: String(e),
        data: cs || null,
      };
    }
  }

  if (action === "x.article_search") {
    // Keyword search → result cards (T1 observe). Optional navigate to search URL.
    const query = String(p.query || p.q || "").trim();
    const sort = String(p.sort || p.f || "latest").toLowerCase(); // latest | top
    const maxResults = Number(p.max_results ?? p.maxResults ?? 20);
    const maxScrolls = Number(p.max_scrolls ?? p.maxScrolls ?? 8);
    const scrollPauseMs = Number(p.scroll_pause_ms ?? p.scrollPauseMs ?? 300);

    let tabId = p.tabId || null;
    let searchUrl = String(p.url || "").trim();
    if (!searchUrl && query) {
      const f = sort === "top" ? "top" : "live";
      // Prefer article-ish hits when operator asks for articles
      const q = p.articles_only
        ? `${query} filter:has_engagement`
        : query;
      searchUrl = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=${f}`;
    }
    if (searchUrl) {
      if (!hostAllowed(searchUrl)) {
        return { ok: false, code: "HOST_DENIED", detail: searchUrl };
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { url: searchUrl });
        tabId = tab.id;
      } else {
        const created = await chrome.tabs.create({ url: searchUrl, active: true });
        tabId = created.id;
      }
      await waitTabComplete(tabId).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      tabId = await activeTabId();
    }
    if (!tabId) return { ok: false, code: "NO_TAB" };

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tabUrl = tab?.url || "";
    if (!/x\.com|twitter\.com/i.test(tabUrl)) {
      return {
        ok: false,
        code: "NOT_X",
        detail: "Need query= or url= to open X search, or already be on x.com search",
        data: { url: tabUrl },
      };
    }

    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageSearchExtract,
        args: [{ maxResults, maxScrolls, scrollPauseMs }],
      });
      const res = injected?.[0]?.result;
      if (res && typeof res === "object") {
        if (res.ok && res.data) {
          res.data.query = query || null;
          res.data.sort = sort;
          res.data.search_url = searchUrl || tabUrl;
        }
        return res;
      }
      return {
        ok: false,
        code: "SEARCH_EMPTY",
        detail: "executeScript returned no search payload",
      };
    } catch (e) {
      return { ok: false, code: "SEARCH_FAIL", detail: String(e) };
    }
  }

  return { ok: false, code: "UNKNOWN_ACTION", detail: action };
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  await helloBridge();
  while (true) {
    try {
      // Always hello so bridge status shows extension.version even when disarmed
      await helloBridge();
      const arm = await chrome.storage.local.get(["armed", "armUntil"]);
      const armed = isArmedLocal(arm);
      if (!armed) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const data = await bridgeGet("/v1/poll?wait=5");
      if (data.job) {
        let result;
        try {
          // Hard cap any single job so the poll loop cannot stall forever
          result = await Promise.race([
            runJob(data.job),
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    ok: false,
                    code: "JOB_TIMEOUT",
                    detail: "runJob exceeded 90s",
                  }),
                90000
              )
            ),
          ]);
        } catch (e) {
          result = { ok: false, code: "EXT_ERROR", detail: String(e) };
        }
        await report(data.job.id, result);
      }
    } catch (_) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Local arm: sticky if armUntil<=0, else timed. */
function isArmedLocal(st) {
  if (!st?.armed) return false;
  const until = Number(st.armUntil || 0);
  if (until <= 0) return true;
  return Date.now() < until;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ armed: false, armUntil: 0 });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ARM") {
    // Default sticky toggle: ttlSec 0 (no auto-expiry). Pass ttlSec>0 for timed arm.
    const ttl =
      msg.ttlSec === undefined || msg.ttlSec === null ? 0 : Number(msg.ttlSec);
    const until = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    chrome.storage.local.set({ armed: true, armUntil: until }, async () => {
      try {
        await bridgePost("/v1/arm", { armed: true, ttl: ttl > 0 ? ttl : 0 });
      } catch (_) {}
      chrome.action.setBadgeText({ text: "ARM" });
      chrome.action.setBadgeBackgroundColor({ color: "#3d8f6e" });
      sendResponse({ ok: true, until, mode: ttl > 0 ? "timed" : "toggle" });
    });
    return true;
  }
  if (msg?.type === "DISARM") {
    chrome.storage.local.set({ armed: false, armUntil: 0 }, async () => {
      try {
        await bridgePost("/v1/arm", { armed: false });
      } catch (_) {}
      chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === "GET_STATE") {
    chrome.storage.local.get(["armed", "armUntil"], async (st) => {
      let bridge = null;
      try {
        bridge = await bridgeGet("/v1/status");
      } catch (e) {
        bridge = { ok: false, detail: String(e) };
      }
      const pending = await chrome.storage.session.get(["pendingPost"]);
      const until = Number(st.armUntil || 0);
      sendResponse({
        version: EXT_VERSION,
        expectVersion: bridge?.expect_extension_version || "0.4.3",
        armed: isArmedLocal(st),
        armUntil: until,
        armMode: until > 0 ? "timed" : st.armed ? "toggle" : "off",
        bridge,
        pendingPost: pending.pendingPost || null,
      });
    });
    return true;
  }
  if (msg?.type === "CONFIRM_POST") {
    chrome.storage.session.set(
      { postConfirm: { id: msg.id, ok: !!msg.ok } },
      () => sendResponse({ ok: true })
    );
    return true;
  }
});

chrome.alarms.create("leash-poll-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  pollLoop();
});

pollLoop();
