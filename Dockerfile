# syntax=docker/dockerfile:1

# The app is a static SPA — no SSR, no API — so the runtime stage is just nginx
# serving `dist/`. Two stages keeps the toolchain out of the shipped image.
FROM node:22-alpine AS build
WORKDIR /app

# corepack pins pnpm from package.json's own field, so the lockfile is honoured.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# `pnpm build` runs `tsc -b` first, so a type error fails the image rather than
# shipping a broken bundle.
RUN pnpm build

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null || exit 1
