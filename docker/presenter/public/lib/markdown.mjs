/**
 * A small markdown renderer for speaker notes.
 * HTML in the notes is escaped before any markup is applied.
 */

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function inline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    return html;
}

export function renderNotes(markdown) {
    const source = String(markdown || "").replace(/\r\n/g, "\n");
    if (!source.trim()) {
        return "";
    }
    const blocks = source.split(/\n{2,}/);
    return blocks
        .map((block) => {
            const lines = block.split("\n");
            const list = lines.every((line) => line.trim().startsWith("- "));
            if (list) {
                const items = lines
                    .map((line) => `<li>${inline(line.trim().slice(2))}</li>`)
                    .join("");
                return `<ul>${items}</ul>`;
            }
            return `<p>${lines.map(inline).join("<br>")}</p>`;
        })
        .join("");
}
