# Ricochet Arena (approach 2: serverless peer-to-peer)

The same game as `../ricochet-arena-server`: same mechanics, controls and
simulation code (`public/shared/sim.js`). Here there is **no game server**.
The page is plain static files, and browsers connect directly to each other over
WebRTC.

* Everyone opens the same link (`…/?room=abc123`). The first browser in a room
  becomes the **host**: it runs the authoritative simulation (`public/room.js`) in a
  Worker-timed loop, so it keeps ticking even when its tab is in the background.
* The other browsers connect to the host directly. Each opens two data channels: a reliable one
  for joins and maze changes, and an unreliable one for inputs and snapshots (no
  head-of-line stalls). Guests predict their own tank exactly as in approach 1.
* **Host handover:** if the host leaves, the remaining browsers notice within ~2.5 s.
  One of them takes over as host and a fresh round starts.

## Run / host it

Any static file host works (GitHub Pages, Netlify, `python3 -m http.server`…).
You just need to serve the `public/` folder:

```bash
cd projects/ricochet-arena-p2p/public
python3 -m http.server 8081      # then open http://localhost:8081
```

Signalling (the initial handshake only) uses the free public PeerJS server by
default. For LAN/offline play, or to avoid relying on it, run your own:

```bash
cd projects/ricochet-arena-p2p
npm install
node dev-server.js --signal      # static files on :8081 + signalling on :9000
```

Then open `http://<your-ip>:8081/?peerhost=<your-ip>&peerport=9000&peersecure=0`.
Optional `&ice=[...]` takes a JSON list of STUN/TURN servers.

Controls are identical to the original: ↑ ↓ ← → + **M**, a second local player on **E S D F + Q**,
and a mouse player (drives toward the pointer, click to fire).

## Tests

```bash
npm test         # host-room logic: joins, acks, prediction == host sim, input dedupe, seat caps
npm run e2e      # real WebRTC between two headless Chromium pages, with local signalling
```

The e2e run checks: the first browser becomes host and the second joins as guest; both
tanks are visible; the guest's movement shows up on the host; **the guest's
predicted position equals the host's authoritative position**; guest shots reach
the host; when the host tab closes, the guest takes over as host. It also checks
there are no page errors.

## Trade-offs vs. approach 1

| | Approach 1 (server) | Approach 2 (P2P) |
|---|---|---|
| Hosting | needs a Node process | any static host |
| Latency | everyone goes via the server | guests go directly to the host. The host itself has zero latency (a small advantage) |
| Strict NAT / corporate networks | always works (WebSocket) | may need a TURN server via `&ice=` |
| Cheating | server is neutral | the host could cheat (fine among friends) |
| Host leaves | n/a | ~2.5 s handover, scores reset |

## Limitations

* Same gameplay limitations as approach 1 (no power-up crates yet, approximated tank size).
* It relies on the public PeerJS signalling server unless you run your own. Without TURN,
  some network pairs can't connect.
* Scores reset when the host changes.
* `public/vendor/peerjs.min.js` is a vendored copy of PeerJS 1.5.5 (MIT, license alongside).
