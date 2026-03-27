FROM oven/bun:latest

RUN apt-get update && apt-get install -y \
    sox \
    libsox-fmt-all \
    alsa-utils \
    libvips-dev \
    python3 \
    make \
    g++ \
    pkg-config

WORKDIR /App

COPY package.json bun.lockb ./
RUN bun install

COPY . .

ENTRYPOINT [ "bun", "start" ]
