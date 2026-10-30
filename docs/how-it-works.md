[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/how-it-works.md)

# How driftnet handles a link

# How your links are handled

Most links never reach a model; the ones that do arrive as a short outline.

1. **Fetched, with a guard.** A link seen before is reused (tracking parameters stripped). Otherwise driftnet reads the GitHub API and README, the YouTube description, the `og:` tags, or the page as you saw it (extension). Links to private or local addresses are refused, hidden Unicode is stripped, prompt injection is flagged.
2. **Cut to an outline.** Headings and the opening of each section, without menus, cookie banners and footers, capped at about 350 tokens.
3. **Judged.** Sources voted down are stored, not summarised. [Jev](https://console.typesafe.ai), if you turned it on, picks the folder, kind and worth in ~100 ms; without it, your model does. With no model, links are listed unsorted under "other".
4. **Summarised.** One call, only for items worth reading: a one-line summary, what you'll see, why it's here. `DRIFTNET_SUMMARY_DEPTH` sets how much each card says (`brief`, `standard` or `detailed`).
5. **Followed.** Repos linked or named in the content are looked up and catalogued too.
6. **Filed in your folders.** The AI uses each folder's path and description; new links wait in the Inbox with two or three suggested folders, and one tap files them.
7. **Shown, and offered to agents.** It appears on the web page, and agents get it over MCP, `/llms.txt`, `/feed.xml` or the outgoing webhook. Export takes it all with you.

**Reels and shorts.** All optional: with none of the tools below installed, driftnet simply reads the post's title and caption as before. Many shared reels only say the tool's name out loud. When a link on Instagram, Facebook, Threads, TikTok, YouTube Shorts or X is a video whose page text says almost nothing, driftnet reads the video itself with tools already on your machine, cheapest first and stopping as soon as there is enough text: (1) captions, title and description from `yt-dlp`, no download; (2) the video at low quality (at most 60 MB and the first 3 minutes), one frame every 2 seconds, read by `tesseract` (English and Chinese if installed); (3) only if still thin, the audio through `whisper` (`whisper-cli` from whisper.cpp also works, with `DRIFTNET_WHISPER_MODEL` set). What it finds is added to the text as labelled `[captions]`, `[on-screen text]` and `[speech]` sections (6,000 characters at most) and goes through the same guard as page text; the card gets a "read from video" mark. Whatever is missing is skipped. On a laptop battery, `DRIFTNET_VIDEO=captions` stops after step 1 (no download, no OCR, no speech model); `off` turns it all off. Tools run without a shell, in a private temp folder that is always deleted, with your driftnet secrets removed from their environment, a time limit per step, links to private or local addresses refused, and one video at a time.

Two more steps are **off by default** and opt-in, because they send something to your model. Both run only when everything above still left the item thin, and both ride inside the *same* summary request (never one request per frame, never a separate call): (4) `DRIFTNET_VIDEO=watch` lets a video-capable model watch the video. With `gemini` or `vertex` as the summary provider, a YouTube link goes as the link itself (no download) and a reel from another site goes as the downloaded clip only if it is 14 MB or smaller (Gemini's request limit is 20 MB including encoding); other providers cannot watch, so driftnet falls through to frames. `DRIFTNET_VIDEO_FRAMES=vision` attaches up to 8 distinct frames (about one per 2 seconds, near-duplicates and black frames dropped, at most 768 px wide, JPEG) when your summary model accepts pictures: an OpenAI-compatible endpoint (including Ollama vision models), Claude, Gemini or Vertex. Frames and videos go only to the model you configured. If a model turns out to be text-only, the item is retried once without the frames. (5) If nothing could be read at all (no captions, no OCR, no speech, nothing to watch or show), driftnet does not guess from a title: the card stays pending with a short hint, `video: needs a transcript`, in the agent queue, so an agent with its own video tools can write it up.

| Goal | A model to try (check each model card for its video/image and size limits) | Setting |
|---|---|---|
| Watch YouTube videos | Gemini Flash (`gemini` or `vertex`) | `DRIFTNET_VIDEO=watch` |
| Captions or transcripts only | Any small, cheap model | default |
| Frames, fully local | A vision model on Ollama, e.g. a Qwen-VL or Gemma vision build, through `DRIFTNET_LLM_PROVIDER=openai` + `DRIFTNET_LLM_BASE_URL=http://localhost:11434/v1` | `DRIFTNET_VIDEO_FRAMES=vision` |
| Frames, hosted | Claude or Gemini | `DRIFTNET_VIDEO_FRAMES=vision` |

<details>
<summary><b>All eight steps</b></summary>

| Step | What happens | Model? |
|---|---|---|
| 1. Cache | Same link again, after stripping `utm_`, `fbclid`, `si`… and unifying share links, `youtu.be` and repo sub-paths | no |
| 2. Extract | GitHub API + README, YouTube description, `og:` tags, or the page as you saw it (extension); PDFs and videos are never downloaded as text | no |
| 3. Outline | Headings and the opening of each section; menus, breadcrumbs, cookie banners and footers dropped; capped at ~350 **tokens**, counting CJK at a token per character | no |
| 4. Guard | Links to private or local addresses refused (every redirect checked); hidden Unicode stripped; prompt injection flagged | no |
| 5. Reputation | Publishers voted below 25% (3+ votes) are stored, not summarised | no |
| 6. Judge (optional) | [Jev](https://console.typesafe.ai), with a TypeSafe key, answers folder, kind, worth and injection as typed choices, ~100 ms. Without it, your model classifies in step 7 | tiny classifier |
| 7. Summarise | One structured call, only for items worth reading, or the agent queue | one call |
| 8. Follow | Repos linked or named in the content are looked up and catalogued too | no |

The outline borrows the idea behind agent browsers such as [Moli](https://github.com/lexmount/moli)
without running one: on real links, a Chinese article went from 831 to 404 tokens.

</details>

# Link health

Links rot and repos get archived. Set `DRIFTNET_HEALTH=weekly` (recommended; it is off by default because it makes network requests) and driftnet re-checks each card about once a week, a few at a time. GitHub repos go through the API (stars, archived, last push; set `GITHUB_TOKEN` for a higher limit, and it pauses on a rate limit); other links get a quiet `HEAD` through the same private-address guard. A card is marked `dead` (404 / gone, or a name that no longer resolves), `archived`, `stale` (no push for 18 months) or `moved` (repo renamed); server errors and timeouts change nothing and are retried. Marked cards show a badge, appear under **Needs review** on the page and in `driftnet_search_items` with `view=needs_review`, and the card's check button (or `POST /api/items/:id/health`) tests one link right now.

# Search by meaning

Optional. With an embedding model, search also finds cards by what they are about, not only by the words in them: "login" finds an OAuth kit, "scanned documents" finds an OCR tool. It is off until a local model is found (or you name a provider), costs **no summary tokens**, and when it is off, slow or down, search is exactly the keyword search it always was.

```bash
ollama pull nomic-embed-text      # that's it: restart driftnet and the startup line says "semantic search: on"
```

- **What is embedded.** A few hundred characters per card: its name, one-liner, tags, highlights, title and the link's host, the same fields the summarizer already saw. Chat text is never embedded; your own notes only if the model runs on this machine. Cards are embedded in the background after they are saved (one request at a time), and existing cards are filled in after you turn it on; saving a link never waits for it.
- **Where it goes.** `ollama` and a local `DRIFTNET_EMBED_BASE_URL` keep everything on your machine. `openai` and `gemini` send each card's text above, and each search query, to that provider, so name them only if you are fine with that. A key is sent only to that provider's own address (or the base URL you typed), and the summary model's key is reused only for the same vendor.
- **Speed.** Vectors are stored compactly and compared in memory (about 12 ms for 10,000 cards). A search waits at most 1.5 s for its query vector, then falls back to keywords; after a failure it stops trying for 30 s. Repeated queries are cached.
- **Related cards.** A card's detail shows up to 5 similar cards (vectors when available, otherwise shared tags and name words). The same list is in `GET /api/items/:id` and in the `driftnet_get_item` tool.

| Variable | Default | Purpose |
|---|---|---|
| `DRIFTNET_EMBED` | `auto` | `auto`: on when a local Ollama has the embedding model, or when `DRIFTNET_EMBED_PROVIDER` is set. `off`: never |
| `DRIFTNET_EMBED_PROVIDER` | *(auto)* | `ollama`, `openai` (also any OpenAI-compatible `/embeddings`, including Ollama's `/v1`) or `gemini` |
| `DRIFTNET_EMBED_MODEL` | per provider | `nomic-embed-text` (Ollama), `text-embedding-3-small` (OpenAI), `gemini-embedding-001` (Gemini). Changing it re-embeds everything in the background |
| `DRIFTNET_EMBED_BASE_URL` | Ollama `http://127.0.0.1:11434`, OpenAI's own | Endpoint for `ollama` / `openai` |
| `DRIFTNET_EMBED_API_KEY` | — | Key for `openai` / `gemini` (not needed locally) |
| `DRIFTNET_EMBED_FLOOR` | `0.55` for nomic; `0.3` OpenAI; `0.5` Gemini | Cosine a card needs to appear with no matching word; raise it for fewer matches. Only nomic-embed-text was measured |
