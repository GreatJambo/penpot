# Thin layer on the public Playwright image. Browsers are already in the
# base image. This install does not download Chromium again and does not
# change any Penpot image.
FROM mcr.microsoft.com/playwright:v1.55.0-noble@sha256:b27e719ecbfef153e13fd24e8341736733bf2658b229677eb21ff57ff5d7fb29

USER root
WORKDIR /opt/penpot-mcp-headless

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LIBGL_ALWAYS_SOFTWARE=1

RUN npm install --omit=dev playwright@1.55.0 \
    && npm cache clean --force \
    && mkdir -p /opt/penpot-mcp-headless/artifacts \
    && chmod 1777 /opt/penpot-mcp-headless/artifacts

COPY entrypoint.sh /opt/penpot-mcp-headless/entrypoint.sh
RUN chmod 755 /opt/penpot-mcp-headless/entrypoint.sh

USER pwuser
ENTRYPOINT ["/opt/penpot-mcp-headless/entrypoint.sh"]
