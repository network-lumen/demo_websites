export const STORAGE_KEY = "lumen-live-v2-state";
export const PUBSUB_EVENT_KEY = "lumen-live-v2-pubsub-event";

export const defaultState = {
  profiles: [],
  discoveredLives: [],
  liveSessions: [],
  activeStreams: {},
  pubsubLogs: [],
  cidObjects: {},
  ipnsRecords: {},
  rejectedChunks: [],
  activeTopics: {}
};

function cloneDefault() {
  return JSON.parse(JSON.stringify(defaultState));
}

function normalizeState(input) {
  const next = { ...cloneDefault(), ...(input || {}) };
  next.profiles = Array.isArray(next.profiles) ? next.profiles : [];
  next.discoveredLives = Array.isArray(next.discoveredLives) ? next.discoveredLives : [];
  next.liveSessions = Array.isArray(next.liveSessions) ? next.liveSessions : [];
  next.pubsubLogs = Array.isArray(next.pubsubLogs) ? next.pubsubLogs : [];
  next.rejectedChunks = Array.isArray(next.rejectedChunks) ? next.rejectedChunks : [];
  next.cidObjects = next.cidObjects && typeof next.cidObjects === "object" ? next.cidObjects : {};
  next.ipnsRecords = next.ipnsRecords && typeof next.ipnsRecords === "object" ? next.ipnsRecords : {};
  next.activeStreams = next.activeStreams && typeof next.activeStreams === "object" ? next.activeStreams : {};
  next.activeTopics = next.activeTopics && typeof next.activeTopics === "object" ? next.activeTopics : {};
  return next;
}

export function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeState(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.warn("Could not read Lumen Live state", error);
    return cloneDefault();
  }
}

export function writeState(state) {
  const normalized = normalizeState(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent("lumen-live-state", { detail: normalized }));
  return normalized;
}

export function updateState(mutator) {
  const state = readState();
  mutator(state);
  return writeState(state);
}

export function replaceState(nextState) {
  return writeState(normalizeState(nextState));
}

export function clearState() {
  return writeState(cloneDefault());
}

export function onStateChange(handler) {
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY) handler(readState());
  };
  const onLocal = (event) => handler(event.detail || readState());
  window.addEventListener("storage", onStorage);
  window.addEventListener("lumen-live-state", onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("lumen-live-state", onLocal);
  };
}

export function appendPubsubLog(entry) {
  updateState((state) => {
    if (entry?.id && state.pubsubLogs.some((item) => item.id === entry.id)) return;
    state.pubsubLogs.unshift(entry);
    state.pubsubLogs = state.pubsubLogs.slice(0, 500);
  });
}

export function appendRejectedChunk(entry) {
  updateState((state) => {
    state.rejectedChunks.unshift(entry);
    state.rejectedChunks = state.rejectedChunks.slice(0, 120);
  });
}

export function upsertByKey(list, key, value) {
  const index = list.findIndex((item) => item && item[key] === value[key]);
  if (index >= 0) {
    list[index] = { ...list[index], ...value };
  } else {
    list.unshift(value);
  }
}
