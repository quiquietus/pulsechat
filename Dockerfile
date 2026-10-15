# One image for every service; SERVICE picks the entry point.
#   SERVICE=all (default)  -> server.js: all four services + the React client
#   SERVICE=auth|chat|ws|notification -> services/<name>/main.js
FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY services ./services
COPY server.js ./
COPY --from=client /app/client/dist ./client/dist
ENV SERVICE=all
EXPOSE 4000
CMD ["sh", "-c", "if [ \"$SERVICE\" = all ]; then exec node server.js; else exec node services/$SERVICE/main.js; fi"]
