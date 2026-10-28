const t = (key, ...subs) => chrome.i18n.getMessage(key, subs);
const $ = (id) => document.getElementById(id);

for (const [id, key] of [["title", "settingsTitle"], ["serverLabel", "serverUrl"], ["serverHint", "serverHint"],
  ["tokenLabel", "token"], ["save", "save"], ["privacy", "privacy"]]) $(id).textContent = t(key);

const saved = await chrome.storage.local.get(["serverUrl", "token"]);
$("serverUrl").value = saved.serverUrl ?? "";
$("token").value = saved.token ?? "";

$("save").addEventListener("click", async () => {
  const result = $("result");
  try {
    const serverUrl = new URL($("serverUrl").value.trim()).origin;
    // localhost is granted up front; any other server needs the user's OK.
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(serverUrl)) {
      const granted = await chrome.permissions.request({ origins: [`${serverUrl}/*`] });
      if (!granted) return void (result.textContent = t("permissionDenied"));
    }
    await chrome.storage.local.set({ serverUrl, token: $("token").value.trim() });
    const stats = await (await fetch(`${serverUrl}/api/stats`)).json();
    result.textContent = t("savedOk", String(stats.items));
  } catch (err) {
    result.textContent = `${t("failed")}: ${err.message}`;
  }
});
