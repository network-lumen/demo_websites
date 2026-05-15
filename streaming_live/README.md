# Lumen Live V2 MVP

This folder contains a standalone browser demo for the Lumen Live V2 architecture. It is client-side, but the local mock network is functional across browser tabs: Studio writes chunks by CID, publishes signed PubSub heads, and Watch receives those heads in another tab, verifies them, fetches the CID payloads, buffers them, and plays a reconstructed fake live frame.

## Goal

Lumen Live validates a practical decentralized live-streaming split:

- PubSub = signal. It announces live sessions and chunk heads in realtime.
- CID = media. Video/audio chunks are addressed as IPFS CIDs and never carried inside PubSub messages.
- IPNS = state. A signed provider profile is published through a stable profile key.
- Wallet = trust. Profiles, discovery announcements, and live chunk messages carry wallet/pubkey/signature fields.
- Indexer = discovery. Discovery can come from PubSub, local cache, or an optional indexer that rebuilds state from announcements.

## Files

- `index.html` - app shell and tab layout.
- `styles.css` - responsive UI styles.
- `src/main.js` - UI orchestration for discovery, profile creation, studio, viewer, and debug.
- `src/store.js` - localStorage database shared across tabs.
- `src/pubsub.js` - cross-tab PubSub using BroadcastChannel with a localStorage-event fallback.
- `src/lumen-adapter.js` - single adapter for `window.lumen` real APIs with mock fallback.
- `src/live-core.js` - profile, discovery, live chunk, window, and viewer validation logic.
- `src/crypto.js` - canonical payloads, SHA-256 mock signatures, and CID-like hashes.

## Run

Serve the folder with any static server:

```bash
cd demo_website/lumen-live-v2
python -m http.server 8080
```

Then open `http://localhost:8080`.

The app uses ES modules, so a static server is preferred over opening the file directly.

## Demo Flow

1. Open **Create Profile** and save a provider profile.
2. Open **Studio**, select the profile, and start a live session.
3. The browser opens the native screen/window/tab picker through `getDisplayMedia`. If **Shared window/system audio** is selected, the picker is asked for an audio track too.
4. If **Microphone** or **Shared audio + microphone** is selected, the browser also asks for microphone permission and mixes the microphone with any shared audio returned by the picker.
5. The studio records the shared screen with `MediaRecorder` at a 24fps target and emits standalone WebM segments about every 1 second.
6. Each video segment is stored as a CID payload and only the signed head is announced on `/lumen/live/<streamId>/head`.
7. Open **Watch** in another tab and subscribe to the discovered live.
8. The viewer verifies the signed head, calls `cat(cid)`, validates the payload, loads `windowCid`, maintains a real buffer, and displays frames from the retrieved chunks.
9. Use **Debug** to inspect PubSub logs, CID objects, IPNS records, profiles, and discovered lives.

## Mock Interfaces

The demo exposes these helpers on `window.LumenLiveDemo`:

- `pubsub.subscribe(topic, handler)`
- `pubsub.publish(topic, message)`
- `pubsub.unsubscribe(topic, handler)`
- `adapter.addJson(obj)`
- `adapter.addChunk(data)`
- `adapter.cat(cid)`
- `adapter.publishIPNS(key, cid)`
- `adapter.resolveIPNS(key)`
- `signLiveMessage(message, privateKeyOrMock)`
- `verifyLiveMessage(message)`

The PubSub topics are:

- `/lumen/discovery/live`
- `/lumen/live/<streamId>/head`

The expected chunk message shape is:

```json
{
  "type": "lumen.live.chunk",
  "version": 1,
  "streamId": "...",
  "seq": 1,
  "cid": "bafy...",
  "durationMs": 2000,
  "windowCid": "bafy...",
  "wallet": "lmn...",
  "pubkey": "...",
  "signature": "...",
  "createdAt": 1234567890
}
```

## Optional Lumen Hooks

If `window.lumen` exists, the demo tries the current `contributor/browser` APIs first where available, then falls back to local mocks if they fail:

- `window.lumen.ipfsAdd`
- `window.lumen.ipfsGet`
- `window.lumen.ipfsPublishToIPNS`
- `window.lumen.ipfsResolveIPNS`
- `window.lumen.profiles.getActive`
- `window.lumen.wallet.signArbitrary`
- `window.lumen.wallet.verifyArbitrary`
- `window.lumen.pubsub.publish`
- `window.lumen.pubsub.subscribe`

It also keeps compatibility with the future nested shape:

- `window.lumen.ipfs.add`
- `window.lumen.ipfs.cat`
- `window.lumen.ipns.publish`
- `window.lumen.ipns.resolve`
- `window.lumen.wallet.getActive`
- `window.lumen.wallet.signMessage`

The current MVP keeps deterministic local signing as a fallback so the demo works without a wallet.

All UI code talks to `src/lumen-adapter.js`; it does not call `window.lumen` directly.

## Manual Tests

### Test A: cross-tab live pipeline

1. Start the static server and open `http://localhost:8080` in two tabs.
2. Tab 1: open **Create Profile**, create a profile, then open **Studio**.
3. Tab 1: select the profile and click **Start live**.
4. Tab 2: open **Discover**. The live should appear through `/lumen/discovery/live`.
5. Tab 2: click **Watch**.
6. Verify that chunks arrive every ~2 seconds, the player frame changes, `Received` and `Played` increase, the buffer updates, and the sliding window shows CID-backed frames.

Expected transport path:

```text
Studio screen picker -> MediaRecorder 24fps WebM segment -> addChunk(payload) -> CID -> PubSub signed head -> Watch -> verify -> cat(CID) -> buffer -> video display
```

### Test B: rejected signed chunk

1. Keep Tab 1 live and Tab 2 watching.
2. Open **Debug** in either tab.
3. Click **Publish invalid chunk**.
4. Tab 2 should reject the message because the signed fields were changed after signing.
5. Open **Debug** and confirm the rejected chunk appears in `Rejected chunks`.

### Test C: refresh and catch up

1. Keep Tab 1 live and Tab 2 watching.
2. Refresh Tab 2.
3. The viewer tab should reopen Watch for the last stream, resolve the profile through IPNS, load the latest `windowCid`, hydrate the recent chunks by CID, and resume close to live.

## V2 Limits

- The MediaRecorder pipeline is segment-based: each CID carries about 1 second of WebM screen share, not one CID per rendered frame.
- Shared window/system audio depends on the browser, OS, selected source type, and the native picker returning an audio track. Microphone capture is a separate `getUserMedia` permission.
- No real IPFS node, DHT, pubsub mesh, or IPNS publishing unless `window.lumen` provides those APIs.
- No chunks are stored on-chain.
- No video payload is sent through PubSub.
- Chain behavior is simulated only for names, identity, tips, and permissions.
- Mock signatures use SHA-256 over canonical payloads plus the mock pubkey/secret. They are strict for tamper detection, but not real wallet cryptography.

## Next Steps

- Replace the mock CID fallback in `src/lumen-adapter.js` with the Lumen browser IPFS bridge.
- Replace the mock IPNS fallback in `src/lumen-adapter.js` with real profile publishing and resolution.
- Wire `signLiveMessage` to `window.lumen.wallet.signMessage`.
- Add real media capture, segmenting, and chunk upload.
- Add real PubSub transport and peer lifecycle handling.
- Add an indexer service that persists verified live announcements.
- Add permission and tipping flows backed by the Lumen chain.
