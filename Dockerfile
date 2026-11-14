FROM node:24-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/scripts ./scripts
COPY server/src ./src
COPY bridge /bridge
COPY deploy/client /deploy/client
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production DATA_DIR=/data VAULT_DIR=/vault PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./
COPY server/public ./public
# The Early Echo story, used only when DEMO_MODE=1 (docs/showcase.md#demo-mode): the Replay bar resets the hub to its
# start and runs eval/run.mjs in-process. Read only; without DEMO_MODE nothing loads it.
COPY eval/vault /eval/vault
COPY eval/story /eval/story
COPY eval/run.mjs /eval/run.mjs
RUN mkdir -p /data /vault && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
