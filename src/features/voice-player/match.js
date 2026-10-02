// Forgiving name matching, used both to find a file in the Drive folder and to
// find a track in the queue. Case and the file extension are ignored, and a
// partial name works when it identifies exactly one item.

const EXTENSION = /\.[a-z0-9]{2,5}$/i;

export function normalizeName(name) {
  return name.trim().replace(EXTENSION, "").toLowerCase().replace(/\s+/g, " ");
}

// Strips one pair of surrounding quotes a user may have typed around a name.
export function cleanQuery(query) {
  return query.trim().replace(/^["'`](.*)["'`]$/, "$1").trim();
}

// items: any array; nameOf(item) -> its display name.
// Returns { status: "one", item } | { status: "many", items } | { status: "none" }.
// Order of preference: the exact full name, then the exact name without its
// extension, then a unique partial match. When the same name appears more than
// once (a track queued twice) the first one wins on an exact match.
export function matchByName(items, query, nameOf) {
  const wanted = cleanQuery(query);
  const wantedNormalized = normalizeName(wanted);
  if (!wantedNormalized) return { status: "none" };

  const exactFull = items.filter((item) => nameOf(item).toLowerCase() === wanted.toLowerCase());
  if (exactFull.length > 0) return { status: "one", item: exactFull[0] };

  const exact = items.filter((item) => normalizeName(nameOf(item)) === wantedNormalized);
  if (exact.length > 0) return { status: "one", item: exact[0] };

  const partial = items.filter((item) => normalizeName(nameOf(item)).includes(wantedNormalized));
  if (partial.length === 1) return { status: "one", item: partial[0] };
  return partial.length > 1 ? { status: "many", items: partial } : { status: "none" };
}
