/**
 * Clicker keys. Right, space, and PageDown advance.
 * Left and PageUp go back. Other keys are ignored.
 */

const NEXT = new Set(["ArrowRight", "Space", "PageDown"]);
const PREV = new Set(["ArrowLeft", "PageUp"]);

export function keyDelta(event) {
    const key = event && (event.key || event.code);
    if (NEXT.has(key)) {
        return 1;
    }
    if (PREV.has(key)) {
        return -1;
    }
    return 0;
}

export function keyFromEditable(target) {
    if (!target || !target.tagName) {
        return false;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}
