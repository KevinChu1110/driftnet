/**
 * Runs inside the page (chrome.scripting.executeScript) and returns what the
 * user can see: the post's full text, the comments that are open, and the links
 * in them. Must be self-contained — it is serialised and injected, so no
 * imports or closures.
 *
 * @param {string | null} linkUrl  set when the user right-clicked a link, else null
 */
export async function collectPage(linkUrl) {
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
  const more = /^(see more|show more|more|查看更多|顯示更多|更多)$/i;
  const buttons = roots.flatMap((r) => [...r.querySelectorAll('[role="button"], button')])
    .filter((b) => more.test(b.innerText.trim()))
    .slice(0, 20);
  for (const b of buttons) b.click();
  if (buttons.length) await sleep(400);

  const selection = String(window.getSelection() ?? "").trim();
  const raw = selection || roots.map((r) => r.innerText).join("\n\n");
  const text = raw
    .replace(/\u034F/g, "") // anti-scraping filler Facebook mixes into timestamps
    .split("\n")
    .map((line) => line.trim())
    // Drop one-character crumbs and bare counters (likes, shares, "·").
    .filter((line) => line.length > 2 && !/^[\d.,\s·KkMm萬千]+$/.test(line))
    .join("\n")
    .slice(0, 15000);
  const links = linksIn(roots).slice(0, 50);

  return {
    url: wanted ?? decode(meta("og:url") || location.href) ?? location.href,
    title: meta("og:title") || document.title,
    text,
    links,
  };
}
