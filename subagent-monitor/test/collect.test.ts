import test from "node:test";
import assert from "node:assert/strict";

import { collect, elapsed, summary, type SessionsLike } from "../collect.ts";

function fake(children: Array<[string, string, "idle" | "running", number]>): SessionsLike {
  const byId = new Map(children.map(([id, agent, status, created]) => [id, { agent, status, created }]));
  return {
    family: (sessionID) => [sessionID, ...children.map(([id]) => id)],
    get: (sessionID) => {
      const entry = byId.get(sessionID);
      return entry
        ? { title: `task for ${entry.agent}`, agent: { id: entry.agent }, time: { created: entry.created } }
        : undefined;
    },
    status: (sessionID) => byId.get(sessionID)?.status ?? "idle",
  };
}

test("only the children of the session are listed, not the session itself", () => {
  const rows = collect(fake([["a", "reviewer", "running", 10]]), "root");
  assert.deepEqual(rows.map((row) => row.id), ["a"]);
});

test("running subagents come first, then newest", () => {
  const rows = collect(
    fake([
      ["old-idle", "explore", "idle", 100],
      ["new-idle", "explore", "idle", 300],
      ["run", "reviewer", "running", 200],
    ]),
    "root",
  );
  assert.deepEqual(rows.map((row) => row.id), ["run", "new-idle", "old-idle"]);
});

test("the agent id survives both shapes the schema allows", () => {
  const sessions: SessionsLike = {
    family: () => ["root", "a", "b"],
    get: (id) => (id === "a" ? { agent: "string-agent" } : { agent: { id: "object-agent" } }),
    status: () => "idle",
  };
  assert.deepEqual(collect(sessions, "root").map((row) => row.agent), ["string-agent", "object-agent"]);
});

test("a missing info still yields a row, titled by its id", () => {
  const sessions: SessionsLike = {
    family: () => ["root", "a"],
    get: () => undefined,
    status: () => "running",
  };
  const [row] = collect(sessions, "root");
  assert.equal(row?.title, "a");
  assert.equal(row?.agent, "agent");
  assert.equal(row?.running, true);
  assert.equal(row?.created, 0);
});

test("the summary counts and names what is running", () => {
  const rows = collect(
    fake([
      ["a", "reviewer", "running", 1],
      ["b", "explore", "idle", 2],
    ]),
    "root",
  );
  const line = summary(rows, Date.now());
  assert.match(line, /1 running · 2 in this session/);
  assert.match(line, /● reviewer/);
  assert.match(line, /○ explore done/);
});

test("an empty session says so instead of showing a bare header", () => {
  assert.match(summary([], Date.now()), /none yet/);
});

test("elapsed time is readable at each scale", () => {
  assert.equal(elapsed(1000, 1000 + 5_000), "5s");
  assert.equal(elapsed(0, 1000), "");
  assert.equal(elapsed(1000, 1000 + 65_000), "1m05s");
  assert.equal(elapsed(1000, 1000 + 3_725_000), "1h02m");
});
