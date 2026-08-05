import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the Barsoom Cauchy Array shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Barsoom — Cauchy Array Mars Reconstruction<\/title>/i);
  assert.match(html, /BARSOOM/);
  assert.match(html, /CAUCHY ARRAY/);
  assert.match(html, /SPECTRAL ALBEDO · RELIEF PHASE \/ OBSERVATION PRIORS/);
  assert.doesNotMatch(html, /\b(?:MOLA|VIKING)\b/i);
  assert.match(html, /PLANETARY APERTURE/);
  assert.match(html, /AUDIO (?:<!-- -->)?ON/);
  assert.match(html, /TUTORIALS/);
  assert.match(html, /SOVA \/ ONLINE/);
  assert.match(html, /This is not a live telescope image/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});
