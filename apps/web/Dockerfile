FROM node:20-alpine AS builder

WORKDIR /repo
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/web/package*.json ./apps/web/
WORKDIR /repo/apps/web
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM nginx:1.27-alpine
ENV PORT=3000
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null "http://localhost:${PORT}/" || exit 1

CMD ["nginx", "-g", "daemon off;"]
