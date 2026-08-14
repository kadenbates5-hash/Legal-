FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Persisted state lives here when DATABASE_URL isn't set — see STATE_FILE
# in CLAUDE.md. On most hosts this is ephemeral unless you mount a
# volume at /app/data; prefer DATABASE_URL (Postgres) for anything that
# needs to survive a redeploy.
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/review-ui/start.js"]
