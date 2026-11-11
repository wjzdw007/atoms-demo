# Runs the app as one long-lived Node process (generation jobs live in the process, so do not
# scale this to several replicas). The SQLite database is kept in the /app/data volume.
#
#   docker compose up -d --build        (see docker-compose.yml and docs/部署.md)

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
# The whole build tree, dev dependencies included: next.config.ts is compiled at start.
COPY --from=build /app ./
RUN mkdir -p data && chown -R node:node data .next
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
