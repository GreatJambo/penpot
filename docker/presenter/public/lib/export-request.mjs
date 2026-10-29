/**
 * One PNG export of one board through Penpot's exporter.
 *
 * is-wasm follows the frontend export path in
 * frontend/src/app/main/data/exports/assets.cljs: the instance flag
 * wasm-export is on, and the file features include render-wasm/v1.
 * PNG is one of the wasm export types, so the flag is the only extra
 * check. The flag is off unless PENPOT_FLAGS contains enable-wasm-export.
 */

import { Keyword, Uuid, encode } from "./transit.mjs";

export function wasmExportEnabled(flagsText, fileFeatures) {
    const words = String(flagsText || "").split(/\s+/).filter(Boolean);
    let flag = false;
    for (const word of words) {
        if (word === "enable-wasm-export" || word === "wasm-export") {
            flag = true;
        }
        if (word === "disable-wasm-export") {
            flag = false;
        }
    }
    const features = Array.isArray(fileFeatures) ? fileFeatures : [];
    return flag && features.includes("render-wasm/v1");
}

export function exportRequest({
    profileId,
    fileId,
    pageId,
    objectId,
    name,
    scale = 1.5,
    wasm = false,
}) {
    const body = {
        cmd: new Keyword("export-shapes"),
        wait: true,
        "profile-id": new Uuid(profileId),
        exports: [
            {
                "file-id": new Uuid(fileId),
                "page-id": new Uuid(pageId),
                "object-id": new Uuid(objectId),
                type: new Keyword("png"),
                scale,
                suffix: "",
                name: name || "slide",
            },
        ],
    };
    if (wasm) {
        body["is-wasm"] = true;
    }
    return encode(body);
}
