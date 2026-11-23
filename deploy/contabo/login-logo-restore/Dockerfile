ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE_ID
ARG PACKAGE_SHA256
LABEL org.softventa.login-logo.base-image-id="${BASE_IMAGE_ID}" \
      org.softventa.login-logo.package-sha256="${PACKAGE_SHA256}"
COPY apply-login-logo.sh /tmp/apply-login-logo.sh
RUN /bin/sh /tmp/apply-login-logo.sh && rm -f /tmp/apply-login-logo.sh
