// Naming of backup instances. An instance is stored as one item named
// `instance_<sequence>__<timestamp>`; sequence numbers only ever grow, so the
// highest is always the newest. Faulty snapshots taken when verification
// fails are named `FAULTY_<timestamp>` and never count toward the retained
// instances.

export const KEEP_INSTANCES = 16;
const FAULTY_PREFIX = "FAULTY_";
const INSTANCE_NAME = /^instance_(\d+)__/;

// "2026-09-24T00-00-00Z" — colons and dots aren't friendly in names.
const stamp = (date) => date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

export const instanceName = (sequence, date) => `instance_${String(sequence).padStart(5, "0")}__${stamp(date)}`;
export const faultyName = (date) => `${FAULTY_PREFIX}${stamp(date)}`;
export const fileNameFor = (databaseName) => `${databaseName}.db`;

// The retained (non-faulty) instances among a group's items, oldest first,
// each with its `sequence` number.
export function retainedInstances(items) {
  return items
    .map((item) => ({ ...item, sequence: Number(INSTANCE_NAME.exec(item.name)?.[1]) }))
    .filter((item) => Number.isInteger(item.sequence))
    .sort((a, b) => a.sequence - b.sequence);
}
