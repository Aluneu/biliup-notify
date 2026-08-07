FROM node:20-alpine

WORKDIR /app

# 依赖层(利用缓存)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 源码
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# 无浏览器环境,不自动打开网页
ENV BILIUP_NOTIFY_NO_OPEN=1
ENV NODE_ENV=production

EXPOSE 4000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
