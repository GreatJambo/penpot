/**
 * One PNG export of one board through Penpot's exporter.
 * The exporter renders with its own browser and returns an asset URI.
 */

import { Keyword, Uuid, encode } from "./transit.mjs";

export function exportRequest({ profileId, fileId, pageId, objectId, name, scale = 2 }) {
    return encode({
        cmd: new Keyword("export-shapes"),
        wait: true,
        "profile-id": new Uuid(profileId),
        "is-wasm": true,
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
