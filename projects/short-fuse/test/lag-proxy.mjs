// A TCP proxy that delays traffic both ways (latency + jitter), for testing the game under
// realistic network conditions. Like real TCP it never reorders: each direction is one queue
// drained in order by a single timer.
import net from 'node:net';

export function lagProxy({ target, latency = 60, jitter = 15 }) {
  const sockets = new Set();
  const server = net.createServer(client => {
    const upstream = net.connect(target);
    sockets.add(client); sockets.add(upstream);
    const pipe = (from, to) => {
      const queue = []; let timer = null, last = 0;
      const drain = () => {
        timer = null;
        while (queue.length && queue[0].at <= Date.now()) { const { chunk } = queue.shift(); if (!to.destroyed) to.write(chunk); }
        if (queue.length) timer = setTimeout(drain, Math.max(1, queue[0].at - Date.now()));
      };
      from.on('data', chunk => {
        last = Math.max(Date.now() + latency + (Math.random() * 2 - 1) * jitter, last);
        queue.push({ at: last, chunk });
        if (!timer) timer = setTimeout(drain, Math.max(1, queue[0].at - Date.now()));
      });
      from.on('close', () => setTimeout(() => to.destroy(), latency + jitter + 50));
      from.on('error', () => to.destroy());
    };
    pipe(client, upstream); pipe(upstream, client);
  });
  return new Promise(resolve => server.listen(0, () => resolve({
    port: server.address().port,
    close: () => { server.close(); for (const s of sockets) s.destroy(); },
  })));
}
