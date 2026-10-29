# Presenter

A same-origin page for presenting Penpot boards, with speaker notes and a separate audience window.

Open `/presenter/` while you are signed in to Penpot. Pick a file and a page. Slides are the top-level boards, in the same order as the Penpot viewer. That order starts at the top of the layer stack. Nested frames, hidden boards, and boards marked hide-in-viewer are skipped.

The current slide is a PNG from Penpot's exporter (`POST /api/export`). The exporter renders the board with Penpot's own render page, so fonts and images match an export. The page prefetches the next slide, then the rest.

The audience window shows only the current slide. It stays in sync through a `BroadcastChannel` named `penpot-presenter-v1`. Keys on either window move the deck: Right, Space, PageDown, Left, PageUp.

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

`docker-compose.yaml` is an override. It adds the `penpot-presenter` service and mounts `nginx-presenter.conf` into the frontend at `/etc/nginx/overrides/server.d/presenter.conf`. The Penpot images stay the official ones. See `ROLLOUT.md`.

```shell
cd docker/presenter && npm test
docker build -t penpot-presenter:2.18.5 docker/presenter
```
