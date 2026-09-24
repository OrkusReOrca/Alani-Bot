// In-memory stand-in for discordStore.js, same list / put / get / remove shape.

import { CorruptBackupError } from "../../src/features/cloud-backup/crypto.js";

export function createFakeStore() {
  const items = new Map(); // id -> { id, groupId, name, files, corrupt }
  let nextId = 1;
  let down = false;

  const guard = () => {
    if (down) throw new Error("Discord is down");
  };

  const store = {
    async list(groupId) {
      guard();
      return [...items.values()].filter((i) => i.groupId === groupId).map(({ id, groupId: g, name }) => ({ id, groupId: g, name }));
    },
    async put(groupId, name, files) {
      guard();
      const id = String(nextId++);
      items.set(id, { id, groupId, name, files: structuredClone(files), corrupt: false });
      return id;
    },
    async get(item) {
      guard();
      const stored = items.get(item.id);
      if (stored.corrupt) throw new CorruptBackupError("failed to decrypt");
      return Object.fromEntries(Object.entries(stored.files).map(([k, v]) => [k, Buffer.from(v)]));
    },
    async remove(item) {
      guard();
      items.delete(item.id);
    },
  };

  // ---- test helpers (not part of the store interface) ----
  store.names = async (groupId) => (await store.list(groupId)).map((i) => i.name);
  store.markCorrupt = (id) => {
    items.get(id).corrupt = true;
  };
  store.setDown = (value) => {
    down = value;
  };
  return store;
}
