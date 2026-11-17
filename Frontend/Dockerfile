# Plant Information Dashboard — frontend app image
# Multi-stage: build with Node, serve with nginx.

FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ARG VITE_DATA_SOURCE=api
ARG VITE_API_URL=/api/v1
ARG VITE_GIT_SHA=
ENV VITE_DATA_SOURCE=$VITE_DATA_SOURCE
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_GIT_SHA=$VITE_GIT_SHA

RUN npm run build

# Pinned to the nginx 1.28 stable line so a rebuild does not pick up a new major version.
FROM nginx:1.28-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
