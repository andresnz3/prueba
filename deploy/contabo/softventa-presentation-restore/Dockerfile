ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE_ID
ARG PACKAGE_SHA256
LABEL org.softventa.presentation.base-image-id="${BASE_IMAGE_ID}" \
      org.softventa.presentation.package-sha256="${PACKAGE_SHA256}"
COPY --chmod=755 apply-presentation.sh /tmp/apply-presentation.sh
COPY --chmod=644 utm-cleanup.js /tmp/utm-cleanup.js
RUN /bin/sh /tmp/apply-presentation.sh "$PACKAGE_SHA256" && rm -f /tmp/apply-presentation.sh /tmp/utm-cleanup.js
