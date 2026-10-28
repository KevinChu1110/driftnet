// Hacker News: read the story behind a news.ycombinator.com/item?id=… link
// through the official API instead of the page. Copy this file to
// ~/.driftnet/plugins/ and restart driftnet.

/** @param {{ fetch: typeof fetch }} api */
export default ({ fetch }) => ({
  name: "hackernews",
  matches: (url) => /^https:\/\/news\.ycombinator\.com\/item\?id=\d+/.test(url),
  async extract(url) {
    const id = new URL(url).searchParams.get("id");
    const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (!res.ok) return null; // let the next extractor try
    const item = await res.json();
    if (!item?.title) return null;
    // HN comments are HTML; a plain-text cut is enough for the outline.
    const text = String(item.text ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    return {
      url,
      kind: "post",
      title: item.title,
      text: [item.title, text].join("\n\n").slice(0, 4000),
      // The story's own link: driftnet follows it to the tool, as it does for social posts.
      outlinks: item.url ? [item.url] : [],
      meta: { points: item.score ?? 0, comments: item.descendants ?? 0 },
    };
  },
});
