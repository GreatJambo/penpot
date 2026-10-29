import { CHANNEL_NAME, clampIndex, edgeMessage, helloMessage, navMessage, stateMessage } from "./lib/channel.mjs";
import { exportRequest, wasmExportEnabled } from "./lib/export-request.mjs";
import { keyCommand, keyFromEditable } from "./lib/keys.mjs";
import { renderNotes } from "./lib/markdown.mjs";
import { readNotes } from "./lib/notes.mjs";
import { RELOAD_MESSAGE, sessionExpired } from "./lib/session.mjs";
import { pageList, slidesFromObjects } from "./lib/slides.mjs";
import { decode } from "./lib/transit.mjs";

const params = new URLSearchParams(location.search);
const role = params.get("role") === "audience" ? "audience" : "presenter";

const app = document.querySelector("#app");
const channel = new BroadcastChannel(CHANNEL_NAME);

const deck = {
    fileId: params.get("file") || "",
    pageId: params.get("page") || "",
    profileId: "",
    revn: 0,
    slides: [],
    index: 0,
    urls: new Map(),
    blobs: new Map(),
    errors: new Map(),
    flagsText: "",
    wasm: false,
    startedAt: 0,
    generation: 0,
};

const inflight = new Map();
let audienceUrl = "";

function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (key === "class") {
            node.className = value;
        } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value != null) {
            node.setAttribute(key, value);
        }
    }
    for (const child of children || []) {
        if (child == null) {
            continue;
        }
        node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
}

async function rpc(method, body) {
    const url = new URL(`/api/main/methods/${method}`, location.origin);
    url.searchParams.set("_fmt", "json");
    const headers = { accept: "application/json", "x-client": "penpot-presenter" };
    let payload;
    const isGet = method.startsWith("get-");
    if (isGet) {
        for (const [key, value] of Object.entries(body || {})) {
            if (value != null && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }
    } else {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body || {});
    }
    const response = await fetch(url, {
        method: isGet ? "GET" : "POST",
        credentials: "include",
        redirect: "manual",
        headers,
        body: payload,
    });
    if (sessionExpired(response)) {
        const error = new Error("reload");
        throw error;
    }
    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text.slice(0, 400) };
        }
    }
    if (response.status === 401 || response.status === 403) {
        const error = new Error("sign-in");
        error.status = response.status;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`${method} failed (${response.status})`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

function signInView(message) {
    const reload = message === "reload" || message === RELOAD_MESSAGE;
    app.replaceChildren(
        el("main", { class: "gate" }, [
            el("h1", {}, ["Penpot Presenter"]),
            el("p", {}, [reload ? RELOAD_MESSAGE : (message || "Sign in to Penpot, then come back to this page.")]),
            reload
                ? el("button", { type: "button", onClick: () => location.reload() }, ["Reload"])
                : el("a", { href: "/#/auth/login" }, ["Sign in"]),
        ])
    );
}

function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function currentSlide() {
    return deck.slides[deck.index] || null;
}

function slideUrl(slide) {
    if (!slide) {
        return "";
    }
    return deck.urls.get(`${slide.id}:${deck.revn}`) || "";
}

function slideKey(slide) {
    return slide ? `${slide.id}:${deck.revn}` : "";
}

function slideBlob(slide) {
    return deck.blobs.get(slideKey(slide)) || null;
}

function slideProblem(slide) {
    return slide ? deck.errors.get(String(slide.id)) || "" : "";
}

function publish() {
    const slide = currentSlide();
    channel.postMessage(
        stateMessage({
            fileId: deck.fileId,
            pageId: deck.pageId,
            index: deck.index,
            total: deck.slides.length,
            name: slide ? slide.name : "",
            blob: slideBlob(slide),
        })
    );
}

function rememberQuery() {
    const url = new URL(location.href);
    if (deck.fileId) {
        url.searchParams.set("file", deck.fileId);
    }
    if (deck.pageId) {
        url.searchParams.set("page", deck.pageId);
    }
    history.replaceState(null, "", url);
}

async function fetchExport(slide, key) {
    const body = exportRequest({
        profileId: deck.profileId,
        fileId: deck.fileId,
        pageId: deck.pageId,
        objectId: slide.id,
        name: slide.name || "slide",
        scale: 1.5,
        wasm: deck.wasm,
    });
    const response = await fetch(new URL("/api/export", location.origin), {
        method: "POST",
        credentials: "include",
        redirect: "manual",
        headers: {
            "content-type": "application/transit+json",
            accept: "application/transit+json",
            "x-client": "penpot-presenter",
        },
        body: JSON.stringify(body),
    });
    if (sessionExpired(response)) {
        const error = new Error("reload");
        throw error;
    }
    const text = await response.text();
    let data;
    try {
        data = decode(JSON.parse(text));
    } catch {
        data = { hint: text.slice(0, 300) };
    }
    if (!response.ok || !data || !data.uri) {
        const hint = (data && (data.hint || data.message)) || `export failed (${response.status})`;
        throw new Error(String(hint));
    }
    const asset = await fetch(new URL(String(data.uri), location.origin), {
        credentials: "include",
        redirect: "manual",
    });
    if (sessionExpired(asset)) {
        throw new Error("reload");
    }
    if (!asset.ok) {
        throw new Error(`slide image failed (${asset.status})`);
    }
    const blob = await asset.blob();
    deck.blobs.set(key, blob);
    deck.urls.set(key, URL.createObjectURL(blob));
    deck.errors.delete(String(slide.id));
    return blob;
}

async function exportSlide(slide) {
    const key = slideKey(slide);
    if (deck.blobs.has(key)) {
        return deck.blobs.get(key);
    }
    if (inflight.has(key)) {
        return inflight.get(key);
    }
    const job = fetchExport(slide, key).finally(() => {
        inflight.delete(key);
    });
    inflight.set(key, job);
    return job;
}

async function prefetch(start) {
    const generation = ++deck.generation;
    const order = [];
    if (deck.slides[start]) {
        order.push(start);
    }
    if (deck.slides[start + 1]) {
        order.push(start + 1);
    }
    for (let i = 0; i < deck.slides.length; i += 1) {
        if (i !== start && i !== start + 1) {
            order.push(i);
        }
    }
    for (const index of order) {
        if (generation !== deck.generation) {
            return;
        }
        try {
            await exportSlide(deck.slides[index]);
        } catch (error) {
            if (error.message === "reload") {
                signInView("reload");
                return;
            }
            deck.errors.set(String(deck.slides[index].id), error.message);
        }
        if (generation === deck.generation && (index === deck.index || index === deck.index + 1)) {
            drawPresenter();
            publish();
        }
    }
}

function goTo(index) {
    const next = clampIndex(index, deck.slides.length);
    if (next === deck.index) {
        return;
    }
    deck.index = next;
    drawPresenter();
    publish();
    prefetch(deck.index);
}

function go(delta) {
    goTo(deck.index + delta);
}

function drawAudience(state) {
    let src = "";
    if (state && state.blob) {
        if (audienceUrl) {
            URL.revokeObjectURL(audienceUrl);
        }
        audienceUrl = URL.createObjectURL(state.blob);
        src = audienceUrl;
    }
    app.replaceChildren(
        el("main", { class: "audience", tabindex: "0" }, [
            src
                ? el("img", { class: "audience-slide", src, alt: (state && state.name) || "Slide" }, [])
                : el("p", { class: "waiting" }, ["Waiting for the presenter"]),
        ])
    );
    app.querySelector(".audience").focus();
}

function fillNotes(node, slide) {
    const notes = slide ? readNotes(slide) : "";
    if (!notes) {
        node.replaceChildren(el("p", { class: "muted" }, ["No notes for this slide."]));
        return;
    }
    node.innerHTML = renderNotes(notes);
}

function fillStage(node, src, alt, empty) {
    if (src) {
        const image = node.querySelector("img.slide");
        if (image) {
            image.src = src;
            image.alt = alt;
            return;
        }
        node.replaceChildren(el("img", { class: "slide", src, alt }, []));
        return;
    }
    node.replaceChildren(el("p", { class: "waiting" }, [empty]));
}

function fillNext(node, src, alt, empty) {
    if (src) {
        const image = node.querySelector("img");
        if (image) {
            image.src = src;
            image.alt = alt;
            return;
        }
        node.append(el("img", { src, alt }, []));
        const waiting = node.querySelector("p");
        if (waiting) {
            waiting.remove();
        }
        return;
    }
    const image = node.querySelector("img");
    if (image) {
        image.remove();
    }
    let waiting = node.querySelector("p");
    if (!waiting) {
        waiting = el("p", { class: "muted" }, [empty]);
        node.append(waiting);
    } else {
        waiting.textContent = empty;
    }
}

function drawPresenter() {
    const slide = currentSlide();
    const next = deck.slides[deck.index + 1];
    const src = slideUrl(slide);
    const nextSrc = slideUrl(next);
    const elapsed = deck.startedAt ? formatTime(performance.now() - deck.startedAt) : "00:00";
    const count = deck.slides.length ? `${deck.index + 1} / ${deck.slides.length}` : "0 / 0";
    const title = slide ? slide.name || "Notes" : "Notes";
    const shell = document.querySelector(".presenter");

    if (shell) {
        document.getElementById("count").textContent = count;
        document.getElementById("slide-title").textContent = title;
        fillStage(document.getElementById("stage"), src, title, slideProblem(slide) || "Rendering the slide…");
        fillNext(document.getElementById("next"), nextSrc, next ? next.name || "Next slide" : "", slideProblem(next) || (next ? "Rendering…" : "End"));
        const notes = document.getElementById("notes");
        if (notes.dataset.slide !== String(deck.index)) {
            notes.dataset.slide = String(deck.index);
            fillNotes(notes, slide);
        }
        return;
    }

    const stage = el("section", { class: "stage", id: "stage", tabindex: "0" }, []);
    const nextBox = el("figure", { class: "next", id: "next" }, [el("figcaption", {}, ["Next"])]);
    const notes = el("div", { class: "notes-body", id: "notes" }, []);
    fillStage(stage, src, title, slideProblem(slide) || "Rendering the slide…");
    fillNext(nextBox, nextSrc, next ? next.name || "Next slide" : "", slideProblem(next) || (next ? "Rendering…" : "End"));
    notes.dataset.slide = String(deck.index);
    fillNotes(notes, slide);

    app.replaceChildren(
        el("div", { class: "presenter" }, [
            el("header", { class: "bar" }, [
                el("a", { href: "/presenter/", class: "brand" }, ["Presenter"]),
                el("span", { class: "count", id: "count" }, [count]),
                el("span", { class: "timer", id: "timer" }, [elapsed]),
                el("button", { type: "button", onClick: resetTimer }, ["Reset timer"]),
                el("button", { type: "button", onClick: openAudience }, ["Open audience window"]),
            ]),
            el("div", { class: "body" }, [
                stage,
                el("aside", { class: "side" }, [
                    nextBox,
                    el("section", { class: "notes" }, [
                        el("h2", { id: "slide-title" }, [title]),
                        notes,
                    ]),
                    el("p", { class: "hint" }, ["Keys: → ← space PageDown PageUp Home End"]),
                ]),
            ]),
        ])
    );
    if (document.activeElement === document.body) {
        stage.focus();
    }
}

function resetTimer() {
    deck.startedAt = performance.now();
    const timer = document.getElementById("timer");
    if (timer) {
        timer.textContent = "00:00";
    }
}

function openAudience() {
    const url = new URL("/presenter/", location.origin);
    url.searchParams.set("role", "audience");
    window.open(url, "penpot-presenter-audience");
    publish();
}

function tick() {
    if (role !== "presenter" || !deck.startedAt) {
        return;
    }
    const timer = document.getElementById("timer");
    if (timer) {
        timer.textContent = formatTime(performance.now() - deck.startedAt);
    }
}

async function loadFile(fileId) {
    const file = await rpc("get-file", { id: fileId });
    deck.fileId = file.id || fileId;
    deck.revn = file.revn || 0;
    const pages = pageList(file);
    return { file, pages };
}

function pageObjects(pages, pageId) {
    const page = pages.find((item) => item.id === pageId) || pages[0];
    return page || null;
}

async function present(fileId, pageId) {
    const loaded = await loadFile(fileId);
    const pages = loaded.pages;
    const page = pageObjects(pages, pageId);
    if (!page || !page.objects) {
        throw new Error("This page has no shapes yet.");
    }
    deck.pageId = page.id;
    deck.slides = slidesFromObjects(page.objects);
    deck.index = 0;
    for (const url of deck.urls.values()) {
        URL.revokeObjectURL(url);
    }
    deck.urls = new Map();
    deck.blobs = new Map();
    deck.errors = new Map();
    inflight.clear();
    deck.wasm = wasmExportEnabled(deck.flagsText, loaded.file.features);
    deck.startedAt = performance.now();
    rememberQuery();
    drawPresenter();
    publish();
    prefetch(0);
    return pages;
}

function picker(files, pages, errorText) {
    const fileSelect = el("select", { id: "file" }, []);
    for (const file of files) {
        const option = el("option", { value: file.id }, [`${file.project} / ${file.name}`]);
        if (file.id === deck.fileId) {
            option.selected = true;
        }
        fileSelect.append(option);
    }
    const pageSelect = el("select", { id: "page" }, []);
    for (const page of pages) {
        const option = el("option", { value: page.id }, [page.name]);
        if (page.id === deck.pageId) {
            option.selected = true;
        }
        pageSelect.append(option);
    }
    fileSelect.addEventListener("change", async () => {
        deck.fileId = fileSelect.value;
        try {
            const { pages: nextPages } = await loadFile(fileSelect.value);
            deck.pageId = nextPages[0] ? nextPages[0].id : "";
            picker(files, nextPages, "");
        } catch (error) {
            if (error.message === "sign-in") {
                signInView();
                return;
            }
            picker(files, [], error.message);
        }
    });
    app.replaceChildren(
        el("main", { class: "gate" }, [
            el("h1", {}, ["Penpot Presenter"]),
            el("p", {}, ["Pick a file and a page. Slides follow the Penpot viewer, including nested boards shown in view mode."]),
            el("label", {}, ["File", fileSelect]),
            el("label", {}, ["Page", pageSelect]),
            errorText ? el("p", { class: "error" }, [errorText]) : null,
            el("button", {
                type: "button",
                onClick: async () => {
                    try {
                        await present(fileSelect.value, pageSelect.value);
                    } catch (error) {
                        if (error.message === "sign-in") {
                            signInView();
                            return;
                        }
                        picker(files, pages, error.message);
                    }
                },
            }, ["Present"]),
        ])
    );
}

async function listFiles() {
    const profile = await rpc("get-profile", {});
    deck.profileId = profile.id;
    const teams = await rpc("get-teams", {});
    const files = [];
    for (const team of teams || []) {
        const projects = await rpc("get-projects", { "team-id": team.id });
        for (const project of projects || []) {
            if (project.deletedAt || project["deleted-at"]) {
                continue;
            }
            const projectFiles = await rpc("get-project-files", { "project-id": project.id });
            for (const file of projectFiles || []) {
                if (file.deletedAt || file["deleted-at"]) {
                    continue;
                }
                files.push({
                    id: file.id,
                    name: file.name || "File",
                    project: project.name || "Project",
                });
            }
        }
    }
    files.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    return files;
}

function onKey(event) {
    if (keyFromEditable(event.target)) {
        return;
    }
    const command = keyCommand(event);
    if (!command) {
        return;
    }
    event.preventDefault();
    if (role === "audience") {
        channel.postMessage(command.edge ? edgeMessage(command.edge) : navMessage(command.delta));
        return;
    }
    if (!deck.slides.length) {
        return;
    }
    if (command.edge === "start") {
        goTo(0);
    } else if (command.edge === "end") {
        goTo(deck.slides.length - 1);
    } else {
        go(command.delta);
    }
}

channel.onmessage = (event) => {
    const message = event.data || {};
    if (role === "audience" && message.type === "state") {
        drawAudience(message);
        return;
    }
    if (role === "presenter" && message.type === "hello") {
        publish();
        return;
    }
    if (role === "presenter" && message.type === "edge" && deck.slides.length) {
        goTo(message.edge === "end" ? deck.slides.length - 1 : 0);
        return;
    }
    if (role === "presenter" && message.type === "nav" && deck.slides.length) {
        go(message.delta || 0);
    }
};

document.addEventListener("keydown", onKey);
setInterval(tick, 250);

async function main() {
    if (role === "audience") {
        drawAudience(null);
        channel.postMessage(helloMessage());
        return;
    }
    try {
        await loadFlags();
        const files = await listFiles();
        if (!files.length) {
            signInView("No files are visible for this account.");
            return;
        }
        let pages = [];
        if (deck.fileId && files.some((file) => file.id === deck.fileId)) {
            const loaded = await loadFile(deck.fileId);
            pages = loaded.pages;
            if (deck.pageId && pages.some((page) => page.id === deck.pageId)) {
                await present(deck.fileId, deck.pageId);
                return;
            }
        } else {
            deck.fileId = files[0].id;
            const loaded = await loadFile(deck.fileId);
            pages = loaded.pages;
            deck.pageId = pages[0] ? pages[0].id : "";
        }
        picker(files, pages, "");
    } catch (error) {
        if (error.message === "reload") {
            signInView("reload");
            return;
        }
        if (error.message === "sign-in") {
            signInView();
            return;
        }
        signInView(error.message);
    }
}

async function loadFlags() {
    const response = await fetch(new URL("/js/config.js", location.origin), {
        credentials: "include",
        redirect: "manual",
    });
    if (sessionExpired(response)) {
        throw new Error("reload");
    }
    const text = await response.text();
    const match = text.match(/var penpotFlags = "([^"]*)"/);
    deck.flagsText = match ? match[1] : "";
}

main();
