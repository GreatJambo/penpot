/** Presenter and audience stay in sync on this channel. */

export const CHANNEL_NAME = "penpot-presenter-v1";

export function stateMessage({ fileId, pageId, index, total, src, name }) {
    return {
        v: 1,
        type: "state",
        fileId,
        pageId,
        index,
        total,
        src: src || "",
        name: name || "",
    };
}

export function navMessage(delta) {
    return { v: 1, type: "nav", delta };
}

export function helloMessage() {
    return { v: 1, type: "hello" };
}

export function clampIndex(index, total) {
    if (!total) {
        return 0;
    }
    const value = Number(index) || 0;
    return Math.min(total - 1, Math.max(0, value));
}

export function applyDelta(index, delta, total) {
    return clampIndex(index + delta, total);
}
