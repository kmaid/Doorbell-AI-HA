FROM oven/bun:latest

WORKDIR /App

COPY . .

RUN bun install

# ENTRYPOINT [ "bun", "start" ]
ENTRYPOINT ["tail", "-f","/dev/null"]
