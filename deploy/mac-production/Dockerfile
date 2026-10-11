FROM node:24.19.0-bookworm-slim

ENV NODE_ENV=production
ENV WEB_DIST=/app/web-dist
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY dist ./dist
COPY web-dist ./web-dist

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
