/**
 * Plugin code an agent runs with the MCP execute_code tool.
 * The file must already be open on the page that holds the boards.
 *
 * notesByName maps a top-level board name to its speaker notes.
 * Notes are plain text or markdown.
 */
export function notesSnippet(notesByName) {
    const notes = JSON.stringify(notesByName);
    return `const notes = ${notes};
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
return written;`;
}
