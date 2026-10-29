# Presenter

A same-origin page for presenting Penpot boards, with speaker notes and a separate audience window.

Open `/presenter/` while you are signed in to Penpot. Pick a file and a page. Slides match Penpot's viewer (`get-viewer-frames`): every board except the page root, in viewer order (front of the stack first, a board before the boards inside it). A board is dropped only when `hide-in-viewer` is set. Nested boards are included when show-in-view-mode is on, which clears that flag. A hidden layer stays in the list, the same as the viewer.

The current slide is a PNG from Penpot's exporter (`POST /api/export`) at scale 1.5. The exporter renders the board with Penpot's own render page. `is-wasm` is sent only when `PENPOT_FLAGS` enables `wasm-export` and the file features include `render-wasm/v1`, which is the same rule as the editor's export path. The page copies each PNG into memory as soon as it arrives, prefetches the next slide, then the rest. One export per slide is in flight at a time.

The audience window shows only the current slide. The presenter sends the PNG bytes over a `BroadcastChannel` named `penpot-presenter-v1`, so the audience does not request `/assets/by-id/` again. Keys on either window move the deck: Right, Space, PageDown, Left, PageUp, Home, End. Space is `event.key === " "` (and `event.code === "Space"`). It does not activate a focused button.

If the access check in front of Penpot redirects the request, the page says to reload.

## Export files

Each slide export stores a PNG in Penpot's tempfile bucket (`storage_object`). The upload sets `touched_at` about ten minutes ahead. The daily `storage-gc-touched` task, after that timestamp is at least two hours old, sets `deleted_at`. `/assets/by-id/` then returns 404, because lookup requires `deleted_at` to be null. It does not wait for the deletion time. A talk that kept the URL would go blank at the next daily run.

On 2.18.5 the daily `storage-gc-deleted` task is commented out in `backend/src/app/main.clj` (`FIXME: temporary commented`). Marking a row deleted does not remove the row or the file on disk. The presenter does not need the URL after it has copied the bytes. To reclaim the disk later, run `storage-gc-deleted` by hand, or delete tempfile rows whose `deleted_at` is set and remove the matching files under the assets directory. The path of an id is the hex of the uuid, two bytes per directory, then the rest of the hex as the file name.

## Speaker notes

Notes are plain text or a small markdown subset. They are stored on each board in the shape's existing shared plugin data. There is no new database column and no file-format change beyond that map.

Namespace: `presenter`
Key: `notes`

The plugin API writes that as keyword `:shared/presenter`.

An agent with the file open can set notes through MCP `execute_code`:

```javascript
const notes = {
  "Slide 1": "Opening. State the question.\n\n- point at the figure",
  "Slide 2": "Walk the result."
};
const root = penpot.currentPage.root;
const boards = penpot.currentPage.findShapes({ type: "board" });
const written = [];
for (const board of boards) {
  if (!board.parent || board.parent.id !== root.id) continue;
  const text = notes[board.name];
  if (text == null) continue;
  board.setSharedPluginData("presenter", "notes", text);
  written.push({
    name: board.name,
    notes: board.getSharedPluginData("presenter", "notes"),
  });
}
return written;
```

`public/lib/snippet.mjs` builds this call. The unit test checks the call. A rehearsal runs it against a live file through MCP `execute_code`.

## Layout

`docker-compose.yaml` is the third compose file. It adds `penpot-presenter` and mounts `nginx-presenter.conf` into the frontend. The first file is the Penpot stack. The second is the MCP headless overlay, which mounts `/mcp-nav/stream`. Every `up` passes all three, or the frontend loses one of those mounts. See `ROLLOUT.md`.

```shell
cd docker/presenter && npm test
docker build -t penpot-presenter:2.18.5 docker/presenter
```
