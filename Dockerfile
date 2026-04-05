FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY server.ts ./
EXPOSE 8585
CMD ["bun", "run", "server.ts"]
