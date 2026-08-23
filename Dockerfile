# syntax=docker/dockerfile:1
# Kern chat service: chat module and the realtime WebSocket gateway.
#
# @kernhq/* packages come from GitHub Packages while the repositories are private, so the build needs a
# token with read:packages:
#   docker build --secret id=NODE_AUTH_TOKEN,env=GITHUB_TOKEN .
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
    if [ -s /run/secrets/NODE_AUTH_TOKEN ]; then \
      printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" >> .npmrc; \
    fi && \
    pnpm install --prod=false --no-frozen-lockfile && \
    sed -i '/_authToken/d' .npmrc

FROM deps AS build
COPY . .
RUN pnpm build && pnpm prune --prod

FROM base AS runtime
# The release this image belongs to. Every Kern service in an instance is built from the same one,
# which is what lets the kernel answer "which version of Kern is this" with a single number.
ARG KERN_VERSION=0.0.0-dev
ENV NODE_ENV=production KERN_VERSION=${KERN_VERSION}
RUN useradd --system --uid 10001 --create-home kern
COPY --from=build --chown=kern:kern /app/node_modules ./node_modules
COPY --from=build --chown=kern:kern /app/dist ./dist
COPY --from=build --chown=kern:kern /app/package.json ./package.json

USER kern
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
