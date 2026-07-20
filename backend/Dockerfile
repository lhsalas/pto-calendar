FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
RUN npm ci --ignore-scripts --include-workspace-root
COPY backend ./backend
RUN npx prisma generate --schema=backend/prisma/schema.prisma
RUN npm run build -w backend

FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/prisma ./backend/prisma
# `prisma/seed.ts` and `prisma/seedHolidays.ts` are run via `tsx` from the
# `migrate` service in `docker-compose.app.yml`, and they import from
# `../src/...` (env validation, HolidayService, etc.). The compiled JS
# (in `dist/`) is used by the `backend` service via `node`, but tsx needs
# the original source on disk to resolve those relative imports. Image-size
# impact is ~1 MB and only matters on the all-in-one demo stack.
COPY --from=build /app/backend/src ./backend/src
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
