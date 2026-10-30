[← driftnet](../../README.zh-TW.md) · [English](../models.md) · **繁體中文**

# 模型

driftnet 只要模型做一件事：把 JSON schema 填好。由你決定誰來回答。

| `DRIFTNET_LLM_PROVIDER` | 使用 | 金鑰 |
|---|---|---|
| `anthropic` | Claude（官方 SDK） | `DRIFTNET_LLM_API_KEY` |
| `openai` | 所有相容 OpenAI 格式的服務：OpenAI、Grok、DeepSeek、OpenRouter、LiteLLM、**Ollama／LM Studio** | `DRIFTNET_LLM_API_KEY`（本機不用） |
| `gemini` | 直接接 Google 的 Gemini API（JSON schema 輸出） | `DRIFTNET_LLM_API_KEY` 或 `GEMINI_API_KEY` |
| `bedrock` | Amazon Bedrock，Converse API，用 SigV4 簽章（不裝 AWS SDK） | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`（＋`AWS_SESSION_TOKEN`），或 `AWS_BEARER_TOKEN_BEDROCK` |
| `vertex` | Google Cloud 上的 Gemini（Vertex AI） | 服務帳戶 JSON 檔（`GOOGLE_APPLICATION_CREDENTIALS`），或把存取權杖填在 `DRIFTNET_LLM_API_KEY` |
| `claude-cli` | **你的 Claude 訂閱**，透過同一台機器上已登入的 Claude Code | 不用 |
| `gemini-cli` | **你的 Google 帳號**，透過同一台機器上已登入的 Gemini CLI | 不用 |
| *（不填）* | 不用模型：照樣擷取、列出（有開 Jev 也會判斷），並排進 [agent 佇列](agents.md#讓你的-agent-來讀) | 不用 |

```bash
# Gemini API。模型可不填（預設 gemini-flash-latest，永遠指向目前的 Flash 模型）
DRIFTNET_LLM_PROVIDER=gemini
DRIFTNET_LLM_API_KEY=...

# Amazon Bedrock：填 Bedrock 主控台上的模型或推論設定檔 ID，且該區域你有權限
DRIFTNET_LLM_PROVIDER=bedrock
DRIFTNET_LLM_MODEL=<模型 ID>
DRIFTNET_LLM_REGION=us-east-1            # 或 AWS_REGION
AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...   # 臨時憑證再加 AWS_SESSION_TOKEN
# ……或不用上面三個 AWS 變數，改設 AWS_BEARER_TOKEN_BEDROCK=<Bedrock API 金鑰>

# Google Vertex AI：填你那個區域有的 Gemini 模型 ID
DRIFTNET_LLM_PROVIDER=vertex
DRIFTNET_LLM_MODEL=<模型 ID>
DRIFTNET_LLM_REGION=us-central1          # 預設；也可填 global
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=my-project          # 金鑰檔裡有寫專案就可以不填
```

> [!NOTE]
> driftnet **刻意不讀** `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`。這些變數一旦 export，會改變其他工具的計費方式，
> 例如 Claude Code 會從訂閱額度改走 API 計費。雲端供應商則會讀各自雲端的標準變數
> （`AWS_*`、`GOOGLE_*`、`GEMINI_API_KEY`），因為憑證本來就放在那裡。

`gemini`、`bedrock`、`vertex` 只連固定的供應商網址，簽章和權杖快取都自己做（不裝任何雲端 SDK），逾時 30 秒，
429／5xx 重試一次，錯誤會顯示供應商原本的訊息，但絕不印出金鑰。Bedrock 沒有每個模型都支援的強制 schema 輸出，
所以 schema 放在提示裡，回覆照樣用 schema 驗證。不管選哪個供應商，driftnet 都不統計 token 或花費。

不論哪家模型，回覆都會照 schema 驗證；被截斷或拒答時重試一次；模型給的連結，只有真的出現在抓到的內容裡才會保留。

<details>
<summary><b>CLI 供應商怎麼隔離</b></summary>

分享進來的連結是不可信的內容，所以 CLI 被鎖成純文字模型，一次只跑一個：

| | Claude Code | Gemini CLI |
|---|---|---|
| 工具 | 全部關閉（`--tools ""`） | 用系統層級設定檔全部排除 |
| 你的設定、hooks、MCP、`CLAUDE.md`／`GEMINI.md` | 不載入 | 不載入 |
| 工作資料夾 | 空的私人暫存資料夾 | 空的私人暫存資料夾 |
| 環境變數 | 拿掉 driftnet 的機密和 `ANTHROPIC_API_KEY` | 拿掉 driftnet 的機密和 `GEMINI_API_KEY` |
| 實測 | 每則約 4 秒 | 每則約 3.5 秒 |

跑 driftnet 的那台機器要裝好 CLI 並登入；每次呼叫都會計入你方案的用量上限。

> [!WARNING]
> 用程式呼叫個人訂閱，受各家條款規範；Anthropic 不允許第三方產品提供 claude.ai 登入。`claude-cli` 是在
> **你自己的**機器上、用**你自己的**登入、跑**你自己的** Claude Code，預設關閉。使用前請確認最新條款，
> 也不要拿來替別人提供服務。

</details>

## 判斷器

判斷器在問模型之前，先決定每個連結的資料夾、類型和值不值得看。用 `DRIFTNET_JUDGE` 選：

| `DRIFTNET_JUDGE` | 做什麼 |
|---|---|
| *（不填）* | 有 TypeSafe 金鑰就用 [Jev](https://console.typesafe.ai)，否則交給模型 |
| `jev` | 只用 Jev |
| `rules` | **免費，不用模型。** 先看你的規則檔，再看頁面用字和資料夾名稱、說明的重疊。沒把握就讓位，由模型（或「other」）決定 |
| `llm`／`heuristic`／`off` | 不用獨立的判斷器：交給模型，沒有模型就放「other」 |
| *名稱* | 外掛新增的判斷器 |

規則檔用 `DRIFTNET_JUDGE_RULES` 指定，一行一條，由上往下第一條符合的生效：

```text
# 樣式                   -> 資料夾（ID 或資料夾名稱）
github.com/*             -> coding        # 網域＋路徑，* 代表任意字元
youtube.com              -> videos        # 只寫網域時，子網域也算
kind:repo                -> coding        # repo、product、video、article、post 或 other
contains:酸種             -> cooking       # 標題或內文裡出現這個詞
```

## 外掛

`~/.driftnet/plugins` 裡的檔案可以匯出 `{ extractors, providers, judges }`（都是選填；單一擷取器或擷取器清單仍然可用）。
供應商寫成 `名稱: (env) => ({ label, complete })`，用 `DRIFTNET_LLM_PROVIDER=名稱` 選；判斷器寫成
`名稱: (env) => ({ name, judge })`，用 `DRIFTNET_JUDGE=名稱` 選。範例見
[`examples/plugins/rainbow-judge.mjs`](../../examples/plugins/rainbow-judge.mjs)。
