FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# 复制根 tsconfig（子包 extends 需要）
COPY tsconfig.json tsconfig.json

# 复制 types 包（controller 的依赖）
COPY packages/types/package.json packages/types/package.json
COPY packages/types/tsconfig.json packages/types/tsconfig.json
COPY packages/types/src packages/types/src

# 安装 types 依赖并编译
RUN cd packages/types && npm install && npx tsc

# 复制 controller 包
COPY packages/controller/package.json packages/controller/package.json
COPY packages/controller/tsconfig.json packages/controller/tsconfig.json
COPY packages/controller/src packages/controller/src

# 将 workspace:* 替换为 file: 引用，然后安装依赖并编译
RUN cd packages/controller && \
    sed -i 's|"workspace:\*"|"file:../types"|' package.json && \
    npm install && \
    npx tsc

WORKDIR /workspace/packages/controller

EXPOSE 3000

CMD ["node", "dist/index.js"]
