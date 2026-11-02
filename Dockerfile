# driftnet as a container. Default: the MCP server over stdio (what MCP
# directories such as Glama start and introspect). For the web page and chat
# bots instead:  docker run -p 8787:8787 -v driftnet:/data -e DRIFTNET_HOST=0.0.0.0 <image> start
FROM node:22-slim
RUN npm install -g driftnet@1.1.1 && npm cache clean --force
ENV DRIFTNET_HOME=/data NODE_ENV=production
# Not root: driftnet runs yt-dlp, ffmpeg and tesseract on strangers' links.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["driftnet"]
CMD ["mcp"]
