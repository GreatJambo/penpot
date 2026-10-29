/**
 * Clicker keys. Right, space, and PageDown advance.
 * Left and PageUp go back. Home and End jump to the ends.
 * Browsers report the space bar as event.key " " and event.code "Space".
 */

import { clampIndex } from "./channel.mjs";

export function keyCommand(event) {
    const key = event && event.key;
    const code = event && event.code;
    if (key === " " || code === "Space" || key === "ArrowRight" || key === "PageDown") {
        return { delta: 1 };
    }
    if (key === "ArrowLeft" || key === "PageUp") {
        return { delta: -1 };
    }
    if (key === "Home") {
        return { edge: "start" };
    }
    if (key === "End") {
        return { edge: "end" };
    }
    return null;
}

export function keyFromEditable(target) {
    if (!target || !target.tagName) {
        return false;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

/** Apply a key. preventDefault stops Space from clicking a focused button. */
export function applyKey(event, index, total) {
    if (keyFromEditable(event && event.target)) {
        return null;
    }
    const command = keyCommand(event);
    if (!command) {
        return null;
    }
    if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
    }
    if (command.edge === "start") {
        return 0;
    }
    if (command.edge === "end") {
        return total ? total - 1 : 0;
    }
    return clampIndex(index + command.delta, total);
}
