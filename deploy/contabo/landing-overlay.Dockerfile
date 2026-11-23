ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE_ID
ARG PACKAGE_SHA256
LABEL org.softventa.landing.package-sha256="${PACKAGE_SHA256}" \
      org.softventa.landing.base-image-id="${BASE_IMAGE_ID}"
COPY --chmod=644 inicio/index.html /usr/share/nginx/html/inicio/index.html
COPY --chmod=644 inicio/styles.css /usr/share/nginx/html/inicio/styles.css
COPY --chmod=644 robots.txt /usr/share/nginx/html/robots.txt
COPY --chmod=644 sitemap.xml /usr/share/nginx/html/sitemap.xml
COPY --chmod=644 assets/pwa/softventaweb-logo.webp /usr/share/nginx/html/assets/pwa/softventaweb-logo.webp
COPY --chmod=644 assets/pwa/favicon-16.png /usr/share/nginx/html/assets/pwa/favicon-16.png
COPY --chmod=644 assets/pwa/favicon-32.png /usr/share/nginx/html/assets/pwa/favicon-32.png
COPY --chmod=644 assets/pwa/favicon-48.png /usr/share/nginx/html/assets/pwa/favicon-48.png
RUN chmod 755 /usr/share/nginx/html/inicio && \
    chmod 644 /usr/share/nginx/html/inicio/index.html && \
    chmod 644 /usr/share/nginx/html/inicio/styles.css && \
    chmod 644 /usr/share/nginx/html/robots.txt && \
    chmod 644 /usr/share/nginx/html/sitemap.xml && \
    chmod 644 /usr/share/nginx/html/assets/pwa/softventaweb-logo.webp && \
    chmod 644 /usr/share/nginx/html/assets/pwa/favicon-16.png && \
    chmod 644 /usr/share/nginx/html/assets/pwa/favicon-32.png && \
    chmod 644 /usr/share/nginx/html/assets/pwa/favicon-48.png
