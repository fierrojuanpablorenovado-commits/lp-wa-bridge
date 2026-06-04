FROM node:20-alpine

WORKDIR /app

# Instala deps con cache eficiente
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia código
COPY src ./src

# Crea directorio de sesiones persistido (Railway volume monta aquí)
RUN mkdir -p /app/sessions
ENV SESSION_DIR=/app/sessions

EXPOSE 3000

CMD ["node", "src/index.js"]
