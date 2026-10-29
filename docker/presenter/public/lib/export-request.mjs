/**
 * One PNG export of one board through Penpot's exporter.
 *
 * The editor never sends is-wasm for a PNG. When wasm export is on,
 * a PNG is rendered in the browser. The exporter only sees a PNG when
 * that path is off, and then is-wasm is false. This request omits it.
 */

import { Keyword, Uuid, encode } from "./transit.mjs";

export function exportRequest({
    profileId,
    fileId,
    pageId,
    objectId,
    name,
    scale = 1.5,
}) {
    return encode({
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
    });
}
