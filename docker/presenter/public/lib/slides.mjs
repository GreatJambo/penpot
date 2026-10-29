/**
 * Top-level boards of a Penpot page, in board order.
 *
 * Board order matches the Penpot viewer. The root child list is back
 * to front, and the viewer starts at the front, so this list is reversed.
 * The top of the layer stack is slide 1.
 * Nested frames are not slides. Hidden boards and boards marked
 * hide-in-viewer are not slides.
 */

export const ROOT_ID = "00000000-0000-0000-0000-000000000000";

function field(shape, camel, kebab) {
    if (!shape || typeof shape !== "object") {
        return undefined;
    }
    if (shape[camel] !== undefined) {
        return shape[camel];
    }
    return shape[kebab];
}

export function isTopLevelBoard(shape) {
    if (!shape || typeof shape !== "object") {
        return false;
    }
    const type = shape.type;
    if (type !== "frame" && type !== "board") {
        return false;
    }
    const id = String(shape.id || "");
    if (!id || id === ROOT_ID) {
        return false;
    }
    const frameId = String(field(shape, "frameId", "frame-id") || "");
    if (frameId !== ROOT_ID) {
        return false;
    }
    if (shape.hidden === true) {
        return false;
    }
    const hideInViewer = field(shape, "hideInViewer", "hide-in-viewer");
    if (hideInViewer === true) {
        return false;
    }
    return true;
}

/**
 * @param {Record<string, object>} objects page objects map from get-file JSON
 * @returns {object[]} slides in board order
 */
export function slidesFromObjects(objects) {
    if (!objects || typeof objects !== "object") {
        return [];
    }
    const root = objects[ROOT_ID];
    const childIds = root && Array.isArray(root.shapes) ? root.shapes : [];
    const slides = [];
    for (const id of childIds) {
        const shape = objects[String(id)];
        if (isTopLevelBoard(shape)) {
            slides.push(shape);
        }
    }
    slides.reverse();
    return slides;
}

export function pageList(file) {
    const data = (file && (file.data || file)) || {};
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const index = data.pagesIndex || data["pages-index"] || {};
    return pages.map((id) => {
        const page = index[id] || {};
        return {
            id: String(id),
            name: page.name || "Page",
            objects: page.objects || null,
        };
    });
}
