FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY server-live.js ./

EXPOSE 10000

CMD ["node", "server-live.js"]
