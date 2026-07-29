function $(id) {
  return document.getElementById(id);
}

function render(state) {
  const el = $("status");
  const armed = state.armed;
  const bridgeOk = state.bridge && state.bridge.bridge === "up";
  const mode = state.armMode || (armed ? "toggle" : "off");
  const until =
    state.armUntil && state.armUntil > 0
      ? new Date(state.armUntil).toLocaleTimeString()
      : null;
  const ver = state.version || chrome.runtime.getManifest().version || "?";
  const expect = state.expectVersion || "";
  const verOk = !expect || ver === expect;
  el.innerHTML = `
    <div>Version: <span class="${verOk ? "ok" : "warn"}"><b>${ver}</b></span>
      ${expect && !verOk ? ` <span class="warn">(expect ${expect} — Reload)</span>` : ""}</div>
    <div>Arm: <span class="${armed ? "ok" : "bad"}"><b>${armed ? "ON" : "OFF"}</b></span>
      <span class="muted">(${mode}${until ? " until " + until : ""})</span></div>
    <div>Bridge: <span class="${bridgeOk ? "ok" : "bad"}">${bridgeOk ? "UP" : "DOWN"}</span>
      ${bridgeOk ? "" : " — start <code>python3 bridge/server.py</code>"}</div>
  `;

  const pend = state.pendingPost;
  if (pend && pend.text) {
    $("pending").hidden = false;
    $("pendingText").textContent = pend.text.slice(0, 2000);
    $("confirmYes").onclick = () => {
      chrome.runtime.sendMessage(
        { type: "CONFIRM_POST", id: pend.id, ok: true },
        () => refresh()
      );
    };
    $("confirmNo").onclick = () => {
      chrome.runtime.sendMessage(
        { type: "CONFIRM_POST", id: pend.id, ok: false },
        () => refresh()
      );
    };
  } else {
    $("pending").hidden = true;
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (st) => {
    if (chrome.runtime.lastError) {
      $("status").textContent = chrome.runtime.lastError.message;
      return;
    }
    render(st || {});
  });
}

$("arm").onclick = () => {
  // Sticky toggle — no ttl
  chrome.runtime.sendMessage({ type: "ARM", ttlSec: 0 }, () => refresh());
};
$("disarm").onclick = () => {
  chrome.runtime.sendMessage({ type: "DISARM" }, () => refresh());
};
$("refresh").onclick = () => refresh();
refresh();
setInterval(refresh, 1500);
