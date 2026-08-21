// Registry of database KINDS the ".a db" command can dispatch to — one
// entry per feature module ("orkus-info", "general-user-db",
// "general-server-db"), each exposing { add, list, delete, edit }: async
// functions taking (args: string[], ctx, instance) and returning a reply
// string. `instance` is the specific database ROW (from store.js) that
// command.js's resolution logic picked for this call — orkus-info's
// handlers ignore it (Main is a single fixed database, not multiple
// instances); the two general-*-db modules use it to scope every query
// to that one instance (see src/common/recordActions.js). This registry
// itself stays deliberately dumb — no knowledge of tiers, ownership, or
// which instance is being targeted, just a name -> handler-set lookup.
// See src/features/db/README.md for the full tier/permission design.

const databases = new Map();

export function register(name, handlers) {
  databases.set(name, handlers);
}

export function get(name) {
  return databases.get(name);
}

export function names() {
  return [...databases.keys()];
}
