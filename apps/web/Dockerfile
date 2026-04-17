FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY next.config.mjs ./
COPY tsconfig.json ./
COPY tailwind.config.ts ./
COPY postcss.config.mjs ./
COPY src ./src
RUN mkdir -p public
RUN npx next build
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["npx", "next", "start"]
