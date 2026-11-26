FROM node:22-alpine AS builder

WORKDIR /app
COPY apps/learning/frontend/package.json apps/learning/frontend/package-lock.json ./
RUN npm ci
COPY apps/learning/frontend/ ./
COPY frontend/src/platform_core/ /frontend/src/platform_core/
ENV CODEOS_PLATFORM_CORE_PATH=/frontend/src/platform_core
ARG VITE_BASE_PATH=/learning/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx/static-app.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
