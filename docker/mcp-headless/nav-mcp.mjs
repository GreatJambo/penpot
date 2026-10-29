/**
 * Tiny Streamable HTTP MCP server for file navigation.
 *
 * It is not the Penpot design MCP. It only lists files and points the
 * headless browser at one of them. Bind it on the Docker network and on
 * 127.0.0.1. Do not publish it through Cloudflare.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

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
 * @param {{ listFiles: () => Promise<unknown>, openFile: (args: object) => Promise<unknown>, currentFile: () => Promise<unknown> }} api
 */
export function startNavServer(port, api) {
    const sessions = new Map();

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
            send(res, 200, null, { ok: true });
            return;
        }
        if (req.method !== "POST" || (url.pathname !== "/mcp" && url.pathname !== "/mcp-nav/stream")) {
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
        const sessionId = req.headers["mcp-session-id"];
        const result = await handle(body, typeof sessionId === "string" ? sessionId : undefined);
        send(res, result.status, result.sessionId, result.body);
    });

    server.listen(port, "0.0.0.0", () => {
        console.log(`nav MCP listening on 0.0.0.0:${port}/mcp`);
    });
    return server;
}
