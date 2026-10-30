[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/web-page.md)

# The web page

<p align="center"><img src="../assets/screenshot-en.jpg" alt="The driftnet web page: your folder tree on the left, summarised tools on the right" width="100%"></p>

<p align="center"><img src="../assets/phone-en.jpg" alt="driftnet on a phone: the ☰ drawer with your folder tree, filing a card on the mind map (hold it, then tap a folder), and a card being swiped left to the trash" width="100%"></p>

Every link lands on a page you can search, filter by folder and kind, and open from a phone. On a
phone the sidebar folds into a ☰ drawer, and a line under the search box says what you're looking at.

<details>
<summary><b>Everything the page does</b></summary>

- **Inbox.** New links the AI filed on its own wait in **Inbox (N)** at the top of the sidebar, each with
  two or three suggested folders. One tap (or `1`–`3`) files it, `s` skips, `m` opens the full picker;
  once you've placed a card it leaves the Inbox, and Undo brings it back.
- **Your folders are the categories.** Add, nest, rename and describe them from the sidebar (＋ and ⋯);
  the AI files new links by each folder's path and description, so “Games › MapleStory — Artale
  helpers” gets the MapleStory tools. Move a card with 📁 **Move to…**, or drag it by ⠿ onto a folder
  on a computer; a card you placed stays put. Deleting a folder moves its links up one level.
- **Mind map.** Folders branch out on both sides of the root like XMind, a colour per branch (one tap
  switches to everything on the right). Tap a folder to open
  it, tap a card to preview it, and drag a card onto a folder to file it (on a phone, hold it a moment
  first, so a quick swipe still pans). Shift-click adds cards to a selection (on a phone, hold one, let
  go, then tap more cards) and dragging any of them onto a folder files them all. Drag a folder onto
  another to nest it. Search highlights the matches; big folders fold into “+N”. Double-click a folder
  (or `z`) to focus on it: only its branch is drawn, a breadcrumb leads back up, and `Esc` goes up one
  level; the focus is in the address, so a link opens on it. With the keyboard the map is a tree:
  arrows walk it, → / ← open and close, Home / End, or type a name to jump.
- **Split view.** On a wide screen, **Split** shows the card list and the mind map side by side; drag
  cards (or a whole selection) from the list onto a folder in the map.
- **AI tidy-up.** ✨ next to ＋ in the folders header asks the model for a plan: new folders, renames,
  merges and cards to move, each with its reason. Nothing changes until you tick lines and press
  **Apply selected**; cards you placed yourself and folders you made are never touched, and one Undo
  reverts the whole plan.
- **Swipe right** to add a favorite, **swipe left** to move to the trash; a short swipe does nothing,
  and scrolling never counts as a swipe. On a computer, use ☆ and 🗑 or drag with the mouse.
- **Select many cards.** `x` selects the focused card, Shift-click selects a range, and on a phone a long
  press (about half a second) starts selecting. A bar at the bottom then offers **Move to…**, ★, **Trash**
  (**Restore** in the trash), **Select all** and **Clear**; `Esc` clears. The whole batch is one change,
  and one **Undo** puts every card back exactly where it was.
- **Refresh** a card to fetch its page again and redo the summary, e.g. when it was saved behind a login
  wall or the page has changed. Your note, favorite, share count and a folder you chose stay; if the page
  now comes back empty, the old summary is kept.
- **Undo** right after removing, or restore anything later from **Trash**. Trashed links disappear from
  agents and `/llms.txt` too; if someone shares one again, it comes back.
- **Every change can be undone.** Open a card and press **History**: its last 20 changes (note, summary,
  title, folder, star, trash; up to 180 days) are listed with who made them and what the card said before,
  and **Restore** puts one back as a new change, so a restore can be undone too. Anyone who can read the
  card can see its history (the old text of your private note is shown to the admin only); restoring needs
  write access and passes the same checks as a normal edit. **Forget history** (admin) erases one card's list.
  An agent can do the same with `restore_version` on `driftnet_update_item`.
- **Notes.** 📝 on any card for your own note (tried it? needs a GPU?). What people wrote with the link
  in chat shows on the card too (💬), and both are searchable. **📝 Notes** in the sidebar holds
  free-standing Markdown notes; `#12` links card 12.
- **⚙ Settings** on the page: model, Jev, summary language, chat replies, your own summary rules and
  blocked domains, saved to `~/.driftnet/.env` and applied without a restart. Per browser: order (best,
  newest, most shared), compact cards, tags, chat text, light or dark.
- **Export** everything as one Markdown file, or as a zip of Markdown files with front matter that
  Obsidian opens as a vault and Notion imports (Import → Markdown & CSV).
- **Import bookmarks.** ⚙ Settings → *Import bookmarks* takes a browser bookmarks file (Chrome, Firefox,
  Safari, Edge: HTML), a Pocket export (HTML or CSV), a Raindrop CSV, a JSON list of links, or any text
  or Markdown with links in it. It shows how many are new before anything starts; tick *Keep my bookmark
  folders* to mirror them under an **Imported** folder, otherwise the classifier sorts as usual. Links you
  already have, repeats, non-web and private addresses are skipped, up to 5,000 per import. With a model
  set up, each new link is one model call, so hundreds of links mean hundreds of calls.
- **Share a folder.** A folder's ⋯ menu → *Share as pack…* turns that folder, its sub-folders and the cards
  in them into one JSON file (`"driftnet_pack": 1`, at most 1,000 cards and 2 MB): links, summaries, tags
  and original picture URLs. Your notes, chat text, who shared what, counters, tokens and the share key never
  go in, and neither do trashed or flagged cards. Download it, or copy a link (needs `DRIFTNET_PUBLIC_URL` or a
  tunnel); on a private catalogue the link is signed for that one pack, so it opens without the share key and
  shows nothing else. To pull one in, use Settings → Import → *From a pack link* (or `driftnet import <link>`,
  or import the file): the folders are recreated under a top-level folder named after the pack and the cards
  are stored as summarised, with no model call. Cards you already have keep your summary, text that looks like
  instructions to an AI drops the card, and importing the same pack twice adds nothing.
- **Shared links open read-only.** A card link from a chat bot or an agent carries the read-only share
  key, so it opens on a phone without a password; edit buttons appear after **Unlock** with the admin
  password. Forgot it? Open driftnet on the computer it runs on: Settings there sets a new one.
- **Keyboard.** `⌘K` / `Ctrl+K` opens the command palette (jump to a folder or card, switch view,
  export, settings…). `j`/`k` step through cards, `f` favorite, `m` move (type to find the folder), `n` note,
  `#` trash, `x` select, `z` undo, `/` search, `g m` mind map, `?` the list. `1`–`9` file the focused card
  (or the selection) into the nine folders you file into most; `?` shows which number is which, and the
  **Move to…** picker marks them too.
- **Add to Home Screen** to open it like an app.

</details>

<details>
<summary><b>More screenshots</b></summary>

<p align="center"><img src="../assets/notes-settings-en.jpg" alt="The notes page with links to cards, and the settings dialog" width="100%"></p>

<p align="center"><img src="../assets/select-en.jpg" alt="Three cards selected; the bar at the bottom offers Move to…, favorite, trash, select all and clear for all of them" width="100%"></p>

<p align="center"><img src="../assets/tokens-en.jpg" alt="Settings → Access → Agent tokens: a new token shown once, the list with scope and last use, and Revoke" width="100%"></p>

<p align="center"><img src="../assets/inbox-en.jpg" alt="The Inbox: new cards with one-tap folder suggestions, keys 1–3 and m for any other folder" width="100%"></p>

<p align="center"><img src="../assets/split-en.jpg" alt="Split view: the card list on the left and the mind map on the right" width="100%"></p>

<p align="center"><img src="../assets/palette-en.jpg" alt="The command palette (Ctrl+K): folders to jump to and commands" width="100%"></p>

<p align="center"><img src="../assets/pair-en.jpg" alt="Settings → Access → Unlock a phone: a one-time QR code with a five-minute countdown" width="100%"></p>

</details>
