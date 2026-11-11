# ── 1. Build: needs dev dependencies (vite, typescript) ──
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
# The whole repo first: npm workspaces (extensions/*) need their package.json files for `npm ci`.
COPY . .
RUN npm ci
RUN npx prisma generate && npm run build
# Drop dev dependencies so the runtime stage can copy node_modules as is.
RUN npm prune --omit=dev && npm cache clean --force

# ── 2. Runtime: production dependencies and the built app only ──
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma
# The PDF renderer reads its fonts from public/fonts at runtime.
COPY --from=build /app/public ./public
EXPOSE 3000
# docker-start = prisma generate + prisma migrate deploy + react-router-serve (listens on $PORT)
CMD ["npm", "run", "docker-start"]
