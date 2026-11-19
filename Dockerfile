FROM oven/bun:latest

RUN apt-get update && apt-get install -y \
    sox \
    libsox-fmt-all \
    alsa-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /App

COPY . .

ENTRYPOINT [ "bun", "start" ]
