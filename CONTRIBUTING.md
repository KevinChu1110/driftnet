[← driftnet](README.md) · **English** · [繁體中文](CONTRIBUTING.zh-TW.md)

# Contributing

```text
packages/core          pipeline, extractors, outline, judge, summariser + model adapters, guard, store
apps/server            HTTP API, web page, MCP, chat adapters
apps/chrome-extension  send what you see while logged in
skills/driftnet        Agent Skill
assets · scripts       logo, banners, service installer
```

```bash
pnpm typecheck && pnpm test
CHROME=/path/to/chromium pnpm e2e:extension   # the extension in a real browser (Chrome for Testing or Chromium)
CHROME=/path/to/chrome pnpm e2e:web             # the web page on a phone-sized screen, with real touch swipes
pnpm build:npm                                  # the npm package in dist/npm (try: cd dist/npm && npm pack)
pnpm demo -- --many --private --password demo-pass-123 --read-key demo-share-key-0000   # a throwaway driftnet with demo data
```

Releasing: bump the version in `apps/server/package.json`, `server.json` and `.claude-plugin/`, then push a tag
(`git tag v0.2.0 && git push origin v0.2.0`). [`release.yml`](.github/workflows/release.yml) tests and publishes to
npm (trusted publishing) and the MCP Registry, and creates the GitHub release — no passwords or one-time codes.

Extend it: a site (a plugin file in `~/.driftnet/plugins`, like
[`examples/plugins/hackernews.mjs`](examples/plugins/hackernews.mjs), or `registerExtractor()`), a model (`LlmProvider`), a judge (`Judge`), a chat
platform (`handleChatText()`), browser capture (`collect.js`), or a bot language (`i18n.ts`).

**Want to help?** Look for [`good first issue`](https://github.com/KevinChu1110/driftnet/labels/good%20first%20issue) on GitHub, or open an issue with
a link driftnet handled badly: real links people share are how every feature here was found.
