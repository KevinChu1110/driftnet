[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/models.md)

# Models

driftnet asks a model for one thing: fill in a JSON schema. Pick who answers.

| `DRIFTNET_LLM_PROVIDER` | Uses | Key |
|---|---|---|
| `anthropic` | Claude through the official SDK | `DRIFTNET_LLM_API_KEY` |
| `openai` | Anything OpenAI-compatible: OpenAI, Grok, DeepSeek, OpenRouter, LiteLLM, **Ollama / LM Studio** | `DRIFTNET_LLM_API_KEY` (none for local) |
| `gemini` | Google's Gemini API directly (JSON-schema output) | `DRIFTNET_LLM_API_KEY` or `GEMINI_API_KEY` |
| `bedrock` | Amazon Bedrock, Converse API, signed with SigV4 (no AWS SDK) | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), or `AWS_BEARER_TOKEN_BEDROCK` |
| `vertex` | Gemini on Google Cloud (Vertex AI) | A service-account JSON file (`GOOGLE_APPLICATION_CREDENTIALS`), or an access token in `DRIFTNET_LLM_API_KEY` |
| `claude-cli` | **Your Claude subscription**, via Claude Code logged in on the same machine | none |
| `gemini-cli` | **Your Google account**, via Gemini CLI logged in on the same machine | none |
| *(empty)* | No model. Links are still extracted and listed (judged too if Jev is on), and wait in the [agent queue](agents.md#let-your-agent-do-the-reading) | none |

```bash
# Gemini API. The model is optional (default: gemini-flash-latest, which tracks the current Flash model)
DRIFTNET_LLM_PROVIDER=gemini
DRIFTNET_LLM_API_KEY=...

# Amazon Bedrock: a model or inference-profile id from your Bedrock console, in a region you have access to
DRIFTNET_LLM_PROVIDER=bedrock
DRIFTNET_LLM_MODEL=<model id>
DRIFTNET_LLM_REGION=us-east-1            # or AWS_REGION
AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...   # + AWS_SESSION_TOKEN for temporary credentials
# …or, instead of the three AWS variables: AWS_BEARER_TOKEN_BEDROCK=<Bedrock API key>

# Google Vertex AI: a Gemini model id that exists in your region
DRIFTNET_LLM_PROVIDER=vertex
DRIFTNET_LLM_MODEL=<model id>
DRIFTNET_LLM_REGION=us-central1          # default; "global" also works
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=my-project          # optional if the key file names its project
```

> [!NOTE]
> driftnet never reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Exporting those changes how other
> tools bill you: Claude Code, for one, switches from your subscription to API billing. The cloud
> providers do read their own cloud's standard variables (`AWS_*`, `GOOGLE_*`, `GEMINI_API_KEY`),
> because that is where those credentials live.

`gemini`, `bedrock` and `vertex` talk to fixed vendor hosts, sign and cache tokens themselves (no
cloud SDK is installed), time out after 30 s, retry 429 / 5xx once, and show the vendor's own error
message without ever printing a key. Bedrock has no schema-enforced output that every model supports,
so the schema goes in the prompt and the reply is validated like any other. driftnet keeps no count
of tokens or spend, whichever provider you pick.

Whatever the provider, replies are validated against the schema; truncated or refused answers are
retried once, and a link the model gives is kept only if it appears in what was fetched.

<details>
<summary><b>How the CLI providers are locked down</b></summary>

Shared links are untrusted input, so the CLI runs as a bare text model, one call at a time:

| | Claude Code | Gemini CLI |
|---|---|---|
| Tools | all off (`--tools ""`) | all excluded through a system-level settings file |
| Your settings, hooks, MCP servers, `CLAUDE.md` / `GEMINI.md` | not loaded | not loaded |
| Working directory | an empty private temp folder | an empty private temp folder |
| Environment | driftnet's secrets and `ANTHROPIC_API_KEY` removed | driftnet's secrets and `GEMINI_API_KEY` removed |
| Measured | ~4 s per item | ~3.5 s per item |

The CLI must be installed and logged in on the machine running driftnet, and calls count toward your
plan's limits.

> [!WARNING]
> Using a consumer subscription from a program is governed by each vendor's terms; Anthropic does
> not permit third-party products to offer claude.ai login. `claude-cli` runs **your own** Claude
> Code with **your own** login on **your own** machine and is off by default. Check the current terms
> and don't use it to serve other people.

</details>

## Judges

A judge files each link (folder, kind, worth) before the model is asked. `DRIFTNET_JUDGE` picks one:

| `DRIFTNET_JUDGE` | Does |
|---|---|
| *(empty)* | [Jev](https://console.typesafe.ai) if a TypeSafe key is set, otherwise the model files it |
| `jev` | Jev only |
| `rules` | **Free, no model.** Your rules file first, then word overlap with your folder names and descriptions. When it isn't sure it steps aside and the model (or "other") decides |
| `llm` / `heuristic` / `off` | No separate judge: the model files it, or "other" when there is no model |
| *a name* | A judge added by a plugin |

The rules file is `DRIFTNET_JUDGE_RULES`, one rule per line, first match wins:

```text
# pattern                -> folder (an id or the folder's name)
github.com/*             -> coding        # host + path, * matches anything
youtube.com              -> videos        # a bare host also covers its subdomains
kind:repo                -> coding        # repo, product, video, article, post or other
contains:sourdough       -> cooking       # a word in the title or text
```

## Plugins

A file in `~/.driftnet/plugins` may export `{ extractors, providers, judges }` (all optional; a lone
extractor or a list of extractors still works). A provider is `name: (env) => ({ label, complete })`
and is chosen with `DRIFTNET_LLM_PROVIDER=name`; a judge is `name: (env) => ({ name, judge })` chosen
with `DRIFTNET_JUDGE=name`. See [`examples/plugins/rainbow-judge.mjs`](../examples/plugins/rainbow-judge.mjs).
