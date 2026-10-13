# ai-redactor worker: one long-running process, no open port. Needs outbound HTTPS only
# (TrueRing's bridge, Supabase storage URLs, Telnyx recording links, AssemblyAI, OpenRouter).
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/check-ffmpeg.mjs scripts/
# ffmpeg-static's install script downloads the ffmpeg binary; our postinstall fails the build if it is missing
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY lib lib
COPY src src
USER node
# healthy = the worker completed a bridge poll in the last 3 minutes (it writes the time after each poll)
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const t=+require('fs').readFileSync('/tmp/ai-redactor-alive','utf8');process.exit(Date.now()-t<180000?0:1)"
CMD ["node", "--import", "tsx", "src/worker.ts"]
