const t = (key, ...subs) => chrome.i18n.getMessage(key, subs);
const $ = (id) => document.getElementById(id);

for (const [id, key] of [["title", "settingsTitle"], ["serverLabel", "serverUrl"], ["serverHint", "serverHint"],
  ["tokenLabel", "token"], ["save", "save"], ["privacy", "privacy"]]) $(id).textContent = t(key);

const saved = await chrome.storage.local.get(["serverUrl", "token"]);
$("serverUrl").value = saved.serverUrl ?? "http://localhost:8787";
$("token").value = saved.token ?? "";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

$("save").addEventListener("click", async () => {
  const result = $("result");
  const raw = $("serverUrl").value.trim();
  if (!/^https?:\/\//i.test(raw) || !URL.canParse(raw)) return void (result.textContent = t("serverHint"));
  try {
    const { origin: serverUrl, protocol, hostname } = new URL(raw);
    // The token travels with every request: only loopback may use plain http.
    if (protocol === "http:" && !LOOPBACK.has(hostname)) return void (result.textContent = t("httpsRequired"));
    // localhost is granted up front; any other server needs the user's OK.
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(serverUrl)) {
      const granted = await chrome.permissions.request({ origins: [`${serverUrl}/*`] });
      if (!granted) return void (result.textContent = t("permissionDenied"));
    }
    const token = $("token").value.trim();
    const res = await fetch(`${serverUrl}/api/stats`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    if (res.status === 401) throw new Error(t("tokenRejected"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stats = await res.json();
    await chrome.storage.local.set({ serverUrl, token });
    result.textContent = t("savedOk", String(stats.items));
  } catch (err) {
    result.textContent = `${t("failed")}: ${err.message}`;
  }
});
