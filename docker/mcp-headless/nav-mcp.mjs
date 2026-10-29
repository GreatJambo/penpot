/**
 * Tiny Streamable HTTP MCP server for file navigation.
 *
 * It is not the Penpot design MCP. It only lists files and points the
 * headless browser at one of them. It listens on the compose network.
 * The frontend nginx publishes it at /mcp-nav/stream. Callers pass the
 * same userToken query parameter as /mcp/stream. This server accepts
 * only the token of the headless session's profile.
 */

import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { SESSION_IDLE_MS, expireSessions } from "./nav-logic.mjs";

/**
 * True only when the presented token is the configured one.
 *
 * Both sides are hashed to a fixed length first so the compare does not
 * leak the length and does not throw when the lengths differ.
 *
 * @param {string | null} presented
 * @param {string} expectedToken
 * @param {Buffer} expectedDigest
 * @returns {boolean}
 */
export function tokenAccepted(presented, expectedToken, expectedDigest) {
    if (!expectedToken) {
        return false;
    }
    const digest = createHash("sha256").update(String(presented ?? ""), "utf8").digest();
    return timingSafeEqual(digest, expectedDigest);
}

const tools = [
    {
        name: "list_files",
        description:
            "List teams, projects, and files visible to the logged-in Penpot session. " +
            "Use this before open_file when you do not already know the file id.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "open_file",
        description:
            "Open a Penpot file in the headless browser and wait until the MCP plugin reconnects. " +
            "Pass fileId, or name (optionally with projectId). pageId is optional. " +
            "Switches are serialized and wait until the plugin has no task in flight.",
        inputSchema: {
            type: "object",
            properties: {
                fileId: { type: "string", description: "Penpot file UUID." },
                projectId: { type: "string", description: "Project UUID, used when opening by name." },
                name: { type: "string", description: "File name. Matched within one project when projectId is set." },
                pageId: { type: "string", description: "Page UUID to open. Omit to let Penpot open the file's first page." },
            },
        },
    },
    {
        name: "current_file",
        description: "Return the file and page the headless browser has open, or idle if it is on the dashboard.",
        inputSchema: { type: "object", properties: {} },
    },
];

/**
 * @param {number} port
 * @param {{ listFiles: () => Promise<unknown>, openFile: (args: object) => Promise<unknown>, currentFile: () => Promise<unknown>, healthy?: () => boolean }} api
 * @param {string} expectedToken
 * @param {{ sessionIdleMs?: number }} [options]
 */
export function startNavServer(port, api, expectedToken, options = {}) {
    const sessions = new Map();
    const idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
    const token = expectedToken || "";
    const expectedDigest = createHash("sha256").update(token, "utf8").digest();
    if (!token) {
        console.error("PENPOT_MCP_USER_TOKEN is unset; nav MCP rejects every call");
    }

    function send(res, status, sessionId, payload) {
        const headers = { "content-type": "application/json" };
        if (sessionId) {
            headers["mcp-session-id"] = sessionId;
        }
        res.writeHead(status, headers);
        if (payload === undefined) {
            res.end();
            return;
        }
        res.end(JSON.stringify(payload));
    }

    async function handle(body, sessionId) {
        if (!body || typeof body !== "object") {
            return { status: 400, body: { jsonrpc: "2.0", error: { code: -32700, message: "invalid request" } } };
        }
        if (body.method === "notifications/initialized" || (body.method && body.method.startsWith("notifications/"))) {
            return { status: 202 };
        }
        if (body.method === "initialize") {
            const id = randomUUID();
            sessions.set(id, Date.now());
            return {
                status: 200,
                sessionId: id,
                body: {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: "penpot-mcp-nav", version: "0.1.0" },
                    },
                },
            };
        }
        if (sessionId && !sessions.has(sessionId)) {
            return {
                status: 404,
                body: { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "unknown session" } },
            };
        }
        if (sessionId) {
            sessions.set(sessionId, Date.now());
        }
        if (body.method === "tools/list") {
            return {
                status: 200,
                sessionId,
                body: { jsonrpc: "2.0", id: body.id, result: { tools } },
            };
        }
        if (body.method === "tools/call") {
            const name = body.params && body.params.name;
            const args = (body.params && body.params.arguments) || {};
            try {
                let data;
                if (name === "list_files") {
                    data = await api.listFiles();
                } else if (name === "open_file") {
                    data = await api.openFile(args);
                } else if (name === "current_file") {
                    data = await api.currentFile();
                } else {
                    throw new Error(`unknown tool ${name}`);
                }
                return {
                    status: 200,
                    sessionId,
                    body: {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] },
                    },
                };
            } catch (error) {
                return {
                    status: 200,
                    sessionId,
                    body: {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            isError: true,
                            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                        },
                    },
                };
            }
        }
        return {
            status: 400,
            sessionId,
            body: { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } },
        };
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/health") {
            const ok = api.healthy ? api.healthy() : false;
            send(res, ok ? 200 : 503, null, { ok });
            return;
        }
        if (url.pathname !== "/mcp" && url.pathname !== "/mcp-nav/stream") {
            send(res, 404, null, { error: "not found" });
            return;
        }
        if (!tokenAccepted(url.searchParams.get("userToken"), token, expectedDigest)) {
            send(res, 401, null, { error: "unauthorized" });
            return;
        }
        const headerSession = req.headers["mcp-session-id"];
        const sessionId = typeof headerSession === "string" ? headerSession : undefined;
        expireSessions(sessions, Date.now(), idleMs);
        if (req.method === "DELETE") {
            if (sessionId) {
                sessions.delete(sessionId);
            }
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== "POST") {
            send(res, 404, null, { error: "not found" });
            return;
        }
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        let body = {};
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) {
            try {
                body = JSON.parse(raw);
            } catch {
                send(res, 400, null, { jsonrpc: "2.0", error: { code: -32700, message: "invalid json" } });
                return;
            }
        }
        const result = await handle(body, sessionId);
        send(res, result.status, result.sessionId, result.body);
    });

    server.listen(port, "0.0.0.0", () => {
        const bound = server.address();
        console.log(`nav MCP listening on 0.0.0.0:${bound && bound.port}/mcp`);
    });
    return server;
}
