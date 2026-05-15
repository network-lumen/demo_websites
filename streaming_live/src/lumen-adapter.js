import { makeCidLike, signLiveMessage, verifyLiveMessage } from "./crypto.js";
import { clearCidPayloads, getCidPayload, putCidPayload } from "./idb-cid-store.js";
import { readState, updateState } from "./store.js";

function getLumen() {
  return globalThis.window?.lumen || null;
}

function normalizeCidResult(result) {
  if (!result) return "";
  if (typeof result === "string") return result.replace(/^\/ipfs\//, "");
  return result.cid || result.Cid || result.Hash || result.hash || "";
}

function parseMaybeJson(value) {
  if (value?.ok && value.data !== undefined) return parseMaybeJson(decodeIpfsData(value.data));
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeIpfsData(data) {
  if (typeof data === "string") return data;
  try {
    const bytes = data instanceof Uint8Array
      ? data
      : Array.isArray(data)
        ? new Uint8Array(data)
        : null;
    return bytes ? new TextDecoder().decode(bytes) : data;
  } catch {
    return data;
  }
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

export class LumenAdapter {
  constructor() {
    this.realFailures = new Set();
    this.migrateLegacyMediaChunks();
  }

  getMode() {
    const lumen = getLumen();
    if (!lumen) return "mock";
    const checks = [
      !!(lumen.ipfs?.add || lumen.ipfsAdd),
      !!(lumen.ipfs?.cat || lumen.ipfsGet),
      !!(lumen.ipns?.publish || lumen.ipfsPublishToIPNS),
      !!(lumen.ipns?.resolve || lumen.ipfsResolveIPNS),
      !!lumen.pubsub?.publish,
      !!lumen.pubsub?.subscribe,
      !!lumen.profiles?.getActive
    ];
    return checks.every(Boolean) && this.realFailures.size === 0 ? "real Lumen" : "hybrid";
  }

  async getActiveProfile() {
    const lumen = getLumen();
    try {
      if (lumen?.wallet?.getActive) return await lumen.wallet.getActive();
      if (lumen?.profiles?.getActive) return await lumen.profiles.getActive();
    } catch (error) {
      this.realFailures.add("profiles.getActive");
      console.warn("Lumen active profile lookup failed", error);
    }
    return null;
  }

  async addJson(obj) {
    const data = JSON.parse(JSON.stringify(obj));
    const lumen = getLumen();
    let cid = "";
    try {
      if (lumen?.ipfs?.add) cid = normalizeCidResult(await lumen.ipfs.add(JSON.stringify(data)));
      else if (lumen?.ipfsAdd) cid = normalizeCidResult(await lumen.ipfsAdd(JSON.stringify(data), "lumen-live.json"));
    } catch (error) {
      this.realFailures.add("ipfs.add");
      console.warn("Lumen IPFS add failed, using mock store", error);
    }
    if (!cid) cid = await makeCidLike(data);
    updateState((state) => {
      state.cidObjects[cid] = { kind: "json", data, createdAt: Date.now() };
    });
    return cid;
  }

  async addChunk(data) {
    const payload = JSON.parse(JSON.stringify(data));
    const lumen = getLumen();
    let cid = "";
    try {
      if (lumen?.ipfs?.add) cid = normalizeCidResult(await lumen.ipfs.add(JSON.stringify(payload)));
      else if (lumen?.ipfsAdd) cid = normalizeCidResult(await lumen.ipfsAdd(JSON.stringify(payload), "lumen-live-chunk.json"));
    } catch (error) {
      this.realFailures.add("ipfs.addChunk");
      console.warn("Lumen IPFS chunk add failed, using mock store", error);
    }
    if (!cid) cid = await makeCidLike(payload);
    const externalized = shouldExternalizePayload(payload);
    if (externalized) await putCidPayload(cid, payload);
    updateState((state) => {
      state.cidObjects[cid] = {
        kind: "chunk",
        data: externalized ? makePayloadSummary(payload) : payload,
        externalized,
        createdAt: Date.now()
      };
    });
    return cid;
  }

  async cat(cid) {
    const key = normalizeIpfsCid(cid);
    const local = readState().cidObjects[key];
    if (local?.externalized) {
      const payload = await getCidPayload(key);
      if (payload) return payload;
    }
    if (local?.data && !local.externalized) return local.data;

    const lumen = getLumen();
    try {
      if (lumen?.ipfs?.cat) return parseMaybeJson(await lumen.ipfs.cat(key));
      if (lumen?.ipfsGet) return parseMaybeJson(await lumen.ipfsGet(key, { encoding: "text" }));
    } catch (error) {
      this.realFailures.add("ipfs.cat");
      console.warn("Lumen IPFS cat failed", error);
    }
    return null;
  }

  async clearMockCidPayloads() {
    await clearCidPayloads();
  }

  migrateLegacyMediaChunks() {
    window.setTimeout(async () => {
      const state = readState();
      const entries = Object.entries(state.cidObjects || {}).filter(([, value]) => (
        value?.kind === "chunk" &&
        !value.externalized &&
        shouldExternalizePayload(value.data)
      ));
      if (!entries.length) return;

      for (const [cid, value] of entries) {
        await putCidPayload(cid, value.data);
      }

      updateState((next) => {
        for (const [cid, value] of entries) {
          if (!next.cidObjects[cid]) continue;
          next.cidObjects[cid] = {
            ...next.cidObjects[cid],
            data: makePayloadSummary(value.data),
            externalized: true
          };
        }
      });
    }, 0);
  }

  async publishIPNS(key, cid) {
    const lumen = getLumen();
    try {
      if (lumen?.ipns?.publish) await lumen.ipns.publish(key, cid);
      else if (lumen?.ipfsPublishToIPNS) await lumen.ipfsPublishToIPNS(cid, key);
    } catch (error) {
      this.realFailures.add("ipns.publish");
      console.warn("Lumen IPNS publish failed, using mock record", error);
    }
    updateState((state) => {
      state.ipnsRecords[key] = { cid, updatedAt: Date.now() };
    });
    return { key, cid };
  }

  async resolveIPNS(key) {
    const lumen = getLumen();
    try {
      let resolved = "";
      if (lumen?.ipns?.resolve) resolved = await lumen.ipns.resolve(key);
      else if (lumen?.ipfsResolveIPNS) resolved = await lumen.ipfsResolveIPNS(key);
      if (resolved) return String(resolved).replace(/^\/ipfs\//, "");
    } catch (error) {
      this.realFailures.add("ipns.resolve");
      console.warn("Lumen IPNS resolve failed, using mock record", error);
    }
    return readState().ipnsRecords[key]?.cid || "";
  }

  async chooseStableLinkForLive(payload) {
    const lumen = getLumen();
    const chooser = lumen?.stableLinks?.chooseForLive || lumen?.chooseStableLinkForLive;
    if (!chooser) return { ok: false, error: "stable_links_unavailable" };
    try {
      return await chooser(payload);
    } catch (error) {
      this.realFailures.add("stableLinks.chooseForLive");
      console.warn("Lumen stable link chooser failed", error);
      return { ok: false, error: String(error?.message || error || "stable_link_failed") };
    }
  }

  async selectLiveLinkSetup(payload = {}) {
    const lumen = getLumen();
    const chooser = lumen?.stableLinks?.selectForLiveSetup;
    if (!chooser) return { ok: false, error: "stable_link_setup_unavailable" };
    try {
      return await chooser(payload);
    } catch (error) {
      this.realFailures.add("stableLinks.selectForLiveSetup");
      console.warn("Lumen live link setup chooser failed", error);
      return { ok: false, error: String(error?.message || error || "stable_link_setup_failed") };
    }
  }

  async publishStableLinkForLive(payload) {
    const lumen = getLumen();
    const publisher = lumen?.stableLinks?.publishForLive;
    if (!publisher) return { ok: false, error: "stable_link_publish_unavailable" };
    try {
      return await publisher(payload);
    } catch (error) {
      this.realFailures.add("stableLinks.publishForLive");
      console.warn("Lumen live link publish failed", error);
      return { ok: false, error: String(error?.message || error || "stable_link_publish_failed") };
    }
  }

  async setWindowFullscreen(active) {
    const lumen = getLumen();
    const requested = Boolean(active);
    try {
      const setter = lumen?.window?.setFullscreen || lumen?.setWindowFullscreen;
      if (!setter) return { ok: false, error: "window_fullscreen_unavailable" };
      return await setter(requested);
    } catch (error) {
      this.realFailures.add("window.setFullscreen");
      console.warn("Lumen window fullscreen failed", error);
      return { ok: false, error: String(error?.message || error || "window_fullscreen_failed") };
    }
  }

  async publishPubSub(topic, message) {
    const lumen = getLumen();
    if (!lumen?.pubsub?.publish) return false;
    try {
      const result = await lumen.pubsub.publish(topic, message, { encoding: "json" });
      return result?.ok !== false;
    } catch (error) {
      this.realFailures.add("pubsub.publish");
      console.warn("Lumen PubSub publish failed, using local cross-tab PubSub", error);
      return false;
    }
  }

  async subscribePubSub(topic, handler) {
    const lumen = getLumen();
    if (!lumen?.pubsub?.subscribe) return null;
    try {
      const sub = await lumen.pubsub.subscribe(topic, { encoding: "json", autoConnect: false }, (payload) => {
        handler(payload?.json || payload?.data || payload);
      });
      return () => sub?.unsubscribe?.();
    } catch (error) {
      this.realFailures.add("pubsub.subscribe");
      console.warn("Lumen PubSub subscribe failed, using local cross-tab PubSub", error);
      return null;
    }
  }

  async signLiveMessage(message) {
    return signLiveMessage(message, message.pubkey);
  }

  async verifyLiveMessage(message) {
    return verifyLiveMessage(message);
  }
}

function shouldExternalizePayload(payload) {
  return Boolean(
    payload?.kind === "media-segment" ||
    payload?.kind === "screen-frame" ||
    payload?.dataUrl ||
    payload?.imageDataUrl
  );
}

function makePayloadSummary(payload) {
  const {
    dataUrl,
    imageDataUrl,
    waveform,
    audioSegment,
    ...summary
  } = payload || {};
  return {
    ...summary,
    audioSegment: audioSegment ? {
      mimeType: audioSegment.mimeType,
      size: audioSegment.size,
      dataUrlBytes: audioSegment.dataUrl ? String(audioSegment.dataUrl).length : 0
    } : null,
    externalizedPayload: true,
    dataUrlBytes: dataUrl ? String(dataUrl).length : 0,
    imageDataUrlBytes: imageDataUrl ? String(imageDataUrl).length : 0,
    waveformPoints: Array.isArray(waveform) ? waveform.length : 0
  };
}
