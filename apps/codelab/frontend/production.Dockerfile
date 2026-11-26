FROM node:22-alpine AS builder

WORKDIR /app
COPY apps/codelab/frontend/package.json apps/codelab/frontend/package-lock.json ./
RUN npm ci
COPY apps/codelab/frontend/ ./
COPY frontend/src/platform_core/ /frontend/src/platform_core/
ARG VITE_BASE_PATH=/codelab/
ARG VITE_CODELAB_API_URL=/api/codelab
ARG CODEOS_PLATFORM_CORE_PATH=/frontend/src/platform_core
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_CODELAB_API_URL=${VITE_CODELAB_API_URL}
ENV CODEOS_PLATFORM_CORE_PATH=${CODEOS_PLATFORM_CORE_PATH}
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx/static-app.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
