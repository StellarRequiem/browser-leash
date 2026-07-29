/**
 * Re-runnable proof for the human Post-confirm gate in background.js.
 *
 * This is the highest-consequence control in the whole system: it is the human
 * between an agent and an irreversible public post. The gate lives in the
 * service worker's runJob() — on a require_post_confirm job it stores a pending
 * post, badges "POST", and waits for the popup's CONFIRM_POST approval before
 * the Post button is ever clicked; it bails to POST_NOT_CONFIRMED (timeout /
 * explicit no) or DISARMED (arm dropped mid-wait) and never clicks.
 *
 * background.js is a DOM-less service worker, so we don't need jsdom — we load
 * it in a vm context with a mocked chrome + fetch, then stub the CDP/DOM helpers
 * (cdpFillComposer / cdpClickPost / ensureXTab) so the test isolates the confirm
 * CONTROL FLOW and asserts exactly when Post is (not) clicked. No browser, no
 * network, no live bridge.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "..", "extension", "background.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}

function pick(store, keys) {
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
  if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
  return { ...keys, ...store }; // object-of-defaults form
}

function makeEnv() {
  const localStore = { armed: false, armUntil: 0 };
  const sessionStore = {};
  const badges = [];
  const messageListeners = [];

  const asyncGet = (store) => (keys, cb) => {
    const r = pick(store, keys);
    if (cb) cb(r);
    return Promise.resolve(r);
  };
  const asyncSet = (store) => (obj, cb) => {
    Object.assign(store, obj);
    if (cb) cb();
    return Promise.resolve();
  };

  const chrome = {
    storage: {
      local: { get: asyncGet(localStore), set: asyncSet(localStore) },
      session: {
        get: asyncGet(sessionStore),
        set: asyncSet(sessionStore),
        remove: (keys) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete sessionStore[k]);
          return Promise.resolve();
        },
      },
    },
    action: {
      setBadgeText: ({ text }) => { badges.push(text); return Promise.resolve(); },
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://x.com/compose/post", status: "complete", active: true }],
      update: async () => {},
      create: async () => ({ id: 1 }),
      get: async () => ({ status: "complete" }),
      onUpdated: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({ ok: true }),
      captureVisibleTab: async () => "data:,",
    },
    scripting: { executeScript: async () => {} },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: {} } }) },
    runtime: { onMessage: { addListener: (fn) => messageListeners.push(fn) }, onInstalled: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };

  const fetchMock = async () => ({ ok: true, json: async () => ({ ok: true, expect_extension_version: "0.3.9" }) });
  const navigator = { clipboard: { writeText: async () => {} } };

  const ctx = vm.createContext({
    chrome, fetch: fetchMock, navigator, URL, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(SRC, ctx, { filename: "background.js" });

  // Stub the CDP/DOM helpers so the test isolates the confirm control flow.
  vm.runInContext(
    `globalThis.__clicks = 0;
     cdpClickPost = async () => { __clicks++; return { ok: true, code: "POST_CLICKED" }; };
     cdpFillComposer = async () => ({ ok: true, readyToPost: true, data: { postDisabled: false } });
     cdpReadComposerState = async () => ({ postDisabled: false, gotLen: 20 });
     ensureXTab = async () => 1;
     waitTabComplete = async () => {};
     sendToTab = async () => ({ ok: false, code: "SHOULD_NOT_FALLBACK" });
     globalThis.__runJob = (j) => runJob(j);`,
    ctx
  );

  return { ctx, localStore, sessionStore, badges, messageListeners, clicks: () => ctx.__clicks };
}

const POST_JOB = (id = "j1") => ({ id, action: "x.post", require_post_confirm: true, payload: { text: "hello world" } });

// ---- the test cases -------------------------------------------------------

const cases = [
  async function approves_only_after_human_confirm() {
    const env = makeEnv();
    env.localStore.armed = true;
    const p = env.ctx.__runJob(POST_JOB());
    // wait for the gate to actually engage (runJob has a real pre-fill delay)
    await waitFor(() => env.sessionStore.pendingPost);
    // gate is pending, badge shown, and NOTHING clicked yet
    assert.equal(env.clicks(), 0, "must not click before confirm");
    assert.ok(env.sessionStore.pendingPost, "pendingPost should be set while waiting");
    assert.ok(env.badges.includes("POST"), "POST badge should be shown");
    // human approves via the popup message path
    env.messageListeners[0]({ type: "CONFIRM_POST", id: "j1", ok: true }, {}, () => {});
    const res = await p;
    assert.equal(res.code, "POST_CLICKED", "should post after approval");
    assert.equal(env.clicks(), 1, "exactly one click after approval");
  },

  async function explicit_no_never_posts() {
    const env = makeEnv();
    env.localStore.armed = true;
    const p = env.ctx.__runJob(POST_JOB());
    await sleep(80);
    env.messageListeners[0]({ type: "CONFIRM_POST", id: "j1", ok: false }, {}, () => {});
    const res = await p;
    assert.equal(res.code, "POST_NOT_CONFIRMED", "explicit no -> not confirmed");
    assert.equal(env.clicks(), 0, "must never click on an explicit no");
  },

  async function disarm_mid_wait_aborts() {
    const env = makeEnv();
    env.localStore.armed = true;
    const p = env.ctx.__runJob(POST_JOB());
    await sleep(80);
    env.localStore.armed = false; // operator disarms while the confirm is pending
    const res = await p;
    assert.equal(res.code, "DISARMED", "disarm mid-wait -> DISARMED");
    assert.equal(env.clicks(), 0, "must never click after disarm");
  },

  async function wrong_confirm_id_is_ignored() {
    const env = makeEnv();
    env.localStore.armed = true;
    const p = env.ctx.__runJob(POST_JOB("j1"));
    await sleep(80);
    // approval for a DIFFERENT job id must not release this post
    env.messageListeners[0]({ type: "CONFIRM_POST", id: "different", ok: true }, {}, () => {});
    await sleep(300);
    assert.equal(env.clicks(), 0, "mismatched confirm id must not click");
    // now the right one
    env.messageListeners[0]({ type: "CONFIRM_POST", id: "j1", ok: true }, {}, () => {});
    const res = await p;
    assert.equal(res.code, "POST_CLICKED");
    assert.equal(env.clicks(), 1);
  },

  async function confirm_post_handler_records_approval() {
    const env = makeEnv();
    let acked = false;
    env.messageListeners[0]({ type: "CONFIRM_POST", id: "jX", ok: true }, {}, () => { acked = true; });
    await sleep(20);
    assert.ok(acked, "handler should ack");
    assert.deepEqual(env.sessionStore.postConfirm, { id: "jX", ok: true }, "approval stored for runJob to read");
  },
];

// ---- runner ---------------------------------------------------------------

let failed = 0;
console.log("=== browser-leash human Post-confirm gate ===\n");
for (const t of cases) {
  try {
    await t();
    console.log(`  [PASS] ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${t.name}: ${e.message}`);
  }
}
console.log(`\nconfirm_gate=${failed === 0 ? "PASS" : "FAIL"} (${cases.length - failed}/${cases.length})`);
process.exit(failed === 0 ? 0 : 1);
