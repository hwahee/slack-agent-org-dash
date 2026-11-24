# Multi-stage build: the final image contains ONLY the built artifacts —
# the server bundle (which embeds the built client) and the migration runner.

FROM oven/bun:1.4.2 AS build
WORKDIR /app

# Install with a frozen lockfile first, so source changes don't bust the layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
RUN bun run build

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV APP_ENV=production
ENV PORT=40000
# Data and control planes listen on every interface inside the container.
ENV TESTBED_BIND_HOST=0.0.0.0

COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

# 40000: dashboard + control plane, 40001: sample core (TCP echo)
EXPOSE 40000 40001

# The bundled client assets are resolved relative to the working directory.
WORKDIR /app/dist

# Apply migrations with: docker compose run app bun migrate.js
CMD ["bun", "index.js"]
