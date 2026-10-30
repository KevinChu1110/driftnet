[← driftnet](../../README.zh-TW.md) · [English](../install-beginners.md) · **繁體中文**

# 新手安裝

沒用過終端機也沒關係，大約五分鐘。你只要輸入一行指令，driftnet 會自己處理好，並在瀏覽器打開它的網頁。
不會裝到雲端，也不用註冊帳號。

## 1. 安裝 Node.js（只要一次）

driftnet 靠 Node.js 執行，它是一個免費程式，讓 JavaScript 能在你的電腦上跑。

1. 到 [nodejs.org](https://nodejs.org) 下載 **LTS** 版本（22.13 以上的版本都可以）。
2. 打開下載的檔案，照預設選項一路按下一步裝完。

## 2. 打開終端機

- **Mac：** 按 <kbd>⌘ Command</kbd> + <kbd>空白鍵</kbd>，輸入 **終端機**（或 **Terminal**），按 <kbd>Enter</kbd>。
- **Windows：** 按 <kbd>Windows</kbd> 鍵，輸入 **PowerShell**，按 <kbd>Enter</kbd>。

會打開一個有閃爍游標的視窗，那就是終端機。

## 3. 啟動 driftnet

把下面這行貼進終端機，按 <kbd>Enter</kbd>：

```bash
npx driftnet
```

第一次可能會問 `Ok to proceed? (y)`：輸入 <kbd>y</kbd> 再按 <kbd>Enter</kbd>。稍等一下，瀏覽器會打開
**http://localhost:8787**。這就是 driftnet 的網頁，由你自己的電腦提供（*localhost* 就是「這台電腦」，別人看不到）。

如果瀏覽器沒有自己打開，就手動打開瀏覽器，前往 `http://localhost:8787`。

## 4. 視窗要一直開著

**只有那個終端機視窗開著，driftnet 才會運作。** 可以縮小，但關掉視窗（或重新開機）driftnet 就停了。
下次再打開終端機執行一次 `npx driftnet` 就好，你的連結和設定都還在。

想讓它開機自動啟動，目前要改用原始碼安裝（`pnpm service:install`，只支援 macOS 和 Linux）；
見 [README](../../README.zh-TW.md#-開始使用) 的「其他跑法」。

## 5. 加入連結

- 安裝 [Chrome 擴充功能](chrome-extension.md)，在任何網頁點一下就能存下那一頁。
- 或把連結貼進 driftnet 網頁上的輸入框。

想讓卡片自動分類、寫好說明，到網頁的 ⚙ 設定 → AI 選一個供應商：用 Ollama 在自己電腦上跑免費模型、
你已經有的訂閱（Claude 或 Gemini），或 API 金鑰。見[模型](models.md)。都不接的話，連結照樣會存下來，
先放在「其他」等待整理。

## 卡住了？

- **找不到 `npx` 指令（not recognized / command not found）：** Node.js 還沒裝好，或終端機是在安裝前就開的。
  關掉終端機、重開一個再試一次。
- **出現 `driftnet needs Node 22.13 or newer`：** 到 [nodejs.org](https://nodejs.org) 下載最新的 LTS 版，直接裝上去。
- **Windows 說不能執行指令碼（running scripts is disabled）：** 在 PowerShell 改輸入 `npx.cmd driftnet`。
- 更多問題見 [README](../../README.zh-TW.md#-開始使用) 的「沒反應？」。
