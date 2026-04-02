FROM node:18-slim

WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
COPY packages/types/package.json packages/types/
COPY packages/controller/package.json packages/controller/

RUN npm install --workspaces

COPY packages/types/ packages/types/
COPY packages/controller/ packages/controller/

RUN cd packages/types && npx tsc \
    && cd ../controller && npx tsc

# Install patchright browser
RUN npx patchright install chromium

EXPOSE 3000

CMD ["node", "packages/controller/dist/index.js"]
