// Shared radio stations: made in the web app, besides each account's own station ("On account"). A shared
// station has a name, an owner and members; it plays like any station (station.js): everyone in it hears it
// in step and controls it fully. The owner names it, invites people (the web app only lets you invite
// friends: it checks with the account service before asking here), removes people, and deletes it.
// An invited person isn't in it until they accept. How many shared stations an account may own depends on
// its plan: the web app sends it with "create" (maxOwned, 1 to MAX_OWNED_LIMIT; 1 when not sent).
//
//   list(accountId)            { own, stations: [{ id, name, owner, yourRole, members, playing, song }] }
//   act(accountId, body)       body.op: create {name, maxOwned} | rename {station, name} | delete {station}
//                              | invite {station, accountIds} | respond {station, accept} | leave {station}
//                              | kick {station, accountId}

import crypto from "node:crypto";

export const MAX_OWNED_LIMIT = 10;
export const MAX_PEOPLE = 20; // in a station, invitations included
const NAME_MAX = 40;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** deps: { store (stateStore's station functions), stations (createStations), ApiError } */
export function createStationAdmin({ store, stations, ApiError }) {
  const cleanName = (value) => {
    const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!name || name.length > NAME_MAX) throw new ApiError(400, `A station's name is 1 to ${NAME_MAX} characters.`);
    return name;
  };

  function viewOf(id, accountId) {
    const info = store.stationInfo(id);
    const v = stations.view(id);
    return {
      id,
      name: info.name,
      owner: info.owner,
      yourRole: info.members.find((m) => m.accountId === accountId)?.role ?? null,
      members: info.members.map((m) => ({ accountId: m.accountId, role: m.role, invitedBy: m.invitedBy })),
      playing: Boolean(v.playback.playing && v.cursor !== null),
      song: v.cursor !== null ? v.queue[v.cursor]?.name ?? null : null,
    };
  }

  function list(accountId) {
    return { own: store.stationOf(accountId), stations: store.sharedStationsOf(accountId).map((id) => viewOf(id, accountId)) };
  }

  /** The shared station named in the body, and this account's place in it (404 if it has none). */
  function stationOf(accountId, body) {
    const id = String(body.station ?? "");
    const info = id.startsWith("station:") ? store.stationInfo(id) : null;
    const me = info?.members.find((m) => m.accountId === accountId);
    if (!me) throw new ApiError(404, "That station isn't available to you.");
    return { id, info, me };
  }
  const ownerOnly = (me, what) => {
    if (me.role !== "owner") throw new ApiError(403, `Only the station's owner can ${what}.`);
  };

  function act(accountId, body) {
    if (body.op === "create") {
      const allowed = Math.min(Math.max(Math.trunc(Number(body.maxOwned)) || 1, 1), MAX_OWNED_LIMIT);
      if (store.ownedSharedStations(accountId).length >= allowed) throw new ApiError(409, `Your plan has ${allowed} radio station${allowed === 1 ? "" : "s"} of your own, and ${allowed === 1 ? "it is" : "they are"} made. Delete one to make another.`);
      const id = store.createSharedStation(accountId, cleanName(body.name), `station:${crypto.randomBytes(8).toString("hex")}`);
      return { station: viewOf(id, accountId) };
    }
    const { id, info, me } = stationOf(accountId, body);
    switch (body.op) {
      case "rename":
        ownerOnly(me, "rename it");
        store.renameStation(id, cleanName(body.name));
        break;
      case "delete":
        ownerOnly(me, "delete it");
        store.deleteStation(id);
        stations.forget(id);
        return { deleted: id };
      case "invite": {
        ownerOnly(me, "invite people");
        const ids = [...new Set((Array.isArray(body.accountIds) ? body.accountIds : []).map(String))].filter((a) => ACCOUNT_ID.test(a) && !info.members.some((m) => m.accountId === a));
        if (info.members.length + ids.length > MAX_PEOPLE) throw new ApiError(409, `A station can have up to ${MAX_PEOPLE} people (invitations included).`);
        for (const invitee of ids) store.setStationMember(id, invitee, "invited", accountId);
        return { invited: ids, station: viewOf(id, accountId) };
      }
      case "respond":
        if (me.role !== "invited") throw new ApiError(409, "You are already in this station.");
        if (body.accept === true) store.setStationMember(id, accountId, "member", me.invitedBy);
        else store.removeStationMember(id, accountId);
        stations.poke(id);
        return body.accept === true ? { station: viewOf(id, accountId) } : { left: id };
      case "leave":
        if (me.role === "owner") throw new ApiError(409, "You own this station: delete it instead.");
        store.removeStationMember(id, accountId);
        stations.poke(id);
        return { left: id };
      case "kick": {
        ownerOnly(me, "remove people");
        const target = info.members.find((m) => m.accountId === String(body.accountId ?? ""));
        if (!target || target.role === "owner") throw new ApiError(404, "They aren't in this station.");
        store.removeStationMember(id, target.accountId);
        stations.poke(id); // their devices ask again, and are told it isn't theirs any more
        break;
      }
      default:
        throw new ApiError(400, "Unknown station change.");
    }
    return { station: viewOf(id, accountId) };
  }

  return { list, act };
}
