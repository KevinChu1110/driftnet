import { collectPage } from "./collect.js";

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "link", title: t("menuLink"), contexts: ["link"] });
    chrome.contextMenus.create({ id: "selection", title: t("menuSelection"), contexts: ["selection"] });
    chrome.contextMenus.create({ id: "page", title: t("menuPage"), contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id !== undefined) void send(tab.id, info.menuItemId === "link" ? info.linkUrl : undefined);
});

// The popup asks the worker to send, so the request survives the popup closing.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "send-tab") {
    void send(msg.tabId).then(reply);
    return true;
  }
  return false;
});

async function settings() {
  // A local install is the default; change it in the settings for a remote server.
  const { serverUrl = "http://localhost:8787", token = "" } = await chrome.storage.local.get(["serverUrl", "token"]);
  return { serverUrl: serverUrl.replace(/\/+$/, ""), token };
}

/** Read the tab (only now, on the user's click) and post it to driftnet. */
async function send(tabId, linkUrl) {
  await setStatus({ state: "sending" }, tabId);
  try {
    const { serverUrl, token } = await settings();
    if (!serverUrl) return await setStatus({ state: "error", message: t("notConfigured"), needsSettings: true }, tabId);

    let page;
    try {
      // Arguments must be JSON: undefined is not, so "no link" travels as null.
      [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectPage, args: [linkUrl ?? null] });
    } catch (err) {
      // Browser pages (chrome://, the Web Store) are off-limits to every extension; say so.
      // Anything else is a real failure and keeps its message.
      const restricted = /cannot be scripted|cannot access|chrome:\/\/|extensions gallery/i.test(err.message);
      return await setStatus({ state: "error", message: restricted ? t("cantReadPage") : `${t("failed")}: ${err.message}` }, tabId);
    }
    if (!page) return await setStatus({ state: "error", message: `${t("failed")}: the page returned nothing` }, tabId);

    let res;
    try {
      res = await fetch(`${serverUrl}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          url: page.url,
          page: { title: page.title, text: page.text, links: page.links },
          platform: "chrome",
          chat: "browser",
        }),
      });
    } catch {
      // fetch only throws when nothing answered (not running, wrong address, offline): "Failed to fetch" helps nobody.
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(serverUrl);
      return await setStatus({ state: "error", message: local ? t("unreachableLocal") : t("unreachableRemote", serverUrl), help: t("helpUrl") }, tabId);
    }
    if (!res.ok) {
      // The server says why (blocked address, bad token…); show that, not just a status code.
      const reason = await res.json().then((b) => b.error).catch(() => "");
      throw new Error(`HTTP ${res.status}${res.status === 401 ? " — check the token" : reason ? ` — ${reason}` : ""}`);
    }
    const [result] = await res.json();
    return await setStatus({ state: "done", result, serverUrl }, tabId);
  } catch (err) {
    return await setStatus({ state: "error", message: `${t("failed")}: ${err.message}` }, tabId);
  }
}

async function setStatus(status, tabId) {
  await chrome.storage.session.set({ status: { ...status, at: Date.now() } });
  const badge = { sending: ["…", "#888888"], done: ["✓", "#2e7d32"], error: ["!", "#c62828"] }[status.state];
  await chrome.action.setBadgeText({ tabId, text: badge[0] });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge[1] });
  if (status.state === "done") setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 4000);
  return status;
}
