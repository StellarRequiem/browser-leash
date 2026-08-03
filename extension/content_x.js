/**
 * X compose — React/Draft-aware fill.
 * Strategy order: clipboard paste → insertText → InputEvent → space/backspace nudge.
 * Never claim success if Post stays aria-disabled when post=true.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findComposer() {
  const selectors = [
    '[data-testid="tweetTextarea_0"]',
    '[data-testid="tweetTextarea_1"]',
    'div.public-DraftEditor-content[contenteditable="true"]',
    'div[role="textbox"][data-testid^="tweetTextarea"]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findPostButton() {
  for (const sel of ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]']) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function isDisabled(btn) {
  if (!btn) return true;
  if (btn.getAttribute("aria-disabled") === "true") return true;
  if (btn.hasAttribute("disabled")) return true;
  return false;
}

function readComposerText(box) {
  return (box.innerText || box.textContent || "").replace(/\u200b/g, "").trim();
}

async function ensureComposeOpen() {
  let box = findComposer();
  if (box) return box;
  if (!location.pathname.includes("compose")) {
    // try sidebar compose
    const side = document.querySelector('a[href="/compose/post"], a[href*="/compose/post"]');
    if (side) {
      side.click();
      await sleep(800);
    }
  }
  for (let i = 0; i < 40; i++) {
    box = findComposer();
    if (box) return box;
    await sleep(150);
  }
  return null;
}

function selectAllIn(el) {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

async function fillReactComposer(box, text) {
  box.focus();
  await sleep(80);
  // physical focus click
  const r = box.getBoundingClientRect();
  const opts = { bubbles: true, clientX: r.left + 8, clientY: r.top + 8, view: window };
  box.dispatchEvent(new MouseEvent("mousedown", opts));
  box.dispatchEvent(new MouseEvent("mouseup", opts));
  box.dispatchEvent(new MouseEvent("click", opts));
  await sleep(50);

  selectAllIn(box);
  try {
    document.execCommand("delete", false, null);
  } catch (_) {}

  let method = "none";

  // --- Strategy A: clipboard paste (often updates React) ---
  try {
    await navigator.clipboard.writeText(text);
    selectAllIn(box);
    const pasted = document.execCommand("paste");
    await sleep(200);
    if (pasted && readComposerText(box).length > 0) {
      method = "clipboard_paste";
    }
  } catch (_) {}

  // --- Strategy B: insertText ---
  if (method === "none" || readComposerText(box).length < Math.min(10, text.length)) {
    try {
      selectAllIn(box);
      document.execCommand("delete", false, null);
      const ok = document.execCommand("insertText", false, text);
      await sleep(150);
      if (ok && readComposerText(box).length > 0) method = "insertText";
    } catch (_) {}
  }

  // --- Strategy C: beforeinput/input ---
  if (readComposerText(box).length < Math.min(10, text.length)) {
    selectAllIn(box);
    box.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: text,
      })
    );
    // Draft often ignores textContent alone; still try leaf
    const leaf =
      box.querySelector('[data-contents="true"]') ||
      box.querySelector('[data-text="true"]') ||
      box;
    if (leaf !== box && leaf.getAttribute("data-text") === "true") {
      leaf.textContent = text;
    }
    box.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: text,
      })
    );
    method = method === "none" ? "input_event" : method + "+input_event";
    await sleep(150);
  }

  // --- Nudge: force React re-validation (space + backspace) ---
  box.focus();
  try {
    document.execCommand("insertText", false, " ");
    await sleep(30);
    document.execCommand("delete", false, null);
    await sleep(30);
    // if still empty of real text, re-insert full text after nudge focus
    if (readComposerText(box).length < Math.min(5, text.length)) {
      document.execCommand("insertText", false, text);
    }
  } catch (_) {}

  await sleep(250);
  const got = readComposerText(box);
  return {
    method,
    gotLen: got.length,
    expectLen: text.length,
    preview: got.slice(0, 100),
    filled: got.length > 0,
  };
}

async function waitPostEnabled(maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const btn = findPostButton();
    if (btn && !isDisabled(btn)) return btn;
    await sleep(150);
  }
  return findPostButton();
}

async function compose({ text, post }) {
  if (!location.hostname.includes("x.com") && !location.hostname.includes("twitter.com")) {
    return { ok: false, code: "WRONG_HOST", detail: location.hostname };
  }

  const box = await ensureComposeOpen();
  if (!box) {
    return {
      ok: false,
      code: "NO_COMPOSER",
      detail: "Open https://x.com/compose/post while logged in",
    };
  }

  const fill = await fillReactComposer(box, text);
  if (!fill.filled) {
    return {
      ok: false,
      code: "FILL_FAILED",
      detail: `React editor did not accept text (method=${fill.method})`,
      data: fill,
    };
  }

  if (!post) {
    return {
      ok: true,
      code: "DRAFT_FILLED",
      detail: `gotLen=${fill.gotLen} method=${fill.method}`,
      data: fill,
    };
  }

  const btn = await waitPostEnabled(6000);
  if (!btn) {
    return {
      ok: false,
      code: "NO_POST_BUTTON",
      detail: `gotLen=${fill.gotLen} method=${fill.method}`,
      data: fill,
    };
  }
  if (isDisabled(btn)) {
    return {
      ok: false,
      code: "POST_DISABLED",
      detail: `gotLen=${fill.gotLen} method=${fill.method} preview=${JSON.stringify(fill.preview)} — React state may not have accepted input`,
      data: fill,
    };
  }

  btn.click();
  await sleep(1500);
  return {
    ok: true,
    code: "POST_CLICKED",
    detail: `Post clicked gotLen=${fill.gotLen} method=${fill.method}`,
    data: fill,
  };
}

// Generic page actions for parity with browser plugins
async function pageClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, code: "NO_ELEMENT", detail: selector };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, code: "CLICKED", detail: selector };
}

async function pageType(selector, text) {
  const el = document.querySelector(selector) || document.activeElement;
  if (!el) return { ok: false, code: "NO_ELEMENT", detail: selector };
  el.focus();
  if ("value" in el) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    await fillReactComposer(el, text);
  }
  return { ok: true, code: "TYPED", detail: selector };
}

async function clickPostOnly() {
  const btn = await waitPostEnabled(8000);
  if (!btn) {
    return { ok: false, code: "NO_POST_BUTTON", detail: "no post button after wait" };
  }
  if (isDisabled(btn)) {
    return {
      ok: false,
      code: "POST_DISABLED",
      detail: "Post still disabled after fill — React state or length limit",
    };
  }
  btn.click();
  await sleep(1500);
  return { ok: true, code: "POST_CLICKED", detail: "Post button clicked" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "X_COMPOSE") {
    compose({ text: msg.text || "", post: !!msg.post })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: "CONTENT_ERROR", detail: String(e) }));
    return true;
  }
  if (msg?.type === "X_CLICK_POST") {
    clickPostOnly()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: "CONTENT_ERROR", detail: String(e) }));
    return true;
  }
  if (msg?.type === "PAGE_CLICK") {
    pageClick(msg.selector || "")
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: "CONTENT_ERROR", detail: String(e) }));
    return true;
  }
  if (msg?.type === "PAGE_TYPE") {
    pageType(msg.selector || "", msg.text || "")
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: "CONTENT_ERROR", detail: String(e) }));
    return true;
  }
  if (msg?.type === "PAGE_EVAL_TEXT") {
    try {
      const t = document.body ? document.body.innerText.slice(0, 50000) : "";
      sendResponse({
        ok: true,
        data: { title: document.title, url: location.href, text: t },
      });
    } catch (e) {
      sendResponse({ ok: false, code: "CONTENT_ERROR", detail: String(e) });
    }
    return true;
  }
  if (msg?.type === "X_ARTICLE_READ") {
    readXArticle({
      maxScrolls: msg.maxScrolls || 30,
      maxChars: msg.maxChars || 200000,
      scrollPauseMs: msg.scrollPauseMs || 350,
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: "CONTENT_ERROR", detail: String(e) }));
    return true;
  }
});

/**
 * Full-article / full-post reader for X.
 * Handles long-form X Articles (/i/article/…), status posts, and author threads.
 * Scrolls to load lazy content; expands "Show more" / "Show replies" when cheap.
 */
function detectXKind(href) {
  const u = href || location.href;
  if (/\/i\/article\//i.test(u) || /\/articles?\//i.test(u)) return "article";
  if (/\/status\/\d+/i.test(u)) return "status";
  if (/x\.com\/[^/]+\/?$/i.test(u) || /twitter\.com\/[^/]+\/?$/i.test(u)) return "profile";
  return "page";
}

function clickExpanders(root) {
  const scope = root || document;
  let clicked = 0;
  const re = /show more|show replies|show this thread|read more|see more|view post engagements/i;
  const candidates = scope.querySelectorAll(
    'button, div[role="button"], span[role="button"], a[role="link"]'
  );
  for (const el of candidates) {
    const t = (el.innerText || el.textContent || "").trim();
    if (!t || t.length > 64) continue;
    if (!re.test(t)) continue;
    try {
      el.click();
      clicked += 1;
      if (clicked >= 12) break;
    } catch (_) {}
  }
  return clicked;
}

function extractArticleBlocks() {
  // Prefer long-form article shells when present
  const selectors = [
    '[data-testid="twitterarticle"]',
    '[data-testid="article-viewer"]',
    'article[data-testid="tweet"]',
    'div[data-testid="cellInnerDiv"]',
    'main[role="main"]',
    "article",
  ];
  const seen = new Set();
  const blocks = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const text = (el.innerText || "").replace(/\u200b/g, "").trim();
      if (!text || text.length < 40) continue;
      // de-dupe by first 120 chars
      const key = text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push({
        selector: sel,
        text,
        len: text.length,
      });
    }
    // If we found a strong article shell, stop early
    if (sel.includes("article") && blocks.length && blocks[0].len > 500) break;
  }
  return blocks;
}

function extractMeta() {
  const title = document.title || "";
  const url = location.href;
  let author = "";
  let handle = "";
  // User name near primary column
  const userName = document.querySelector('[data-testid="User-Name"]');
  if (userName) {
    const lines = (userName.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines[0]) author = lines[0];
    const at = lines.find((l) => l.startsWith("@"));
    if (at) handle = at;
  }
  // Headline for articles
  let headline = "";
  const h1 = document.querySelector('h1, [data-testid="tweetText"] span');
  if (h1 && (h1.innerText || "").trim().length > 8) {
    headline = (h1.innerText || "").trim().slice(0, 500);
  }
  // og:title as fallback
  const og = document.querySelector('meta[property="og:title"]');
  if (!headline && og?.content) headline = og.content;
  return { title, url, author, handle, headline };
}

function pickBody(blocks, kind) {
  if (!blocks.length) {
    const raw = (document.body?.innerText || "").replace(/\u200b/g, "").trim();
    return raw;
  }
  // Prefer the longest coherent block for articles
  if (kind === "article") {
    blocks.sort((a, b) => b.len - a.len);
    return blocks[0].text;
  }
  // Status: stitch tweet texts in order (primary + thread visible)
  if (kind === "status") {
    const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')].map((el) => {
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const text = (textEl?.innerText || el.innerText || "").replace(/\u200b/g, "").trim();
      return text;
    }).filter((t) => t.length > 0);
    if (tweets.length) {
      // de-dupe consecutive identical
      const out = [];
      for (const t of tweets) {
        if (out[out.length - 1] === t) continue;
        out.push(t);
      }
      return out.join("\n\n---\n\n");
    }
  }
  blocks.sort((a, b) => b.len - a.len);
  return blocks[0].text;
}

async function readXArticle(opts) {
  const maxScrolls = Math.max(1, Math.min(Number(opts.maxScrolls) || 30, 80));
  const maxChars = Math.max(1000, Math.min(Number(opts.maxChars) || 200000, 500000));
  const scrollPauseMs = Math.max(100, Math.min(Number(opts.scrollPauseMs) || 350, 2000));

  if (!location.hostname.includes("x.com") && !location.hostname.includes("twitter.com")) {
    return {
      ok: false,
      code: "NOT_X",
      detail: "Active tab is not x.com/twitter.com — navigate first",
      data: { url: location.href, title: document.title },
    };
  }

  const kind = detectXKind(location.href);
  let expandClicks = 0;
  expandClicks += clickExpanders(document);

  // Progressive scroll to force lazy load of long articles
  let lastHeight = 0;
  let stable = 0;
  for (let i = 0; i < maxScrolls; i++) {
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.9), left: 0, behavior: "instant" });
    await sleep(scrollPauseMs);
    if (i % 3 === 2) expandClicks += clickExpanders(document);
    const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    if (h <= lastHeight + 8) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
      lastHeight = h;
    }
  }
  // Return to top for consistent extraction
  window.scrollTo({ top: 0, behavior: "instant" });
  await sleep(200);
  expandClicks += clickExpanders(document);
  await sleep(250);

  const meta = extractMeta();
  const blocks = extractArticleBlocks();
  let body = pickBody(blocks, kind);
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
      detail:
        "Could not extract readable body — page may still be loading, paywalled, or logged out",
      data: {
        kind,
        ...meta,
        expand_clicks: expandClicks,
        blocks_found: blocks.length,
        char_count: body.length,
        word_count: words,
      },
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
      blocks_found: blocks.length,
      scrolls: maxScrolls,
    },
  };
}
