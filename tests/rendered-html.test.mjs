import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("static export contains the complete first screen and metadata", async () => {
  const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>Bangumi Resorter<\/title>/);
  assert.match(html, /让你的评分/);
  assert.match(html, /先用演示数据体验/);
  assert.match(html, /og:image/);
  assert.doesNotMatch(html, /SkeletonPreview|react-loading-skeleton|Starter Project/);
});

test("static export bundles the ranking worker and social preview", async () => {
  const [staticFiles, preview] = await Promise.all([
    readdir(new URL("../dist/client/_next/static/", import.meta.url), { recursive: true }),
    readFile(new URL("../dist/client/og.png", import.meta.url)),
  ]);
  assert.ok(staticFiles.some((filename) => /ranking\.worker.*\.js$/.test(filename)));
  assert.ok(preview.byteLength > 100_000);
});
