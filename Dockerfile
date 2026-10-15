FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
# Runtime dependencies only, exactly as locked.
RUN cd /temp/dev && bun install --frozen-lockfile --production

FROM base AS release
# Each book as Libro.fm's single m4b where it has one (MP3 tracks where it
# doesn't). Set LIBROFM_M4B=false for MP3 tracks throughout.
ENV LIBROFM_M4B=true
COPY --from=install /temp/dev/node_modules ./node_modules
COPY . .

ENTRYPOINT [ "bun", "run", "service.ts" ]
