# Single-container Devnet demo: Fastify serves both the API and the dashboard.
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Manifests first so dependency installation caches independently of source.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY shared/package.json shared/
COPY agent/package.json agent/
COPY web/package.json web/

RUN pnpm install --frozen-lockfile

COPY shared ./shared
COPY agent ./agent
COPY web ./web

RUN pnpm build

ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=hosted
ENV HOST=0.0.0.0
ENV PORT=8787
ENV AGENT_DATA_DIR=/data

# Keystore, audit log and request state live on a volume, so a restart resumes
# with the same agent wallet.
VOLUME ["/data"]
EXPOSE 8787

WORKDIR /app/agent
CMD ["pnpm", "start"]
