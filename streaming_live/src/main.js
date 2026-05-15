import { LumenAdapter } from "./lumen-adapter.js";
import { CrossTabPubSub } from "./pubsub.js";
import { signLiveMessage, verifyLiveMessage } from "./crypto.js";
import {
  CHUNK_DURATION_MS,
  DISCOVERY_TOPIC,
  acceptChunkHead,
  acceptDiscovery,
  createProfile,
  hydrateWindowChunks,
  loadProfileFromIPNS,
  now,
  parseTags,
  produceChunk,
  seedWallet,
  shortAddress,
  slugify,
  startLive,
  stopLive
} from "./live-core.js";
import { onStateChange, readState, updateState } from "./store.js";

const adapter = new LumenAdapter();
const pubsub = new CrossTabPubSub(adapter);
const els = {};
const MEDIA_TARGET_FPS = 24;
const MEDIA_SEGMENT_MS = 1000;
const VIEWER_LIVE_WINDOW_SECONDS = 30;
const VIEWER_START_BUFFER_SEGMENTS = Math.ceil(VIEWER_LIVE_WINDOW_SECONDS / (MEDIA_SEGMENT_MS / 1000));
const MSE_QUEUE_PREROLL_MS = 450;
const LIVE_EDGE_GAP_SECONDS = 0.5;
const MSE_PRUNE_MARGIN_SECONDS = 1;
const AUDIO_SYNC_SOFT_DRIFT_SECONDS = 0.08;
const AUDIO_SYNC_HARD_DRIFT_SECONDS = 1.2;
const AUDIO_SYNC_MAX_RATE_OFFSET = 0.035;
const AUDIO_MIX_GAIN_SINGLE = 0.92;
const AUDIO_MIX_GAIN_MULTI = 0.68;
const CONNECTION_LOST_MS = 10_000;
const CONNECTIVITY_ISSUE_MS = 20_000;
const OFFLINE_SETTLE_MS = 1_500;
const STABLE_LINK_UPDATE_TIMEOUT_MS = 60_000;
const VIEWER_FULLSCREEN_CONTROLS_IDLE_MS = 1_800;
const VIEWER_FULLSCREEN_ACTIVITY_OPTIONS = { capture: true, passive: true };

let currentLive = null;
let liveTimer = null;
let displayStream = null;
let recorderStream = null;
let microphoneStream = null;
let displayVideo = null;
let captureCanvas = null;
let captureMode = "none";
let captureIssue = "";
let audioMode = "system";
let audioContext = null;
let audioDestination = null;
let viewerMuted = localStorage.getItem("lumen-live-v2-muted") === "1";
let viewerVolume = Number(localStorage.getItem("lumen-live-v2-volume") || "1");
let mediaRecorder = null;
let audioRecorder = null;
let mediaMimeType = "";
let audioMimeType = "";
let recorderQueue = Promise.resolve();
let pendingAudioSegments = [];
let viewerPosterKey = "";
let viewerPosterIndex = 0;
let recorderActive = false;
let mseProcessTimer = null;
let msePlayer = createEmptyMsePlayer();
let audioMseProcessTimer = null;
let audioMsePlayer = createEmptyMsePlayer();
let syncingNativeVideoAudio = false;
let viewerWindowFullscreen = false;
let viewerFullscreenControlsTimer = null;
let viewerFullscreenControlsActive = false;
let viewer = emptyViewer();
let pendingWatchStreamId = "";
let selectedLiveLink = null;
let preloadedCoverImage = null;
let preloadedOfflineImage = null;
let studioRenderScheduled = false;

function isCurrentLiveSession(live) {
  return Boolean(live?.streamId && currentLive?.streamId === live.streamId);
}

function createEmptyMsePlayer() {
  return {
    mediaSource: null,
    sourceBuffer: null,
    objectUrl: "",
    mimeType: "",
    queue: [],
    appendedSeqs: new Set(),
    appendedCount: 0,
    createdAt: now(),
    started: false,
    open: false,
    appending: false,
    lastPrunedBefore: 0
  };
}

function emptyViewer() {
  return {
    streamId: "",
    live: null,
    profile: null,
    unsubscribe: null,
    playbackTimer: null,
    buffer: [],
    received: [],
    slidingWindow: [],
    current: null,
    status: "idle",
    progress: 0,
    chunksReceived: 0,
    chunksPlayed: 0,
    paused: false,
    offlineImageDataUrl: "",
    startedWatchingAt: 0,
    lastReceivedAt: 0,
    offlineDetectedAt: 0,
    timelineSeeking: false,
    followLiveEdge: true
  };
}

function initElements() {
  [
    "page-title", "studio-form",
    "studio-audio-source", "start-live", "stop-live", "studio-state", "studio-chunks", "studio-window", "studio-source",
    "studio-log", "studio-live-link-card", "studio-live-link", "copy-live-link",
    "existing-live-link-tools", "load-live-link-settings", "selected-live-link", "cover-image-input", "cover-image-preview", "offline-image-input", "offline-image-preview",
    "player-title", "viewer-description", "current-frame", "current-frame-image", "offline-screen-image", "media-stage", "media-poster-image", "current-frame-video-a", "current-frame-video-b", "viewer-spinner", "waveform", "play-progress",
    "viewer-timeline", "viewer-timecode", "viewer-pause", "viewer-mute", "viewer-volume", "viewer-volume-label", "viewer-go-live", "viewer-fullscreen",
    "countdown-modal", "countdown-title", "countdown-value", "countdown-message", "cancel-countdown", "toast"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  const on = (id, event, handler) => els[id]?.addEventListener(event, handler);
  on("studio-form", "submit", onStartLive);
  on("stop-live", "click", onStopLive);
  on("copy-live-link", "click", () => copyText(els["studio-live-link"]?.value || ""));
  on("load-live-link-settings", "click", loadPreviousLiveLinkSettings);
  on("cover-image-input", "change", () => handleImageInputPreview("cover"));
  on("offline-image-input", "change", () => handleImageInputPreview("offline"));
  document.querySelectorAll("input[name='liveLinkMode']").forEach((input) => {
    input.addEventListener("change", renderLiveLinkMode);
  });
  on("viewer-timeline", "input", onTimelineInput);
  on("viewer-timeline", "change", onTimelineCommit);
  on("viewer-pause", "click", toggleViewerPause);
  on("viewer-mute", "click", toggleViewerMute);
  on("viewer-volume", "input", onViewerVolumeInput);
  on("viewer-go-live", "click", seekToLiveEdge);
  on("viewer-fullscreen", "click", toggleViewerFullscreen);
  on("current-frame-video-a", "play", onNativeVideoPlay);
  on("current-frame-video-a", "pause", onNativeVideoPause);
  on("current-frame-video-a", "volumechange", onNativeVideoVolumeChange);
  on("current-frame-video-a", "seeking", onNativeVideoSeeking);
  on("current-frame-video-a", "seeked", onNativeVideoSeeked);
  on("current-frame-video-a", "dblclick", toggleViewerFullscreen);
  on("current-frame-video-a", "webkitbeginfullscreen", enterViewerFullscreenControlsMode);
  on("current-frame-video-a", "webkitendfullscreen", leaveViewerFullscreenControlsMode);
  document.addEventListener("fullscreenchange", syncViewerFullscreenState);
  document.addEventListener("webkitfullscreenchange", syncViewerFullscreenState);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (viewerFullscreenControlsActive || isDocumentFullscreen()) return;
    if (viewerWindowFullscreen) exitViewerFullscreen();
  });

  pubsub.subscribe(DISCOVERY_TOPIC, async (message) => {
    const accepted = await acceptDiscovery(adapter, message);
    if (accepted) {
      syncViewerLiveState();
      tryStartPendingWatch();
      renderViewer();
    }
  });

  onStateChange(() => {
    syncViewerLiveState();
    scheduleStudioRender();
    tryStartPendingWatch();
  });
}

function scheduleStudioRender() {
  if (studioRenderScheduled) return;
  studioRenderScheduled = true;
  window.requestAnimationFrame(() => {
    studioRenderScheduled = false;
    renderStudio();
  });
}

function getLiveLinkMode() {
  return document.querySelector("input[name='liveLinkMode']:checked")?.value || "create";
}

function renderLiveLinkMode() {
  const existing = getLiveLinkMode() === "existing";
  els["existing-live-link-tools"]?.classList.toggle("is-hidden", !existing);
  if (!existing) {
    selectedLiveLink = null;
    renderSelectedLiveLink();
  }
}

function renderSelectedLiveLink() {
  const box = els["selected-live-link"];
  if (!box) return;
  box.classList.toggle("is-hidden", !selectedLiveLink?.url);
  const text = box.querySelector("strong");
  if (text) text.textContent = selectedLiveLink?.url || "";
}

async function onStartLive(event) {
  event.preventDefault();
  if (currentLive) return;
  if (els["start-live"]) els["start-live"].disabled = true;
  const form = new FormData(event.currentTarget);
  let startingLive = null;
  if (getLiveLinkMode() === "existing" && !selectedLiveLink?.keyName) {
    toast("Load a previous live link first");
    if (els["start-live"]) els["start-live"].disabled = false;
    return;
  }
  try {
    audioMode = String(form.get("audioSource") || "system");
    const source = await startDisplayCapture(audioMode);
    if (!source.ok) {
      captureMode = "synthetic";
      captureIssue = source.reason;
      appendStudioLog(`Screen capture unavailable: ${source.reason}`);
      toast(`Screen capture unavailable; starting with synthetic frames`);
    }

    const liveImage = await addLiveImageToCid(form.get("image"));
    const offlineImage = await addOfflineImageToCid(form.get("offlineImage"));
    const profile = await createLiveProfile(form, liveImage);
    currentLive = await startLive(adapter, pubsub, profile, {
      title: form.get("title"),
      description: form.get("description"),
      tags: form.get("tags"),
      imageCid: liveImage.cid,
      imageName: liveImage.name,
      imageMimeType: liveImage.type,
      offlineImageCid: offlineImage.cid,
      offlineImageName: offlineImage.name,
      offlineImageMimeType: offlineImage.type
    });
    startingLive = currentLive;
    appendStudioLog("Live metadata ready.");

    const stableLink = await requestStableLinkForLive(startingLive);
    if (!isCurrentLiveSession(startingLive)) {
      appendStudioLog("Live start interrupted.");
      renderAll();
      return;
    }
    if (!stableLink?.url) {
      await stopLive(adapter, pubsub, startingLive);
      if (isCurrentLiveSession(startingLive)) currentLive = null;
      stopDisplayCapture();
      appendStudioLog("Live start cancelled: stable link was not created.");
      renderAll();
      return;
    }

    const confirmed = await showStartCountdown();
    if (!isCurrentLiveSession(startingLive)) {
      appendStudioLog("Live start interrupted.");
      renderAll();
      return;
    }
    if (!confirmed) {
      await stopLive(adapter, pubsub, startingLive);
      if (isCurrentLiveSession(startingLive)) currentLive = null;
      stopDisplayCapture();
      appendStudioLog("Live start cancelled");
      renderAll();
      return;
    }

    appendStudioLog(`Started ${startingLive.topic}`);
    if (!startMediaRecorder()) {
      await produceAndRenderChunk();
      liveTimer = window.setInterval(produceAndRenderChunk, CHUNK_DURATION_MS);
    }
    renderAll();
  } catch (error) {
    stopDisplayCapture();
    if (currentLive && (!startingLive || isCurrentLiveSession(startingLive))) {
      await stopLive(adapter, pubsub, currentLive).catch(() => {});
      currentLive = null;
    }
    appendStudioLog(`Live start failed: ${error?.message || error}`);
    toast("Live start failed");
    renderAll();
  } finally {
    if (els["start-live"]) els["start-live"].disabled = Boolean(currentLive);
  }
}

function showStartCountdown() {
  const modal = els["countdown-modal"];
  const title = els["countdown-title"];
  const value = els["countdown-value"];
  const message = els["countdown-message"];
  const cancel = els["cancel-countdown"];
  if (!modal || !value || !cancel) return Promise.resolve(true);

  if (title) title.textContent = "Your live starts in";
  if (message) message.textContent = "Capture permissions are ready. The stream will start when the countdown ends.";
  value.classList.remove("is-loading");
  cancel.textContent = "Cancel";
  modal.classList.remove("is-hidden");
  let remaining = 3;
  value.textContent = String(remaining);

  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const finish = (ok) => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      cancel.removeEventListener("click", onCancel);
      modal.classList.add("is-hidden");
      resolve(ok);
    };
    const onCancel = () => finish(false);
    cancel.addEventListener("click", onCancel);
    timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) finish(true);
      else value.textContent = String(remaining);
    }, 1000);
  });
}

function showLaunchPendingModal() {
  const modal = els["countdown-modal"];
  const title = els["countdown-title"];
  const value = els["countdown-value"];
  const message = els["countdown-message"];
  const cancel = els["cancel-countdown"];
  if (!modal || !value || !cancel) {
    return {
      cancelled: new Promise(() => {}),
      close() {},
      isCancelled: () => false
    };
  }

  if (title) title.textContent = "Starting your live";
  if (message) message.textContent = "Your live is starting. It will begin in a moment.";
  value.textContent = "";
  value.classList.add("is-loading");
  cancel.textContent = "Cancel";
  modal.classList.remove("is-hidden");

  let didCancel = false;
  let resolveCancel = null;
  const cancelled = new Promise((resolve) => {
    resolveCancel = resolve;
  });
  const onCancel = () => {
    didCancel = true;
    if (resolveCancel) resolveCancel({ ok: false, error: "user_cancelled" });
  };
  cancel.addEventListener("click", onCancel, { once: true });

  return {
    cancelled,
    close() {
      cancel.removeEventListener("click", onCancel);
      value.classList.remove("is-loading");
      modal.classList.add("is-hidden");
    },
    isCancelled: () => didCancel
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function renderImagePreview(kind, src) {
  const el = kind === "offline" ? els["offline-image-preview"] : els["cover-image-preview"];
  if (!el) return;
  const value = String(src || "");
  el.classList.toggle("is-empty", !value);
  el.innerHTML = value
    ? `<img src="${escapeAttr(value)}" alt="${kind === "offline" ? "Offline screen preview" : "Cover image preview"}">`
    : `<span>No image selected</span>`;
}

async function handleImageInputPreview(kind) {
  const input = kind === "offline" ? els["offline-image-input"] : els["cover-image-input"];
  const file = input?.files?.[0] || null;
  if (kind === "offline") preloadedOfflineImage = null;
  else preloadedCoverImage = null;
  if (!file) {
    renderImagePreview(kind, "");
    return;
  }
  const dataUrl = await readFileAsDataUrl(file).catch(() => "");
  renderImagePreview(kind, dataUrl);
}

async function loadImagePreviewFromCid(kind, cid) {
  const id = normalizeIpfsCid(cid);
  if (!id) {
    renderImagePreview(kind, "");
    return null;
  }
  const payload = await adapter.cat(id).catch(() => null);
  const dataUrl = String(payload?.imageDataUrl || "");
  renderImagePreview(kind, dataUrl);
  return dataUrl ? { cid: id, name: String(payload?.name || ""), type: String(payload?.type || ""), imageDataUrl: dataUrl } : { cid: id, name: "", type: "" };
}

function normalizeIpfsCid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lumenMatch = raw.match(/^lumen:\/\/ipfs\/([^/?#]+)/i);
  if (lumenMatch) return lumenMatch[1];
  const ipfsMatch = raw.match(/^\/?ipfs\/([^/?#]+)/i);
  if (ipfsMatch) return ipfsMatch[1];
  return raw.split(/[/?#]/)[0] || raw;
}

async function addImageFileToCid(file, kind) {
  if (!file || typeof file !== "object" || !file.size) return { cid: "", name: "", type: "" };
  const imageDataUrl = await readFileAsDataUrl(file);
  const payload = {
    kind,
    name: file.name || "cover-image",
    type: file.type || "application/octet-stream",
    size: file.size || 0,
    imageDataUrl,
    createdAt: now()
  };
  const cid = await adapter.addChunk(payload);
  return { cid, name: payload.name, type: payload.type };
}

async function addLiveImageToCid(file) {
  if (!file || !file.size) return preloadedCoverImage || { cid: "", name: "", type: "" };
  return await addImageFileToCid(file, "live-image");
}

async function addOfflineImageToCid(file) {
  if (!file || !file.size) return preloadedOfflineImage || { cid: "", name: "", type: "" };
  return await addImageFileToCid(file, "live-offline-image");
}

async function createLiveProfile(form, liveImage) {
  const active = await adapter.getActiveProfile();
  const title = String(form.get("title") || "Live").trim();
  const pseudo = slugify(active?.name || active?.address || title || "lumen-live");
  const wallet = active?.address || active?.walletAddress || seedWallet();
  const pubkey = active?.pubkey || active?.pubkeyB64 || active?.pqcPublicKey || active?.publicKey || `pub_${Math.random().toString(16).slice(2)}`;
  return await createProfile(adapter, {
    pseudo,
    title,
    description: form.get("description"),
    avatar: liveImage.cid ? `lumen://ipfs/${liveImage.cid}` : "",
    banner: liveImage.cid ? `lumen://ipfs/${liveImage.cid}` : "",
    wallet,
    pubkey,
    tags: form.get("tags")
  });
}

function currentLumenContentUrl() {
  try {
    const u = new URL(window.location.href);
    const pathname = u.pathname || "/";
    const pathMatch = pathname.match(/^\/(ipfs|ipns)\/([^/]+)(\/.*)?$/i);
    if (pathMatch) {
      return `lumen://${pathMatch[1].toLowerCase()}/${pathMatch[2]}${pathMatch[3] || "/"}`;
    }

    const hostMatch = String(u.hostname || "").match(/^([a-z0-9]+)\.(ipfs|ipns)\./i);
    if (hostMatch) {
      const path = pathname && pathname !== "/" ? pathname : "/";
      return `lumen://${hostMatch[2].toLowerCase()}/${hostMatch[1]}${path}`;
    }
  } catch {
    return "";
  }
  return "";
}

function stripLumenUrlRuntimeParts(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/^(lumen:\/\/(?:ipfs|ipns)\/[^?#]+)(?:[?#].*)?$/i);
  return match ? match[1] : "";
}

function stableLinkPreviousSiteBase() {
  const values = recordsToMap(selectedLiveLink?.records || []);
  const previous = stripLumenUrlRuntimeParts(values.site);
  if (!previous) return "";
  const selectedIpns = String(selectedLiveLink?.ipnsName || "").trim();
  if (selectedIpns && previous.toLowerCase().startsWith(`lumen://ipns/${selectedIpns.toLowerCase()}`)) return "";
  return previous;
}

function liveSiteBaseUrl() {
  const previousSite = stableLinkPreviousSiteBase();
  if (previousSite) return previousSite;
  const current = stripLumenUrlRuntimeParts(currentLumenContentUrl());
  const selectedIpns = String(selectedLiveLink?.ipnsName || "").trim();
  if (selectedIpns && current.toLowerCase().startsWith(`lumen://ipns/${selectedIpns.toLowerCase()}`)) return "";
  return current;
}

function stableLiveUrlFor(live) {
  const base = liveSiteBaseUrl();
  if (!base || !live?.streamId) return "";
  const [pathPart, hashPart = ""] = base.split("#");
  const [urlPart, queryPart = ""] = pathPart.split("?");
  const params = new URLSearchParams(queryPart);
  params.set("watch", live.streamId);
  if (live.topic) params.set("topic", live.topic);
  if (live.profileKey) params.set("profile", live.profileKey);
  if (live.title) params.set("title", live.title);
  if (live.description) params.set("description", live.description);
  if (Array.isArray(live.tags) && live.tags.length) params.set("tags", live.tags.join(", "));
  if (audioMode) params.set("audioSource", audioMode);
  if (live.imageCid) params.set("imageCid", live.imageCid);
  if (live.offlineImageCid) params.set("offlineImageCid", live.offlineImageCid);
  const qs = params.toString();
  return `${urlPart}${qs ? `?${qs}` : ""}${hashPart ? `#${hashPart}` : ""}`;
}

function stableLiveRecords(live) {
  const target = stableLiveUrlFor(live);
  if (!target) return [];
  return [
    { key: "site", value: target },
    { key: "streamId", value: live.streamId },
    { key: "topic", value: live.topic },
    { key: "profile", value: live.profileKey },
    { key: "imageCid", value: live.imageCid },
    { key: "offlineImageCid", value: live.offlineImageCid },
    { key: "description", value: live.description || "" },
    { key: "tags", value: Array.isArray(live.tags) ? live.tags.join(", ") : "" },
    { key: "audioSource", value: audioMode },
    { key: "title", value: live.title || "Untitled live" }
  ].filter((record) => record.value);
}

function recordsToMap(records) {
  const out = {};
  (Array.isArray(records) ? records : []).forEach((record) => {
    const key = String(record?.key || "").trim();
    if (!key) return;
    out[key] = String(record?.value ?? "").trim();
  });
  const site = String(out.site || "");
  const queryIndex = site.indexOf("?");
  if (queryIndex >= 0) {
    const query = site.slice(queryIndex + 1).split("#")[0] || "";
    const params = new URLSearchParams(query);
    ["title", "description", "tags", "audioSource", "imageCid", "offlineImageCid"].forEach((key) => {
      if (!out[key] && params.get(key)) out[key] = String(params.get(key) || "");
    });
  }
  return out;
}

async function loadPreviousLiveLinkSettings() {
  const form = els["studio-form"];
  if (!form) return;
  const result = await adapter.selectLiveLinkSetup({ title: form.elements.title?.value || "Live" });
  if (!result?.ok) {
    if (result?.error && result.error !== "user_cancelled") toast("Could not load live link settings");
    return;
  }
  selectedLiveLink = {
    keyName: result.keyName,
    ipnsName: result.ipnsName,
    url: result.url,
    records: Array.isArray(result.records) ? result.records : [],
  };
  renderSelectedLiveLink();
  const values = recordsToMap(selectedLiveLink.records);
  if (values.title) form.elements.title.value = values.title;
  if (values.description) form.elements.description.value = values.description;
  if (values.tags) form.elements.tags.value = values.tags;
  if (values.audioSource && form.elements.audioSource) form.elements.audioSource.value = values.audioSource;
  if (els["cover-image-input"]) els["cover-image-input"].value = "";
  if (els["offline-image-input"]) els["offline-image-input"].value = "";
  const coverPreview = applyPreloadedImagePreview("cover", result.imagePreviews?.imageCid);
  const offlinePreview = applyPreloadedImagePreview("offline", result.imagePreviews?.offlineImageCid);
  preloadedCoverImage = coverPreview?.imageDataUrl
    ? coverPreview
    : await loadImagePreviewFromCid("cover", values.imageCid) || coverPreview;
  preloadedOfflineImage = offlinePreview?.imageDataUrl
    ? offlinePreview
    : await loadImagePreviewFromCid("offline", values.offlineImageCid) || offlinePreview;
  toast("Previous live settings loaded");
}

function applyPreloadedImagePreview(kind, preview) {
  const cid = normalizeIpfsCid(preview?.cid);
  const imageDataUrl = String(preview?.imageDataUrl || "");
  if (!cid) return null;
  if (imageDataUrl) renderImagePreview(kind, imageDataUrl);
  return {
    cid,
    name: String(preview?.name || ""),
    type: String(preview?.type || ""),
    imageDataUrl,
  };
}

function applyStableLinkToLive(live, url) {
  if (!live?.streamId || !url) return;
  if (currentLive?.streamId === live.streamId) currentLive = { ...currentLive, stableLinkUrl: url };
  updateState((state) => {
    const active = state.activeStreams?.[live.streamId];
    if (active) state.activeStreams[live.streamId] = { ...active, stableLinkUrl: url };
    const discovered = state.discoveredLives.find((item) => item.streamId === live.streamId);
    if (discovered) discovered.stableLinkUrl = url;
  });
}

async function requestStableLinkForLive(live) {
  const records = stableLiveRecords(live);
  if (!records.length) return;
  if (selectedLiveLink?.keyName) {
    const fallbackUrl = selectedLiveLink.url || (selectedLiveLink.ipnsName ? `lumen://ipns/${selectedLiveLink.ipnsName}/` : "");
    if (fallbackUrl) {
      applyStableLinkToLive(live, fallbackUrl);
      renderAll();
    }
    appendStudioLog("Updating selected stable link...");
    const publishPromise = adapter.publishStableLinkForLive({
      title: live.title || "Untitled live",
      keyName: selectedLiveLink.keyName,
      records,
    });
    const launchModal = showLaunchPendingModal();
    const result = await Promise.race([
      withTimeout(publishPromise, STABLE_LINK_UPDATE_TIMEOUT_MS, {
        ok: false,
        error: "stable_link_update_timeout",
        url: fallbackUrl,
      }),
      launchModal.cancelled
    ]).finally(() => {
      launchModal.close();
    });
    if (launchModal.isCancelled() || result?.error === "user_cancelled") {
      appendStudioLog("Stable link update cancelled.");
      return null;
    }
    if (result?.ok && result.url) {
      applyStableLinkToLive(live, result.url);
      appendStudioLog(`Stable link copied: ${result.url}`);
      toast("Stable live link copied");
      renderAll();
      return result;
    }
    if (fallbackUrl && result?.error === "stable_link_update_timeout") {
      appendStudioLog("Stable link update is still pending; starting live now.");
      publishPromise.then((lateResult) => {
        if (lateResult?.ok && lateResult.url) {
          applyStableLinkToLive(live, lateResult.url);
          appendStudioLog(`Stable link updated: ${lateResult.url}`);
          renderAll();
        } else {
          appendStudioLog(`Stable link update failed: ${lateResult?.error || "publish_failed"}`);
        }
      }).catch((error) => {
        appendStudioLog(`Stable link update failed: ${error?.message || error}`);
      });
      return { ok: true, url: fallbackUrl, pending: true };
    }
    appendStudioLog(`Stable link skipped: ${result?.error || "publish_failed"}`);
    return fallbackUrl ? { ok: true, url: fallbackUrl, warning: result?.error || "publish_failed" } : null;
  }
  appendStudioLog("Choose or create a stable link to share this live.");
  const result = await adapter.chooseStableLinkForLive({
    title: live.title || "Untitled live",
    suggestedName: slugify(live.title || live.streamId || "live"),
    records
  });
  if (!result?.ok) {
    if (result?.error && result.error !== "stable_links_unavailable" && result.error !== "user_cancelled") {
      appendStudioLog(`Stable link skipped: ${result.error}`);
    }
    return null;
  }
  if (result.url) {
    applyStableLinkToLive(live, result.url);
    appendStudioLog(`Stable link copied: ${result.url}`);
    toast("Stable live link copied");
    renderAll();
  }
  return result;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) window.clearTimeout(timer);
  });
}

async function produceAndRenderChunk() {
  if (!currentLive) return;
  const mediaPayload = captureDisplayFrame();
  currentLive = await produceChunk(adapter, pubsub, currentLive, mediaPayload);
  appendStudioLog(`Chunk #${currentLive.seq} ${currentLive.lastChunkCid}`);
  renderStudio();
}

async function onStopLive() {
  if (!currentLive) return;
  window.clearInterval(liveTimer);
  liveTimer = null;
  stopDisplayCapture();
  await recorderQueue.catch(() => {});
  await stopLive(adapter, pubsub, currentLive);
  appendStudioLog(`Stopped ${currentLive.streamId}`);
  currentLive = null;
  renderAll();
}

async function startViewer(streamId = "") {
  const live = readState().discoveredLives.find((item) => item.streamId === streamId) || liveHintFromUrl(streamId);
  if (!live) {
    setViewerStatus("connecting");
    renderViewer();
    return;
  }
  pendingWatchStreamId = "";
  stopViewer();
  viewer = emptyViewer();
  viewer.streamId = live.streamId;
  viewer.live = live;
  viewer.status = "connecting";
  viewer.startedWatchingAt = now();
  localStorage.setItem("lumen-live-v2-last-watch", live.streamId);
  els["player-title"].textContent = live.title || live.streamId;
  renderViewer();

  const loadedProfile = live.profileKey ? await loadProfileFromIPNS(adapter, live.profileKey) : null;
  viewer.profile = loadedProfile?.profile || null;
  await loadViewerOfflineImage(live);
  await catchUpFromStreamHistory(live);
  await catchUpFromLiveState(live);

  viewer.unsubscribe = pubsub.subscribe(live.topic, onViewerChunk);
  viewer.playbackTimer = window.setInterval(tickPlayback, 500);
  setViewerStatus(viewer.buffer.length ? "live" : "buffering");
  renderViewer();
  toast(`Subscribed to ${live.topic}`);
}

function stopViewer() {
  if (viewer.unsubscribe) viewer.unsubscribe();
  if (viewer.playbackTimer) window.clearInterval(viewer.playbackTimer);
  localStorage.removeItem("lumen-live-v2-last-watch");
  resetMediaSegmentPlayer();
  viewer = emptyViewer();
  renderViewer();
}

async function catchUpFromLiveState(live) {
  if (live.initSegmentCid) {
    const initPayload = await adapter.cat(live.initSegmentCid);
    if (initPayload?.kind === "media-segment") {
      addViewerEntry({
        seq: initPayload.seq || 0,
        cid: live.initSegmentCid,
        createdAt: initPayload.timestamp || now(),
        receivedAt: now(),
        durationMs: initPayload.durationMs || CHUNK_DURATION_MS,
        payload: initPayload,
        message: null,
        isBootstrap: true
      });
    }
  }
  if (live.windowCid) {
    const windowObject = await adapter.cat(live.windowCid);
    await applyWindow(windowObject);
  }
  if (live.lastHead) {
    const result = await acceptChunkHead(adapter, live.lastHead);
    if (result.ok) {
      await applyAcceptedChunk(result);
    }
  }
}

async function loadViewerOfflineImage(live) {
  const cid = String(live?.offlineImageCid || "").trim();
  if (!cid) return;
  const payload = await adapter.cat(cid).catch(() => null);
  if (payload?.imageDataUrl) viewer.offlineImageDataUrl = String(payload.imageDataUrl);
}

async function catchUpFromStreamHistory(live) {
  const logs = readState().pubsubLogs
    .filter((entry) => entry.topic === live.topic && entry.message?.type === "lumen.live.chunk" && entry.message.streamId === live.streamId)
    .sort((a, b) => Number(a.message.seq || 0) - Number(b.message.seq || 0));

  for (const entry of logs) {
    const result = await acceptChunkHead(adapter, entry.message);
    if (result.ok) await applyAcceptedChunk(result);
  }
}

async function onViewerChunk(message) {
  if (message.streamId !== viewer.streamId) return;
  const result = await acceptChunkHead(adapter, message);
  if (!result.ok) {
    setViewerStatus("stalled");
    renderViewer();
    toast(`Rejected chunk: ${result.reason}`);
    return;
  }
  await applyAcceptedChunk(result);
  setViewerStatus(viewer.buffer.length > 1 ? "live" : "buffering");
  renderViewer();
}

async function applyAcceptedChunk(result) {
  const initSegmentCid = String(result.message?.initSegmentCid || "").trim();
  if (initSegmentCid && initSegmentCid !== result.message.cid && !viewer.received.some((item) => item.cid === initSegmentCid)) {
    const initPayload = await adapter.cat(initSegmentCid).catch(() => null);
    if (initPayload?.kind === "media-segment") {
      addViewerEntry({
        seq: initPayload.seq || 0,
        cid: initSegmentCid,
        createdAt: initPayload.timestamp || now(),
        receivedAt: now(),
        durationMs: initPayload.durationMs || CHUNK_DURATION_MS,
        payload: initPayload,
        message: null,
        isBootstrap: true
      });
    }
  }
  const entry = {
    seq: result.message.seq,
    cid: result.message.cid,
    windowCid: result.message.windowCid,
    createdAt: result.message.createdAt,
    receivedAt: now(),
    durationMs: result.message.durationMs,
    message: result.message,
    payload: result.payload
  };
  addViewerEntry(entry);
  if (result.windowObject) await applyWindow(result.windowObject);
}

async function applyWindow(windowObject) {
  if (!windowObject) return;
  const hydrated = await hydrateWindowChunks(adapter, windowObject);
  viewer.slidingWindow = hydrated.map((item) => ({
    seq: item.seq,
    cid: item.cid,
    createdAt: item.createdAt,
    durationMs: item.durationMs,
    payload: item.payload
  }));
  hydrated.forEach((item) => {
    addViewerEntry({
      seq: item.seq,
      cid: item.cid,
      createdAt: item.createdAt,
      receivedAt: now(),
      durationMs: item.durationMs,
      payload: item.payload,
      message: null
    });
  });
}

function addViewerEntry(entry) {
  if (viewer.received.some((item) => item.seq === entry.seq)) return;
  viewer.received.push(entry);
  viewer.received.sort((a, b) => a.seq - b.seq);
  if (!entry.isBootstrap) {
    viewer.buffer.push(entry);
    viewer.buffer.sort((a, b) => a.seq - b.seq);
    viewer.buffer = viewer.buffer.filter((item) => item.seq > (viewer.current?.seq || 0));
  }
  viewer.chunksReceived = viewer.received.length;
  viewer.lastReceivedAt = now();
  if (!viewer.current && entry.payload?.kind === "media-segment") {
    viewer.current = entry;
  }
  if (entry.payload?.kind === "media-segment") {
    enqueueMseSegment(entry);
  }
}

function tickPlayback() {
  if (!viewer.streamId) return;
  if (viewer.paused) {
    applyViewerConnectionStatus();
    renderViewer();
    return;
  }
  if (msePlayer.mediaSource) {
    tickMsePlayback();
    renderViewer();
    return;
  }
  if (!viewer.current && shouldStartPlayback()) {
    viewer.current = viewer.buffer.shift();
    viewer.progress = 0;
    viewer.chunksPlayed += 1;
  } else if (viewer.current) {
    const durationMs = Number(viewer.current.durationMs || CHUNK_DURATION_MS);
    viewer.progress += (500 / Math.max(250, durationMs)) * 100;
    if (viewer.progress >= 100) {
      const next = viewer.buffer[0] || null;
      if (next && isEntryReadyForPlayback(next)) {
        viewer.current = viewer.buffer.shift();
        viewer.progress = 0;
        viewer.chunksPlayed += 1;
      } else if (next) {
        viewer.progress = 96;
        setViewerStatus("buffering");
      } else {
        viewer.progress = 100;
      }
    }
  }
  if (isViewerOffline()) {
    setViewerStatus("offline");
  } else if (isViewerTailWaiting()) {
    setViewerStatus("buffering");
  } else if (viewer.buffer.length || viewer.current) {
    setViewerStatus("live");
  } else if (isViewerConnectionLost()) {
    setViewerStatus("stalled");
  } else if (viewer.streamId) {
    setViewerStatus("buffering");
  }
  applyViewerConnectionStatus();
  renderViewer();
}

function shouldStartPlayback() {
  if (!viewer.buffer.length) return false;
  if (viewer.buffer.length >= VIEWER_START_BUFFER_SEGMENTS && isEntryReadyForPlayback(viewer.buffer[0])) return true;
  return viewer.lastReceivedAt && now() - viewer.lastReceivedAt > VIEWER_LIVE_WINDOW_SECONDS * 1000;
}

function isEntryReadyForPlayback(entry) {
  if (entry?.payload?.kind !== "media-segment") return true;
  const seq = String(entry.seq);
  const active = activeVideoElement();
  const inactive = inactiveVideoElement();
  return (
    (active.dataset.seq === seq && active.readyState >= 2) ||
    (inactive.dataset.seq === seq && inactive.readyState >= 2)
  );
}

function setViewerStatus(status) {
  const allowed = new Set(["idle", "connecting", "buffering", "stalled", "live", "offline"]);
  viewer.status = allowed.has(status) ? status : "live";
}

function viewerNoNewsAgeMs() {
  const reference = Number(viewer.lastReceivedAt || viewer.startedWatchingAt || 0);
  return reference ? now() - reference : 0;
}

function isViewerConnectionLost() {
  return viewerNoNewsAgeMs() >= CONNECTION_LOST_MS;
}

function applyViewerConnectionStatus() {
  if (!viewer.streamId) return;
  syncViewerLiveState();
  if (isViewerOffline()) {
    setViewerStatus("offline");
  } else if (isViewerTailWaiting()) {
    setViewerStatus("buffering");
  } else if (isViewerConnectionLost()) {
    setViewerStatus("stalled");
  }
}

function syncViewerLiveState() {
  if (!viewer.streamId) return;
  const live = readState().discoveredLives.find((item) => item.streamId === viewer.streamId);
  if (!live) return;
  const wasOffline = String(viewer.live?.status || "").toUpperCase() === "OFFLINE";
  viewer.live = { ...viewer.live, ...live };
  const isOffline = String(live.status || "").toUpperCase() === "OFFLINE";
  if (isOffline && !wasOffline && !viewer.offlineDetectedAt) viewer.offlineDetectedAt = now();
  if (!isOffline) viewer.offlineDetectedAt = 0;
}

function isViewerDeclaredOffline() {
  return String(viewer.live?.status || "").toUpperCase() === "OFFLINE";
}

function isViewerTailWaiting() {
  if (!viewer.streamId || isViewerOffline()) return false;
  if (msePlayer.started && hasViewerMseRunway(1)) return false;
  if (isViewerDeclaredOffline()) return true;
  return viewerNoNewsAgeMs() >= Math.max(MEDIA_SEGMENT_MS * 2, CHUNK_DURATION_MS);
}

function hasViewerMseRunway(minSeconds) {
  const video = els["current-frame-video-a"];
  if (!video || !msePlayer.mediaSource) return false;
  const timeline = getTimelineState();
  return Math.max(bufferedAhead(video), timeline.behindLive) >= minSeconds;
}

function isViewerOffline() {
  if (!viewer.streamId) return false;
  if (isViewerDeclaredOffline()) {
    const detectedAt = Number(viewer.offlineDetectedAt || viewer.lastReceivedAt || viewer.startedWatchingAt || now());
    return now() - detectedAt >= OFFLINE_SETTLE_MS;
  }
  return viewerNoNewsAgeMs() >= CONNECTIVITY_ISSUE_MS;
}

function renderAll() {
  renderStudio();
  renderViewer();
}

function renderStudio() {
  if (!els["studio-state"]) return;
  els["studio-state"].textContent = currentLive ? "live" : "idle";
  els["studio-chunks"].textContent = currentLive ? String(currentLive.seq) : "0";
  els["studio-window"].textContent = currentLive?.windowCid ? shortAddress(currentLive.windowCid) : "none";
  els["studio-source"].textContent = currentLive ? captureMode : "none";
  els["studio-source"].title = captureIssue || "";
  els["stop-live"].disabled = !currentLive;
  els["start-live"].disabled = Boolean(currentLive);
  const link = currentLive?.stableLinkUrl || "";
  if (els["studio-live-link"]) els["studio-live-link"].value = link;
  els["studio-live-link-card"]?.classList.toggle("is-hidden", !link);
}

function renderViewer() {
  if (!els["player-title"]) return;
  applyViewerConnectionStatus();
  const offline = isViewerOffline();
  const current = viewer.current;
  const waiting = shouldShowViewerSpinner(offline, current);
  els["player-title"].textContent = viewer.live?.title || "Lumen Live Player";
  if (els["viewer-description"]) {
    els["viewer-description"].textContent = viewer.live?.description || "No description provided.";
  }
  renderViewerSpinner(waiting);
  if (offline) {
    els["current-frame"].textContent = "This live is offline.";
    renderOfflineScreen();
    renderTimelineControls();
    renderVolumeControls();
    renderPlaybackControls();
    renderWaveform(null);
    return;
  }
  hideOfflineScreen();
  els["current-frame"].textContent = current ? "" : "Waiting for video";
  renderScreenFrame(current?.payload);
  renderMediaSegment(current?.payload);
  els["play-progress"].style.width = `${Math.min(100, viewer.progress)}%`;
  renderTimelineControls();
  renderVolumeControls();
  renderPlaybackControls();
  renderWaveform(current?.payload);
  const player = document.querySelector(".fake-player");
  if (player && current?.payload?.color) {
    player.style.background = `linear-gradient(rgba(23,32,42,.62),rgba(23,32,42,.32)), linear-gradient(135deg, #17202a 0%, ${current.payload.color} 60%, #f5a524 100%)`;
  }
}

function renderViewerSpinner(visible) {
  els["viewer-spinner"]?.classList.toggle("is-hidden", !visible);
}

function shouldShowViewerSpinner(offline, current) {
  if (offline || !viewer.streamId) return false;
  if (viewer.paused) return false;
  if (isViewerTailWaiting()) return true;
  if (msePlayer.started && bufferedAhead(els["current-frame-video-a"]) > 0.25) return false;
  return viewer.status === "connecting" || viewer.status === "buffering" || viewer.status === "stalled";
}

function renderWaveform(payload) {
  if (payload?.kind === "screen-frame" || payload?.kind === "media-segment") {
    els["waveform"].innerHTML = "";
    return;
  }
  const values = Array.isArray(payload?.waveform) ? payload.waveform : [];
  els["waveform"].innerHTML = values.map((value) => `<span style="height:${Math.max(6, value / 2)}px"></span>`).join("");
}

function renderScreenFrame(payload) {
  const image = els["current-frame-image"];
  if (payload?.kind === "screen-frame" && payload.imageDataUrl) {
    image.src = payload.imageDataUrl;
    image.classList.add("is-visible");
    els["current-frame"].textContent = "";
  } else {
    image.removeAttribute("src");
    image.classList.remove("is-visible");
  }
}

function renderMediaSegment(payload) {
  const stage = els["media-stage"];
  if (payload?.kind === "media-segment" && payload.dataUrl) {
    hideViewerPoster();
    stage.classList.add("is-visible");
    els["current-frame-video-a"].classList.add("is-visible");
    els["current-frame-video-b"].classList.remove("is-visible");
    els["current-frame"].textContent = "";
  } else if (msePlayer.mediaSource || msePlayer.queue.length || msePlayer.appendedCount > 0) {
    hideViewerPoster();
    stage.classList.add("is-visible");
    els["current-frame-video-a"].classList.add("is-visible");
    els["current-frame-video-b"].classList.remove("is-visible");
  } else {
    resetMediaSegmentPlayer();
  }
}

function isRealVideoFrameVisible() {
  const video = els["current-frame-video-a"];
  return Boolean(
    msePlayer.mediaSource &&
    video &&
    (msePlayer.started || msePlayer.appendedCount > 0) &&
    video.readyState >= 2 &&
    !video.seeking
  );
}

function hideViewerPoster(clearKey = true) {
  const image = els["media-poster-image"];
  stopViewerPosterAnimation(clearKey);
  if (!image) return;
  image.removeAttribute("src");
  image.classList.remove("is-visible");
}

function posterFramesForPayload(payload) {
  const frames = Array.isArray(payload?.posterFrames)
    ? payload.posterFrames.map((item) => String(item || "")).filter(Boolean)
    : [];
  const single = String(payload?.posterDataUrl || "");
  if (single && !frames.includes(single)) frames.push(single);
  if (frames.length) return frames;
  const latest = latestViewerPosterFrames();
  return latest.length ? latest : [];
}

function freezeViewerPoster(payload, frames) {
  const image = els["media-poster-image"];
  if (!image || !frames.length) return;
  stopViewerPosterAnimation(false);
  viewerPosterKey = viewerPosterFrameKey(payload, frames);
  viewerPosterIndex = posterFrameIndexForCurrentTime(payload, frames);
  image.src = frames[viewerPosterIndex] || frames[frames.length - 1];
}

function viewerPosterFrameKey(payload, frames) {
  return `${payload?.seq || viewer.current?.seq || "latest"}:${frames.length}:${frames[0].slice(0, 48)}`;
}

function posterFrameIndexForCurrentTime(payload, frames) {
  if (!frames.length) return 0;
  const durationSeconds = Math.max(0.1, Number(payload?.durationMs || MEDIA_SEGMENT_MS) / 1000);
  const video = els["current-frame-video-a"];
  const mediaTime = Number(video?.currentTime || 0);
  const ratio = msePlayer.mediaSource && Number.isFinite(mediaTime)
    ? (mediaTime % durationSeconds) / durationSeconds
    : clamp(Number(viewer.progress || 0) / 100, 0, 1);
  return Math.max(0, Math.min(frames.length - 1, Math.floor(ratio * frames.length)));
}

function stopViewerPosterAnimation(clearKey = true) {
  if (clearKey) viewerPosterKey = "";
}

function latestViewerPosterFrames() {
  for (let index = viewer.received.length - 1; index >= 0; index -= 1) {
    const payload = viewer.received[index]?.payload;
    const frames = Array.isArray(payload?.posterFrames)
      ? payload.posterFrames.map((item) => String(item || "")).filter(Boolean)
      : [];
    const single = String(payload?.posterDataUrl || "");
    if (single && !frames.includes(single)) frames.push(single);
    if (frames.length) return frames;
  }
  return [];
}

function latestViewerPosterDataUrl() {
  return latestViewerPosterFrames()[0] || "";
}

function renderOfflineScreen() {
  const image = els["offline-screen-image"];
  const stage = els["media-stage"];
  if (stage) stage.classList.remove("is-visible");
  els["media-poster-image"]?.classList.remove("is-visible");
  els["current-frame-image"]?.classList.remove("is-visible");
  if (viewer.offlineImageDataUrl && image) {
    image.src = viewer.offlineImageDataUrl;
    image.classList.add("is-visible");
  } else if (image) {
    image.removeAttribute("src");
    image.classList.remove("is-visible");
  }
  activeVideoElement()?.pause?.();
  getAudioElement()?.pause?.();
}

function hideOfflineScreen() {
  const image = els["offline-screen-image"];
  if (!image) return;
  image.classList.remove("is-visible");
}

function renderPlaybackControls() {
  if (els["viewer-pause"]) els["viewer-pause"].textContent = viewer.paused ? "Start" : "Pause";
}

function renderTimelineControls() {
  const timeline = getTimelineState();
  const input = els["viewer-timeline"];
  const displayCurrent = timeline.current;
  input.min = String(Math.max(0, timeline.windowStart));
  input.max = String(Math.max(0, timeline.playableEnd));
  if (!viewer.timelineSeeking) input.value = String(clamp(displayCurrent, timeline.windowStart, timeline.playableEnd));
  input.disabled = timeline.windowDuration <= 0;
  els["viewer-timecode"].textContent = `${formatDuration(displayCurrent)} / ${formatDuration(timeline.duration)}`;
  els["viewer-go-live"].disabled = timeline.windowDuration <= 0 || timeline.atTargetDelay;
}

function renderVolumeControls() {
  const video = els["current-frame-video-a"];
  if (!els["viewer-volume"]) return;
  const volume = clamp(viewerVolume, 0, 1);
  const localMonitorMuted = shouldMuteLocalMonitor();
  const effectiveMuted = viewerMuted || localMonitorMuted;
  els["viewer-volume"].value = String(volume);
  els["viewer-volume"].disabled = localMonitorMuted;
  els["viewer-volume-label"].textContent = effectiveMuted
    ? localMonitorMuted ? "Local monitor muted" : "Muted"
    : `${Math.round(volume * 100)}%`;
  els["viewer-mute"].textContent = localMonitorMuted ? "Monitor muted" : effectiveMuted ? "Unmute" : "Mute";
  els["viewer-mute"].disabled = localMonitorMuted;
  if (video) {
    if (!viewerFullscreenControlsActive || !video.classList.contains("viewer-controls-hidden")) {
      video.controls = true;
      video.setAttribute("controls", "");
    }
    setNativeVideoVolume(video, effectiveMuted, volume);
  }
  const audio = getAudioElement();
  if (audio) {
    audio.muted = effectiveMuted;
    audio.volume = volume;
  }
}

function setNativeVideoVolume(video, muted, volume) {
  if (!video) return;
  syncingNativeVideoAudio = true;
  try {
    const safeVolume = clamp(volume, 0, 1);
    if (Math.abs(Number(video.volume || 0) - safeVolume) > 0.01) video.volume = safeVolume;
    if (video.muted !== Boolean(muted)) video.muted = Boolean(muted);
  } finally {
    window.setTimeout(() => {
      syncingNativeVideoAudio = false;
    }, 0);
  }
}

function onNativeVideoVolumeChange(event) {
  if (syncingNativeVideoAudio) return;
  const video = event.currentTarget;
  const localMonitorMuted = shouldMuteLocalMonitor();
  viewerVolume = clamp(Number(video.volume || 0), 0, 1);
  viewerMuted = video.muted || viewerVolume <= 0;
  localStorage.setItem("lumen-live-v2-volume", String(viewerVolume));
  localStorage.setItem("lumen-live-v2-muted", viewerMuted ? "1" : "0");
  const audio = getAudioElement();
  audio.muted = viewerMuted || localMonitorMuted;
  audio.volume = viewerVolume;
  renderVolumeControls();
}

function onNativeVideoPlay() {
  if (!msePlayer.mediaSource || !viewer.streamId) return;
  viewer.paused = false;
  viewer.status = "live";
  maybeStartAudioPlayback();
  renderPlaybackControls();
}

function onNativeVideoPause(event) {
  if (!msePlayer.mediaSource || !viewer.streamId) return;
  const video = event.currentTarget;
  if (video.seeking) return;
  viewer.paused = true;
  viewer.followLiveEdge = false;
  getAudioElement()?.pause?.();
  renderPlaybackControls();
}

function onNativeVideoSeeking(event) {
  if (!msePlayer.mediaSource || !viewer.streamId) return;
  viewer.timelineSeeking = true;
  viewer.followLiveEdge = false;
  getAudioElement()?.pause?.();
  const timeline = getTimelineState(Number(event.currentTarget.currentTime || 0));
  if (els["viewer-timecode"]) {
    els["viewer-timecode"].textContent = `${formatDuration(timeline.current)} / ${formatDuration(timeline.duration)}`;
  }
}

function onNativeVideoSeeked(event) {
  if (!msePlayer.mediaSource || !viewer.streamId) return;
  const video = event.currentTarget;
  const audio = getAudioElement();
  try {
    if (audio.readyState > 0) audio.currentTime = video.currentTime;
  } catch {
    // ignore MSE seek races
  }
  viewer.timelineSeeking = false;
  viewer.paused = video.paused;
  if (!video.paused) {
    maybeStartAudioPlayback();
    syncAudioPlayback(video);
  }
  tickMsePlayback();
  renderViewer();
}

function toggleViewerMute() {
  viewerMuted = !viewerMuted;
  localStorage.setItem("lumen-live-v2-muted", viewerMuted ? "1" : "0");
  applyViewerAudioSettings();
}

function onViewerVolumeInput(event) {
  viewerVolume = clamp(Number(event.currentTarget.value || 0), 0, 1);
  if (viewerVolume > 0) viewerMuted = false;
  localStorage.setItem("lumen-live-v2-volume", String(viewerVolume));
  localStorage.setItem("lumen-live-v2-muted", viewerMuted ? "1" : "0");
  applyViewerAudioSettings();
}

function applyViewerAudioSettings() {
  renderVolumeControls();
  const video = els["current-frame-video-a"];
  if (video && msePlayer.started && !viewer.paused) video.play().catch(() => {});
  const audio = getAudioElement();
  if (audio && audioMsePlayer.started && !viewer.paused) audio.play().catch(() => {});
}

function toggleViewerPause() {
  viewer.paused = !viewer.paused;
  const video = els["current-frame-video-a"];
  const audio = getAudioElement();
  if (viewer.paused) {
    viewer.followLiveEdge = false;
    video?.pause?.();
    audio?.pause?.();
    if (isRealVideoFrameVisible()) {
      hideViewerPoster();
    } else {
      const frames = posterFramesForPayload(viewer.current?.payload);
      if (frames.length) freezeViewerPoster(viewer.current?.payload, frames);
    }
  } else {
    video?.play?.().catch(() => {});
    audio?.play?.().catch(() => {});
  }
  renderPlaybackControls();
  renderViewer();
}

async function toggleViewerFullscreen(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (isViewerPlayerFullscreen()) {
    await exitViewerFullscreen();
    return;
  }
  if (viewerWindowFullscreen) {
    await setViewerWindowFullscreen(false);
    return;
  }
  if (await requestViewerPlayerFullscreen()) return;
  await setViewerWindowFullscreen(!viewerWindowFullscreen);
}

async function setViewerWindowFullscreen(active) {
  viewerWindowFullscreen = Boolean(active);
  renderFullscreenButton();
  const result = await adapter.setWindowFullscreen(viewerWindowFullscreen);
  if (result?.ok === false) {
    console.warn("Viewer window fullscreen failed", result);
    viewerWindowFullscreen = false;
  } else if (typeof result?.active === "boolean") {
    viewerWindowFullscreen = result.active;
  }
  renderFullscreenButton();
}

async function requestViewerPlayerFullscreen() {
  const video = els["current-frame-video-a"];
  const stage = els["media-stage"];
  if (!video || !video.classList.contains("is-visible")) return false;
  video.controls = true;
  const targets = [stage, video].filter(Boolean);
  try {
    let requested = false;
    for (const target of targets) {
      const request =
        target.requestFullscreen ||
        target.webkitRequestFullscreen ||
        target.mozRequestFullScreen ||
        target.msRequestFullscreen ||
        target.webkitEnterFullscreen;
      if (typeof request !== "function") continue;
      await Promise.resolve(request.call(target));
      requested = true;
      break;
    }
    if (!requested) return false;
    viewerWindowFullscreen = true;
    enterViewerFullscreenControlsMode();
    renderFullscreenButton();
    return true;
  } catch (error) {
    console.warn("Viewer player fullscreen failed", error);
    return false;
  }
}

async function exitViewerFullscreen() {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.mozCancelFullScreen ||
    document.msExitFullscreen;
  if (isDocumentFullscreen() && typeof exit === "function") {
    try {
      await Promise.resolve(exit.call(document));
      return;
    } catch (error) {
      console.warn("Viewer video fullscreen exit failed", error);
    }
  }
  if (viewerWindowFullscreen) await setViewerWindowFullscreen(false);
}

function fullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function isDocumentFullscreen() {
  return Boolean(fullscreenElement());
}

function isViewerPlayerFullscreen() {
  const element = fullscreenElement();
  const video = els["current-frame-video-a"];
  const stage = els["media-stage"];
  return Boolean(element && (element === video || element === stage));
}

function syncViewerFullscreenState() {
  if (isViewerPlayerFullscreen()) {
    viewerWindowFullscreen = true;
    enterViewerFullscreenControlsMode();
  } else {
    leaveViewerFullscreenControlsMode();
    if (!isDocumentFullscreen()) viewerWindowFullscreen = false;
  }
  renderFullscreenButton();
}

function enterViewerFullscreenControlsMode() {
  if (viewerFullscreenControlsActive) {
    showViewerFullscreenControls();
    return;
  }
  viewerFullscreenControlsActive = true;
  addViewerFullscreenActivityListeners();
  showViewerFullscreenControls();
}

function leaveViewerFullscreenControlsMode() {
  if (viewerFullscreenControlsActive) {
    removeViewerFullscreenActivityListeners();
  }
  viewerFullscreenControlsActive = false;
  clearViewerFullscreenControlsTimer();
  const video = els["current-frame-video-a"];
  const stage = els["media-stage"];
  stage?.classList.remove("viewer-controls-hidden");
  video?.classList.remove("viewer-controls-hidden");
  if (video?.classList.contains("is-visible")) {
    video.controls = true;
    video.setAttribute("controls", "");
  }
}

function addViewerFullscreenActivityListeners() {
  if (window.PointerEvent) {
    document.addEventListener("pointermove", onViewerFullscreenActivity, VIEWER_FULLSCREEN_ACTIVITY_OPTIONS);
    document.addEventListener("pointerdown", onViewerFullscreenActivity, VIEWER_FULLSCREEN_ACTIVITY_OPTIONS);
  } else {
    document.addEventListener("mousemove", onViewerFullscreenActivity, VIEWER_FULLSCREEN_ACTIVITY_OPTIONS);
    document.addEventListener("mousedown", onViewerFullscreenActivity, VIEWER_FULLSCREEN_ACTIVITY_OPTIONS);
  }
  document.addEventListener("wheel", onViewerFullscreenActivity, VIEWER_FULLSCREEN_ACTIVITY_OPTIONS);
  document.addEventListener("touchstart", onViewerFullscreenActivity, VIEWER_FULLSCREEN_ACTIVITY_OPTIONS);
  document.addEventListener("keydown", onViewerFullscreenKeydown, true);
}

function removeViewerFullscreenActivityListeners() {
  document.removeEventListener("pointermove", onViewerFullscreenActivity, true);
  document.removeEventListener("pointerdown", onViewerFullscreenActivity, true);
  document.removeEventListener("mousemove", onViewerFullscreenActivity, true);
  document.removeEventListener("mousedown", onViewerFullscreenActivity, true);
  document.removeEventListener("wheel", onViewerFullscreenActivity, true);
  document.removeEventListener("touchstart", onViewerFullscreenActivity, true);
  document.removeEventListener("keydown", onViewerFullscreenKeydown, true);
}

function onViewerFullscreenKeydown(event) {
  onViewerFullscreenActivity(event);
  if (event.key !== "Escape") return;
  exitViewerFullscreen();
}

function onViewerFullscreenActivity(event) {
  if (!viewerFullscreenControlsActive) return;
  showViewerFullscreenControls();
}

function showViewerFullscreenControls() {
  if (!viewerFullscreenControlsActive) return;
  const video = els["current-frame-video-a"];
  const stage = els["media-stage"];
  if (!video) return;
  video.controls = true;
  video.setAttribute("controls", "");
  stage?.classList.remove("viewer-controls-hidden");
  video.classList.remove("viewer-controls-hidden");
  scheduleViewerFullscreenControlsHide();
}

function scheduleViewerFullscreenControlsHide(delay = VIEWER_FULLSCREEN_CONTROLS_IDLE_MS) {
  clearViewerFullscreenControlsTimer();
  viewerFullscreenControlsTimer = window.setTimeout(() => {
    hideViewerFullscreenControls();
  }, delay);
}

function hideViewerFullscreenControls() {
  if (!viewerFullscreenControlsActive) return;
  const video = els["current-frame-video-a"];
  const stage = els["media-stage"];
  if (!video) return;
  video.controls = false;
  video.removeAttribute("controls");
  stage?.classList.add("viewer-controls-hidden");
  video.classList.add("viewer-controls-hidden");
}

function clearViewerFullscreenControlsTimer() {
  if (!viewerFullscreenControlsTimer) return;
  window.clearTimeout(viewerFullscreenControlsTimer);
  viewerFullscreenControlsTimer = null;
}

function renderFullscreenButton() {
  if (els["viewer-fullscreen"]) {
    els["viewer-fullscreen"].textContent = viewerWindowFullscreen ? "Exit fullscreen" : "Fullscreen";
  }
}

function shouldMuteLocalMonitor() {
  if (!viewer.streamId) return false;
  const localStream = readState().activeStreams?.[viewer.streamId];
  return localStream?.status === "LIVE";
}

function onTimelineInput(event) {
  viewer.timelineSeeking = true;
  viewer.followLiveEdge = false;
  const value = Number(event.currentTarget.value || 0);
  const timeline = getTimelineState(value);
  els["viewer-timecode"].textContent = `${formatDuration(value)} / ${formatDuration(timeline.duration)}`;
}

function onTimelineCommit(event) {
  seekTimeline(Number(event.currentTarget.value || 0), { followLiveEdge: false });
}

function seekTimeline(seconds, options = {}) {
  const video = els["current-frame-video-a"];
  const audio = getAudioElement();
  const timeline = getTimelineState();
  if (!video || !msePlayer.mediaSource || timeline.windowDuration <= 0) {
    viewer.timelineSeeking = false;
    return;
  }
  const target = clamp(seconds, Math.max(0, timeline.windowStart), Math.max(0, timeline.playableEnd));
  viewer.followLiveEdge = Boolean(options.followLiveEdge);
  try {
    video.currentTime = target;
    if (audio && audio.readyState > 0) audio.currentTime = target;
    if (msePlayer.started && !viewer.paused) video.play().catch(() => {});
    if (audioMsePlayer.started && !viewer.paused) audio?.play().catch(() => {});
  } catch (error) {
    console.warn("Timeline seek failed", error);
  }
  viewer.timelineSeeking = false;
  if (!options.silent) {
    tickMsePlayback();
    renderViewer();
  }
}

function seekToLiveEdge() {
  const timeline = getTimelineState();
  seekTimeline(timeline.windowStart, { followLiveEdge: true });
}

function viewerWindowStart(duration) {
  return Math.max(0, Number(duration || 0) - VIEWER_LIVE_WINDOW_SECONDS);
}

function hasMseStartupBuffer(timeline) {
  return Number(timeline?.windowDuration || 0) >= VIEWER_LIVE_WINDOW_SECONDS;
}

function seekMseToWindowStart(video, timeline) {
  if (!video || !timeline || timeline.duration <= 0) return;
  const target = timeline.windowStart;
  if (Math.abs(Number(video.currentTime || 0) - target) <= 0.25) return;
  try {
    video.currentTime = target;
    const audio = getAudioElement();
    if (audio?.readyState > 0) audio.currentTime = target;
  } catch (error) {
    console.warn("Viewer live-window seek failed", error);
  }
}

function resetMediaSegmentPlayer() {
  stopViewerPosterAnimation();
  els["media-stage"]?.classList.remove("is-visible");
  els["media-stage"]?.classList.remove("video-playing");
  els["media-poster-image"]?.classList.remove("is-visible");
  els["media-poster-image"]?.removeAttribute("src");
  ["current-frame-video-a", "current-frame-video-b"].forEach((id) => {
    const video = els[id];
    if (!video) return;
    video.pause();
    video.oncanplay = null;
    video.onerror = null;
    video.controls = false;
    video.classList.remove("is-visible");
    video.removeAttribute("src");
    video.dataset.seq = "";
    video.load();
  });
  if (msePlayer.objectUrl) {
    URL.revokeObjectURL(msePlayer.objectUrl);
  }
  if (mseProcessTimer) {
    window.clearTimeout(mseProcessTimer);
    mseProcessTimer = null;
  }
  msePlayer = createEmptyMsePlayer();
  resetAudioMsePlayer();
}

async function enqueueMseSegment(entry) {
  if (!entry?.payload?.dataUrl) return;
  if (Number(entry.payload.audio?.tracks || 0) > 0 && entry.payload.mediaPipeline !== "split-av-v1") {
    console.warn("Skipping legacy muxed A/V segment", { seq: entry.seq, mimeType: entry.payload.mimeType });
    return;
  }
  if (!ensureMsePlayer(entry.payload)) return;
  const seq = String(entry.seq);
  if (msePlayer.appendedSeqs.has(seq) || msePlayer.queue.some((item) => item.seq === seq)) return;
  try {
    const buffer = await dataUrlToArrayBuffer(entry.payload.dataUrl);
    msePlayer.queue.push({
      seq,
      buffer,
      durationMs: entry.durationMs || CHUNK_DURATION_MS,
      isInit: Boolean(entry.payload.isInit || entry.isBootstrap)
    });
    msePlayer.queue.sort((a, b) => Number(a.seq) - Number(b.seq));
    scheduleMseQueue();
  } catch (error) {
    console.warn("Could not queue MSE segment", error);
  }
  if (entry.payload.audioSegment?.dataUrl) {
    enqueueAudioMseSegment(entry);
  }
}

function ensureMsePlayer(payload) {
  if (!window.MediaSource) return false;
  const selectedMime = selectMseMimeType(payload);
  if (!selectedMime) return false;
  if (msePlayer.mediaSource) return true;

  const video = els["current-frame-video-a"];
  const hidden = els["current-frame-video-b"];
  hidden.classList.remove("is-visible");
  hidden.removeAttribute("src");
  msePlayer = createEmptyMsePlayer();
  msePlayer.mimeType = selectedMime;
  msePlayer.mediaSource = new MediaSource();
  msePlayer.objectUrl = URL.createObjectURL(msePlayer.mediaSource);
  video.src = msePlayer.objectUrl;
  video.playsInline = false;
  video.removeAttribute("playsinline");
  video.removeAttribute("controlslist");
  video.preload = "auto";
  video.controls = true;
  video.setAttribute("controls", "");
  setNativeVideoVolume(video, viewerMuted || shouldMuteLocalMonitor(), viewerVolume);
  video.addEventListener("waiting", () => {
    viewer.status = "buffering";
    els["media-stage"]?.classList.remove("video-playing");
  }, { passive: true });
  video.addEventListener("seeking", () => {
    els["media-stage"]?.classList.remove("video-playing");
  }, { passive: true });
  video.addEventListener("playing", () => {
    viewer.status = "live";
    els["media-stage"]?.classList.add("video-playing");
  }, { passive: true });
  video.addEventListener("timeupdate", () => {
    if (!video.paused && !video.seeking && video.readyState >= 3) {
      els["media-stage"]?.classList.add("video-playing");
    }
  }, { passive: true });
  video.addEventListener("error", () => {
    console.warn("Viewer video error", video.error);
    els["media-stage"]?.classList.remove("video-playing");
  }, { passive: true });
  video.classList.add("is-visible");
  renderVolumeControls();
  els["media-stage"].classList.add("is-visible");
  msePlayer.mediaSource.addEventListener("sourceopen", () => {
    if (msePlayer.sourceBuffer) return;
    msePlayer.open = true;
    msePlayer.sourceBuffer = msePlayer.mediaSource.addSourceBuffer(selectedMime);
    msePlayer.sourceBuffer.mode = "sequence";
    msePlayer.sourceBuffer.addEventListener("updateend", () => {
      msePlayer.appending = false;
      updateNativeVideoDuration();
      if (pruneMseLiveWindow()) return;
      maybeStartMsePlayback();
      scheduleMseQueue(0);
    });
    scheduleMseQueue();
  });
  return true;
}

function scheduleMseQueue(delay = MSE_QUEUE_PREROLL_MS) {
  if (mseProcessTimer) return;
  mseProcessTimer = window.setTimeout(processMseQueue, delay);
}

function processMseQueue() {
  mseProcessTimer = null;
  if (
    !msePlayer.open ||
    !msePlayer.sourceBuffer ||
    msePlayer.sourceBuffer.updating ||
    msePlayer.appending ||
    msePlayer.mediaSource?.readyState !== "open"
  ) return;
  const next = takeNextMseSegment();
  if (!next) {
    maybeStartMsePlayback();
    return;
  }
  try {
    msePlayer.appending = true;
    msePlayer.sourceBuffer.appendBuffer(next.buffer);
    msePlayer.appendedSeqs.add(String(next.seq));
    msePlayer.appendedCount += 1;
  } catch (error) {
    msePlayer.appending = false;
    console.warn("MSE append failed", {
      name: error?.name || "",
      message: error?.message || String(error || ""),
      mimeType: msePlayer.mimeType,
      seq: next.seq,
      isInit: next.isInit,
      appendedCount: msePlayer.appendedCount,
      queue: msePlayer.queue.length,
      mediaSourceState: msePlayer.mediaSource?.readyState || ""
    });
    scheduleMseQueue(250);
  }
}

function takeNextMseSegment() {
  if (!msePlayer.queue.length) return null;
  if (msePlayer.appendedCount > 0) return msePlayer.queue.shift();

  const initIndex = msePlayer.queue.findIndex((item) => item.isInit || Number(item.seq) === 1);
  if (initIndex >= 0) {
    return msePlayer.queue.splice(initIndex, 1)[0];
  }

  scheduleMseQueue(250);
  return null;
}

function maybeStartMsePlayback() {
  const video = els["current-frame-video-a"];
  const timeline = getTimelineState();
  if (!hasMseStartupBuffer(timeline)) {
    setViewerStatus("buffering");
    return;
  }
  if (!msePlayer.started) {
    msePlayer.started = true;
    seekMseToWindowStart(video, timeline);
    viewer.status = "live";
  }
  viewer.status = "live";
  if (video.playbackRate !== 1) video.playbackRate = 1;
  if (!viewer.paused && video.paused && !video.ended) {
    video.play().catch(() => {
      viewerMuted = true;
      localStorage.setItem("lumen-live-v2-muted", "1");
      renderVolumeControls();
      if (!viewer.paused) video.play().catch(() => {});
    });
  }
  if (!viewer.paused) maybeStartAudioPlayback();
}

function tickMsePlayback() {
  const video = els["current-frame-video-a"];
  if (!msePlayer.started) {
    maybeStartMsePlayback();
    if (!msePlayer.started) {
      setViewerStatus("buffering");
      viewer.progress = 0;
      return;
    }
  }
  const timeline = getTimelineState();
  if (isViewerOffline()) {
    setViewerStatus("offline");
    renderViewerSpinner(false);
    return;
  }
  if (isViewerTailWaiting()) {
    setViewerStatus("buffering");
  }
  if (viewer.paused) {
    setViewerStatus(isViewerOffline() ? "offline" : "live");
    return;
  }
  if (isViewerTailWaiting()) {
    setViewerStatus("buffering");
  } else if (!video.paused && video.readyState >= 2) {
    setViewerStatus("live");
  } else if (bufferedAhead(video) > 0.75) {
    video.play().catch(() => {});
    setViewerStatus("live");
  } else if (isViewerConnectionLost()) {
    setViewerStatus("live");
  } else {
    setViewerStatus("live");
  }
  applyViewerConnectionStatus();
  viewer.progress = ((video.currentTime % (MEDIA_SEGMENT_MS / 1000)) / (MEDIA_SEGMENT_MS / 1000)) * 100;
  viewer.chunksPlayed = Math.max(viewer.chunksPlayed, Math.floor(video.currentTime));
  const playable = viewer.received.filter((entry) => entry.payload?.kind === "media-segment");
  const segmentIndex = Math.max(0, Math.min(playable.length - 1, Math.floor(video.currentTime / (MEDIA_SEGMENT_MS / 1000))));
  viewer.current = playable[segmentIndex] || viewer.current || viewer.received[viewer.received.length - 1];
  syncAudioPlayback(video);
}

function getTimelineState(overrideCurrent = null) {
  const video = els["current-frame-video-a"];
  const bufferedEnd = getBufferedEnd(video);
  const mediaSegments = viewer.received.filter((entry) => entry.payload?.kind === "media-segment").length;
  const estimatedDuration = mediaSegments * (MEDIA_SEGMENT_MS / 1000);
  const duration = msePlayer.mediaSource
    ? Math.max(bufferedEnd, 0)
    : Math.max(bufferedEnd, estimatedDuration, 0);
  const windowStart = viewerWindowStart(duration);
  const playableEnd = Math.max(windowStart, duration);
  const current = clamp(overrideCurrent ?? Number(video?.currentTime || 0), windowStart, playableEnd || duration);
  const behindPlayableEdge = Math.max(0, playableEnd - current);
  const behindLive = Math.max(0, duration - current);
  return {
    current,
    duration,
    windowStart,
    windowDuration: Math.max(0, playableEnd - windowStart),
    playableEnd,
    behindLive,
    behindPlayableEdge,
    atLiveEdge: playableEnd <= 0 || behindPlayableEdge <= LIVE_EDGE_GAP_SECONDS,
    atTargetDelay: Math.abs(current - windowStart) <= LIVE_EDGE_GAP_SECONDS
  };
}

function getBufferedEnd(video) {
  if (!video?.buffered?.length) return 0;
  let end = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    end = Math.max(end, video.buffered.end(index));
  }
  return end;
}

function updateNativeVideoDuration() {
  const video = els["current-frame-video-a"];
  const mediaSource = msePlayer.mediaSource;
  if (!video || !mediaSource || mediaSource.readyState !== "open" || msePlayer.sourceBuffer?.updating) return;
  const bufferedEnd = getBufferedEnd(video);
  const estimatedEnd = msePlayer.appendedCount * (MEDIA_SEGMENT_MS / 1000);
  const duration = Math.max(bufferedEnd, estimatedEnd, 0);
  if (duration <= 0) return;
  try {
    if (!Number.isFinite(mediaSource.duration) || Math.abs(mediaSource.duration - duration) > 0.25) {
      mediaSource.duration = duration;
    }
  } catch {
    // Chromium can reject duration updates while it is reconciling buffered ranges.
  }
}

function pruneMseLiveWindow() {
  const video = els["current-frame-video-a"];
  const sourceBuffer = msePlayer.sourceBuffer;
  if (!video || !sourceBuffer || sourceBuffer.updating || msePlayer.mediaSource?.readyState !== "open") return false;
  const timeline = getTimelineState();
  const pruneBefore = Math.max(0, timeline.windowStart - MSE_PRUNE_MARGIN_SECONDS);
  if (pruneBefore <= 0 || pruneBefore - Number(msePlayer.lastPrunedBefore || 0) < 1) return false;
  try {
    const bufferedStart = sourceBuffer.buffered?.length ? sourceBuffer.buffered.start(0) : 0;
    if (pruneBefore <= bufferedStart + 0.25) return false;
    sourceBuffer.remove(0, pruneBefore);
    msePlayer.lastPrunedBefore = pruneBefore;
    return true;
  } catch (error) {
    console.warn("Viewer live-window prune failed", error);
    return false;
  }
}

function pruneAudioMseLiveWindow() {
  const sourceBuffer = audioMsePlayer.sourceBuffer;
  if (!sourceBuffer || sourceBuffer.updating || audioMsePlayer.mediaSource?.readyState !== "open") return false;
  const timeline = getTimelineState();
  const pruneBefore = Math.max(0, timeline.windowStart - MSE_PRUNE_MARGIN_SECONDS);
  if (pruneBefore <= 0 || pruneBefore - Number(audioMsePlayer.lastPrunedBefore || 0) < 1) return false;
  try {
    const bufferedStart = sourceBuffer.buffered?.length ? sourceBuffer.buffered.start(0) : 0;
    if (pruneBefore <= bufferedStart + 0.25) return false;
    sourceBuffer.remove(0, pruneBefore);
    audioMsePlayer.lastPrunedBefore = pruneBefore;
    return true;
  } catch {
    return false;
  }
}

function bufferedAhead(video) {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
      return video.buffered.end(index) - video.currentTime;
    }
  }
  return 0;
}

function activeVideoElement() {
  return els["current-frame-video-a"];
}

function inactiveVideoElement() {
  return els["current-frame-video-b"];
}

async function enqueueAudioMseSegment(entry) {
  const segment = entry.payload.audioSegment;
  if (!segment?.dataUrl || !ensureAudioMsePlayer(segment.mimeType)) return;
  const seq = String(entry.seq);
  if (audioMsePlayer.appendedSeqs.has(seq) || audioMsePlayer.queue.some((item) => item.seq === seq)) return;
  try {
    const buffer = await dataUrlToArrayBuffer(segment.dataUrl);
    audioMsePlayer.queue.push({
      seq,
      buffer,
      durationMs: entry.durationMs || CHUNK_DURATION_MS,
      isInit: Boolean(entry.payload.isInit || entry.isBootstrap)
    });
    audioMsePlayer.queue.sort((a, b) => Number(a.seq) - Number(b.seq));
    scheduleAudioMseQueue();
  } catch (error) {
    console.warn("Could not queue audio MSE segment", error);
  }
}

function ensureAudioMsePlayer(mimeType) {
  if (!window.MediaSource) return false;
  const selectedMime = selectAudioMseMimeType(mimeType);
  if (!selectedMime) return false;
  if (audioMsePlayer.mediaSource) return true;

  const audio = getAudioElement();
  audioMsePlayer = createEmptyMsePlayer();
  audioMsePlayer.mimeType = selectedMime;
  audioMsePlayer.mediaSource = new MediaSource();
  audioMsePlayer.objectUrl = URL.createObjectURL(audioMsePlayer.mediaSource);
  audio.src = audioMsePlayer.objectUrl;
  audio.muted = viewerMuted;
  audio.volume = clamp(viewerVolume, 0, 1);
  audioMsePlayer.mediaSource.addEventListener("sourceopen", () => {
    if (audioMsePlayer.sourceBuffer) return;
    audioMsePlayer.open = true;
    audioMsePlayer.sourceBuffer = audioMsePlayer.mediaSource.addSourceBuffer(selectedMime);
    audioMsePlayer.sourceBuffer.mode = "sequence";
    audioMsePlayer.sourceBuffer.addEventListener("updateend", () => {
      audioMsePlayer.appending = false;
      pruneAudioMseLiveWindow();
      maybeStartAudioPlayback();
      scheduleAudioMseQueue(0);
    });
    scheduleAudioMseQueue();
  });
  return true;
}

function getAudioElement() {
  let audio = document.getElementById("lumen-live-audio");
  if (audio) return audio;
  audio = document.createElement("audio");
  audio.id = "lumen-live-audio";
  audio.preload = "auto";
  audio.style.display = "none";
  document.body.appendChild(audio);
  return audio;
}

function scheduleAudioMseQueue(delay = MSE_QUEUE_PREROLL_MS) {
  if (audioMseProcessTimer) return;
  audioMseProcessTimer = window.setTimeout(processAudioMseQueue, delay);
}

function processAudioMseQueue() {
  audioMseProcessTimer = null;
  if (
    !audioMsePlayer.open ||
    !audioMsePlayer.sourceBuffer ||
    audioMsePlayer.sourceBuffer.updating ||
    audioMsePlayer.appending ||
    audioMsePlayer.mediaSource?.readyState !== "open"
  ) return;
  const next = takeNextAudioMseSegment();
  if (!next) {
    maybeStartAudioPlayback();
    return;
  }
  try {
    audioMsePlayer.appending = true;
    audioMsePlayer.sourceBuffer.appendBuffer(next.buffer);
    audioMsePlayer.appendedSeqs.add(String(next.seq));
    audioMsePlayer.appendedCount += 1;
  } catch (error) {
    audioMsePlayer.appending = false;
    console.warn("Audio MSE append failed", {
      name: error?.name || "",
      message: error?.message || String(error || ""),
      mimeType: audioMsePlayer.mimeType,
      seq: next.seq,
      isInit: next.isInit,
      appendedCount: audioMsePlayer.appendedCount,
      queue: audioMsePlayer.queue.length,
      mediaSourceState: audioMsePlayer.mediaSource?.readyState || ""
    });
    scheduleAudioMseQueue(250);
  }
}

function takeNextAudioMseSegment() {
  if (!audioMsePlayer.queue.length) return null;
  if (audioMsePlayer.appendedCount > 0) return audioMsePlayer.queue.shift();
  const initIndex = audioMsePlayer.queue.findIndex((item) => item.isInit || Number(item.seq) === 1);
  if (initIndex >= 0) return audioMsePlayer.queue.splice(initIndex, 1)[0];
  scheduleAudioMseQueue(250);
  return null;
}

function maybeStartAudioPlayback() {
  const video = els["current-frame-video-a"];
  const audio = getAudioElement();
  if (!msePlayer.started || !audioMsePlayer.mediaSource || audioMsePlayer.appendedCount < 2) return;
  if (!audioMsePlayer.started) {
    audioMsePlayer.started = true;
    try {
      audio.currentTime = video.currentTime;
    } catch {
      // ignore seek races while MSE opens
    }
  }
  audio.playbackRate = Number(video?.playbackRate || 1) || 1;
  if (!viewer.paused && !video.paused && audio.paused && !audio.ended) audio.play().catch(() => {});
}

function syncAudioPlayback(video) {
  const audio = getAudioElement();
  if (!audioMsePlayer.started || !video || audio.readyState < 2) return;
  const baseRate = clamp(Number(video.playbackRate || 1), 0.9, 1.1);
  const drift = audio.currentTime - video.currentTime;
  const absoluteDrift = Math.abs(drift);
  if (absoluteDrift > AUDIO_SYNC_HARD_DRIFT_SECONDS) {
    try {
      audio.currentTime = video.currentTime;
      audio.playbackRate = baseRate;
    } catch {
      // ignore transient seek errors
    }
  } else if (absoluteDrift > AUDIO_SYNC_SOFT_DRIFT_SECONDS) {
    const correction = clamp(drift * 0.08, -AUDIO_SYNC_MAX_RATE_OFFSET, AUDIO_SYNC_MAX_RATE_OFFSET);
    audio.playbackRate = clamp(baseRate - correction, 0.9, 1.1);
  } else if (Math.abs(Number(audio.playbackRate || 1) - baseRate) > 0.005) {
    audio.playbackRate = baseRate;
  }
  if (!viewer.paused && !video.paused && audio.paused) audio.play().catch(() => {});
}

function resetAudioMsePlayer() {
  const audio = document.getElementById("lumen-live-audio");
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (audioMsePlayer.objectUrl) URL.revokeObjectURL(audioMsePlayer.objectUrl);
  if (audioMseProcessTimer) {
    window.clearTimeout(audioMseProcessTimer);
    audioMseProcessTimer = null;
  }
  audioMsePlayer = createEmptyMsePlayer();
}

function selectMseMimeType(payload) {
  const mimeType = String(payload?.mimeType || "");
  const candidates = [
    mimeType,
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm"
  ].filter(Boolean);
  if (!window.MediaSource?.isTypeSupported) return candidates[0] || "";
  return candidates.find((candidate) => MediaSource.isTypeSupported(candidate)) || "";
}

function selectAudioMseMimeType(mimeType) {
  const candidates = [
    mimeType,
    "audio/webm;codecs=opus",
    "audio/webm",
    "video/webm;codecs=opus",
    "video/webm"
  ].filter(Boolean);
  if (!window.MediaSource?.isTypeSupported) return candidates[0] || "";
  return candidates.find((candidate) => MediaSource.isTypeSupported(candidate)) || "";
}

function dataUrlToArrayBuffer(dataUrl) {
  return fetch(dataUrl).then((response) => response.arrayBuffer());
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function appendStudioLog(text) {
  const item = document.createElement("div");
  item.className = "log-item";
  item.innerHTML = `<strong>${escapeHtml(text)}</strong><br><small>${new Date().toLocaleTimeString()}</small>`;
  els["studio-log"].prepend(item);
  while (els["studio-log"].children.length > 18) els["studio-log"].lastElementChild.remove();
}

async function startDisplayCapture(requestedAudioMode = "system") {
  stopDisplayCapture();
  captureIssue = "";
  captureMode = "none";
  audioMode = requestedAudioMode;
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: "getDisplayMedia requires a secure context. Use http://localhost, 127.0.0.1, or HTTPS."
    };
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return {
      ok: false,
      reason: "navigator.mediaDevices.getDisplayMedia is not available in this browser/webview."
    };
  }
  try {
    const wantsSharedAudio = requestedAudioMode === "system" || requestedAudioMode === "both";
    const displayOptions = {
      video: true,
      audio: wantsSharedAudio ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } : false
    };
    if (wantsSharedAudio) {
      displayOptions.systemAudio = "include";
      displayOptions.windowAudio = "system";
    }
    displayStream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
    if (wantsSharedAudio && !displayStream.getAudioTracks().length) {
      appendStudioLog("Shared/window audio was requested but no audio track was returned by the picker");
    }
    if (requestedAudioMode === "microphone" || requestedAudioMode === "both") {
      await startMicrophoneCapture();
    }
    recorderStream = await buildRecorderStream(displayStream, microphoneStream);
    await tuneDisplayTrack(displayStream);
    displayVideo = document.createElement("video");
    displayVideo.muted = true;
    displayVideo.playsInline = true;
    displayVideo.srcObject = displayStream;
    await displayVideo.play();
    await waitForVideoMetadata(displayVideo);
    displayStream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (currentLive) onStopLive();
      });
    });
    captureCanvas = document.createElement("canvas");
    captureMode = "screen";
    appendStudioLog(`Screen source selected${describeAudioTracks()}`);
    return { ok: true, reason: "" };
  } catch (error) {
    console.warn("Screen capture failed", error);
    stopDisplayCapture();
    return {
      ok: false,
      reason: error?.name === "NotAllowedError"
        ? "permission denied or picker cancelled"
        : String(error?.message || error?.name || error || "capture failed")
    };
  }
}

function stopDisplayCapture() {
  stopMediaRecorder();
  if (displayStream) {
    displayStream.getTracks().forEach((track) => track.stop());
  }
  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
  }
  if (recorderStream && recorderStream !== displayStream) {
    recorderStream.getTracks().forEach((track) => {
      if (!displayStream || !displayStream.getTracks().includes(track)) track.stop();
    });
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
  }
  displayStream = null;
  recorderStream = null;
  microphoneStream = null;
  displayVideo = null;
  captureCanvas = null;
  audioContext = null;
  audioDestination = null;
  if (captureMode === "screen") captureMode = "none";
}

async function startMicrophoneCapture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    appendStudioLog("Microphone unavailable: getUserMedia missing");
    return;
  }
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    const label = microphoneStream.getAudioTracks()[0]?.label;
    if (label) appendStudioLog(`Microphone selected: ${label}`);
  } catch (error) {
    microphoneStream = null;
    appendStudioLog(`Microphone unavailable: ${String(error?.message || error?.name || error)}`);
  }
}

async function buildRecorderStream(screenStream, micStream) {
  const videoTracks = screenStream.getVideoTracks();
  const audioSources = [screenStream, micStream].filter((stream) => stream?.getAudioTracks().length);
  if (!audioSources.length) return new MediaStream(videoTracks);

  try {
    audioContext = new AudioContext();
    audioDestination = audioContext.createMediaStreamDestination();
    const sourceGain = audioSources.length > 1 ? AUDIO_MIX_GAIN_MULTI : AUDIO_MIX_GAIN_SINGLE;
    for (const stream of audioSources) {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = sourceGain;
      source.connect(gain);
      gain.connect(audioDestination);
    }
    return new MediaStream([...videoTracks, ...audioDestination.stream.getAudioTracks()]);
  } catch (error) {
    appendStudioLog(`Audio mixer unavailable: ${String(error?.message || error?.name || error)}`);
    return new MediaStream([...videoTracks, ...audioSources.flatMap((stream) => stream.getAudioTracks()).slice(0, 1)]);
  }
}

function describeAudioTracks() {
  const sharedCount = displayStream?.getAudioTracks().length || 0;
  const micCount = microphoneStream?.getAudioTracks().length || 0;
  if (!sharedCount && !micCount) return " without audio";
  const label = sharedCount && micCount
    ? "mixed shared audio + microphone"
    : micCount
      ? "microphone audio"
      : "shared window/system audio";
  return ` with ${label}`;
}

async function tuneDisplayTrack(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({ frameRate: MEDIA_TARGET_FPS });
  } catch (error) {
    appendStudioLog(`24fps constraint not applied: ${String(error?.message || error?.name || error)}`);
  }
}

function startMediaRecorder() {
  if (!currentLive || captureMode !== "screen" || !recorderStream || !window.MediaRecorder) return false;
  startAudioRecorder();
  const mimeType = chooseMediaMimeType();
  try {
    const videoOnlyStream = new MediaStream(displayStream.getVideoTracks());
    const recorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 750_000,
      videoKeyFrameIntervalDuration: MEDIA_SEGMENT_MS
    };
    try {
      mediaRecorder = new MediaRecorder(videoOnlyStream, recorderOptions);
    } catch {
      delete recorderOptions.videoKeyFrameIntervalDuration;
      mediaRecorder = new MediaRecorder(videoOnlyStream, recorderOptions);
    }
  } catch (error) {
    appendStudioLog(`MediaRecorder unavailable: ${String(error?.message || error?.name || error)}`);
    mediaRecorder = null;
    return false;
  }
  mediaMimeType = mediaRecorder.mimeType || mimeType || "video/webm";
  captureMode = "screen 24fps";
  recorderActive = true;
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size <= 0) return;
    recorderQueue = recorderQueue.then(() => publishMediaSegment(event.data)).catch((error) => {
      appendStudioLog(`Media segment failed: ${String(error?.message || error)}`);
    });
  });
  mediaRecorder.addEventListener("error", (event) => {
    appendStudioLog(`MediaRecorder error: ${String(event.error?.message || event.error?.name || "unknown")}`);
  });
  mediaRecorder.start(MEDIA_SEGMENT_MS);
  appendStudioLog(`MediaRecorder started: ${mediaMimeType}, ${MEDIA_TARGET_FPS}fps target, ${MEDIA_SEGMENT_MS}ms A/V segments`);
  return true;
}

function stopMediaRecorder() {
  recorderActive = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  mediaRecorder = null;
  mediaMimeType = "";
  if (audioRecorder && audioRecorder.state !== "inactive") {
    try {
      audioRecorder.stop();
    } catch {
      // ignore
    }
  }
  audioRecorder = null;
  audioMimeType = "";
  pendingAudioSegments = [];
}

function chooseMediaMimeType() {
  const candidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm"
  ];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return candidates.find((candidate) => (
    MediaRecorder.isTypeSupported(candidate) &&
    (!window.MediaSource?.isTypeSupported || MediaSource.isTypeSupported(candidate))
  )) || candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function chooseAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "video/webm;codecs=opus",
    "video/webm"
  ];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return candidates.find((candidate) => (
    MediaRecorder.isTypeSupported(candidate) &&
    (!window.MediaSource?.isTypeSupported || MediaSource.isTypeSupported(candidate))
  )) || candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function startAudioRecorder() {
  const audioTracks = recorderStream?.getAudioTracks?.() || [];
  if (!audioTracks.length || !window.MediaRecorder) return false;
  const audioStream = new MediaStream(audioTracks);
  const mimeType = chooseAudioMimeType();
  try {
    audioRecorder = new MediaRecorder(audioStream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 96_000
    });
  } catch (error) {
    appendStudioLog(`Audio recorder unavailable: ${String(error?.message || error?.name || error)}`);
    audioRecorder = null;
    return false;
  }
  audioMimeType = audioRecorder.mimeType || mimeType || "audio/webm";
  audioRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size <= 0) return;
    pendingAudioSegments.push({ blob: event.data, createdAt: now() });
    pendingAudioSegments = pendingAudioSegments.slice(-8);
  });
  audioRecorder.addEventListener("error", (event) => {
    appendStudioLog(`Audio recorder error: ${String(event.error?.message || event.error?.name || "unknown")}`);
  });
  audioRecorder.start(MEDIA_SEGMENT_MS);
  appendStudioLog(`Audio recorder started: ${audioMimeType}`);
  return true;
}

async function publishMediaSegment(blob) {
  if (!currentLive) return;
  const dataUrl = await blobToDataUrl(blob);
  const audioSegment = await takeAudioSegment();
  const mediaPayload = {
    kind: "media-segment",
    mediaPipeline: "split-av-v1",
    frame: "shared screen video segment",
    mimeType: blob.type || mediaMimeType || "video/webm",
    dataUrl,
    size: blob.size,
    durationMs: MEDIA_SEGMENT_MS,
    frameRate: MEDIA_TARGET_FPS,
    audio: {
      mode: audioMode,
      tracks: audioSegment ? 1 : 0
    },
    audioSegment,
    isInit: Number(currentLive.seq || 0) === 0,
    color: "#0f8b8d",
    waveform: []
  };
  currentLive = await produceChunk(adapter, pubsub, currentLive, mediaPayload);
  appendStudioLog(`Segment #${currentLive.seq} ${formatBytes(blob.size)} ${currentLive.lastChunkCid}`);
  renderStudio();
}

async function takeAudioSegment() {
  if (!audioRecorder) return null;
  let segment = pendingAudioSegments.shift();
  if (!segment) {
    await sleep(180);
    segment = pendingAudioSegments.shift();
  }
  if (!segment?.blob) return null;
  return {
    mimeType: segment.blob.type || audioMimeType || "audio/webm",
    dataUrl: await blobToDataUrl(segment.blob),
    size: segment.blob.size
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("blob_read_failed"));
    reader.readAsDataURL(blob);
  });
}

function waitForVideoMetadata(video) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });
}

function captureDisplayFrame(maxWidth = 720, quality = 0.48) {
  if (!displayVideo || !captureCanvas || !displayVideo.videoWidth || !displayVideo.videoHeight) {
    return null;
  }
  const sourceWidth = displayVideo.videoWidth;
  const sourceHeight = displayVideo.videoHeight;
  const scale = Math.min(1, maxWidth / sourceWidth);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  captureCanvas.width = width;
  captureCanvas.height = height;
  const context = captureCanvas.getContext("2d", { alpha: false });
  context.drawImage(displayVideo, 0, 0, width, height);
  const imageDataUrl = captureCanvas.toDataURL("image/jpeg", quality);
  return {
    kind: "screen-frame",
    frame: `shared screen frame`,
    width,
    height,
    imageDataUrl,
    color: "#0f8b8d",
    waveform: []
  };
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied to clipboard")).catch(() => {
    const input = document.createElement("input");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    toast("Copied to clipboard");
  });
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function boot() {
  initElements();
  bindEvents();
  renderLiveLinkMode();
  pendingWatchStreamId = getInitialWatchStreamId();
  if (pendingWatchStreamId) activateAudienceMode();
  renderAll();
  tryStartPendingWatch();
  window.LumenLiveDemo = {
    adapter,
    pubsub,
    readState,
    parseTags,
    signLiveMessage,
    verifyLiveMessage,
    fullscreen: toggleViewerFullscreen,
    live: () => currentLive
  };
}

function getInitialWatchStreamId() {
  try {
    return String(new URLSearchParams(window.location.search).get("watch") || "").trim();
  } catch {
    return "";
  }
}

function liveHintFromUrl(streamId = getInitialWatchStreamId()) {
  const id = String(streamId || "").trim();
  if (!id) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const title = String(params.get("title") || "Lumen Live").trim();
    const description = String(params.get("description") || "").trim();
    const topic = String(params.get("topic") || `/lumen/live/${id}/head`).trim();
    const profileKey = String(params.get("profile") || "").trim();
    const imageCid = String(params.get("imageCid") || "").trim();
    const offlineImageCid = String(params.get("offlineImageCid") || "").trim();
    return {
      streamId: id,
      profileId: "",
      pseudo: "Lumen Live",
      title,
      description,
      avatar: imageCid ? `lumen://ipfs/${imageCid}` : "",
      banner: imageCid ? `lumen://ipfs/${imageCid}` : "",
      wallet: "",
      pubkey: "",
      profileCid: "",
      profileKey,
      tags: [],
      topic,
      status: "LIVE",
      viewers: 0,
      seq: 0,
      lastSeq: 0,
      chunks: [],
      lastSeenAt: now(),
      imageCid,
      offlineImageCid
    };
  } catch {
    return {
      streamId: id,
      title: "Lumen Live",
      topic: `/lumen/live/${id}/head`,
      status: "LIVE",
      chunks: [],
      lastSeenAt: now()
    };
  }
}

function activateAudienceMode() {
  document.getElementById("studio")?.classList.remove("is-active");
  document.getElementById("audience")?.classList.add("is-active");
  if (els["page-title"]) els["page-title"].textContent = "Live";
}

function tryStartPendingWatch() {
  if (!pendingWatchStreamId || viewer.streamId) return false;
  const exists = readState().discoveredLives.some((live) => live.streamId === pendingWatchStreamId) || liveHintFromUrl(pendingWatchStreamId);
  if (!exists) return false;
  activateAudienceMode();
  const streamId = pendingWatchStreamId;
  startViewer(streamId);
  return true;
}

document.addEventListener("DOMContentLoaded", boot);
window.addEventListener("beforeunload", stopDisplayCapture);
