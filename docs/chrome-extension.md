[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/chrome-extension.md)

# Chrome extension

<p align="center"><img src="../assets/extension-en.jpg" alt="The driftnet popup over a social post: saved, with category, worth and a three-point summary" width="100%"></p>
<sub>Recorded by the extension's end-to-end test (<code>pnpm e2e:extension</code>) on a test page: the caption is cut off and the link sits in the comments.</sub>

An anonymous fetch of a Facebook photo post returns nothing. The extension sends what **you** see
while logged in: it expands "See more" and, if the post links nowhere, opens the comments once to
find the link. Tested on real posts: a photo post went from 0 characters to its full text and
comments, and a reel's "link in the comments" turned into its GitHub repo.

- **Toolbar button**: send the page you're on.
- **Right-click a link**: send it with the text of the post around it.
- **Right-click a selection**: send just that.

**What it reads on Threads, X and Instagram.** Only on your click, only what is on screen, never a
fetch on the side; if a site's markup changes it falls back to the generic reader above.

| Site | Captured |
|---|---|
| **Threads** | The post and its author, quoted / reposted posts, up to 20 replies (it opens "View replies", 3 s at most), and the links in them with redirects removed |
| **X / Twitter** | The tweet with `t.co` links shown as their real targets (from the link's own title, never fetched), the quoted tweet, the card link, and the author's own thread (their later tweets; other people's replies are left out) |
| **Instagram** (`/p/`, `/reel/`) | The caption ("more" expanded), the author, the first 20 comments and the links in them. Links in bio and Story link stickers are not on the page, so they are skipped; a "link in comments" is found |

**Install**

- **[Chrome Web Store](https://chromewebstore.google.com/detail/driftnet/inmlinbodfopmanbllkkjcgheelacddm)**: one click, updates itself.
- **From the zip** (a [release build](https://github.com/KevinChu1110/driftnet/actions/workflows/extension.yml), or `pnpm build:extension` → `dist/driftnet-extension-<version>.zip`): unzip it, open `chrome://extensions`, turn on Developer mode, **Load unpacked**, pick the unzipped folder.
- **From the source**: the same, picking `apps/chrome-extension`.

It talks to `http://localhost:8787`; for a remote server, set the URL and token in its settings. It
reads a tab only when you click, and sends only to your own server. See the
[privacy policy](../apps/chrome-extension/store/PRIVACY.md).
