/**
 * Runs inside the page (chrome.scripting.executeScript) and returns what the
 * user can see: the post's full text, the comments that are open, and the links
 * in them. Must be self-contained — it is serialised and injected, so no
 * imports or closures.
 *
 * Threads, X and Instagram get a site-specific reader (see `reader` below);
 * anything it can't make sense of falls back to the generic path.
 *
 * @param {string | null} linkUrl  set when the user right-clicked a link, else null
 * @param {string | null} forceSite  tests only: "threads" | "x" | "instagram" | "none" instead of detecting by hostname
 */
export async function collectPage(linkUrl, forceSite = null) {
  // Social sites wrap outbound links in a redirector; keep the real target.
  const decode = (href) => {
    try {
      const u = new URL(href, location.href);
      const redirect =
        /^(l|lm)\.(facebook|instagram)\.com$/.test(u.hostname) || /^l\.threads\.(com|net)$/.test(u.hostname)
          ? u.searchParams.get("u")
          : u.hostname.endsWith("google.com") && u.pathname === "/url"
            ? u.searchParams.get("q") || u.searchParams.get("url")
            : null;
      const target = new URL(redirect || u.href);
      target.hash = "";
      return /^https?:$/.test(target.protocol) ? target.href : null;
    } catch {
      return null;
    }
  };
  const meta = (name) =>
    document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") || undefined;

  const wanted = linkUrl ? decode(linkUrl) : null;
  const sameSite = (href) => new URL(href).hostname.split(".").slice(-2).join(".") === location.hostname.split(".").slice(-2).join(".");

  // Where the post lives. A right-clicked link → the article around it.
  // Otherwise every content region: Facebook puts a reel's caption in the main
  // column but a photo's caption and comments in a side panel.
  const findRoots = () => {
    if (wanted) {
      const anchor = [...document.querySelectorAll("a[href]")].find((a) => decode(a.href) === wanted);
      const article = anchor?.closest('[role="article"], article');
      if (article) return [article];
    }
    const regions = [...document.querySelectorAll('[role="dialog"], [role="main"], [role="complementary"], article')];
    // Keep outermost regions only, so nested ones are not read twice.
    const outer = regions.filter((el) => !regions.some((other) => other !== el && other.contains(el)));
    return outer.some((el) => el.innerText.trim()) ? outer : [document.body];
  };
  const linksIn = (roots) => [
    ...new Set(roots.flatMap((r) => [...r.querySelectorAll("a[href]")]).map((a) => decode(a.href)).filter(Boolean)),
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const clean = (raw) =>
    raw
      .replace(/͏/g, "") // anti-scraping filler Facebook mixes into timestamps
      .split("\n")
      .map((line) => line.trim())
      // Drop one-character crumbs and bare counters (likes, shares, "·").
      .filter((line) => line.length > 2 && !/^[\d.,\s·KkMm萬千]+$/.test(line))
      .join("\n")
      .slice(0, 15000);
  const moreRe = /^(see more|show more|more|查看更多|顯示更多|更多)$/i;
  const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  const unique = (list) => [...new Set(list.filter(Boolean))];

  // ── Site readers ────────────────────────────────────────────────────────
  // Each returns { text, links } or null. They read only what is already on the
  // screen (plus a bounded click on "view replies" / "more"), never fetch, and
  // any surprise in the page's markup ends in null → the generic path below.
  const site =
    forceSite === "none" ? null
    : forceSite ||
      (/(^|\.)threads\.(net|com)$/.test(location.hostname) ? "threads"
        : /(^|\.)(x|twitter)\.com$/.test(location.hostname) ? "x"
        : /(^|\.)instagram\.com$/.test(location.hostname) && /\/(p|reel|reels|tv)\/[\w-]+/.test(location.pathname) ? "instagram"
        : null);

  const readThreads = async () => {
    const main = document.querySelector('[role="main"]') || document.body;
    const posts = () => outermost([...main.querySelectorAll('[data-pressable-container="true"]')]);
    if (!posts().length) return null;
    const viewRe = /^(view|show)\s+(\d+\s+)?(more\s+)?(repl(y|ies)|comments?)\b|^(查看|顯示)\s*(\d+\s*則)?(更多)?\s*回覆/i;
    const clicked = new WeakSet();
    const end = Date.now() + 3000; // bounded: 3 s, 20 replies
    for (let round = 0; round < 6 && Date.now() < end && posts().length < 21; round++) {
      const buttons = [...main.querySelectorAll('[role="button"], button')].filter((b) => !clicked.has(b) && (viewRe.test(b.innerText.trim()) || moreRe.test(b.innerText.trim())));
      if (!buttons.length) break;
      for (const b of buttons.slice(0, 8)) { clicked.add(b); b.click(); }
      await sleep(500);
    }
    const list = posts().slice(0, 21);
    const handle = (el) => el.querySelector('a[href^="/@"]')?.getAttribute("href").split("/")[1] ?? "";
    const read = (el) => clean(el.innerText);
    const [first, ...replies] = list;
    const text = [
      `Post by ${handle(first) || "unknown"}:`,
      read(first), // a quoted or reposted post sits inside the container, so it is read with it
      replies.length ? "\nReplies:" : "",
      ...replies.map((r) => `${handle(r)}: ${read(r)}`),
    ].join("\n");
    const links = unique(list.flatMap((el) => [...el.querySelectorAll("a[href]")].map((a) => decode(a.href))))
      .filter((l) => !(sameSite(l) && /^\/(@[^/]+\/?|search.*|tag\/.*)?$/.test(new URL(l).pathname)));
    return { text, links };
  };

  // X shows a shortened t.co link; the real address is in the anchor's title
  // (or data-expanded-url), or spelled out in the displayed text when not cut off.
  const realTarget = (a) => {
    for (const v of [a.getAttribute("title"), a.getAttribute("data-expanded-url")]) if (v && /^https?:\/\//i.test(v)) return decode(v);
    const shown = a.textContent.replace(/\s+/g, "");
    if (/…|\.\.\.$/.test(shown)) return null;
    return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(shown) ? decode(/^https?:/i.test(shown) ? shown : `https://${shown}`) : null;
  };
  const isOutbound = (a) => /^https?:/i.test(a.href) && (/^t\.co$/.test(new URL(a.href).hostname) || !sameSite(a.href));

  const readX = async () => {
    const all = () => [...document.querySelectorAll('article[data-testid="tweet"], article[role="article"]')];
    if (!all().length) return null;
    for (const b of document.querySelectorAll('[data-testid="tweet-text-show-more-link"]')) b.click();
    for (const b of all().flatMap((a) => [...a.querySelectorAll('[role="button"]')]).filter((b) => moreRe.test(b.innerText.trim())).slice(0, 10)) b.click();
    await sleep(300);

    const authorOf = (art) => art.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute("href").split("/")[1] ?? "";
    const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1];
    const articles = all();
    const focused = (statusId && articles.find((a) => a.querySelector(`a[href$="/status/${statusId}"]`))) || articles[0];
    const handle = authorOf(focused);
    // Self-thread: later tweets by the same author. Replies from others are left out.
    const mine = [focused, ...articles.slice(articles.indexOf(focused) + 1).filter((a) => handle && authorOf(a) === handle)].slice(0, 20);

    const links = [];
    const body = (node) => {
      // Spell out t.co links and emoji so the text reads as the author wrote it.
      const copy = node.cloneNode(true);
      const anchors = [...node.querySelectorAll("a[href]")];
      [...copy.querySelectorAll("a[href]")].forEach((c, i) => {
        const target = anchors[i] && isOutbound(anchors[i]) ? realTarget(anchors[i]) : null;
        if (target) { links.push(target); c.textContent = target; }
      });
      copy.querySelectorAll("img[alt]").forEach((img) => img.replaceWith(img.getAttribute("alt")));
      return copy.textContent.trim();
    };
    const parts = [];
    mine.forEach((art, i) => {
      const quoted = (n) => { const q = n.closest('[role="link"]'); return !!q && art.contains(q) && q !== art; };
      const texts = [...art.querySelectorAll('[data-testid="tweetText"]')];
      const own = texts.filter((n) => !quoted(n));
      const quotes = texts.filter(quoted);
      parts.push(`${i ? "Thread, next tweet" : "Tweet"} by @${authorOf(art) || "unknown"}:`, own.map(body).join("\n"));
      for (const q of quotes) parts.push(`Quoted tweet: ${body(q)}`);
      for (const a of art.querySelectorAll('[data-testid="card.wrapper"] a[href]')) {
        let target = realTarget(a);
        // No title on the card: its footer shows the domain at least.
        if (!target) {
          const dom = [...a.querySelectorAll("span")].map((s) => s.textContent.trim()).find((s) => /^[\w-]+(\.[\w-]+)+$/.test(s));
          if (dom) target = `https://${dom}`;
        }
        if (target) { links.push(target); parts.push(`Card link: ${target}`); }
      }
      for (const a of art.querySelectorAll("a[href]")) if (isOutbound(a) && !a.closest("[data-testid='card.wrapper']")) { const t = realTarget(a); if (t) links.push(t); }
    });
    return { text: parts.join("\n"), links: unique(links).filter((l) => !/^https?:\/\/(t\.co|(x|twitter)\.com)\//.test(l)) };
  };

  const readInstagram = async () => {
    const root = document.querySelector('[role="dialog"] article') || document.querySelector("article") || document.querySelector("main");
    if (!root) return null;
    const expand = () => [...root.querySelectorAll('[role="button"], button')].filter((b) => moreRe.test(b.innerText.trim())).slice(0, 20);
    expand().forEach((b) => b.click());
    // Open the comment list once (we are already on the post's own page).
    const all = [...root.querySelectorAll('[role="button"], button, a')]
      .find((b) => /^(view all \d+ comments?|查看全部\s*\d+\s*則留言)/i.test(b.innerText.trim()));
    if (all) all.click();
    await sleep(all ? 1000 : 400);
    expand().forEach((b) => b.click());

    const caption = root.querySelector("h1")?.innerText.trim() || "";
    const author = root.querySelector('header a[href^="/"]')?.innerText.trim() || /^(.+?) on Instagram/i.exec(meta("og:title") || "")?.[1] || "";
    const comments = [...root.querySelectorAll("ul li")]
      .filter((li) => !li.querySelector("li, h1"))
      .map((li) => ({ who: li.querySelector('a[href^="/"]')?.innerText.trim() ?? "", said: li.innerText.trim() }))
      .filter((c) => c.said.length > 2)
      .slice(0, 20);
    const text = [
      author ? `Post by ${author}:` : "",
      caption || meta("og:title") || "",
      comments.length ? "\nComments:" : "",
      // innerText already starts with the commenter's name.
      ...comments.map((c) => c.said.replace(/\n+/g, " ")),
    ].join("\n");
    // Link stickers live in Stories only; "link in bio" is not on the post. Links in the caption / comments are.
    const links = linksIn([root]).filter((l) => !sameSite(l));
    return { text, links };
  };

  const readers = { threads: readThreads, x: readX, instagram: readInstagram };
  const selecting = !!String(window.getSelection() ?? "").trim();
  if (site && readers[site] && !wanted && !selecting) {
    try {
      const got = await readers[site]();
      const text = got ? clean(got.text) : "";
      if (text.length > 20) {
        return {
          url: decode(meta("og:url") || location.href) ?? location.href,
          title: meta("og:title") || document.title,
          text,
          links: unique(got.links).slice(0, 50),
        };
      }
    } catch {
      // The page changed under us; the generic reader below still works.
    }
  }

  let roots = findRoots();

  // "Link in the comments": if the post itself links nowhere else, open the
  // comments once and read again.
  if (!wanted && !linksIn(roots).some((l) => !sameSite(l))) {
    const commentButton = [...document.querySelectorAll('[role="button"][aria-label]')]
      .find((b) => /^(留言|评论|評論|comment|comments)$/i.test(b.getAttribute("aria-label").trim()));
    if (commentButton) {
      commentButton.click();
      await sleep(2500);
      roots = findRoots();
    }
  }

  // Expand truncated captions and comments ("See more" / 查看更多) before reading.
  const buttons = roots.flatMap((r) => [...r.querySelectorAll('[role="button"], button')])
    .filter((b) => moreRe.test(b.innerText.trim()))
    .slice(0, 20);
  for (const b of buttons) b.click();
  if (buttons.length) await sleep(400);

  const selection = String(window.getSelection() ?? "").trim();
  const raw = selection || roots.map((r) => r.innerText).join("\n\n");
  const text = clean(raw);
  const links = linksIn(roots).slice(0, 50);

  return {
    url: wanted ?? decode(meta("og:url") || location.href) ?? location.href,
    title: meta("og:title") || document.title,
    text,
    links,
  };
}
