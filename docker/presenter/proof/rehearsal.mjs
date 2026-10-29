/**
 * Rehearsal proof for the presenter sidecar.
 *
 * Talks to a throwaway Penpot on PENPOT_BASE (default http://127.0.0.1:9101).
 * Does not print passwords, tokens, or secret keys.
 *
 *   PENPOT_BASE=http://127.0.0.1:9101 \
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   NODE_PATH=/tmp/pw/node_modules \
 *   node docker/presenter/proof/rehearsal.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readNotes } from "../public/lib/notes.mjs";
import { slidesFromObjects } from "../public/lib/slides.mjs";
import { notesSnippet } from "../public/lib/snippet.mjs";

const base = process.env.PENPOT_BASE || "http://127.0.0.1:9101";
const outDir = process.env.PROOF_DIR || "/tmp/penpot-presenter-proof";
const ZERO = "00000000-0000-0000-0000-000000000000";

mkdirSync(outDir, { recursive: true });

function redact(value, secrets) {
    let text = String(value ?? "");
    for (const secret of secrets) {
        if (secret) {
            text = text.split(secret).join("[redacted]");
        }
    }
    return text;
}

async function rpc(method, body, cookie) {
    const url = new URL(`/api/main/methods/${method}`, base);
    url.searchParams.set("_fmt", "json");
    const headers = { accept: "application/json", "x-client": "penpot-presenter" };
    if (cookie) {
        headers.cookie = cookie;
    }
    let payload;
    const isGet = method.startsWith("get-");
    if (isGet && body) {
        for (const [key, value] of Object.entries(body)) {
            if (value != null) {
                url.searchParams.set(key, String(value));
            }
        }
    } else if (!isGet) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body ?? {});
    }
    const response = await fetch(url, {
        method: isGet ? "GET" : "POST",
        headers,
        body: payload,
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text.slice(0, 400) };
    }
    if (!response.ok) {
        const error = new Error(`${method} ${response.status} ${text.slice(0, 500)}`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return { data, cookies: response.headers.getSetCookie?.() ?? [] };
}

function cookieHeader(setCookies) {
    return setCookies.map((item) => item.split(";")[0]).join("; ");
}

function rect(x, y, width, height) {
    return {
        x,
        y,
        width,
        height,
        selrect: { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height },
        points: [
            { x, y },
            { x: x + width, y },
            { x: x + width, y: y + height },
            { x, y: y + height },
        ],
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    };
}

function textContent(text, font) {
    return {
        type: "root",
        verticalAlign: "top",
        children: [{
            type: "paragraph-set",
            children: [{
                type: "paragraph",
                textAlign: "left",
                textDirection: "ltr",
                children: [{
                    text,
                    fontId: font.fontId,
                    fontFamily: font.fontFamily,
                    fontVariantId: font.fontVariantId,
                    fontSize: font.fontSize || "80",
                    fontWeight: "400",
                    fontStyle: "normal",
                    lineHeight: "1.2",
                    letterSpacing: "0",
                    textTransform: "none",
                    textAlign: "left",
                    textDirection: "ltr",
                    textDecoration: "none",
                    fills: [{ fillColor: font.fill || "#14213d", fillOpacity: 1 }],
                }],
            }],
        }],
    };
}

const builtinFont = {
    fontId: "sourcesanspro",
    fontFamily: "sourcesanspro",
    fontVariantId: "regular",
};

async function uploadMedia(cookie, fileId, bytes, name, type) {
    const form = new FormData();
    form.set("file-id", fileId);
    form.set("is-local", "true");
    form.set("name", name);
    form.set("content", new Blob([bytes], { type }), name);
    const response = await fetch(new URL("/api/main/methods/upload-file-media-object?_fmt=json", base), {
        method: "POST",
        headers: { accept: "application/json", "x-client": "penpot-presenter", cookie },
        body: form,
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`upload ${response.status} ${text.slice(0, 400)}`);
    }
    return JSON.parse(text);
}

async function uploadFont(cookie, teamId) {
    const session = await rpc("create-upload-session", { totalChunks: 1 }, cookie);
    const bytes = readFileSync("/usr/share/fonts/truetype/freefont/FreeSans.ttf");
    const form = new FormData();
    form.set("session-id", session.data.sessionId);
    form.set("index", "0");
    form.set("content", new Blob([bytes], { type: "font/ttf" }), "FreeSans.ttf");
    const chunk = await fetch(new URL("/api/main/methods/upload-chunk?_fmt=json", base), {
        method: "POST",
        headers: { accept: "application/json", "x-client": "penpot-presenter", cookie },
        body: form,
    });
    if (!chunk.ok) {
        throw new Error(`font chunk ${chunk.status}`);
    }
    const variant = await rpc("create-font-variant", {
        teamId,
        fontId: randomUUID(),
        fontFamily: "Free Sans",
        fontWeight: 400,
        fontStyle: "normal",
        uploads: { "font/ttf": session.data.sessionId },
    }, cookie);
    return {
        fontId: variant.data.fontId,
        fontFamily: "Free Sans",
        fontVariantId: variant.data.id,
        fontSize: "84",
        fill: "#14213d",
    };
}

async function mcpCall(token, body, sessionId) {
    const url = new URL("/mcp/stream", base);
    url.searchParams.set("userToken", token);
    const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
    };
    if (sessionId) {
        headers["mcp-session-id"] = sessionId;
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    const messages = [];
    if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        messages.push(JSON.parse(text));
    } else {
        for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) {
                continue;
            }
            const data = line.slice(5).trim();
            if (data) {
                messages.push(JSON.parse(data));
            }
        }
    }
    return {
        status: response.status,
        sessionId: response.headers.get("mcp-session-id") || sessionId || "",
        messages,
        text,
    };
}

function toolText(message) {
    const content = message?.result?.content || [];
    return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

async function writeNotesViaMcp(token, notesByName) {
    const init = await mcpCall(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "presenter-proof", version: "1" },
        },
    });
    if (!init.sessionId) {
        throw new Error(`mcp initialize ${init.status}`);
    }
    await mcpCall(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
    const code = notesSnippet(notesByName);
    const executed = await mcpCall(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "execute_code", arguments: { code } },
    }, init.sessionId);
    const message = executed.messages.find((item) => item.id === 2) || executed.messages[0];
    const text = toolText(message);
    if (!executed.sessionId || message?.result?.isError || message?.error) {
        throw new Error(redact(text || executed.text, [token]).slice(0, 500));
    }
    return text;
}

function sql(statement) {
    return execFileSync(
        "docker",
        ["exec", "-i", "penpot-rehearsal-penpot-postgres-1", "psql", "-U", "penpot", "-d", "penpot", "-tAc", statement],
        { encoding: "utf8" }
    ).trim();
}

async function main() {
    const secrets = [];
    const report = [];
    const note = (line) => {
        report.push(line);
        console.log(line);
    };

    const bareMcp = await fetch(new URL("/mcp/stream", base), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: "{}",
    });
    note(`mcp endpoint without token: ${bareMcp.status}`);
    if (bareMcp.status === 404) {
        throw new Error("mcp endpoint is missing");
    }

    const created = await rpc("create-demo-profile", { skipOnboarding: true });
    secrets.push(created.data.password);
    const login = await rpc("login-with-password", {
        email: created.data.email,
        password: created.data.password,
    });
    const cookie = cookieHeader(login.cookies);
    const tokenValue = cookie.split("auth-token=")[1] || "";
    secrets.push(tokenValue);
    const profile = await rpc("get-profile", {}, cookie);
    const teams = await rpc("get-teams", {}, cookie);
    const team = teams.data[0];
    const projects = await rpc("get-projects", { "team-id": team.id }, cookie);
    const project = projects.data.find((item) => item.isDefault) || projects.data[0];
    note(`demo login ok, projects=${projects.data.length}`);

    const font = await uploadFont(cookie, team.id);
    note("custom font variant created");

    const file = await rpc("create-file", { name: "Presenter talk", projectId: project.id }, cookie);
    const fileId = file.data.id;
    const pageId = file.data.data.pages[0];
    execFileSync("convert", [
        "-size", "960x540", "xc:#2f6fed",
        "-fill", "white", "-pointsize", "64", "-gravity", "center",
        "-annotate", "0", "Figure",
        "/tmp/penpot-rehearsal/figure.png",
    ]);
    const media = await uploadMedia(cookie, fileId, readFileSync("/tmp/penpot-rehearsal/figure.png"), "figure.png", "image/png");

    const names = ["Slide 1", "Slide 2", "Slide 3", "Slide 4"];
    const fills = ["#fff8e7", "#e7f0ff", "#ffffff", "#14213d"];
    const boards = names.map((name, index) => {
        const id = randomUUID();
        return {
            id,
            name,
            obj: {
                id,
                name,
                type: "frame",
                parentId: ZERO,
                frameId: ZERO,
                rotation: 0,
                ...rect(index * 2100, 0, 1920, 1080),
                fills: [{ fillColor: fills[index], fillOpacity: 1 }],
                strokes: [],
                shapes: [],
                r1: 0,
                r2: 0,
                r3: 0,
                r4: 0,
                hideFillOnExport: false,
            },
        };
    });
    const labels = [
        { board: 0, text: "What changed?", font: { ...builtinFont, fontSize: "92" } },
        { board: 1, text: "Free Sans", font },
        { board: 3, text: "Thank you", font: { ...builtinFont, fontSize: "92", fill: "#f4f1ea" } },
    ];
    const changes = boards.map((board) => ({
        type: "add-obj",
        id: board.id,
        pageId,
        frameId: ZERO,
        parentId: ZERO,
        obj: board.obj,
    }));
    for (const label of labels) {
        const id = randomUUID();
        const parent = boards[label.board];
        changes.push({
            type: "add-obj",
            id,
            pageId,
            frameId: parent.id,
            parentId: parent.id,
            obj: {
                id,
                name: label.text,
                type: "text",
                parentId: parent.id,
                frameId: parent.id,
                rotation: 0,
                growType: "fixed",
                ...rect(parent.obj.x + 120, parent.obj.y + 280, 1500, 220),
                content: textContent(label.text, label.font),
            },
        });
    }
    const imageId = randomUUID();
    const figure = boards[2];
    changes.push({
        type: "add-obj",
        id: imageId,
        pageId,
        frameId: figure.id,
        parentId: figure.id,
        obj: {
            id: imageId,
            name: "Figure",
            type: "image",
            parentId: figure.id,
            frameId: figure.id,
            rotation: 0,
            ...rect(figure.obj.x + 320, figure.obj.y + 180, 1280, 720),
            metadata: { id: media.id, width: media.width, height: media.height, mtype: "image/png" },
            proportion: media.width / media.height,
            proportionLock: true,
            fills: [],
            strokes: [],
            r1: 0,
            r2: 0,
            r3: 0,
            r4: 0,
        },
    });
    await rpc("update-file", {
        id: fileId,
        sessionId: randomUUID(),
        revn: 0,
        vern: 0,
        features: file.data.features,
        changes,
    }, cookie);
    note("file has 4 boards, text, an image, and a custom font");

    await rpc("update-profile-props", { props: { mcpEnabled: true } }, cookie);
    const access = await rpc("create-access-token", { name: "presenter-proof", type: "mcp" }, cookie);
    const mcpToken = access.data.token;
    secrets.push(mcpToken);

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ["--disable-gpu", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: "auth-token", value: decodeURIComponent(tokenValue), url: base }]);
    const workspace = await context.newPage();
    await workspace.goto(
        `${base}/#/workspace?team-id=${team.id}&file-id=${fileId}&page-id=${pageId}`,
        { waitUntil: "domcontentloaded" }
    );
    await workspace.waitForTimeout(4000);

    const notesByName = {
        "Slide 1": "Opening. State the question.\n\n- point at the title",
        "Slide 2": "The method uses a custom font.",
        "Slide 3": "This slide has the figure.",
        "Slide 4": "Thank the room.",
    };
    let snippetText = "";
    let snippetError = "";
    for (let attempt = 1; attempt <= 8; attempt += 1) {
        try {
            snippetText = await writeNotesViaMcp(mcpToken, notesByName);
            break;
        } catch (error) {
            snippetError = redact(error.message, secrets);
            await workspace.waitForTimeout(2000);
        }
    }
    if (!snippetText) {
        throw new Error(`snippet failed: ${snippetError}`);
    }
    note(`execute_code snippet wrote notes, bytes=${Buffer.byteLength(snippetText)}`);
    writeFileSync(`${outDir}/snippet-result.json`, redact(snippetText, secrets));

    let notesOk = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const got = await rpc("get-file", { id: fileId }, cookie);
        const page = got.data.data.pagesIndex[pageId];
        const slides = slidesFromObjects(page.objects);
        notesOk = slides.length === 4 && slides.every((slide) => readNotes(slide) === notesByName[slide.name]);
        if (notesOk) {
            note(`get-file notes match for ${slides.map((slide) => slide.name).join(", ")}`);
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!notesOk) {
        throw new Error("notes were not stored on the boards");
    }

    const presenter = await context.newPage();
    await presenter.goto(`${base}/presenter/?file=${fileId}&page=${pageId}`, { waitUntil: "domcontentloaded" });
    await presenter.waitForSelector("img.slide", { timeout: 120000 });
    await presenter.waitForFunction(() => {
        const image = document.querySelector("img.slide");
        return image && image.naturalWidth > 100;
    }, { timeout: 30000 });
    const notesText = await presenter.locator("#notes").innerText();
    if (!notesText.includes("Thank the room") && !notesText.includes("Opening")) {
        throw new Error("presenter is not showing the speaker notes");
    }
    await presenter.screenshot({ path: `${outDir}/presenter-slide-1.png` });
    note("screenshot presenter first slide");

    const beforeCount = await presenter.locator("#count").innerText();
    const beforeTimer = await presenter.locator("#timer").innerText();
    await presenter.getByRole("button", { name: "Reset timer" }).focus();
    await presenter.keyboard.press("Space");
    await presenter.waitForFunction((previous) => {
        const count = document.querySelector("#count")?.textContent || "";
        return count && count !== previous;
    }, beforeCount, { timeout: 120000 });
    const afterTimer = await presenter.locator("#timer").innerText();
    if (beforeTimer !== "00:00" && afterTimer === "00:00") {
        throw new Error("Space activated the focused button");
    }
    await presenter.screenshot({ path: `${outDir}/presenter-space.png` });
    note(`Space moved the deck (${beforeCount} -> ${await presenter.locator("#count").innerText()})`);

    const audiencePromise = presenter.waitForEvent("popup");
    await presenter.getByRole("button", { name: "Open audience window" }).click();
    const audience = await audiencePromise;
    await audience.setViewportSize({ width: 1280, height: 720 });
    await audience.waitForSelector("img.audience-slide", { timeout: 30000 });

    async function goTo(name) {
        for (let step = 0; step < 6; step += 1) {
            const alt = await presenter.locator("img.slide").getAttribute("alt");
            if (alt && alt.includes(name)) {
                return;
            }
            await presenter.keyboard.press("ArrowRight");
            await presenter.waitForFunction((previous) => {
                const image = document.querySelector("img.slide");
                return image && image.naturalWidth > 100 && image.alt && image.alt !== previous;
            }, alt, { timeout: 120000 });
        }
        throw new Error(`did not reach ${name}`);
    }

    await goTo("Slide 3");
    await audience.waitForFunction(() => document.querySelector("img.audience-slide")?.alt?.includes("Slide 3"), { timeout: 30000 });
    const figureSrc = await presenter.locator("img.slide").getAttribute("src");
    const audienceSrc = await audience.locator("img.audience-slide").getAttribute("src");
    if (figureSrc !== audienceSrc) {
        throw new Error("audience window is not showing the presenter slide");
    }
    await presenter.screenshot({ path: `${outDir}/presenter-figure.png` });
    await audience.screenshot({ path: `${outDir}/audience-figure.png` });
    await presenter.keyboard.press("PageDown");
    await presenter.waitForFunction(() => document.querySelector("img.slide")?.alt?.includes("Slide 2"), { timeout: 120000 });
    await audience.waitForFunction(() => document.querySelector("img.audience-slide")?.alt?.includes("Slide 2"), { timeout: 30000 });
    await presenter.screenshot({ path: `${outDir}/presenter-font.png` });
    note("screenshots of the figure and the custom-font slide; audience stays in sync");

    const marked = sql(
        "UPDATE storage_object SET deleted_at = now() " +
        "WHERE deleted_at IS NULL AND metadata::text LIKE '%tempfile%' " +
        "RETURNING id::text"
    );
    const markedIds = marked.split("\n").map((line) => line.trim()).filter(Boolean);
    note(`marked ${markedIds.length} tempfile rows deleted_at`);
    if (!markedIds.length) {
        throw new Error("no tempfile storage rows to mark");
    }
    const asset = await fetch(`${base}/assets/by-id/${markedIds[0]}`, { headers: { cookie } });
    note(`asset after deleted_at: HTTP ${asset.status}`);
    if (asset.status !== 404) {
        throw new Error(`expected 404 after deleted_at, got ${asset.status}`);
    }
    const stillThere = await audience.locator("img.audience-slide").evaluate((image) => image.naturalWidth > 100);
    if (!stillThere) {
        throw new Error("audience lost the slide after storage gc");
    }
    await audience.screenshot({ path: `${outDir}/audience-after-gc.png` });
    const left = sql("SELECT count(*) FROM storage_object WHERE deleted_at IS NOT NULL");
    note(`deleted_at rows still present: ${left}`);

    const viewer = await context.newPage();
    await viewer.goto(`${base}/#/view?file-id=${fileId}&page-id=${pageId}&index=0`, { waitUntil: "domcontentloaded" });
    await viewer.waitForTimeout(3000);
    const viewerText = await viewer.locator("body").innerText();
    if (/internal error|something went wrong/i.test(viewerText)) {
        throw new Error("viewer showed an error");
    }
    await viewer.screenshot({ path: `${outDir}/viewer.png` });
    note("viewer opened");

    const dashboard = await context.newPage();
    await dashboard.goto(`${base}/#/dashboard/files?team-id=${team.id}`, { waitUntil: "domcontentloaded" });
    await dashboard.getByText("Drafts", { exact: true }).waitFor({ timeout: 20000 });
    await dashboard.getByText("Drafts", { exact: true }).click();
    try {
        await dashboard.getByText("Presenter talk", { exact: false }).waitFor({ timeout: 20000 });
    } catch (error) {
        const dashText = await dashboard.locator("body").innerText();
        writeFileSync(`${outDir}/dashboard.txt`, dashText.slice(0, 2000));
        throw new Error("dashboard did not list the file");
    }
    await dashboard.screenshot({ path: `${outDir}/dashboard.png` });
    note("dashboard lists the file");

    const anon = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const loginPage = await anon.newPage();
    await loginPage.goto(`${base}/#/auth/login`, { waitUntil: "domcontentloaded" });
    await loginPage.waitForSelector('input[type="password"]', { timeout: 20000 });
    await loginPage.screenshot({ path: `${outDir}/login.png` });
    note("login form is present");
    await anon.close();
    await browser.close();

    const restoredFiles = Number(sql("SELECT count(*) FROM file WHERE deleted_at IS NULL;"));
    note(`rehearsal database has ${restoredFiles} files`);
    if (restoredFiles < 2) {
        throw new Error("restored file listing looks empty");
    }

    const logs = spawnSync("docker", ["logs", "penpot-rehearsal-penpot-backend-1"], { encoding: "utf8" });
    const logText = `${logs.stdout || ""}${logs.stderr || ""}`;
    const applied = (logText.match(/apply migration/g) || []).length;
    note(`backend 'apply migration' lines: ${applied}`);
    if (applied !== 0) {
        throw new Error("backend applied a migration");
    }

    writeFileSync(`${outDir}/report.txt`, `${report.join("\n")}\n`);
}

main().catch((error) => {
    console.error(String(error && error.message ? error.message : error).slice(0, 800));
    process.exit(1);
});
