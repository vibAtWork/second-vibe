# syntax=docker/dockerfile:1
# Ricochet Arena (authoritative server). Build: docker build -t ricochet-arena .
# Behind a TLS-intercepting proxy, add: --secret id=ca,src=/path/to/ca.crt
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/ca npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["node", "server.js"]
