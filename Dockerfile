FROM node:20-alpine

WORKDIR /app

# Baileys necesita python3 + make + g++ para compilar módulos nativos (bufferutil, utf-8-validate)
RUN apk add --no-cache python3 make g++ libc6-compat

# Instala dependencias con cache eficiente
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copia código
COPY src ./src

# Directorio de sesiones persistido (Railway volume monta aquí)
RUN mkdir -p /app/sessions
ENV SESSION_DIR=/app/sessions

EXPOSE 3000

CMD ["node", "src/index.js"]
