FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME /data
CMD ["npm", "start"]
