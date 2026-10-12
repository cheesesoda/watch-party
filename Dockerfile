FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# Converts files browsers can't play. CPU only: the image has no GPU drivers.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MEDIA_DIR=/media
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared shared
COPY --from=build /app/server server
COPY --from=build /app/web/dist web/dist
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "server/src/index.ts"]
