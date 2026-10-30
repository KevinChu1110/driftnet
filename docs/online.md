[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/online.md)

# Putting it online (optional)

Only needed when something outside this computer should reach it: your phone, LINE around the clock,
or AIs that run in the cloud (Claude.ai, ChatGPT, Grok, Hermes or OpenClaw on a server). The server
listens on `127.0.0.1`. Everything below is on the page under **⚙ Settings → Access & connections**:

1. **Admin password.** Pick your own or press *Generate*; a meter says how strong it is. It can only
   be set from this computer. Anyone who knows it can add, move and delete, so don't reuse one.
2. **Who can read.** *Private* means the password or the share key is needed to read anything.
3. **Read-only share key.** For AIs that can only open links: `…/llms.txt?key=…` reads the catalogue
   and nothing more. If it leaks, press *New key*. The admin password is never accepted in a URL.
   Chat bots and agents put it into the card links they send you, so a link opens on your phone
   without the password; the page keeps it and removes it from the address bar.
4. **Agent tokens.** One named key per agent (Hermes, Claude Code, OpenClaw…) instead of the admin
   password: *write* can add, move and tidy, *read* can only look. A token is shown once when you
   create it and only its hash is stored. *Revoke* cuts off that one agent at once, and *Remove* clears a revoked one from the list (revoked
   tokens also drop out after 30 days); changing the admin password does not touch them. Tokens work as a Bearer header only, never in a URL, and cannot
   change settings or make more tokens. The queue and card moves record which token did it.
5. **Unlock a phone.** Show a QR code on the computer, scan it with the phone, and the phone is
   unlocked with its own device token (read or write) — no password typed on the phone. The code works
   once and for five minutes, and the phone appears in the token list where you can revoke it.
6. **Public URL.** One button opens a temporary `https://….trycloudflare.com` address through
   Cloudflare (no account; install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   yourself, driftnet never downloads it). It needs the password, turns reading private, and closes
   when driftnet stops.

Then **🔌 Connect an AI** in the sidebar has a ready-to-paste card for Claude Code, Claude.ai / Claude
Desktop (custom connector, read-only), ChatGPT custom GPTs, any chat that can open a link, and
Hermes / OpenClaw / pi, with the URL and the share key filled in. The agent cards can make a token for
that agent and put it in the snippet, so the admin password never leaves the page.

<p align="center"><img src="../assets/access-connect-en.jpg" alt="Access & connections in Settings, and the Connect an AI cards" width="100%"></p>

For a permanent address, put HTTPS in front instead, e.g. Caddy:

```caddyfile
driftnet.example.com {
	reverse_proxy 127.0.0.1:8787
}
```
