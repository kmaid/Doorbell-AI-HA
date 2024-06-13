FROM oven/bun:latest

RUN apt-get update && apt-get install -y \
    sox \
    libsox-fmt-all

WORKDIR /App

COPY . .

RUN bun install

# ENTRYPOINT [ "bun", "start" ]
ENTRYPOINT ["tail", "-f","/dev/null"]
