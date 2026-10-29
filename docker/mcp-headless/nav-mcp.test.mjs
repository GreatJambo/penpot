import assert from "node:assert/strict";
import test from "node:test";
import { startNavServer } from "./nav-mcp.mjs";

const TOKEN = "test-token-value";

function listen(server) {
    return new Promise((resolve) => {
        if (server.listening) {
            resolve(server.address().port);
            return;
        }
        server.once("listening", () => resolve(server.address().port));
    });
}

async function start(healthy = true) {
    const server = startNavServer(0, {
        listFiles: async () => ({ teams: [] }),
        openFile: async () => ({ open: true }),
        currentFile: async () => ({ open: false }),
        healthy: () => healthy,
    }, TOKEN, { sessionIdleMs: 30 * 60 * 1000 });
    const port = await listen(server);
    return { server, port };
}

async function call(port, path, { method = "POST", token, sessionId, body } = {}) {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    if (token !== undefined) {
        url.searchParams.set("userToken", token);
    }
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (sessionId) {
        headers["mcp-session-id"] = sessionId;
    }
    const response = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    return { status: response.status, text, sessionId: response.headers.get("mcp-session-id") };
}

test("token gate covers methods and paths", async () => {
    const { server, port } = await start();
    try {
        const paths = ["/mcp", "/mcp-nav/stream"];
        for (const path of paths) {
            assert.equal((await call(port, path, { token: undefined })).status, 401);
            assert.equal((await call(port, path, { method: "GET" })).status, 401);
            assert.equal((await call(port, path, { method: "DELETE" })).status, 401);
            assert.equal((await call(port, path, { method: "PUT", token: "nope" })).status, 401);
            assert.equal((await call(port, path, { token: "nope" })).status, 401);
            const ok = await call(port, path, { method: "GET", token: TOKEN });
            assert.equal(ok.status, 404);
        }
        assert.equal((await call(port, "/health", { method: "GET" })).status, 200);
        assert.equal((await call(port, "/nope", { token: TOKEN })).status, 404);
    } finally {
        server.close();
    }
});

test("health is 503 when the session is not usable", async () => {
    const { server, port } = await start(false);
    try {
        const response = await call(port, "/health", { method: "GET" });
        assert.equal(response.status, 503);
        assert.equal(response.text.includes(TOKEN), false);
    } finally {
        server.close();
    }
});

test("DELETE drops a nav session", async () => {
    const { server, port } = await start();
    try {
        const init = await call(port, "/mcp", {
            token: TOKEN,
            body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        });
        assert.equal(init.status, 200);
        assert.ok(init.sessionId);
        const closed = await call(port, "/mcp", { method: "DELETE", token: TOKEN, sessionId: init.sessionId });
        assert.equal(closed.status, 204);
        const again = await call(port, "/mcp", {
            token: TOKEN,
            sessionId: init.sessionId,
            body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
        });
        assert.equal(again.status, 404);
    } finally {
        server.close();
    }
});

test("idle nav sessions expire", async () => {
    const server = startNavServer(0, {
        listFiles: async () => ({ teams: [] }),
        openFile: async () => ({}),
        currentFile: async () => ({}),
        healthy: () => true,
    }, TOKEN, { sessionIdleMs: 20 });
    const port = await listen(server);
    try {
        const init = await call(port, "/mcp-nav/stream", {
            token: TOKEN,
            body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        });
        assert.equal(init.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const listed = await call(port, "/mcp-nav/stream", {
            token: TOKEN,
            sessionId: init.sessionId,
            body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
        });
        assert.equal(listed.status, 404);
    } finally {
        server.close();
    }
});
