// Builds dist/: a self-contained static site (shared files from the server
// project + the P2P-specific files here). Upload dist/ to any static host.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(here, '..', 'ricochet-arena-server', 'public'), dist, { recursive: true, filter: src => !src.endsWith(`${path.sep}public${path.sep}index.html`) && !src.endsWith('net-ws.js') });
fs.cpSync(path.join(here, 'public'), dist, { recursive: true });
console.log('built', dist, fs.readdirSync(dist).join(' '));
