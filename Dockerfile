# syntax=docker/dockerfile:1.7
# MorniHosting: one image with the web app and the API.

# The panel's own Minecraft plugin (MorniCraft). If its build fails (e.g. a library source is down), the panel is
# still built – it then says that the plugin is missing instead of breaking the update.
FROM maven:3.9.9-eclipse-temurin-21 AS plugin
WORKDIR /src
COPY plugins/mornicraft/pom.xml ./
COPY plugins/mornicraft/src ./src
RUN mkdir -p target && (mvn -B -q package || echo "MorniCraft konnte nicht gebaut werden" > target/BUILD_FAILED.txt)

FROM node:22-alpine AS build
# Nur Bauwerkzeuge für native Module in der Bau-Stufe; ihre Versionen folgen dem Alpine-Stand des Node-Images
# (feste apk-Versionen verschwinden aus dem Alpine-Index und würden den Bau brechen).
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
ARG MH_VERSION=dev
RUN pnpm --filter @mornihosting/web build \
 && pnpm --filter @mornihosting/server build \
 && pnpm --filter @mornihosting/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/

FROM node:22-alpine
ARG MH_VERSION=dev
LABEL org.opencontainers.image.title="MorniHosting" \
      org.opencontainers.image.description="Selbst gehostetes Web-Panel für Minecraft-Server" \
      org.opencontainers.image.source="https://github.com/pmornhart/MorniHosting" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${MH_VERSION}"
ENV NODE_ENV=production \
    MH_DATA_DIR=/data \
    MH_WEB_DIR=/app/web \
    MH_VERSION=${MH_VERSION}
WORKDIR /app
COPY --from=build /out /app/server
COPY --from=build /src/apps/web/dist /app/web
COPY --from=plugin /src/target/ /app/plugins/
# The node user (uid 1000) is the same user the Minecraft images write files as.
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/system/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "/app/server/dist/index.js"]
