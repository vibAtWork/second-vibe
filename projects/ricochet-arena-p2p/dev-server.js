// Local static file server for development (any static host works in production).
// With --signal it also runs a PeerJS signalling server on port 9000, for playing
// on a LAN / offline without the public PeerJS cloud.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

export async function start({ port = 8081, signal = false, signalPort = 9000 } = {}) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
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
