/**
 * TLS reverse proxy bound to 127.0.0.1.
 *
 * Chromium is told that the public Penpot host lives at 127.0.0.1.
 * This process accepts that TLS connection and forwards it, including
 * WebSocket upgrades, to the frontend container. The browser keeps the
 * public origin. The bytes stay on the Docker network.
 */

import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

/**
 * @param {object} options
 * @param {URL} options.publicUrl
 * @param {URL} options.internalUrl
 * @param {(address: string) => void} options.onUpstream
 * @returns {Promise<{ port: number, close: () => void }>}
 */
export function startLocalProxy({ publicUrl, internalUrl, onUpstream }) {
    const port = publicUrl.port ? Number(publicUrl.port) : publicUrl.protocol === "https:" ? 443 : 80;
    const tls = publicUrl.protocol === "https:";
    const dir = fs.mkdtempSync("/tmp/penpot-local-proxy-");
    let credentials = null;
    if (tls) {
        const key = path.join(dir, "key.pem");
        const cert = path.join(dir, "cert.pem");
        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-sha256",
                "-days",
                "2",
                "-nodes",
                "-keyout",
                key,
                "-out",
                cert,
                "-subj",
                `/CN=${publicUrl.hostname}`,
                "-addext",
                `subjectAltName=DNS:${publicUrl.hostname}`,
            ],
            { stdio: "ignore" }
        );
        credentials = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    }

    const server = tls ? https.createServer({ ...credentials, ALPNProtocols: ["http/1.1"] }, onRequest) : http.createServer(onRequest);
    server.on("upgrade", onUpgrade);
    server.on("clientError", (error, socket) => {
        console.log(`local proxy client error: ${error.message}`);
        socket.destroy();
    });

    function pathOnly(url) {
        return String(url || "/").split("?")[0];
    }

    function forwardHeaders(headers) {
        const copy = {};
        for (const [name, value] of Object.entries(headers)) {
            const lower = name.toLowerCase();
            if (HOP.has(lower) && lower !== "upgrade" && lower !== "connection") {
                continue;
            }
            copy[name] = value;
        }
        copy.host = internalUrl.host;
        return copy;
    }

    function watchSocket(request) {
        request.on("socket", (socket) => {
            const note = () => {
                if (socket.remoteAddress) {
                    onUpstream(socket.remoteAddress);
                }
            };
            if (socket.remoteAddress) {
                note();
            } else {
                socket.on("connect", note);
            }
        });
    }

    function onRequest(req, res) {
        console.log(`proxy ${req.method} ${pathOnly(req.url)}`);
        const upstream = http.request(
            {
                hostname: internalUrl.hostname,
                port: internalUrl.port || 80,
                path: req.url,
                method: req.method,
                headers: forwardHeaders(req.headers),
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
                upstreamRes.pipe(res);
            }
        );
        watchSocket(upstream);
        upstream.on("error", (error) => {
            console.log(`proxy upstream error: ${error.message}`);
            if (!res.headersSent) {
                res.writeHead(502);
            }
            res.end();
        });
        req.pipe(upstream);
    }

    function onUpgrade(req, socket, head) {
        console.log(`proxy upgrade ${pathOnly(req.url)}`);
        const headers = forwardHeaders(req.headers);
        const upstream = http.request({
            hostname: internalUrl.hostname,
            port: internalUrl.port || 80,
            path: req.url,
            method: "GET",
            headers,
        });
        watchSocket(upstream);
        upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
            const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ""}`];
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
                if (HOP.has(name.toLowerCase()) && name.toLowerCase() !== "upgrade" && name.toLowerCase() !== "connection") {
                    continue;
                }
                const values = Array.isArray(value) ? value : [value];
                for (const item of values) {
                    if (item != null) {
                        lines.push(`${name}: ${item}`);
                    }
                }
            }
            socket.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (upstreamHead && upstreamHead.length) {
                socket.write(upstreamHead);
            }
            if (head && head.length) {
                upstreamSocket.write(head);
            }
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
            const drop = () => {
                socket.destroy();
                upstreamSocket.destroy();
            };
            socket.on("error", drop);
            upstreamSocket.on("error", drop);
            socket.on("close", () => upstreamSocket.destroy());
            upstreamSocket.on("close", () => socket.destroy());
        });
        upstream.on("error", (error) => {
            console.log(`proxy upgrade error: ${error.message}`);
            socket.destroy();
        });
        upstream.end();
    }

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            console.log(`local proxy listening on 127.0.0.1:${port} -> ${internalUrl.origin}`);
            resolve({
                port,
                close: () => server.close(),
            });
        });
    });
}
