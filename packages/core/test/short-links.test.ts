import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { canonicalize } from "../src/index.ts";
import { fetchText } from "../src/extractors/http.ts";
import { isSocial } from "../src/extractors/web.ts";

test("share short links are followed to the final page, which then canonicalises without tracking", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/xhs") return res.writeHead(302, { location: "/explore/66aa?xsec_token=ABC&xsec_source=pc_share&apptime=1&share_id=9" }).end();
    if (req.url === "/dy") return res.writeHead(301, { location: "/video/7300?_r=1&u_code=x&utm_source=copy" }).end();
    res.setHeader("content-type", "text/html").end("<title>post</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  try {
    const xhs = await fetchText(`http://127.0.0.1:${port}/xhs`);
    assert.equal(new URL(xhs.url).pathname, "/explore/66aa", "redirect followed to the final URL");
    assert.equal(canonicalize(xhs.url.replace("127.0.0.1", "www.xiaohongshu.com")), `https://xiaohongshu.com:${port}/explore/66aa?xsec_source=pc_share&xsec_token=ABC`);
    const dy = await fetchText(`http://127.0.0.1:${port}/dy`);
    assert.equal(new URL(dy.url).pathname, "/video/7300");
  } finally {
    delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
    server.close();
  }
});

test("Xiaohongshu and Douyin are login-walled social hosts", () => {
  for (const u of ["https://www.xiaohongshu.com/explore/1", "https://xhslink.com/a/b", "https://v.douyin.com/abc/", "https://vm.tiktok.com/Z1/", "https://vt.tiktok.com/Z2/"]) {
    assert.equal(isSocial(u), true, u);
  }
});
