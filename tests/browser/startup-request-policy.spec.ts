import { expect, test } from "@playwright/test";

test("production project covers are deferred and low priority", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const covers = [...html.matchAll(/<img\s+[^>]*class="case-cover-img"[^>]*>/g)].map((match) => {
    const tag = match[0];
    return {
      loading: tag.match(/\sloading="([^"]+)"/)?.[1] ?? null,
      fetchPriority: tag.match(/\sfetchpriority="([^"]+)"/)?.[1] ?? null,
    };
  });

  expect(covers).toHaveLength(4);
  expect(covers).toEqual([
    { loading: "lazy", fetchPriority: "low" },
    { loading: "lazy", fetchPriority: "low" },
    { loading: "lazy", fetchPriority: "low" },
    { loading: "lazy", fetchPriority: "low" },
  ]);
});

test("production entry module is discovered from the document head", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const moduleScripts = [...html.matchAll(/<script\s+[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)];

  expect(moduleScripts).toHaveLength(1);
  expect(moduleScripts[0]?.index ?? -1).toBeGreaterThan(html.indexOf("<head>"));
  expect(moduleScripts[0]?.index ?? Number.MAX_SAFE_INTEGER).toBeLessThan(html.indexOf("<\/head>"));
  expect(moduleScripts[0]?.[1]).toMatch(/^\/assets\/main-[^/]+\.js$/);
});

test("production build ships distinct HTML and fingerprinted asset cache policies", async ({ request }) => {
  const headersResponse = await request.get("/_headers");
  expect(headersResponse.ok()).toBe(true);
  const headersFile = (await headersResponse.text()).trim();

  // Assert the complete routing contract so swapping the two policies cannot
  // leave this release gate green while caching HTML immutably.
  expect(headersFile).toBe(`/*
  Cache-Control: public, max-age=0, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable`);
});
