FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
# lock が無くても進むように。失敗しても次で継続
RUN npm ci --omit=dev || npm install --omit=dev
COPY server.js ./
EXPOSE 8080
CMD ["node","server.js"]
