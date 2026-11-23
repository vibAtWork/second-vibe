# Short Fuse server. Build: docker build -t short-fuse .
# No npm dependencies: the image is Alpine + the node binary (and the 3 C++
# runtime libraries it links against) + the game files. No RUN steps, so
# multi-arch builds need no emulation.
FROM node:26-alpine3.24 AS node

FROM alpine:3.24
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /usr/lib/libatomic.so.1 /usr/lib/
WORKDIR /app
COPY server.js ws.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "server.js"]
