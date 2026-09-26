FROM node:22-alpine

ARG COMMIT_HASH=unknown
ARG BUILD_TIMESTAMP
ENV COMMIT_HASH=$COMMIT_HASH \
    BUILD_TIMESTAMP=$BUILD_TIMESTAMP \
    NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000

WORKDIR /app

# better-sqlite3 normally downloads a prebuilt musl binary. The build tools are
# only there as a fallback in case it has to compile, and are removed after.
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && npm cache clean --force

COPY src ./src
COPY public ./public

# Run as the image's non-root `node` user (uid 1000). A host bind mount for
# ./data works best when the host folder is owned by uid 1000 too.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
