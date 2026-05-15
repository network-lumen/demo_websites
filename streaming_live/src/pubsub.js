import { appendPubsubLog, PUBSUB_EVENT_KEY, updateState } from "./store.js";

export class CrossTabPubSub {
  constructor(adapter) {
    this.adapter = adapter;
    this.clientId = sessionStorage.getItem("lumen-live-v2-client-id") || `client-${crypto.randomUUID?.() || Date.now()}`;
    sessionStorage.setItem("lumen-live-v2-client-id", this.clientId);
    this.handlers = new Map();
    this.seen = new Set();
    this.remoteUnsubs = new Map();
    this.channel = "BroadcastChannel" in window ? new BroadcastChannel("lumen-live-v2-pubsub") : null;
    this.channel?.addEventListener("message", (event) => this.receiveEnvelope(event.data));
    window.addEventListener("storage", (event) => {
      if (event.key !== PUBSUB_EVENT_KEY || !event.newValue) return;
      try {
        this.receiveEnvelope(JSON.parse(event.newValue));
      } catch {
        // ignore malformed test data
      }
    });
    window.addEventListener("beforeunload", () => this.clearActiveTopics());
  }

  subscribe(topic, handler) {
    const key = String(topic || "");
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(handler);
    this.syncActiveTopics();

    if (!this.remoteUnsubs.has(key)) {
      this.adapter.subscribePubSub(key, (message) => {
        this.receiveEnvelope({
          id: `real-${Date.now()}-${Math.random()}`,
          source: "real-lumen",
          topic: key,
          message,
          createdAt: Date.now()
        });
      }).then((unsubscribe) => {
        if (unsubscribe) this.remoteUnsubs.set(key, unsubscribe);
      });
    }

    return () => this.unsubscribe(key, handler);
  }

  unsubscribe(topic, handler) {
    const key = String(topic || "");
    const handlers = this.handlers.get(key);
    if (!handlers) return;
    handlers.delete(handler);
    if (!handlers.size) {
      this.handlers.delete(key);
      const remoteUnsub = this.remoteUnsubs.get(key);
      if (remoteUnsub) remoteUnsub();
      this.remoteUnsubs.delete(key);
    }
    this.syncActiveTopics();
  }

  publish(topic, message) {
    const envelope = {
      id: `local-${this.clientId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      source: this.clientId,
      topic: String(topic || ""),
      message,
      createdAt: Date.now()
    };
    appendPubsubLog(envelope);
    this.deliver(envelope);
    this.channel?.postMessage(envelope);
    localStorage.setItem(PUBSUB_EVENT_KEY, JSON.stringify(envelope));
    this.adapter.publishPubSub(envelope.topic, envelope.message);
  }

  receiveEnvelope(envelope) {
    if (!envelope?.id || this.seen.has(envelope.id)) return;
    this.seen.add(envelope.id);
    if (this.seen.size > 1000) this.seen.clear();
    if (envelope.source !== this.clientId) appendPubsubLog(envelope);
    this.deliver(envelope);
  }

  deliver(envelope) {
    const handlers = this.handlers.get(envelope.topic);
    if (!handlers) return;
    handlers.forEach((handler) => handler(envelope.message, envelope.topic, envelope));
  }

  getActiveTopics() {
    return Array.from(this.handlers.keys());
  }

  syncActiveTopics() {
    const topics = this.getActiveTopics();
    updateState((state) => {
      state.activeTopics[this.clientId] = { topics, updatedAt: Date.now() };
    });
  }

  clearActiveTopics() {
    updateState((state) => {
      delete state.activeTopics[this.clientId];
    });
  }
}

