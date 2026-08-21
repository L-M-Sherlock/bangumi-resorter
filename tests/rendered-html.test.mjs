import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("static export contains the complete first screen and metadata", async () => {
  const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>Bangumi Resorter<\/title>/);
  assert.match(html, /让你的评分/);
  assert.match(html, /先用演示数据体验/);
  assert.match(html, /为什么这样排序/);
  assert.match(html, /正在恢复本地排序/);
  assert.match(html, /principles-return-pending/);
  assert.match(html, /has-local-project/);
  assert.match(html, /bangumi-resorter:theme/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /og:image/);
  assert.match(html, /https:\/\/github\.com\/L-M-Sherlock\/bangumi-resorter/);
  assert.match(html, /rel="preconnect" href="https:\/\/lain\.bgm\.tv"/);
  assert.doesNotMatch(html, /SkeletonPreview|react-loading-skeleton|Starter Project/);
});

test("static export contains the public principles article", async () => {
  const html = await readFile(new URL("../dist/client/principles.html", import.meta.url), "utf8");
  assert.match(html, /<title>为什么这样排序？· Bangumi Resorter<\/title>/);
  assert.match(html, /为什么比较比打分更诚实/);
  assert.match(html, /id="stopping-rule"/);
  assert.match(html, /与 Gwern 原版的差异/);
  assert.match(html, /https:\/\/gwern\.net\/resorter/);
  assert.match(html, /data-term-key="bradley-terry"/);
});

test("static export bundles the ranking workers and social preview", async () => {
  const [staticFiles, preview] = await Promise.all([
    readdir(new URL("../dist/client/_next/static/", import.meta.url), { recursive: true }),
    readFile(new URL("../dist/client/og.png", import.meta.url)),
  ]);
  assert.ok(staticFiles.some((filename) => /ranking\.worker.*\.js$/.test(filename)));
  assert.ok(staticFiles.some((filename) => /ranking-forecast\.worker.*\.js$/.test(filename)));
  assert.ok(staticFiles.some((filename) => /forecast\.worker.*\.js$/.test(filename)));
  assert.ok(staticFiles.some((filename) => /analysis\.worker.*\.js$/.test(filename)));
  assert.ok(preview.byteLength > 100_000);
});
