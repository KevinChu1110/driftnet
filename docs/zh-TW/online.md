[← driftnet](../../README.zh-TW.md) · [English](../online.md) · **繁體中文**

# 放上網路（選用）

只有當這台電腦以外的東西要連進來時才需要：你的手機、24 小時收 LINE，或是跑在雲端的 AI（Claude 網頁版、
ChatGPT、Grok、架在伺服器上的 Hermes 或 OpenClaw）。伺服器只聽 `127.0.0.1`。以下全部都在網頁的
**⚙ 設定 →「存取與連線」**：

1. **管理密碼。**自己取一組，或按「產生」；旁邊會顯示強弱。只能在這台電腦上設定。知道它的人可以新增、移動、刪除，所以不要沿用其他網站的密碼。
2. **誰可以讀。**選「要有密碼或分享碼才能讀」，沒有就什麼都看不到。
3. **唯讀分享碼。**給只會開連結的 AI：`…/llms.txt?key=…` 只能讀清單。外流就按「重新產生」。管理密碼永遠不能放在網址裡。
   聊天機器人和 agent 給你的卡片連結會帶著它，手機點開不用輸入密碼；網頁會記住分享碼，並把它從網址列拿掉。
4. **Agent 專用金鑰。**每個 agent（Hermes、Claude Code、OpenClaw……）一把，不必用管理密碼：「可讀寫」能收錄、
   搬移、整理，「唯讀」只能看。金鑰建立時只顯示一次，系統只存它的雜湊值。按「撤銷」立刻斷掉那一個 agent，「移除」把已撤銷的從清單清掉（撤銷超過 30 天也會自動消失）；
   換管理密碼不會影響它們。金鑰只能放在 Bearer header，不能放網址，也不能改設定或再建金鑰。
   佇列領取和卡片搬移都會記下是哪一把金鑰做的。
5. **掃 QR 解鎖手機。**電腦上顯示 QR code，手機一掃就解鎖，拿到自己的裝置金鑰（唯讀或可讀寫），手機上不用打密碼。
   這個碼只能用一次、5 分鐘內有效；手機會出現在金鑰清單裡，可以隨時撤銷。
6. **公開網址。**按一下就透過 Cloudflare 開一個臨時的 `https://….trycloudflare.com`（免帳號；
   [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   要自己裝，driftnet 不會幫你下載）。必須先設密碼，開啟後讀取會改成私人，driftnet 關掉就跟著關。

接著側邊欄的 **🔌 連接 AI** 會列出 Claude Code、Claude 網頁版／桌面版（自訂 connector，唯讀）、ChatGPT 自訂 GPT、
任何會開連結的聊天 AI，以及 Hermes／OpenClaw／pi 的設定，網址和分享碼都已經填好，複製貼上就能用。agent 的卡片還能直接幫它建一把金鑰並填進設定，
管理密碼不必離開網頁。

<p align="center"><img src="../../assets/access-connect-zh-TW.jpg" alt="設定裡的「存取與連線」，和「連接 AI」的卡片" width="100%"></p>

想要固定網址的話，改在前面加 HTTPS，例如 Caddy：

```caddyfile
driftnet.example.com {
	reverse_proxy 127.0.0.1:8787
}
```
