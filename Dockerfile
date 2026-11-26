# driftnet as a container. Default: the MCP server over stdio (what MCP
# directories such as Glama start and introspect). For the web page and chat
# bots instead:
#   docker run -d -p 127.0.0.1:8787:8787 -v driftnet_data:/data -e DRIFTNET_HOST=0.0.0.0 ghcr.io/kevinchu1110/driftnet:latest start
FROM node:22-slim

ARG DRIFTNET_VERSION=latest

LABEL org.opencontainers.image.source="https://github.com/KevinChu1110/driftnet" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Drop links into your group chat, get them sorted, explained and searchable."

RUN npm install -g "driftnet@${DRIFTNET_VERSION}" && npm cache clean --force
ENV DRIFTNET_HOME=/data NODE_ENV=production
# Not root: driftnet runs yt-dlp, ffmpeg and tesseract on strangers' links.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["driftnet"]
CMD ["mcp"]
