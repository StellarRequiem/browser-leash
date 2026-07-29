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
});
