# driftnet as a container. Default: the MCP server over stdio (what MCP
# directories such as Glama start and introspect). For the web page and chat
# bots instead:  docker run -p 8787:8787 -v driftnet:/data -e DRIFTNET_HOST=0.0.0.0 <image> start
FROM node:22-slim
RUN npm install -g driftnet@0.9.0 && npm cache clean --force
ENV DRIFTNET_HOME=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["driftnet"]
CMD ["mcp"]
