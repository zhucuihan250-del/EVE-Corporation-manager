import assert from "node:assert/strict";
import test from "node:test";
import { getCharacterInfo } from "./eve-sso";

const characterId = 1_649_197_762;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("character login prefers the current ESI affiliation over the cached public profile", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);

    if (url.endsWith("/oauth/verify")) {
      return jsonResponse({
        CharacterID: characterId,
        CharacterName: "Queenly",
      });
    }
    if (url.includes("/characters/affiliation/")) {
      return jsonResponse([
        { character_id: characterId, corporation_id: 98_802_528 },
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await getCharacterInfo("test-access-token");
    assert.deepEqual(result, {
      characterId,
      characterName: "Queenly",
      corporationId: 98_802_528,
    });
    assert.equal(
      urls.some((url) => url.includes(`/characters/${characterId}/`)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("character login falls back to the public profile when affiliation is unavailable", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/verify")) {
      return jsonResponse({
        CharacterID: characterId,
        CharacterName: "Queenly",
      });
    }
    if (url.includes("/characters/affiliation/")) {
      return jsonResponse({ error: "unavailable" }, 503);
    }
    if (url.includes(`/characters/${characterId}/`)) {
      return jsonResponse({ corporation_id: 10_000_009 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await getCharacterInfo("test-access-token");
    assert.equal(result.corporationId, 10_000_009);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
