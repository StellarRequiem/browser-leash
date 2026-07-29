/**
 * Browser Leash — service worker v0.3.7
 * CDP trusted input for React composers; arm-gated actions.
 * 0.3.6: sticky ARM toggle.
 * 0.3.7: if filled-but-disabled, hard-clear + per-char insertText (React enable path).
 */

const BRIDGE = "http://127.0.0.1:8756";
const POLL_MS = 800;
const EXT_VERSION = "0.3.7";

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

async function sendToTab(tabId, msg) {
  await injectContent(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return { ok: false, code: "MSG_FAIL", detail: String(e) };
  }
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
      const btn = document.querySelector('[data-testid="tweetButtonInline"]')
        || document.querySelector('[data-testid="tweetButton"]');
      const disabled = !btn || btn.getAttribute('aria-disabled') === 'true' || !!btn.disabled;
      const first = t.split('\\n')[0] || '';
      return {
        gotLen: t.length,
        firstLine: first.slice(0, 120),
        postDisabled: disabled,
        startsWithShipped: t.startsWith('Shipped'),
        hasBtn: !!btn,
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

    let method = "none";

    // --- Strategy 1: system clipboard + Cmd+V (trusted paste into React) ---
    try {
      // Prefer extension clipboard (system-wide); page clipboard often denied.
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
      method = "cmd_v";
    } catch (e) {
      method = "cmd_v_failed:" + String(e).slice(0, 80);
    }

    let v = await cdpReadComposerState(target);
    const intentLen = text.trim().length;
    const looksFilled = (state) => {
      const g = state.gotLen || 0;
      const first = (state.firstLine || "").replace(/\s+/g, " ");
      const want = text.trim().split("\n")[0].slice(0, 40);
      // reject doubled body (gotLen ~2x intent)
      if (intentLen > 0 && g >= intentLen * 1.6) return false;
      if (g >= Math.max(8, Math.floor(intentLen * 0.85)) && first.startsWith(want.slice(0, 12)))
        return true;
      return g >= Math.min(20, intentLen) && g <= intentLen + 5;
    };

    // --- Strategy 2: bulk insertText (fast; may ghost) ---
    if (!looksFilled(v) || (v.postDisabled && (v.gotLen || 0) < 10)) {
      await cdpClearComposer(target);
      await chrome.debugger.sendCommand(target, "Input.insertText", { text });
      await sleep(350);
      method = method.startsWith("cmd_v") ? method + "+insertText" : "insertText";
      v = await cdpReadComposerState(target);
    }

    // --- Strategy 3: per-character only if still empty/short (never retype a full fill) ---
    if (!looksFilled(v) && (v.gotLen || 0) < Math.min(20, intentLen || 20)) {
      await cdpClearComposer(target);
      await cdpTypeChars(target, ".");
      await sleep(40);
      await cdpClearComposer(target);
      await cdpTypeChars(target, text);
      await sleep(400);
      method = "char_keys";
      v = await cdpReadComposerState(target);
    }

    // Nudge only when Post still disabled but we have plausible text (space via char only)
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

    // --- Strategy 4: filled but Post still disabled → hard clear + per-char insertText ---
    // Bulk insertText often ghosts DOM; single-char insertText tends to enable X's Post.
    if (v.postDisabled && intentLen > 0 && intentLen <= 500) {
      await cdpClearComposer(target);
      await cdpClearComposer(target);
      await sleep(80);
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
        } else {
          await chrome.debugger.sendCommand(target, "Input.insertText", { text: ch });
        }
        await sleep(8);
      }
      await sleep(400);
      method = method + "+insertText_per_char";
      v = await cdpReadComposerState(target);
    }

    v.method = method;
    const ready = (v.gotLen || 0) >= 20 && !v.postDisabled;
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
    const loc = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const btn = document.querySelector('[data-testid="tweetButtonInline"]')
          || document.querySelector('[data-testid="tweetButton"]');
        if (!btn) return { ok: false, reason: 'no_btn' };
        if (btn.getAttribute('aria-disabled') === 'true' || btn.disabled)
          return { ok: false, reason: 'disabled' };
        const r = btn.getBoundingClientRect();
        return { ok: true, x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`,
      returnByValue: true,
    });
    const v = loc?.result?.value || {};
    if (!v.ok) {
      return { ok: false, code: "POST_NOT_READY", detail: v.reason || "no button" };
    }
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
    await new Promise((r) => setTimeout(r, 1200));
    return { ok: true, code: "POST_CLICKED", detail: "CDP mouse click on Post" };
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

  return { ok: false, code: "UNKNOWN_ACTION", detail: action };
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  await helloBridge();
  while (true) {
    try {
      const arm = await chrome.storage.local.get(["armed", "armUntil"]);
      const armed = isArmedLocal(arm);
      if (!armed) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      await helloBridge();
      const data = await bridgeGet("/v1/poll?wait=5");
      if (data.job) {
        let result;
        try {
          result = await runJob(data.job);
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
        expectVersion: bridge?.expect_extension_version || "0.3.7",
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
