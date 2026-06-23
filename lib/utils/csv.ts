/**
 * Tiny CSV exporter. Quotes everything, escapes embedded quotes, ends
 * with a newline so trailing-empty-cell parsers don't complain.
 */

function escape(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  const str = String(cell);
  return `"${str.replace(/"/g, '""')}"`;
}

export function rowsToCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(escape).join(","),
    ...rows.map((r) => r.map(escape).join(",")),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Triggers a browser download of the given CSV content.
 * Safe to call only on the client.
 */
export function downloadCsv(filename: string, content: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
