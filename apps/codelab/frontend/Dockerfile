FROM node:22-alpine AS builder

WORKDIR /app
COPY apps/codelab/frontend/package.json apps/codelab/frontend/package-lock.json ./
RUN npm ci
COPY apps/codelab/frontend/ ./
COPY frontend/src/platform_core/ /frontend/src/platform_core/
ARG VITE_CODELAB_API_URL=/api/codelab
ENV VITE_CODELAB_API_URL=${VITE_CODELAB_API_URL}
ARG CODEOS_PLATFORM_CORE_PATH=/frontend/src/platform_core
ENV CODEOS_PLATFORM_CORE_PATH=${CODEOS_PLATFORM_CORE_PATH}
RUN npm run build

FROM nginx:1.27-alpine
COPY apps/codelab/frontend/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8443
