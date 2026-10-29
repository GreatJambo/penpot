/**
 * Boards in Penpot viewer order.
 *
 * This follows get-viewer-frames: every frame except the page root,
 * dropping only shapes with hide-in-viewer. Nested boards are included
 * when show-in-view-mode is on, which clears hide-in-viewer. A hidden
 * layer stays in the list, matching the viewer. Sibling order is the
 * reverse of the parent's child list (front of the stack first), and a
 * board is visited before the boards inside it.
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

export function isViewerFrame(shape) {
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
    return field(shape, "hideInViewer", "hide-in-viewer") !== true;
}

function childIds(shape) {
    return shape && Array.isArray(shape.shapes) ? shape.shapes : [];
}

function walk(objects, id, slides) {
    const shape = objects[String(id)];
    if (!shape) {
        return;
    }
    const ids = childIds(shape);
    for (let index = ids.length - 1; index >= 0; index -= 1) {
        const child = objects[String(ids[index])];
        if (!child) {
            continue;
        }
        if (isViewerFrame(child)) {
            slides.push(child);
        }
        walk(objects, child.id, slides);
    }
}

/**
 * @param {Record<string, object>} objects page objects map from get-file JSON
 * @returns {object[]} slides in viewer order
 */
export function slidesFromObjects(objects) {
    if (!objects || typeof objects !== "object") {
        return [];
    }
    const slides = [];
    walk(objects, ROOT_ID, slides);
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
