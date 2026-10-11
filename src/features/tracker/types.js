// The tracker hierarchy:
//
//   Tracker
//   ├─ Health tracker              (category)
//   │   ├─ Bloodpressure tracker   one per owner
//   │   └─ Pill tracker            one per owner
//   └─ Routine tracker             (category)
//       └─ Activity tracker        any number per owner, each with its own name
//
// Categories only group things: nothing can be created from them, only from the
// smallest subsets (the "types" below). To add a tracker type, add it here and
// give it a handler in command.js — nothing else needs to know the tree.

export const TRACKER_TREE = {
  name: "Tracker",
  children: [
    {
      name: "Health tracker",
      children: [
        { type: "bloodpressure", name: "Bloodpressure tracker", aliases: ["bp", "bloodpressure", "blood pressure", "blood pressure tracker"], onePerOwner: true },
        { type: "pill", name: "Pill tracker", aliases: ["pill", "pills"], onePerOwner: true },
      ],
    },
    {
      name: "Routine tracker",
      children: [{ type: "activity", name: "Activity tracker", aliases: ["activity", "activities"], onePerOwner: false }],
    },
  ],
};

// type id -> { type, name, aliases, onePerOwner, path: ["Tracker", "Health tracker", ...] }
export const TYPES = {};

function register(node, path) {
  const here = [...path, node.name];
  if (node.type) TYPES[node.type] = { ...node, path: here };
  for (const child of node.children ?? []) register(child, here);
}
register(TRACKER_TREE, []);

const normalize = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

// Every creatable type under a category node.
function typesUnder(node) {
  return node.children ? node.children.flatMap(typesUnder) : [TYPES[node.type]];
}

function findNode(node, wanted) {
  if (normalize(node.name) === wanted) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, wanted);
    if (found) return found;
  }
  return null;
}

// What did the user mean by this type name?
//   { status: "type", type }          a creatable type
//   { status: "category", name, creatable: [type, ...] }   a grouping node — nothing to create
//   { status: "none" }
export function resolveType(text) {
  const wanted = normalize(text ?? "");
  const type = Object.values(TYPES).find((t) => normalize(t.name) === wanted || t.aliases.some((alias) => normalize(alias) === wanted));
  if (type) return { status: "type", type };

  const node = findNode(TRACKER_TREE, wanted);
  if (node && !node.type) return { status: "category", name: node.name, creatable: typesUnder(node) };
  return { status: "none" };
}

// What the user can create, for help text.
export const creatableTypeNames = () => Object.values(TYPES).map((t) => t.name);
