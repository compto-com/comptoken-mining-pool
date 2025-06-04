############################
# Docker build environment #
############################

FROM node:20-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    cmake \
    curl \
    ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY .env src package.json package-lock.json tsconfig.build.json tsconfig.json ./

# Build Public Pool using NPM
RUN npm ci && npm run build

############################
# Docker final environment #
############################

FROM node:20-bookworm-slim

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334

WORKDIR /public-pool

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

CMD ["/usr/local/bin/node", "dist/main"]
