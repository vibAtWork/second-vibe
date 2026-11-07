# Ricochet Arena (approach 2: serverless peer-to-peer)

The same game as `../ricochet-arena-server`: same mechanics, controls and code.
This folder only holds what's P2P-specific (`public/index.html`, `public/net-p2p.js`,
vendored PeerJS). The game client, renderer, simulation, room and auditor are reused from
the server project, by `dev-server.js` during development and by `npm run build` when making
a deployable `dist/`. Here there is **no game server**.
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

Build the static site once, then put `dist/` on any static host (GitHub Pages, Netlify,
`python3 -m http.server`…):

```bash
cd projects/ricochet-arena-p2p
npm run build
```

```bash
cd dist && python3 -m http.server 8081      # then open http://localhost:8081
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

## Cheating

Guests can't cheat, for the same reasons as with the server: the host runs the same validated
room code. The host could run modified code, so **every guest audits it**:

* The simulation is bit-exact on every browser engine (`shared/dmath.js` replaces the
  engine-dependent `Math.sin/cos/atan2`), and the whole game state is serialisable.
* A guest gets the full state when it connects. After that the host publishes, every tick,
  the joins and leaves, the exact input frame it used for each seat, and a hash of the
  resulting state.
* Each guest replays that tick on its own copy (`shared/verify.js`) and checks:
  * the hash matches, so the host bent no rule (no teleporting, invincibility or extra shots)
  * its own inputs were used exactly as sent, so nothing was forged or altered
  * its join carried its own random nonce, which is mixed into the round seed so the host
    can't choose mazes or crate drops alone
  * it wasn't silently removed
  * the host keeps publishing
* On any failure the guest stops and shows "Cheating detected" with the reason.

What remains possible for a host: lag (delaying or dropping inputs looks the same as a bad
connection), and bots or aim assistance, which no game can prevent. A host could also fake
extra "players" to add nonces of its own, which gives a little influence over future mazes.

## Tests

```bash
npm test         # the shared unit tests (simulation, weapons, room, anti-cheat)
npm run e2e      # real WebRTC between headless Chromium pages, with local signalling
```

The e2e run checks: the first browser becomes host and the second joins as guest; both
tanks are visible; the guest's movement shows up on the host; **the guest's
predicted position equals the host's authoritative position**; guest shots reach
the host; an honest host raises no alarm; **a host that edits its game state is caught by the
guest on the next tick**; when the host tab closes, another guest takes over as host. It also
checks there are no page errors.

## Trade-offs vs. approach 1

| | Approach 1 (server) | Approach 2 (P2P) |
|---|---|---|
| Hosting | needs a Node process | any static host |
| Latency | everyone goes via the server | guests go directly to the host. The host itself has zero latency (a small advantage) |
| Strict NAT / corporate networks | always works (WebSocket) | may need a TURN server via `&ice=` |
| Cheating | server is neutral | every guest audits the host; a cheating host is detected and play stops |
| Host leaves | n/a | ~2.5 s handover, scores reset |

## Limitations

* Same gameplay and limitations as approach 1, including the power-up crates (laser, frag bomb, gatling gun, homing missile). See its README for the weapon rules.
* It relies on the public PeerJS signalling server unless you run your own. Without TURN,
  some network pairs can't connect.
* Scores reset when the host changes.
* `public/vendor/peerjs.min.js` is a vendored copy of PeerJS 1.5.5 (MIT, license alongside).
