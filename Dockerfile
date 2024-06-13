FROM oven/bun:alpine

WORKDIR /App

COPY . .

ENTRYPOINT [ "bun", "start" ]
