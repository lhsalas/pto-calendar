FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
RUN npm ci --ignore-scripts --include-workspace-root
COPY backend ./backend
RUN npx prisma generate --schema=backend/prisma/schema.prisma
RUN npm run build -w backend

FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/prisma ./backend/prisma
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
