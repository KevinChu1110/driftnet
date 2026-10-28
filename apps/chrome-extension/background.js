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
  const { serverUrl = "", token = "" } = await chrome.storage.local.get(["serverUrl", "token"]);
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
      [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectPage, args: [linkUrl] });
    } catch {
      return await setStatus({ state: "error", message: t("cantReadPage") }, tabId);
    }

    const res = await fetch(`${serverUrl}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        url: page.url,
        page: { title: page.title, text: page.text, links: page.links },
        platform: "chrome",
        chat: "browser",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? " — check the token" : ""}`);
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
