/**
 * Calls the Penpot MCP stream endpoint and writes tool results to disk.
 * Reads PENPOT_MCP_URL and PENPOT_MCP_USER_TOKEN from the environment.
 * Does not print the token. Image payloads are saved as files, not logged.
 */

import fs from "node:fs";
import path from "node:path";

const mcpUrl = required("PENPOT_MCP_URL");
const token = required("PENPOT_MCP_USER_TOKEN");
const outDir = process.argv[2] || "/tmp/penpot-mcp-out";

function required(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`missing ${name}`);
        process.exit(1);
    }
    return value;
}

function redact(value) {
    return String(value ?? "").split(token).join("[redacted]");
}

function endpoint() {
    const url = new URL(mcpUrl);
    url.searchParams.set("userToken", token);
    return url;
}

function parseBody(text, contentType) {
    if (!text || !text.trim()) {
        return [];
    }
    if (contentType && contentType.includes("application/json")) {
        return [JSON.parse(text)];
    }
    const messages = [];
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) {
            continue;
        }
        const data = line.slice(5).trim();
        if (data) {
            messages.push(JSON.parse(data));
        }
    }
    return messages;
}

async function post(body, sessionId) {
    const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
    };
    if (sessionId) {
        headers["mcp-session-id"] = sessionId;
    }
    let response;
    try {
        response = await fetch(endpoint(), { method: "POST", headers, body: JSON.stringify(body) });
    } catch (error) {
        throw new Error(redact(error.message));
    }
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let messages = [];
    try {
        messages = parseBody(text, contentType);
    } catch (error) {
        throw new Error(`bad MCP response HTTP ${response.status}: ${redact(text).slice(0, 500)}`);
    }
    return {
        status: response.status,
        sessionId: response.headers.get("mcp-session-id") || sessionId || null,
        messages,
        raw: text,
    };
}

function toolText(message) {
    const result = message.result || {};
    const content = result.content || [];
    return content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
}

function saveImages(message, stem) {
    const content = (message.result && message.result.content) || [];
    const saved = [];
    let index = 0;
    for (const item of content) {
        if (item.type !== "image" || typeof item.data !== "string") {
            continue;
        }
        const ext = item.mimeType === "image/svg+xml" ? "svg" : "png";
        const file = path.join(outDir, `${stem}-${index}.${ext}`);
        fs.writeFileSync(file, Buffer.from(item.data, "base64"));
        saved.push({ file, bytes: fs.statSync(file).size, mimeType: item.mimeType || null });
        index += 1;
    }
    return saved;
}

async function callTool(sessionId, id, name, args) {
    const response = await post(
        {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
        },
        sessionId
    );
    const message = response.messages.find((item) => item.id === id) || response.messages[0] || null;
    return { response, message };
}

async function main() {
    fs.mkdirSync(outDir, { recursive: true });
    const init = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "penpot-mcp-headless-rehearsal", version: "0.0.1" },
        },
    });
    if (!init.sessionId) {
        console.error(`initialize failed HTTP ${init.status}: ${redact(init.raw).slice(0, 800)}`);
        process.exit(1);
    }
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);

    const overview = await callTool(init.sessionId, 2, "high_level_overview", {});
    const overviewText = overview.message ? toolText(overview.message) : redact(overview.response.raw);
    fs.writeFileSync(path.join(outDir, "high_level_overview.txt"), overviewText);
    console.log(`high_level_overview bytes=${Buffer.byteLength(overviewText)} http=${overview.response.status}`);
    console.log(overviewText.slice(0, 240).replace(/\s+/g, " "));

    const code = [
        "const file = penpot.currentFile;",
        "const pages = Array.from(file.pages).map((page) => ({ id: String(page.id), name: String(page.name) }));",
        "return { fileId: String(file.id), fileName: String(file.name), pageCount: pages.length, pages };",
    ].join("\n");
    const executed = await callTool(init.sessionId, 3, "execute_code", { code });
    const executedText = executed.message ? toolText(executed.message) || redact(JSON.stringify(executed.message)) : redact(executed.response.raw);
    fs.writeFileSync(path.join(outDir, "execute_code.json"), executedText);
    console.log(`execute_code http=${executed.response.status}`);
    console.log(executedText.slice(0, 1500));

    const shapeCode = [
        "const shapes = Array.from(penpot.currentPage.findShapes({}) || []);",
        "const picked = shapes.find((shape) => Number(shape.width) > 20 && Number(shape.height) > 20);",
        "if (!picked) return null;",
        "return { id: String(picked.id), name: String(picked.name), type: String(picked.type), width: Number(picked.width), height: Number(picked.height) };",
    ].join("\n");
    const shapeLookup = await callTool(init.sessionId, 4, "execute_code", { code: shapeCode });
    const shapeText = shapeLookup.message ? toolText(shapeLookup.message) : redact(shapeLookup.response.raw);
    fs.writeFileSync(path.join(outDir, "shape_lookup.json"), shapeText);
    console.log(`shape_lookup http=${shapeLookup.response.status}`);
    console.log(shapeText.slice(0, 800));

    let shapeId = "page";
    try {
        const parsed = JSON.parse(shapeText);
        const result = parsed.result || parsed;
        if (result && result.id) {
            shapeId = result.id;
        }
    } catch {
        // fall back to the whole page
    }

    const exported = await callTool(init.sessionId, 5, "export_shape", {
        shapeId,
        format: "svg",
    });
    const exportText = exported.message ? toolText(exported.message) : "";
    const images = exported.message ? saveImages(exported.message, "export_shape") : [];
    const summary = {
        http: exported.response.status,
        isError: exported.message && exported.message.result ? exported.message.result.isError || false : null,
        text: exportText.slice(0, 1500),
        images,
        error: exported.message && exported.message.error ? exported.message.error : null,
    };
    if (!images.length && exported.message) {
        fs.writeFileSync(path.join(outDir, "export_shape.txt"), exportText || redact(JSON.stringify(exported.message)));
    }
    fs.writeFileSync(path.join(outDir, "export_shape_summary.json"), JSON.stringify(summary, null, 2));
    console.log(`export_shape http=${summary.http} images=${images.length} textBytes=${Buffer.byteLength(exportText)}`);
    if (!images.length) {
        console.log(exportText.slice(0, 800));
    }
}

main().catch((error) => {
    console.error(redact(error && error.stack ? error.stack : error));
    process.exit(1);
});
