import assert from "node:assert/strict";
import test from "node:test";

import { applyDelta, clampIndex, navMessage, stateMessage } from "../public/lib/channel.mjs";
import { exportRequest } from "../public/lib/export-request.mjs";
import { createQueue } from "../public/lib/queue.mjs";
import { applyKey, keyCommand, keyFromEditable } from "../public/lib/keys.mjs";
import { RELOAD_MESSAGE, sessionExpired } from "../public/lib/session.mjs";
import { renderNotes } from "../public/lib/markdown.mjs";
import { readNotes } from "../public/lib/notes.mjs";
import { ROOT_ID, slidesFromObjects } from "../public/lib/slides.mjs";
import { notesSnippet } from "../public/lib/snippet.mjs";
import { decode, encode, Keyword, Uuid } from "../public/lib/transit.mjs";

const ZERO = ROOT_ID;

function board(id, name, extra = {}) {
    return {
        id,
        name,
        type: "frame",
        frameId: ZERO,
        hidden: false,
        hideInViewer: false,
        ...extra,
    };
}

test("slides follow viewer order and keep nested boards shown in view mode", () => {
    const objects = {
        [ZERO]: { id: ZERO, type: "frame", shapes: ["b", "rect", "a", "hidden", "viewer-off"] },
        b: board("b", "First"),
        a: board("a", "Second", { shapes: ["nested", "shown"] }),
        nested: board("nested", "Nested", { frameId: "a", hideInViewer: true }),
        shown: board("shown", "Shown inside", { frameId: "a", hideInViewer: false }),
        rect: { id: "rect", type: "rect", name: "Not a board", frameId: ZERO },
        hidden: board("hidden", "Hidden", { hidden: true }),
        "viewer-off": board("viewer-off", "Off", { hideInViewer: true }),
    };
    const slides = slidesFromObjects(objects);
    assert.deepEqual(slides.map((slide) => slide.name), ["Hidden", "Second", "Shown inside", "First"]);
});

test("notes are read from the shared presenter plugin data", () => {
    assert.equal(readNotes({ pluginData: { presenter: { notes: "Hello" } } }), "Hello");
    assert.equal(
        readNotes({ pluginData: { "shared/presenter": { notes: "From keyword" } } }),
        "From keyword"
    );
    assert.equal(readNotes({ pluginData: { sharedPresenter: { notes: "Camel" } } }), "Camel");
    assert.equal(readNotes({ pluginData: { presenter: { notes: 1 } } }), "");
    assert.equal(readNotes({}), "");
});

test("clicker keys move one slide and ignore typing", () => {
    assert.equal(keyCommand({ key: "ArrowRight" }).delta, 1);
    assert.equal(keyCommand({ key: " ", code: "Space" }).delta, 1);
    assert.equal(keyCommand({ key: "Unidentified", code: "Space" }).delta, 1);
    assert.equal(keyCommand({ key: "PageDown" }).delta, 1);
    assert.equal(keyCommand({ key: "ArrowLeft" }).delta, -1);
    assert.equal(keyCommand({ key: "PageUp" }).delta, -1);
    assert.equal(keyCommand({ key: "Home" }).edge, "start");
    assert.equal(keyCommand({ key: "End" }).edge, "end");
    assert.equal(keyCommand({ key: "a", code: "KeyA" }), null);
    assert.equal(keyFromEditable({ tagName: "TEXTAREA" }), true);
    assert.equal(keyFromEditable({ tagName: "BUTTON" }), false);
    const prevented = [];
    const landed = applyKey({
        key: " ",
        code: "Space",
        target: { tagName: "BUTTON" },
        preventDefault() { prevented.push(true); },
    }, 0, 4);
    assert.equal(landed, 1);
    assert.deepEqual(prevented, [true]);
    assert.equal(applyKey({ key: "Home", preventDefault() {} }, 2, 4), 0);
    assert.equal(applyKey({ key: "End", preventDefault() {} }, 0, 4), 3);
    assert.equal(applyKey({ key: " ", target: { tagName: "INPUT" }, preventDefault() {} }, 0, 4), null);
    assert.equal(clampIndex(-3, 4), 0);
    assert.equal(applyDelta(0, -1, 4), 0);
    assert.equal(applyDelta(3, 1, 4), 3);
    assert.equal(applyDelta(1, 1, 4), 2);
    assert.equal(navMessage(1).type, "nav");
    assert.equal(stateMessage({ fileId: "f", pageId: "p", index: 1, total: 4, name: "S" }).index, 1);
});

test("the export queue runs at most two jobs at once", async () => {
    const queue = createQueue(2);
    let active = 0;
    let peak = 0;
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
        jobs.push(queue.enqueue(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return i;
        }));
    }
    const results = await Promise.all(jobs);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.equal(active, 0);
});

test("an access redirect asks for a reload", () => {
    assert.equal(sessionExpired({ type: "opaqueredirect", status: 0 }), true);
    assert.equal(sessionExpired({ status: 302 }), true);
    assert.equal(sessionExpired({ status: 200, redirected: false }), false);
    assert.equal(RELOAD_MESSAGE.includes("Reload"), true);
});

test("notes markdown escapes html before markup", () => {
    const html = renderNotes("**Hi**\n\n- <script>alert(1)</script>\n- *go*");
    assert.match(html, /<strong>Hi<\/strong>/);
    assert.match(html, /<li>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<em>go<\/em>/);
});

test("export body is transit the exporter can read", () => {
    const body = exportRequest({
        profileId: "11111111-1111-1111-1111-111111111111",
        fileId: "22222222-2222-2222-2222-222222222222",
        pageId: "33333333-3333-3333-3333-333333333333",
        objectId: "44444444-4444-4444-4444-444444444444",
        name: "Slide 1",
    });
    const decoded = decode(body);
    assert.equal(decoded.cmd.name, "export-shapes");
    assert.equal(decoded.wait, true);
    assert.equal(decoded["is-wasm"], undefined);
    assert.equal(JSON.stringify(body).includes("is-wasm"), false);
    assert.equal(decoded.exports[0].scale, 1.5);
    assert.equal(decoded["profile-id"].value, "11111111-1111-1111-1111-111111111111");
    assert.equal(decoded.exports[0].type.name, "png");
    assert.equal(decoded.exports[0]["object-id"].value, "44444444-4444-4444-4444-444444444444");
    assert.equal(decoded.exports[0].name, "Slide 1");
});

test("transit decodes the exporter uri tag", () => {
    const decoded = decode({
        "~:uri": { "~#uri": "http://127.0.0.1:9101/assets/by-id/abc" },
        "~:mtype": "image/png",
        "~:id": "~u11111111-1111-1111-1111-111111111111",
    });
    assert.equal(decoded.uri, "http://127.0.0.1:9101/assets/by-id/abc");
    assert.equal(decoded.mtype, "image/png");
    assert.equal(decoded.id.value, "11111111-1111-1111-1111-111111111111");
});

test("transit escapes strings that look like tags", () => {
    const encoded = encode({ name: new Keyword("n"), title: "~slide" });
    const decoded = decode(encoded);
    assert.equal(decoded.title, "~slide");
    assert.ok(encoded.includes("~~slide"));
    const round = decode(encode(new Uuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")));
    assert.equal(round.value, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
});

test("the agent snippet writes presenter notes through the plugin API", () => {
    const code = notesSnippet({ "Slide 1": "Say this.\n\n- point" });
    assert.match(code, /setSharedPluginData\("presenter", "notes", text\)/);
    assert.match(code, /getSharedPluginData\("presenter", "notes"\)/);
    assert.match(code, /findShapes\(\{ type: "board" \}\)/);
    assert.match(code, /Say this/);
    assert.doesNotMatch(code, /<script>/);
});
