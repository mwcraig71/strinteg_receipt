FROM node:22-bookworm-slim

# pdftoppm turns scanned PDFs into page images; heif-convert opens iPhone HEIC photos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils libheif-examples ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
