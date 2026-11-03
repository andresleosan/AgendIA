FROM golang:1.26.1-alpine@sha256:2389ebfa5b7f43eeafbd6be0c3700cc46690ef842ad962f6c5bd6be49ed82039 AS sigsum-builder
RUN go install sigsum.org/sigsum-go/cmd/sigsum-verify@v0.13.1

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS recovery-age
COPY --from=sigsum-builder /go/bin/sigsum-verify /usr/local/bin/sigsum-verify
COPY scripts/prepare-recovery-age.mjs /prepare/scripts/prepare-recovery-age.mjs
COPY scripts/lib/recovery-age.lock.json /prepare/scripts/lib/recovery-age.lock.json
RUN node /prepare/scripts/prepare-recovery-age.mjs --directory /usr/local/bin

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder
WORKDIR /app
# npm bootstraps only the pinned pnpm CLI in this disposable build stage.
RUN npm install --global pnpm@11.23.0
# Keep both workspace manifests with the one shared lockfile, even though only
# the Next application is installed and Cloudflare source is outside this image.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY cloudflare/package.json ./cloudflare/package.json
RUN pnpm --filter sarin-bot-mvp --fail-if-no-match install --frozen-lockfile
COPY . .
# Public Firebase configuration is embedded at build time, never Admin credentials.
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node scripts/container-start.mjs ./container-start.mjs
COPY --chown=node:node scripts/lib/cloudflare-credentials.mjs ./lib/cloudflare-credentials.mjs
COPY --from=recovery-age /usr/local/bin/age /usr/local/bin/age
COPY --chown=node:node scripts/lib/recovery-age.lock.json ./scripts/lib/recovery-age.lock.json
COPY --chown=node:node scripts/lib/recovery-*.mjs scripts/lib/data-migration.mjs ./scripts/lib/
COPY --chown=node:node shared ./shared
COPY --chown=node:node src/lib/*.ts ./src/lib/
COPY --chown=node:node cloudflare/migrations ./cloudflare/migrations
COPY --from=builder --chown=node:node /app/node_modules/.pnpm/zod@4.6.7/node_modules/zod ./node_modules/zod
USER node
EXPOSE 3000
# Exactly one Node process: replicas/clustering would multiply inference slots.
CMD ["node", "container-start.mjs"]
