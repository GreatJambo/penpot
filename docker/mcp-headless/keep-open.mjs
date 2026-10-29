/**
 * Headless Chromium session for the Penpot MCP plugin.
 *
 * The browser signs in and waits on the dashboard. A small navigation
 * MCP server opens whichever file an agent asks for. The last opened
 * file stays open so later design-tool calls do not pay for a reload.
 * A restart returns to the dashboard. No file id is pinned in config.
 *
 * When PENPOT_INTERNAL_ORIGIN is set and its host differs from
 * PENPOT_PUBLIC_URI, Chromium resolves the public host to 127.0.0.1
 * and a local TLS proxy forwards to the frontend container. Other
 * host names do not resolve, so the browser cannot reach the public site.
 *
 * The password and any Cloudflare Access headers come from the
 * environment. This process never prints them.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { startLocalProxy } from "./local-proxy.mjs";
import { startNavServer } from "./nav-mcp.mjs";
import {
    CONTEXT_MAX_AGE_MS,
    OPEN_WAIT_MS,
    RELOGIN_BUDGET_MS,
    TASK_WAIT_MS,
    notePluginFrame,
    openWaitMode,
    rememberHost,
    sessionDead,
    shouldRecycleContext,
} from "./nav-logic.mjs";

function loadEnvFile(filePath) {
    const out = {};
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
            continue;
        }
        const index = trimmed.indexOf("=");
        out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
    return out;
}

const secretFile = process.env.PENPOT_HEADLESS_ENV_FILE || "/run/secrets/headless.env";
const fileEnv = fs.existsSync(secretFile) ? loadEnvFile(secretFile) : {};

function setting(name) {
    const value = fileEnv[name] || process.env[name] || "";
    return value;
}

const publicUri = (setting("PENPOT_PUBLIC_URI") || "").replace(/\/$/, "");
const email = setting("PENPOT_EMAIL");
const password = setting("PENPOT_PASSWORD");
const navToken = setting("PENPOT_MCP_USER_TOKEN");
const internalOrigin = (setting("PENPOT_INTERNAL_ORIGIN") || "").replace(/\/$/, "");
delete process.env.PENPOT_PASSWORD;
delete process.env.PENPOT_MCP_USER_TOKEN;
delete process.env.PENPOT_INTERNAL_ORIGIN;
if (!publicUri || !email || !password) {
    console.error("missing PENPOT_PUBLIC_URI, PENPOT_EMAIL, or PENPOT_PASSWORD");
    process.exit(1);
}
const artifactDir = process.env.ARTIFACT_DIR || "/opt/penpot-mcp-headless/artifacts";
const navPort = Number(process.env.PENPOT_NAV_PORT || "4410");
const contextMaxAge = Number(process.env.PENPOT_CONTEXT_MAX_AGE_MS || CONTEXT_MAX_AGE_MS);
const publicUrl = new URL(publicUri);
const internalUrl = internalOrigin ? new URL(internalOrigin) : null;
const splitOrigin = Boolean(internalUrl && internalUrl.hostname !== publicUrl.hostname);

const LOGIN_ATTEMPT_LIMIT = 5;

class SessionDead extends Error {
    constructor() {
        super("session dead");
        this.name = "SessionDead";
    }
}

const state = {
    page: null,
    ready: false,
    pluginOpen: false,
    pluginSerial: 0,
    loggedIn: false,
    navDepth: 0,
    sockets: new Map(),
    hosts: new Set(),
    upstreams: new Set(),
    lock: Promise.resolve(),
    lastTarget: null,
    contextStarted: 0,
};

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withLock(fn) {
    const run = state.lock.then(async () => {
        state.navDepth += 1;
        try {
            return await fn();
        } finally {
            state.navDepth -= 1;
        }
    });
    state.lock = run.then(
        () => {},
        () => {}
    );
    return run;
}

function inflightCount() {
    let count = 0;
    for (const ids of state.sockets.values()) {
        count += ids.size;
    }
    return count;
}

function workspaceUrl(teamId, fileId, pageId) {
    const query = new URLSearchParams();
    query.set("team-id", teamId);
    query.set("file-id", fileId);
    if (pageId) {
        query.set("page-id", pageId);
    }
    return `${publicUri}/#/workspace?${query.toString()}`;
}

function writeStatus(mode, extra = {}) {
    fs.mkdirSync(artifactDir, { recursive: true });
    const body = {
        state: mode,
        at: new Date().toISOString(),
        hosts: [...state.hosts],
        upstreams: [...state.upstreams],
        inflight: inflightCount(),
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

function noteHost(raw) {
    try {
        rememberHost(state.hosts, new URL(raw).host);
    } catch {
        // ignore non-URL frames
    }
}

function frameText(event) {
    const payload = event && event.payload !== undefined ? event.payload : event;
    if (typeof payload === "string") {
        return payload;
    }
    if (payload && typeof payload.toString === "function") {
        return payload.toString("utf8");
    }
    return "";
}

function trackSocket(socket) {
    let pathname = "";
    try {
        pathname = new URL(socket.url()).pathname;
        noteHost(socket.url());
    } catch {
        return;
    }
    if (!pathname.endsWith("/mcp/ws")) {
        console.log(`websocket open ${pathname}`);
        return;
    }
    const ids = new Set();
    state.sockets.set(socket, ids);
    state.pluginSerial += 1;
    state.pluginOpen = true;
    console.log("plugin websocket open");
    const take = (event, incoming) => {
        notePluginFrame(ids, incoming, frameText(event));
    };
    socket.on("framereceived", (event) => take(event, true));
    socket.on("framesent", (event) => take(event, false));
    socket.on("close", () => {
        state.sockets.delete(socket);
        state.pluginOpen = state.sockets.size > 0;
        console.log("plugin websocket closed");
    });
}

function attach(page) {
    page.on("request", (request) => noteHost(request.url()));
    page.on("websocket", (socket) => trackSocket(socket));
    page.on("console", (message) => {
        const text = redact(message.text());
        if (/MCP STATUS|Connected to MCP|Disconnected from MCP|Internal Error/i.test(text)) {
            console.log(`browser: ${text.slice(0, 300)}`);
        }
    });
    page.on("pageerror", (error) => {
        console.log(`pageerror: ${redact(error.message).slice(0, 300)}`);
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

async function readLocation(page) {
    return page.evaluate(() => {
        const query = new URLSearchParams(location.hash.split("?")[1] || "");
        return {
            teamId: query.get("team-id"),
            fileId: query.get("file-id"),
            pageId: query.get("page-id"),
            title: document.title,
            login: location.hash.includes("/auth/login"),
            dashboard: location.hash.includes("/dashboard"),
        };
    });
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

async function loginFormVisible(page) {
    return page.locator('input[name="email"]').first().isVisible().catch(() => false);
}

async function login(page, { force = false } = {}) {
    if (force) {
        await page.context().clearCookies();
    }
    await page.goto(`${publicUri}/#/auth/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    const here = await readLocation(page).catch(() => ({ login: true }));
    const form = await loginFormVisible(page);
    if (!force && !sessionDead({ hashLogin: here.login, loginFormVisible: form })) {
        console.log("already signed in");
        state.loggedIn = true;
        return;
    }
    const emailInput = page.locator('input[name="email"]').first();
    await emailInput.waitFor({ state: "visible", timeout: force ? 20000 : 60000 });
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
        const now = await readLocation(page).catch(() => null);
        if (now && !now.login && !(await loginFormVisible(page))) {
            console.log("signed in");
            state.loggedIn = true;
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

async function rpc(page, command, params) {
    const result = await page.evaluate(
        async ({ command, params }) => {
            const response = await fetch(`/api/rpc/command/${command}`, {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify(params || {}),
            });
            const text = await response.text();
            return { status: response.status, text: text.slice(0, 200000) };
        },
        { command, params }
    );
    if (sessionDead({ rpcStatus: result.status })) {
        throw new SessionDead();
    }
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`${command} failed with HTTP ${result.status}`);
    }
    return JSON.parse(result.text);
}

async function ensureAlive(page) {
    const where = await readLocation(page).catch(() => ({ login: true }));
    const form = await loginFormVisible(page);
    if (sessionDead({ hashLogin: Boolean(where.login), loginFormVisible: form })) {
        throw new SessionDead();
    }
}

async function withNav(fn) {
    return withLock(async () => {
        const page = state.page;
        if (!state.ready || !page) {
            throw new Error("sidecar is not logged in yet");
        }
        try {
            await ensureAlive(page);
            return await fn();
        } catch (error) {
            if (!(error instanceof SessionDead)) {
                throw error;
            }
            console.log("session dead; signing in again");
            const started = Date.now();
            await login(page, { force: true });
            if (Date.now() - started > RELOGIN_BUDGET_MS) {
                throw new Error("re-login exceeded its time budget");
            }
            state.ready = true;
            return await fn();
        }
    });
}

function idOf(row) {
    return String(row.id || row.fileId || "");
}

async function listFilesInner() {
    const page = state.page;
    const teams = await rpc(page, "get-teams", {});
    const tree = [];
    for (const team of teams) {
        if (team.deletedAt) {
            continue;
        }
        const projects = await rpc(page, "get-projects", { "team-id": idOf(team) });
        const projectRows = [];
        for (const project of projects) {
            if (project.deletedAt) {
                continue;
            }
            const files = await rpc(page, "get-project-files", { "project-id": idOf(project) });
            projectRows.push({
                id: idOf(project),
                name: project.name,
                files: files.map((file) => ({
                    id: idOf(file),
                    name: file.name,
                    isShared: Boolean(file.isShared),
                })),
            });
        }
        tree.push({ id: idOf(team), name: team.name, projects: projectRows });
    }
    return { teams: tree };
}

function flatten(tree) {
    const rows = [];
    for (const team of tree.teams) {
        for (const project of team.projects) {
            for (const file of project.files) {
                rows.push({ ...file, projectId: project.id, projectName: project.name, teamId: team.id, teamName: team.name });
            }
        }
    }
    return rows;
}

async function listFiles() {
    return withNav(() => listFilesInner());
}

async function resolveFile(args) {
    const tree = await listFilesInner();
    const rows = flatten(tree);
    if (args.fileId) {
        const found = rows.find((row) => row.id === args.fileId);
        if (!found) {
            throw new Error("file not found for this account");
        }
        return found;
    }
    if (!args.name) {
        throw new Error("open_file needs fileId or name");
    }
    const wanted = String(args.name).toLowerCase();
    let matches = rows.filter((row) => row.name.toLowerCase() === wanted);
    if (args.projectId) {
        matches = matches.filter((row) => row.projectId === args.projectId);
    }
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length === 0) {
        throw new Error("no file with that name");
    }
    throw new Error(`name matched ${matches.length} files; pass fileId or projectId`);
}

async function waitUntilIdle(deadline = Date.now() + TASK_WAIT_MS) {
    while (inflightCount() > 0) {
        if (Date.now() > deadline) {
            throw new Error("plugin still has a task in flight");
        }
        console.log(`waiting for ${inflightCount()} plugin task(s)`);
        await sleep(200);
    }
    const quiet = Math.min(300, Math.max(0, deadline - Date.now()));
    await sleep(quiet);
    if (inflightCount() > 0) {
        await waitUntilIdle(deadline);
    }
}

async function currentFileInner() {
    const page = state.page;
    if (!page) {
        return { open: false, connected: false };
    }
    await ensureAlive(page);
    const where = await readLocation(page);
    return {
        open: Boolean(where.fileId),
        connected: state.pluginOpen,
        teamId: where.teamId,
        fileId: where.fileId,
        pageId: where.pageId,
        title: where.title,
    };
}

async function currentFile() {
    return withNav(() => currentFileInner());
}

function rememberTarget(file, pageId) {
    state.lastTarget = {
        fileId: file.id,
        teamId: file.teamId,
        pageId: pageId || undefined,
    };
}

async function openFileInner(args) {
    const page = state.page;
    const file = await resolveFile(args || {});
    const where = await readLocation(page);
    const mode = openWaitMode({
        currentFileId: where.fileId,
        targetFileId: file.id,
        currentPageId: where.pageId,
        requestedPageId: args.pageId,
        pluginOpen: state.pluginOpen,
    });
    if (mode === "noop") {
        rememberTarget(file, where.pageId);
        return {
            fileId: file.id,
            fileName: file.name,
            teamId: file.teamId,
            pageId: where.pageId,
            connected: true,
            switched: false,
            mode,
        };
    }
    await waitUntilIdle();
    const since = state.pluginSerial;
    console.log(mode === "page" ? `opening page in ${file.id}` : `opening file ${file.id}`);
    await page.goto(workspaceUrl(file.teamId, file.id, args.pageId || ""), {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });
    const deadline = Date.now() + OPEN_WAIT_MS;
    while (Date.now() < deadline) {
        await dismissOverlays(page);
        const now = await readLocation(page).catch(() => null);
        const form = await loginFormVisible(page);
        if (now && sessionDead({ hashLogin: now.login, loginFormVisible: form })) {
            throw new SessionDead();
        }
        const crashed = await page.getByText("Internal Error").count().catch(() => 0);
        if (crashed > 0) {
            throw new Error("workspace showed Internal Error");
        }
        const hashOk = now && now.fileId === file.id && (!args.pageId || now.pageId === args.pageId);
        const pluginOk = state.pluginOpen && (mode === "page" || state.pluginSerial > since);
        if (hashOk && pluginOk) {
            await shot(page, "connected.png");
            rememberTarget(file, now.pageId);
            writeStatus("connected", { fileId: file.id, teamId: file.teamId, pageId: now.pageId });
            console.log("plugin connected");
            return {
                fileId: file.id,
                fileName: file.name,
                teamId: file.teamId,
                pageId: now.pageId,
                title: now.title,
                connected: true,
                switched: true,
                mode,
            };
        }
        await sleep(500);
    }
    await shot(page, "workspace-timeout.png");
    throw new Error(mode === "page" ? "timed out waiting for the page" : "timed out waiting for the MCP plugin");
}

async function openFile(args) {
    return withNav(() => openFileInner(args || {}));
}

function healthy() {
    const page = state.page;
    return Boolean(state.ready && state.loggedIn && page && !page.isClosed());
}

function chromiumArgs() {
    const args = ["--disable-gpu", "--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage"];
    if (splitOrigin) {
        args.push(`--host-resolver-rules=MAP ${publicUrl.hostname} 127.0.0.1, MAP * ^NOTFOUND`);
        args.push("--ignore-certificate-errors");
        args.push("--disable-features=UseDnsHttpsSvcb,AsyncDns");
    }
    return args;
}

async function main() {
    fs.mkdirSync(artifactDir, { recursive: true });
    writeStatus("starting");
    if (!["localhost", "127.0.0.1"].includes(publicUrl.hostname) && !splitOrigin) {
        console.error("refusing to open a public host without PENPOT_INTERNAL_ORIGIN");
        process.exit(1);
    }
    if (splitOrigin) {
        await startLocalProxy({
            publicUrl,
            internalUrl,
            onUpstream: (address) => {
                if (!state.upstreams.has(address)) {
                    state.upstreams.add(address);
                    console.log(`upstream ${address}`);
                }
            },
        });
        console.log(`public host ${publicUrl.hostname} is forced to the local proxy`);
    }
    startNavServer(navPort, { listFiles, openFile, currentFile, healthy }, navToken);

    // chromiumSandbox stays off. Turning it on fails in this container
    // ("Chromium sandboxing failed") unless Docker's seccomp profile is
    // removed, which is a wider privilege change than running as pwuser.
    const browser = await chromium.launch({ headless: true, args: chromiumArgs() });
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
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        state.page = page;
        state.ready = false;
        attach(page);
        try {
            state.contextStarted = Date.now();
            await withLock(async () => {
                await login(page);
                state.ready = true;
                if (state.lastTarget) {
                    console.log("reopening last file");
                    await openFileInner(state.lastTarget);
                }
            });
            loginFailures = 0;
            if (!state.lastTarget) {
                await page.goto(`${publicUri}/#/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
            }
            writeStatus(state.lastTarget ? "connected" : "idle");
            console.log(state.lastTarget ? "plugin connected" : "idle on dashboard");
            await shot(page, state.lastTarget ? "connected.png" : "dashboard.png");
            while (state.page === page && !page.isClosed()) {
                await sleep(5000);
                if (state.navDepth > 0) {
                    continue;
                }
                if (
                    shouldRecycleContext({
                        ageMs: Date.now() - state.contextStarted,
                        navDepth: state.navDepth,
                        inflight: inflightCount(),
                        maxAge: contextMaxAge,
                    })
                ) {
                    console.log("recycling browser context");
                    break;
                }
                const where = await readLocation(page).catch(() => null);
                const form = await loginFormVisible(page);
                if (!where || sessionDead({ hashLogin: Boolean(where && where.login), loginFormVisible: form })) {
                    console.log("session ended; signing in again");
                    break;
                }
                writeStatus(where.fileId ? "connected" : "idle", {
                    fileId: where.fileId,
                    teamId: where.teamId,
                    pageId: where.pageId,
                });
            }
        } catch (error) {
            loginFailures += 1;
            state.ready = false;
            console.error(`cycle failed: ${redact(error && error.stack ? error.stack : error)}`);
            writeStatus("error", { message: redact(error.message || String(error)) });
            await shot(page, "error.png");
            if (loginFailures >= LOGIN_ATTEMPT_LIMIT) {
                console.error("too many failed attempts; waiting 5 minutes");
                loginFailures = 0;
                await sleep(5 * 60 * 1000);
            }
        }
        state.ready = false;
        state.page = null;
        await context.close().catch(() => {});
        await sleep(3000);
    }
}

main().catch((error) => {
    console.error(redact(error && error.stack ? error.stack : error));
    process.exit(1);
});
