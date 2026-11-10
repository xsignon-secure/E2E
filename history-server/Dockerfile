# Self-hosted history server for playwright-e2e-mcp.
#   docker build -t pw-history history-server
#   docker run -p 8787:8787 -e HISTORY_TOKENS=web:<token> -v pw-history:/data pw-history
FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY lib ./lib
COPY public ./public
COPY server.mjs ./
RUN mkdir /data && chown node:node /data
ENV HISTORY_DATA_DIR=/data PORT=8787 NODE_ENV=production
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
