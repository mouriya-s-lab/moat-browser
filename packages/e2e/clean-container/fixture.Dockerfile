FROM node:22-slim

WORKDIR /app
COPY fixture.mjs /app/fixture.mjs

ENV NODE_ENV=production
EXPOSE 8080
USER node
ENTRYPOINT ["node", "/app/fixture.mjs"]
