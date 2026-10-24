import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import {
  changeId,
  changeRequest,
  detectForge,
  mcpHint,
  openChange,
  urlFromResponse,
  withChangeId,
  type ChangeRequest,
} from "../src/forge.ts";

const CHANGE: ChangeRequest = {
  owner: "homelab",
  repo: "Homelab",
  head: "propose/skill-docs-1",
  base: "main",
  title: "Improve the docs skill",
  body: "Because it was vague.",
};

test("each host is recognised for what it is", () => {
  assert.equal(detectForge("https://github.com/me/skills.git").kind, "github");
  assert.equal(detectForge("git@github.com:me/skills.git").kind, "github");
  assert.equal(detectForge("https://gitlab.com/me/skills.git").kind, "gitlab");
  assert.equal(detectForge("git@gitlab.example.com:group/skills.git").kind, "gitlab");
  assert.equal(detectForge("ssh://git@forgejo:2222/homelab/Homelab.git").kind, "forgejo");
  assert.equal(detectForge("ssh://git@review.example.com:29418/project").kind, "gerrit");
  assert.equal(detectForge("https://git.example.com/me/x.git", "https://git.example.com").kind, "forgejo");
});

test("github talks to its own api host, not the clone host", () => {
  const forge = detectForge("https://github.com/me/skills.git");
  assert.equal(forge.apiBase, "https://api.github.com");

  const request = changeRequest(forge, CHANGE, "t");
  assert.equal(request?.url, "https://api.github.com/repos/homelab/Homelab/pulls");
  assert.equal(request?.headers.authorization, "Bearer t");
  assert.deepEqual(request?.body, {
    head: CHANGE.head,
    base: CHANGE.base,
    title: CHANGE.title,
    body: CHANGE.body,
  });
});

test("gitlab addresses the project by its encoded path", () => {
  const forge = detectForge("https://gitlab.example.com/group/sub/skills.git");
  const request = changeRequest(forge, CHANGE, "t");
  assert.equal(
    request?.url,
    "https://gitlab.example.com/api/v4/projects/homelab%2FHomelab/merge_requests",
  );
  assert.equal(request?.headers["private-token"], "t");
  assert.deepEqual(request?.body, {
    source_branch: CHANGE.head,
    target_branch: CHANGE.base,
    title: CHANGE.title,
    description: CHANGE.body,
  });
});

test("forgejo uses its v1 pulls endpoint and its own auth header", () => {
  const forge = detectForge("ssh://git@forgejo:2222/homelab/Homelab.git", "https://git.manu343726.com");
  const request = changeRequest(forge, CHANGE, "t");
  assert.equal(request?.url, "https://git.manu343726.com/api/v1/repos/homelab/Homelab/pulls");
  assert.equal(request?.headers.authorization, "token t");
});

test("gerrit has no request: its change is the push, and it says so", () => {
  const forge = detectForge("ssh://git@review.example.com:29418/project");
  assert.equal(changeRequest(forge, CHANGE, "t"), undefined);
  assert.match(mcpHint(forge), /refs\/for/);
});

test("a change id is stable, prefixed, and added only once", () => {
  const id = changeId("skill-docs-abc");
  assert.equal(id, changeId("skill-docs-abc"));
  assert.match(id, /^I[0-9a-f]{40}$/);

  const once = withChangeId("Title\n\nBody", id);
  assert.match(once, /Change-Id: I[0-9a-f]{40}/);
  assert.equal(withChangeId(once, changeId("other")), once);
});

test("the answer's url is read from whichever field the forge uses", () => {
  assert.equal(urlFromResponse({ kind: "forgejo" } as never, { html_url: "u1" }), "u1");
  assert.equal(urlFromResponse({ kind: "gitlab" } as never, { web_url: "u2" }), "u2");
  assert.equal(urlFromResponse({ kind: "github" } as never, { url: "u3" }), "u3");
  assert.equal(urlFromResponse({ kind: "github" } as never, {}), undefined);
});

test("the harness hint names the tool when there is one", () => {
  assert.match(mcpHint({ kind: "forgejo" }), /create_pull_request/);
  assert.match(mcpHint({ kind: "github" }), /GitHub/);
  assert.match(mcpHint({ kind: "unknown" }), /web UI/);
});

/** A server that records what it was asked and answers like a forge. */
async function withServer(
  answer: { status: number; body: unknown },
  run: (base: string, seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>) => Promise<void>,
): Promise<void> {
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("opening the change sends exactly what the forge expects", async () => {
  await withServer({ status: 201, body: { html_url: "https://forge/pull/7" } }, async (base, seen) => {
    const forge = detectForge("https://git.example.com/homelab/Homelab.git", base);
    const result = await openChange(forge, CHANGE, "secret");

    assert.equal(result.url, "https://forge/pull/7");
    assert.deepEqual(result.warnings, []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "/api/v1/repos/homelab/Homelab/pulls");
    assert.equal(seen[0]?.headers.authorization, "token secret");
    assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), {
      head: CHANGE.head,
      base: CHANGE.base,
      title: CHANGE.title,
      body: CHANGE.body,
    });
  });
});

test("a refusal is reported and does not look like success", async () => {
  await withServer({ status: 422, body: { message: "already exists" } }, async (base) => {
    const forge = detectForge("https://git.example.com/homelab/Homelab.git", base);
    const result = await openChange(forge, CHANGE, "secret");
    assert.equal(result.url, undefined);
    assert.match(result.warnings.join(" "), /refused the change: HTTP 422/);
  });
});