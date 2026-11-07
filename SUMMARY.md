# Summary

The owner asked for the supplied Flash maze-tank game to be rebuilt for seamless online
multiplayer in the browser, with the same movement and controls. Two approaches, each in its own folder:

1. **`projects/ricochet-arena-server`**: Node authoritative server + client prediction.
   It's the most robust option: it works on any network and the server is neutral.
   Try: `cd projects/ricochet-arena-server && npm install && npm start`, then open http://localhost:8080 in two tabs.
2. **`projects/ricochet-arena-p2p`**: serverless WebRTC. Guests audit the host, so cheating is detected.
   Try: `cd projects/ricochet-arena-p2p && npm install && npm start`, then open http://localhost:8081 in two tabs.

Both share the same simulation (`public/shared/sim.js`). Its movement, turning, collision fallback, angle snapping, bullet bounce,
lifetime, fire limit, round timing and key bindings were taken from the supplied SWF's logic.

**Review first:** play a round of approach 1 with a friend and judge whether the tank feel matches the
original (tank size is the main approximation). Power-up crates aren't implemented yet (BACKLOG #3).

The Docker image `ghcr.io/vibatwork/ricochet-arena:latest` runs approach 1. Both approaches share one code base: game client, simulation, room and auditor live in `projects/ricochet-arena-server/public/`.
