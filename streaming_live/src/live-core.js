import { shortHashSync } from "./crypto.js";
import { appendRejectedChunk, readState, updateState, upsertByKey } from "./store.js";

export const DISCOVERY_TOPIC = "/lumen/discovery/live";
export const CHUNK_DURATION_MS = 1000;
export const WINDOW_CHUNKS = 30;

export function now() {
  return Date.now();
}

export function slugify(value) {
  return String(value || "live")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "live";
}

export function parseTags(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function shortAddress(address) {
  if (!address) return "unknown";
  return address.length > 14 ? `${address.slice(0, 8)}...${address.slice(-5)}` : address;
}

export async function createProfile(adapter, data) {
  const pseudo = String(data.pseudo || "").trim();
  const profileKey = `${slugify(pseudo)}.lumen`;
  const profile = {
    id: `profile-${slugify(pseudo)}-${shortHashSync(now())}`,
    type: "lumen.profile",
    version: 2,
    pseudo,
    title: String(data.title || "").trim(),
    description: String(data.description || "").trim(),
    avatar: String(data.avatar || "").trim(),
    banner: String(data.banner || "").trim(),
    wallet: String(data.wallet || "").trim(),
    pubkey: String(data.pubkey || "").trim(),
    tags: parseTags(data.tags),
    profileKey,
    live: null,
    createdAt: now(),
    updatedAt: now()
  };
  profile.signature = await adapter.signLiveMessage({
    type: "lumen.profile",
    id: profile.id,
    profileKey,
    pseudo: profile.pseudo,
    wallet: profile.wallet,
    pubkey: profile.pubkey,
    updatedAt: profile.updatedAt
  });
  const profileCid = await adapter.addJson(profile);
  profile.cid = profileCid;
  await adapter.publishIPNS(profileKey, profileCid);
  updateState((state) => {
    state.profiles.unshift(profile);
  });
  return profile;
}

export async function startLive(adapter, pubsub, profile, data) {
  const streamId = `${slugify(profile.pseudo)}-${shortHashSync(`${now()}-${Math.random()}`)}`;
  const live = {
    sessionId: `session-${streamId}`,
    streamId,
    profileId: profile.id,
    pseudo: profile.pseudo,
    title: String(data.title || "").trim(),
    description: String(data.description || "").trim(),
    avatar: profile.avatar,
    banner: profile.banner,
    wallet: profile.wallet,
    pubkey: profile.pubkey,
    profileKey: profile.profileKey,
    profileCid: profile.cid,
    tags: parseTags(data.tags),
    imageCid: String(data.imageCid || "").trim(),
    imageName: String(data.imageName || "").trim(),
    imageMimeType: String(data.imageMimeType || "").trim(),
    offlineImageCid: String(data.offlineImageCid || "").trim(),
    offlineImageName: String(data.offlineImageName || "").trim(),
    offlineImageMimeType: String(data.offlineImageMimeType || "").trim(),
    topic: `/lumen/live/${streamId}/head`,
    status: "LIVE",
    viewers: 10 + Math.floor(Math.random() * 180),
    seq: 0,
    chunks: [],
    chunksProduced: 0,
    windowCid: "",
    initSegmentCid: "",
    lastChunkCid: "",
    lastHead: null,
    startedAt: now(),
    lastSeenAt: now()
  };

  const updatedProfile = {
    ...profile,
    live: {
      streamId: live.streamId,
      topic: live.topic,
      title: live.title,
      description: live.description,
      tags: live.tags,
      imageCid: live.imageCid,
      imageName: live.imageName,
      imageMimeType: live.imageMimeType,
      offlineImageCid: live.offlineImageCid,
      offlineImageName: live.offlineImageName,
      offlineImageMimeType: live.offlineImageMimeType,
      status: "LIVE",
      startedAt: live.startedAt
    },
    updatedAt: now()
  };
  updatedProfile.signature = await adapter.signLiveMessage({
    type: "lumen.profile.live-state",
    profileKey: updatedProfile.profileKey,
    streamId,
    wallet: updatedProfile.wallet,
    pubkey: updatedProfile.pubkey,
    updatedAt: updatedProfile.updatedAt
  });
  updatedProfile.cid = await adapter.addJson(updatedProfile);
  await adapter.publishIPNS(updatedProfile.profileKey, updatedProfile.cid);
  live.profileCid = updatedProfile.cid;

  updateState((state) => {
    upsertByKey(state.profiles, "id", updatedProfile);
    state.liveSessions.unshift({ ...live, chunks: [] });
    state.activeStreams[streamId] = live;
    upsertByKey(state.discoveredLives, "streamId", live);
  });
  await publishDiscovery(adapter, pubsub, live);
  return live;
}

export async function stopLive(adapter, pubsub, live) {
  if (!live) return;
  const endedAt = now();
  const next = { ...live, status: "OFFLINE", endedAt, lastSeenAt: endedAt };
  updateState((state) => {
    state.activeStreams[next.streamId] = next;
    const discovered = state.discoveredLives.find((item) => item.streamId === next.streamId);
    if (discovered) Object.assign(discovered, { status: "OFFLINE", endedAt, lastSeenAt: endedAt });
  });
  await publishDiscovery(adapter, pubsub, next);
}

export async function produceChunk(adapter, pubsub, live, mediaPayload = null) {
  const seq = Number(live.seq || 0) + 1;
  const timestamp = now();
  const payload = mediaPayload
    ? {
        ...mediaPayload,
        seq,
        timestamp,
        streamId: live.streamId
      }
    : makeTextFrame(live, seq, timestamp);
  const cid = await adapter.addChunk(payload);
  const durationMs = Number(payload.durationMs || CHUNK_DURATION_MS);
  const initSegmentCid = payload.isInit ? cid : (live.initSegmentCid || "");
  const chunkRef = { seq, cid, createdAt: timestamp, durationMs };
  const chunks = [...(live.chunks || []), chunkRef].slice(-WINDOW_CHUNKS);
  const windowObject = {
    type: "lumen.live.window",
    version: 1,
    streamId: live.streamId,
    durationMs: chunks.reduce((sum, chunk) => sum + Number(chunk.durationMs || CHUNK_DURATION_MS), 0),
    fromSeq: chunks[0]?.seq || seq,
    toSeq: chunks[chunks.length - 1]?.seq || seq,
    chunks,
    createdAt: timestamp
  };
  const windowCid = await adapter.addJson(windowObject);
  const message = {
    type: "lumen.live.chunk",
    version: 1,
    streamId: live.streamId,
    seq,
    cid,
    durationMs,
    windowCid,
    initSegmentCid,
    wallet: live.wallet,
    pubkey: live.pubkey,
    createdAt: timestamp
  };
  message.signature = await adapter.signLiveMessage(message);
  const nextLive = {
    ...live,
    seq,
    chunks,
    windowCid,
    initSegmentCid,
    lastChunkCid: cid,
    lastHead: message,
    chunksProduced: seq,
    lastSeenAt: timestamp
  };
  updateState((state) => {
    state.activeStreams[nextLive.streamId] = nextLive;
    upsertByKey(state.discoveredLives, "streamId", nextLive);
  });
  pubsub.publish(nextLive.topic, message);
  return nextLive;
}

export function makeTextFrame(live, seq, timestamp) {
  const palette = ["#0f8b8d", "#f5a524", "#3d5a80", "#7c3aed", "#138a4b", "#b42318"];
  const color = palette[seq % palette.length];
  const waveform = Array.from({ length: 24 }, (_, index) => {
    const angle = (seq + index) / 2.4;
    return Math.round((Math.sin(angle) * 0.5 + 0.5) * 100);
  });
  return {
    kind: "text-frame",
    frame: `${live.title} :: frame ${seq}`,
    seq,
    timestamp,
    streamId: live.streamId,
    color,
    waveform
  };
}

export async function publishDiscovery(adapter, pubsub, live) {
  const announce = {
    type: "lumen.live.announce",
    version: 1,
    streamId: live.streamId,
    live: {
      streamId: live.streamId,
      profileId: live.profileId,
      pseudo: live.pseudo,
      title: live.title,
      description: live.description,
      avatar: live.avatar,
      banner: live.banner,
      wallet: live.wallet,
      pubkey: live.pubkey,
      profileCid: live.profileCid,
      profileKey: live.profileKey,
      tags: live.tags,
      imageCid: live.imageCid,
      imageName: live.imageName,
      imageMimeType: live.imageMimeType,
      offlineImageCid: live.offlineImageCid,
      offlineImageName: live.offlineImageName,
      offlineImageMimeType: live.offlineImageMimeType,
      topic: live.topic,
      status: live.status,
      viewers: live.viewers,
      lastSeq: live.seq,
      lastChunkCid: live.lastChunkCid,
      windowCid: live.windowCid,
      initSegmentCid: live.initSegmentCid,
      lastHead: live.lastHead,
      lastSeenAt: now()
    },
    wallet: live.wallet,
    pubkey: live.pubkey,
    createdAt: now()
  };
  announce.signature = await adapter.signLiveMessage(announce);
  pubsub.publish(DISCOVERY_TOPIC, announce);
  updateState((state) => upsertByKey(state.discoveredLives, "streamId", announce.live));
}

export async function acceptDiscovery(adapter, message) {
  if (message?.type !== "lumen.live.announce") return false;
  const ok = await adapter.verifyLiveMessage(message);
  if (!ok) {
    appendRejectedChunk({ reason: "invalid discovery signature", message, createdAt: now() });
    return false;
  }
  updateState((state) => upsertByKey(state.discoveredLives, "streamId", message.live));
  return true;
}

export async function acceptChunkHead(adapter, message) {
  if (message?.type !== "lumen.live.chunk") {
    return { ok: false, reason: "wrong message type", message };
  }
  const signatureOk = await adapter.verifyLiveMessage(message);
  if (!signatureOk) {
    appendRejectedChunk({ reason: "invalid chunk signature", message, createdAt: now() });
    return { ok: false, reason: "invalid signature", message };
  }
  const payload = await adapter.cat(message.cid);
  if (!payload) {
    appendRejectedChunk({ reason: "missing chunk CID", message, createdAt: now() });
    return { ok: false, reason: "missing cid", message };
  }
  if (payload.streamId !== message.streamId || Number(payload.seq) !== Number(message.seq)) {
    appendRejectedChunk({ reason: "chunk payload mismatch", message, payload, createdAt: now() });
    return { ok: false, reason: "payload mismatch", message, payload };
  }
  const windowObject = message.windowCid ? await adapter.cat(message.windowCid) : null;
  if (message.windowCid && (!windowObject || windowObject.streamId !== message.streamId)) {
    appendRejectedChunk({ reason: "invalid window CID", message, windowObject, createdAt: now() });
    return { ok: false, reason: "invalid window", message, payload };
  }
  return { ok: true, message, payload, windowObject };
}

export async function loadProfileFromIPNS(adapter, profileKey) {
  const profileCid = await adapter.resolveIPNS(profileKey);
  if (!profileCid) return null;
  const profile = await adapter.cat(profileCid);
  return profile ? { profileCid, profile } : null;
}

export async function hydrateWindowChunks(adapter, windowObject) {
  const refs = Array.isArray(windowObject?.chunks) ? windowObject.chunks : [];
  const chunks = [];
  for (const ref of refs) {
    const payload = await adapter.cat(ref.cid);
    if (payload) chunks.push({ ...ref, payload });
  }
  return chunks;
}

export function seedWallet() {
  return `lmn1${shortHashSync(Math.random()).padEnd(18, "0")}`;
}
