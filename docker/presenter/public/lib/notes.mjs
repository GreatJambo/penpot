/**
 * Speaker notes live in the shape's shared plugin data.
 *
 * The plugin API stores them with:
 *   shape.setSharedPluginData("presenter", "notes", text)
 * which writes namespace keyword :shared/presenter and key "notes".
 * get-file JSON may camel-case that keyword. Accept every form.
 */

function pluginData(shape) {
    if (!shape || typeof shape !== "object") {
        return null;
    }
    return shape.pluginData || shape["plugin-data"] || null;
}

function isPresenterBucket(key) {
    const normalized = String(key).toLowerCase().replace(/[^a-z]/g, "");
    return normalized === "presenter" || normalized.endsWith("presenter");
}

export function readNotes(shape) {
    const data = pluginData(shape);
    if (!data || typeof data !== "object") {
        return "";
    }
    for (const [key, value] of Object.entries(data)) {
        if (!isPresenterBucket(key) || !value || typeof value !== "object") {
            continue;
        }
        if (typeof value.notes === "string") {
            return value.notes;
        }
    }
    return "";
}
