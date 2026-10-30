# Chrome Web Store listing (English)

The text the store shows: paste changes into the Developer Dashboard by hand (the live listing does not update from this file).

## Name
driftnet

## Short description (max 132)
Send the post you're looking at (text, comments, links, even behind a login) to your own driftnet. Reads Threads, X and Instagram.

(This is the manifest `description`, 130 characters, so it is already the store summary.)

## Category
Productivity

## Detailed description

Needs driftnet running on your computer (free, open source): https://kevinchu1110.github.io/driftnet/

Install it first: with Node.js 22.13 or newer, run `npx driftnet` in a terminal and keep that window
open while you use it. Step by step: https://github.com/KevinChu1110/driftnet/blob/main/README.md#-quick-start

driftnet catches the links you find while scrolling and turns them into a searchable catalogue
that you and your AI agents own. This extension is the "send" button for the browser.

Many pages show nothing to an anonymous fetch: a Facebook photo post, a Threads reply, an
Instagram reel whose real link hides in the comments. The extension sends what YOU see, while
logged in:

- Expands "See more" and opens the comments when the post only says "link in the comments".
- Threads: the post, its author, quoted posts, up to 20 replies, and the links in them.
- X / Twitter: the tweet with t.co short links turned back into their real targets, the quoted
  tweet, the card link, and the author's own thread.
- Instagram: the caption, author, first comments and the links in them.
- Removes redirect wrappers (l.facebook.com, l.instagram.com, l.threads.net, Google) so the
  catalogue gets the real address.

Three ways to send: the toolbar button (the page), right-click a link (that link with the post
around it), right-click a selection (just that text).

Private by design: the extension reads a tab only when you click, sends only to the driftnet
server address you set (by default one running on your own computer, localhost:8787), and has no
analytics, no account and no tracking.

Source code (MIT licensed): https://github.com/KevinChu1110/driftnet

## Single purpose
Send the web page, link or text selection the user chooses to the user's own driftnet server so
it can be saved to their personal catalogue.

## Permission justifications

| Permission | Why it is needed |
|---|---|
| `activeTab` | Lets the extension read the tab the user clicked on, only at the moment of the click (toolbar button or right-click menu), without any broad access to sites. |
| `scripting` | Runs the page reader in that tab after the user's click: it expands "See more", opens the comments and extracts text and links. |
| `contextMenus` | Adds the right-click entries "Send link / selection / this page to driftnet". |
| `storage` | Keeps the user's settings (server address, optional token) on their computer, and the last send result for the popup. |
| Host access `http://localhost/*`, `http://127.0.0.1/*` | Sending the page to the default driftnet server running on the user's own computer. |
| Optional host access (`https://*/*`, `http://*/*`) | Never granted automatically. If the user points the extension at a remote driftnet server, the settings page asks for permission for that single address only. |

Remote code: none. All code is in the package.

## Data usage disclosure (Privacy practices tab)

Collected data types, tick only:
- **Website content** (text, images, links of the page the user chooses to send).

Everything else (personally identifiable information, health, financial, authentication
information, personal communications, location, web history, user activity) is not collected.
The token the user may enter is stored locally and sent only to their own server as a
`Authorization` header; declare it as **Authentication information** if the dashboard asks about
credentials in transit, answering that it is user-provided, local, and sent only to the user's own server.

Certifications (all three):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Plain-language answers:
- What is collected? The page text, title, address and links of the single tab the user clicks on
  (plus visible replies / comments on Threads, X and Instagram).
- When? Only at the user's click on the toolbar button or the right-click menu.
- Sent to? Only the server address the user configured (their own driftnet server). The developer
  receives nothing.
- Analytics / telemetry / ads? None.

Privacy policy URL (once pushed):
https://github.com/KevinChu1110/driftnet/blob/main/apps/chrome-extension/store/PRIVACY.md

## Homepage / support
https://github.com/KevinChu1110/driftnet , issues: https://github.com/KevinChu1110/driftnet/issues

## Pictures
- Screenshots 1280x800: `screenshots/en/1.png`, `2.png`, `3.png`
- Small promo tile 440x280: `promo/en.png`
- Icon 128x128: `../icons/128.png`

Regenerate with `store/render.mjs` (see the header of that file).
