export function parseParentMarker(body: string): number | null {
  const markers = [...body.matchAll(/<!-- t3:parent=([1-9]\d*) -->/g)];
  const number = Number(markers[0]?.[1]);
  return markers.length === 1 && Number.isSafeInteger(number) ? number : null;
}

export function updateParentMarker(
  body: string,
  parentNumber: number,
  action: "add" | "remove",
): string {
  const current = parseParentMarker(body);
  if (action === "remove" && current !== parentNumber) return body;
  const marker = `Part of #${parentNumber} <!-- t3:parent=${parentNumber} -->`;
  const pattern = /(?:Part of #[1-9]\d* )?<!-- t3:parent=[1-9]\d* -->/g;
  let replaced = false;
  const edited = body.replace(pattern, () => {
    if (action === "remove" || replaced) return "";
    replaced = true;
    return marker;
  });
  const next = action === "add" && !replaced ? `${body}${body ? "\n\n" : ""}${marker}` : edited;
  return next;
}
