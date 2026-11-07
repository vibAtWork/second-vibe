// Local static file server for development (any static host works in production).
// With --signal it also runs a PeerJS signalling server on port 9000, for playing
// on a LAN / offline without the public PeerJS cloud.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This folder only holds what is specific to P2P; everything else (game client,
// renderer, shared simulation/room/auditor) is served from the server project.
const ROOTS = [path.join(__dirname, 'public'), path.join(__dirname, '..', 'ricochet-arena-server', 'public')];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

export async function start({ port = 8081, signal = false, signalPort = 9000 } = {}) {
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (p === '/') p = '/index.html';
    const file = ROOTS.map(r => path.normalize(path.join(r, p))).find((f, i) => f.startsWith(ROOTS[i] + path.sep) && fs.existsSync(f));
    if (!file) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(port, '0.0.0.0', r));
  let peerServer = null;
  if (signal) {
    const { ExpressPeerServer } = await import('peer');
    const express = (await import('express')).default;
    const app = express();
    const httpServer = await new Promise(r => { const s = app.listen(signalPort, '0.0.0.0', () => r(s)); });
    app.use('/', ExpressPeerServer(httpServer, { path: '/' }));
    peerServer = httpServer;
  }
  return {
    port: server.address().port,
    close: () => { server.close(); if (peerServer) { peerServer.closeAllConnections?.(); peerServer.close(); } },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const signal = process.argv.includes('--signal');
  const port = +(process.env.PORT || 8081);
  start({ port, signal }).then(({ port }) => {
    console.log(`Static files: http://localhost:${port}/`);
    if (signal) console.log(`Local signalling: http://localhost:${port}/?peerhost=localhost&peerport=9000&peersecure=0`);
  });
}
