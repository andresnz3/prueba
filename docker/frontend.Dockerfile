FROM node:22.23.4-bookworm-slim AS public-build
WORKDIR /source
COPY scripts/build-static.cjs ./scripts/build-static.cjs
COPY scripts/check-vendored-assets.cjs ./scripts/check-vendored-assets.cjs
COPY vendor/ ./vendor/
COPY index.html app.js data-tables.js styles.css icons.js 404.html api-config.js api-client.js connected-auth.js connected-inventory.js validation.js connected-sales.js connected-clients.js connected-expenses.js connected-purchases.js connected-reports.js dashboard-period.js period-filters.js connected-dashboard.js local-cash-flow.js local-migration-preview.js local-migration-export.js connected-migration-history.js ./
RUN node scripts/build-static.cjs

FROM nginx:1.30.6-alpine AS frontend
COPY --from=public-build /source/dist/ /usr/share/nginx/html/
COPY docker/frontend/api-config.js /usr/share/nginx/html/api-config.js
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
