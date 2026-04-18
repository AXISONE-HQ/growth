FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
RUN npm install
RUN npx prisma generate
COPY src ./src
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
