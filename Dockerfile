# playwright-e2e-mcp over stdio, with Chromium ready for the URL tools.
#
#   docker run -i --rm -v "$PWD:/work" ghcr.io/xsignon-secure/playwright-e2e-mcp
#
# or build it yourself:
#
#   docker build -t playwright-e2e-mcp .
#   docker run -i --rm -v "$PWD:/work" playwright-e2e-mcp
#
# Mount the Playwright project at /work (the default project root). Its own
# node_modules provide @playwright/test for run-test; the browsers in this
# image serve inspect-page, validate-selector and compare-visual-state.
FROM mcr.microsoft.com/playwright:v1.65.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.65.0-noble
LABEL org.opencontainers.image.source="https://github.com/xsignon-secure/E2E" \
      org.opencontainers.image.description="MCP server that runs, diagnoses and fixes failing Playwright tests" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PW_MCP_PROJECT_ROOT=/work \
    LOG_FORMAT=json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./
WORKDIR /work
USER pwuser
ENTRYPOINT ["node", "/app/dist/index.js"]
