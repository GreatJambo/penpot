/**
 * Keeps one Penpot workspace open in headless Chromium so the bundled
 * MCP plugin stays connected. Official Penpot images are not modified.
 *
 * The Penpot password and any Cloudflare Access service-token headers
 * come from the environment (a secret env file). This process never
 * prints those values.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const publicUri = required("PENPOT_PUBLIC_URI").replace(/\/$/, "");
const email = required("PENPOT_EMAIL");
const password = required("PENPOT_PASSWORD");
const teamId = required("PENPOT_TEAM_ID");
const fileId = required("PENPOT_FILE_ID");
const pageId = process.env.PENPOT_PAGE_ID || "";
const artifactDir = process.env.ARTIFACT_DIR || "/opt/penpot-mcp-headless/artifacts";

const LOGIN_ATTEMPT_LIMIT = 5;

function required(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`missing ${name}`);
        process.exit(1);
    }
    return value;
}

function redact(value) {
    let text = String(value ?? "");
    if (password) {
        text = text.split(password).join("[redacted]");
    }
    text = text.replace(/userToken=[^&\s"']+/gi, "userToken=[redacted]");
    text = text.replace(/CF-Access-Client-Secret['":\s]+[^'"\s]+/gi, "CF-Access-Client-Secret=[redacted]");
    return text;
}

function workspaceUrl() {
    const query = new URLSearchParams();
    query.set("team-id", teamId);
    query.set("file-id", fileId);
    if (pageId) {
        query.set("page-id", pageId);
    }
    return `${publicUri}/#/workspace?${query.toString()}`;
}

function writeStatus(state, extra = {}) {
    fs.mkdirSync(artifactDir, { recursive: true });
    const body = {
        state,
        fileId,
        teamId,
        at: new Date().toISOString(),
        ...extra,
    };
    fs.writeFileSync(path.join(artifactDir, "status.json"), JSON.stringify(body, null, 2));
}

function accessHeaders() {
    const id = process.env.CF_ACCESS_CLIENT_ID || "";
    const secret = process.env.CF_ACCESS_CLIENT_SECRET || "";
    if (!id && !secret) {
        return {};
    }
    if (!id || !secret) {
        console.error("set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither");
        process.exit(1);
    }
    return {
        "CF-Access-Client-Id": id,
        "CF-Access-Client-Secret": secret,
    };
}

function attach(page, tracker) {
    page.on("websocket", (socket) => {
        let pathname = "";
        try {
            pathname = new URL(socket.url()).pathname;
        } catch {
            return;
        }
        if (!pathname.endsWith("/mcp/ws")) {
            return;
        }
        tracker.open = true;
        console.log("plugin websocket open");
        socket.on("close", () => {
            tracker.open = false;
            console.log("plugin websocket closed");
        });
    });

    page.on("console", (message) => {
        const text = redact(message.text());
        if (/MCP STATUS|Connected to MCP|Disconnected from MCP|Internal Error|wrong-credentials/i.test(text)) {
            console.log(`browser: ${text.slice(0, 400)}`);
        }
    });

    page.on("pageerror", (error) => {
        console.log(`pageerror: ${redact(error.message).slice(0, 400)}`);
    });
}

async function shot(page, name) {
    try {
        fs.mkdirSync(artifactDir, { recursive: true });
        await page.screenshot({ path: path.join(artifactDir, name), fullPage: false });
    } catch (error) {
        console.log(`screenshot failed: ${redact(error.message)}`);
    }
}

async function login(page) {
    await page.goto(`${publicUri}/#/auth/login`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });
    await page.waitForTimeout(1500);
    const hash = await page.evaluate(() => location.hash);
    if (hash.includes("/dashboard") || hash.includes("/workspace")) {
        console.log("already signed in");
        return;
    }

    const emailInput = page.locator('input[name="email"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 30000 });
    await emailInput.fill(email);

    const passwordInput = page.locator('input[name="password"]').first();
    if (!(await passwordInput.isVisible().catch(() => false))) {
        await page.locator('[data-testid="login-submit"]').click();
        await passwordInput.waitFor({ state: "visible", timeout: 20000 });
    }
    await passwordInput.fill(password);
    await page.locator('[data-testid="login-submit"]').click();

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const nowHash = await page.evaluate(() => location.hash).catch(() => "");
        if (nowHash.includes("/dashboard") || nowHash.includes("/workspace")) {
            console.log("signed in");
            return;
        }
        const wrong = await page.getByText("Email or password is incorrect.").count().catch(() => 0);
        if (wrong > 0) {
            throw new Error("login rejected");
        }
        await page.waitForTimeout(500);
    }
    await shot(page, "login-timeout.png");
    throw new Error("login timed out");
}

async function dismissOverlays(page) {
    const labels = ["Skip", "Not now", "Maybe later", "Close", "Got it"];
    for (const label of labels) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.count().catch(() => 0)) {
            await button.first().click({ timeout: 1000 }).catch(() => {});
        }
    }
}

async function openWorkspace(page, tracker) {
    tracker.open = false;
    console.log("opening workspace");
    await page.goto(workspaceUrl(), { waitUntil: "domcontentloaded", timeout: 60000 });

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (tracker.open) {
            return true;
        }
        const hash = await page.evaluate(() => location.hash).catch(() => "");
        if (hash.includes("/auth/login")) {
            return false;
        }
        const crashed = await page.getByText("Internal Error").count().catch(() => 0);
        if (crashed > 0) {
            console.log("workspace showed Internal Error; reloading");
            await page.reload({ waitUntil: "domcontentloaded" });
        }
        await dismissOverlays(page);
        await page.waitForTimeout(2000);
    }
    await shot(page, "workspace-timeout.png");
    return false;
}

async function main() {
    fs.mkdirSync(artifactDir, { recursive: true });
    writeStatus("starting");
    console.log(`headless sidecar starting for file ${fileId}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-gpu",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
    });
    browser.on("disconnected", () => {
        console.log("browser closed; exiting");
        process.exit(0);
    });

    let loginFailures = 0;
    const headers = accessHeaders();

    while (true) {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            extraHTTPHeaders: headers,
        });
        const page = await context.newPage();
        const tracker = { open: false };
        attach(page, tracker);

        try {
            await login(page);
            loginFailures = 0;
            const opened = await openWorkspace(page, tracker);
            if (!opened) {
                loginFailures += 1;
                writeStatus("login-required", { loginFailures });
                await shot(page, "not-connected.png");
                if (loginFailures >= LOGIN_ATTEMPT_LIMIT) {
                    throw new Error("too many failed attempts to open the workspace");
                }
            } else {
                console.log("plugin connected");
                await shot(page, "connected.png");
                writeStatus("connected");
                let quietSince = null;
                while (true) {
                    await page.waitForTimeout(10000);
                    const hash = await page.evaluate(() => location.hash).catch(() => "");
                    if (hash.includes("/auth/login")) {
                        console.log("session ended; signing in again");
                        break;
                    }
                    const crashed = await page.getByText("Internal Error").count().catch(() => 0);
                    if (crashed > 0) {
                        console.log("workspace crashed; reopening");
                        break;
                    }
                    if (tracker.open) {
                        quietSince = null;
                        writeStatus("connected");
                        continue;
                    }
                    if (quietSince === null) {
                        quietSince = Date.now();
                        console.log("plugin websocket down; waiting for the plugin to reconnect");
                    }
                    // The plugin reconnects on its own (1s, then up to 30s).
                    // Reload only if that does not restore the socket.
                    if (Date.now() - quietSince > 45000) {
                        console.log("plugin did not reconnect; reopening the file");
                        break;
                    }
                }
            }
        } catch (error) {
            loginFailures += 1;
            console.error(`cycle failed: ${redact(error && error.stack ? error.stack : error)}`);
            writeStatus("error", { message: redact(error.message || String(error)) });
            await shot(page, "error.png");
            if (loginFailures >= LOGIN_ATTEMPT_LIMIT) {
                console.error("too many failed attempts; waiting 5 minutes");
                loginFailures = 0;
                await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
            }
        }

        await context.close().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

main().catch((error) => {
    console.error(redact(error && error.stack ? error.stack : error));
    process.exit(1);
});
