const t = (key, ...subs) => chrome.i18n.getMessage(key, subs);
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => Object.assign(document.createElement(tag), { textContent: text ?? "", ...(cls ? { className: cls } : {}) });

$("settings").textContent = t("openSettings");

/** Category display names come from the server, in the browser's language. */
async function categoryLabel(serverUrl, id) {
  try {
    const ui = await (await fetch(`${serverUrl}/api/ui`)).json();
    const lang = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh") ? "zh-TW" : "en";
    return ui.categories?.[id]?.[lang] ?? id;
  } catch {
    return id;
  }
}

async function render(status) {
  const box = $("status");
  box.className = `status ${status?.state ?? ""}`;
  $("item").replaceChildren();
  $("open").hidden = true;
  if (!status || status.state === "sending") return void (box.textContent = t("sending"));
  if (status.state === "error") return void (box.textContent = status.message);

  const { item, cached } = status.result;
  const s = item.summary;
  box.textContent = cached ? t("alreadySaved") : t("saved");
  const head = el("h2", s?.name ?? item.title);
  const tags = el("div");
  tags.append(el("span", await categoryLabel(status.serverUrl, item.category), "badge"), el("span", item.worth, "badge"));
  $("item").append(head, tags);
  if (s?.oneLiner) $("item").append(el("p", s.oneLiner));
  if (s?.highlights?.length) {
    const ul = el("ul");
    for (const h of s.highlights) ul.append(el("li", h));
    $("item").append(ul);
  }
  $("open").textContent = t("openItem");
  $("open").href = `${status.serverUrl}/#item-${item.id}`;
  $("open").hidden = false;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.status) void render(changes.status.newValue);
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
void render({ state: "sending" });
chrome.runtime.sendMessage({ type: "send-tab", tabId: tab.id });
