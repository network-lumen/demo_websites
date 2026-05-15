export function canonicalPayload(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPayload).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => key !== "signature")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPayload(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(input) {
  const text = String(input);
  if (crypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(64, "0");
}

export async function makeCidLike(payload) {
  const digest = await sha256Hex(canonicalPayload(payload));
  return `bafy${digest.slice(0, 30)}`;
}

export async function signLiveMessage(message, privateKeyOrMock) {
  const signer = privateKeyOrMock || message.pubkey || message.wallet || "mock";
  const digest = await sha256Hex(`${canonicalPayload(message)}:${signer}`);
  return `mocksha256:${digest}`;
}

export async function verifyLiveMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (!message.signature || !message.pubkey || !message.wallet) return false;
  if (!String(message.signature).startsWith("mocksha256:")) return false;
  const expected = await signLiveMessage(message, message.pubkey);
  return expected === message.signature;
}

export function shortHashSync(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(8, "0");
}

