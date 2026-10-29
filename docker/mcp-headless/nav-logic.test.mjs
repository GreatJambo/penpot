import assert from "node:assert/strict";
import test from "node:test";
import {
    expireSessions,
    notePluginFrame,
    openWaitMode,
    rememberHost,
    sessionDead,
    shouldRecycleContext,
} from "./nav-logic.mjs";

test("session is dead on the login hash, a visible login form, or RPC 401/403", () => {
    assert.equal(sessionDead({ hashLogin: true }), true);
    assert.equal(sessionDead({ loginFormVisible: true }), true);
    assert.equal(sessionDead({ rpcStatus: 401 }), true);
    assert.equal(sessionDead({ rpcStatus: 403 }), true);
    assert.equal(sessionDead({ hashLogin: false, loginFormVisible: false, rpcStatus: 200 }), false);
    assert.equal(sessionDead({ rpcStatus: 500 }), false);
});

test("page-only open does not wait for a new plugin socket", () => {
    assert.equal(
        openWaitMode({
            currentFileId: "file-a",
            targetFileId: "file-a",
            currentPageId: "page-1",
            requestedPageId: "page-2",
            pluginOpen: true,
        }),
        "page"
    );
    assert.equal(
        openWaitMode({
            currentFileId: "file-a",
            targetFileId: "file-b",
            currentPageId: "page-1",
            requestedPageId: "page-9",
            pluginOpen: true,
        }),
        "file"
    );
    assert.equal(
        openWaitMode({
            currentFileId: "file-a",
            targetFileId: "file-a",
            currentPageId: "page-1",
            requestedPageId: "page-1",
            pluginOpen: true,
        }),
        "noop"
    );
    assert.equal(
        openWaitMode({
            currentFileId: "file-a",
            targetFileId: "file-a",
            currentPageId: "page-1",
            requestedPageId: "page-2",
            pluginOpen: false,
        }),
        "file"
    );
});

test("plugin frames count tasks until the matching response", () => {
    const ids = new Set();
    notePluginFrame(ids, true, JSON.stringify({ type: "heartbeat" }));
    assert.equal(ids.size, 0);
    notePluginFrame(ids, true, JSON.stringify({ id: "t1", task: "executeCode" }));
    notePluginFrame(ids, true, JSON.stringify({ id: "t2", task: "executeCode" }));
    assert.equal(ids.size, 2);
    notePluginFrame(ids, false, JSON.stringify({ id: "t1", success: true }));
    assert.deepEqual([...ids], ["t2"]);
    notePluginFrame(ids, false, "not-json");
    assert.equal(ids.size, 1);
    notePluginFrame(ids, false, JSON.stringify({ id: "t2", success: false, error: "x" }));
    assert.equal(ids.size, 0);
});

test("host list drops the oldest entry past the cap", () => {
    const hosts = new Set();
    rememberHost(hosts, "a.example", 2);
    rememberHost(hosts, "b.example", 2);
    rememberHost(hosts, "a.example", 2);
    rememberHost(hosts, "c.example", 2);
    assert.deepEqual([...hosts], ["b.example", "c.example"]);
});

test("idle nav sessions expire and a fresh one stays", () => {
    const sessions = new Map([
        ["old", 1_000],
        ["new", 5_000],
    ]);
    expireSessions(sessions, 5_100, 1_000);
    assert.deepEqual([...sessions.keys()], ["new"]);
});

test("context recycle runs only when idle and old", () => {
    assert.equal(shouldRecycleContext({ ageMs: 10, navDepth: 0, inflight: 0, maxAge: 5 }), true);
    assert.equal(shouldRecycleContext({ ageMs: 10, navDepth: 1, inflight: 0, maxAge: 5 }), false);
    assert.equal(shouldRecycleContext({ ageMs: 10, navDepth: 0, inflight: 2, maxAge: 5 }), false);
    assert.equal(shouldRecycleContext({ ageMs: 4, navDepth: 0, inflight: 0, maxAge: 5 }), false);
});
