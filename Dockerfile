FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS backend-base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    librsvg2-bin libimage-exiftool-perl fontconfig libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY prompts ./prompts
ENV OUTPUT_ROOT=/output
EXPOSE 8000

FROM backend-base AS development
CMD ["uvicorn", "app.web:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM backend-base AS production
COPY --from=frontend /frontend/dist ./frontend/dist
CMD ["uvicorn", "app.web:app", "--host", "0.0.0.0", "--port", "8000"]
