// In-memory stand-in for src/common/googleDrive.js, same function shapes.

export function createFakeDrive() {
  const items = new Map([["root", { id: "root", name: "root", isFolder: true }]]);
  let nextId = 1;

  const children = (parentId) => [...items.values()].filter((i) => i.parentId === parentId);
  const add = (item) => {
    const id = `id${nextId++}`;
    items.set(id, { id, ...item });
    return id;
  };

  const drive = {
    async resolveFolderPath(segments) {
      let parentId = "root";
      for (const name of segments) {
        const match = children(parentId).find((i) => i.isFolder && i.name === name);
        if (!match) throw new Error(`Drive folder "${name}" not found`);
        parentId = match.id;
      }
      return parentId;
    },
    async listFolders(parentId) {
      return children(parentId).filter((i) => i.isFolder).map(({ id, name }) => ({ id, name }));
    },
    async listFiles(parentId) {
      return children(parentId).filter((i) => !i.isFolder).map(({ id, name }) => ({ id, name }));
    },
    async createFolder(parentId, name) {
      return add({ name, parentId, isFolder: true });
    },
    async uploadFile(parentId, name, buffer) {
      return add({ name, parentId, isFolder: false, data: Buffer.from(buffer) });
    },
    async downloadFile(id) {
      return Buffer.from(items.get(id).data);
    },
    async deleteItem(id) {
      for (const child of children(id)) await drive.deleteItem(child.id);
      items.delete(id);
    },
  };

  // ---- test helpers (not part of the Drive interface) ----
  drive.seedFolders = async (segments) => {
    let parentId = "root";
    for (const name of segments) {
      parentId = children(parentId).find((i) => i.isFolder && i.name === name)?.id ?? (await drive.createFolder(parentId, name));
    }
    return parentId;
  };
  drive.folderNames = async (segments) => (await drive.listFolders(await drive.resolveFolderPath(segments))).map((f) => f.name);
  drive.findFile = async (folderSegments, folderName, fileName) => {
    const parent = (await drive.listFolders(await drive.resolveFolderPath(folderSegments))).find((f) => f.name === folderName);
    return (await drive.listFiles(parent.id)).find((f) => f.name === fileName);
  };
  drive.overwrite = (id, buffer) => {
    items.get(id).data = Buffer.from(buffer);
  };

  return drive;
}
