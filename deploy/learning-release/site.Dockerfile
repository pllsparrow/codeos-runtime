FROM node:22-alpine AS build
WORKDIR /src
COPY frontend/src/platform_core frontend/src/platform_core/
ENV CODEOS_PLATFORM_CORE_PATH=/src/frontend/src/platform_core \
    VITE_CODEOS_LEARNING_EDITION=true

COPY apps/learning/frontend/package*.json apps/learning/frontend/
RUN npm ci --prefix apps/learning/frontend
COPY apps/learning/frontend apps/learning/frontend/
RUN VITE_BASE_PATH=/learning/ npm run build --prefix apps/learning/frontend

COPY apps/codelab/frontend/package*.json apps/codelab/frontend/
RUN npm ci --prefix apps/codelab/frontend
COPY apps/codelab/frontend apps/codelab/frontend/
RUN VITE_BASE_PATH=/codelab/ VITE_CODELAB_API_URL=/api/codelab npm run build --prefix apps/codelab/frontend

FROM nginx:1.27-alpine
COPY deploy/learning-release/nginx.conf /etc/nginx/templates/default.conf.template
COPY deploy/learning-release/web/ /srv/learning/
COPY --from=build /src/apps/learning/frontend/dist/ /srv/learning/learning/
COPY --from=build /src/apps/codelab/frontend/dist/ /srv/learning/codelab/
