# PPTX Analyzer

Веб-сервис для анализа PPTX-презентаций, генерации новых слайдов по брифу и экспорта результата в PPTX, HTML или PDF.

## Стек

- Backend: Python / FastAPI
- Frontend: Vite / JavaScript
- LLM-модель для анализа брифа и генерации структуры презентации
- PPTX-анализатор шаблонов и элементов
- HTML-превью
- Экспорт в PPTX / HTML / PDF
- `prompt-history` для версионирования промптов

## Запуск через Docker Compose

### 1. Подготовить `.env`

В корне проекта создайте файл `.env`:

```env
MODEL_PROVIDER=yandex
MODEL_URI=your_model_uri
MODEL_API_KEY=your_api_key
```

### 2. Запустить проект

```bash
docker compose up --build
```

Docker Compose поднимет два сервиса:

- `analyzer` — backend/API на FastAPI;
- `frontend` — frontend-приложение на Vite.

## Адреса после запуска

Backend API:

```text
http://localhost:8000
```

Frontend UI:

```text
http://localhost:5173
```

Открывать в браузере нужно именно frontend:

```text
http://localhost:5173
```

## Как устроен запуск

### Backend

Сервис `analyzer` собирается из текущего проекта:

```yaml
analyzer:
  build:
    context: .
    target: development
  ports:
    - "8000:8000"
```

Он читает переменные из `.env`, сохраняет результаты в `/output`, а локальные папки монтируются внутрь контейнера:

```yaml
volumes:
  - ./app:/app/app
  - ./prompts:/app/prompts
  - ./output:/output
```

Это удобно для разработки: изменения в `app/` и `prompts/` сразу попадают в контейнер.

### Frontend

Сервис `frontend` запускается отдельно на Node:

```yaml
frontend:
  image: node:22-alpine
  working_dir: /frontend
  command: sh -c "npm ci && npm run dev"
```

Фронт доступен на порту `5173`:

```yaml
ports:
  - "5173:5173"
```

Для обращения к backend используется переменная:

```env
VITE_API_PROXY_TARGET=http://analyzer:8000
```

То есть frontend внутри Docker обращается к API по имени сервиса `analyzer`.

`node_modules` вынесены в отдельный volume:

```yaml
volumes:
  - ./frontend:/frontend
  - frontend_node_modules:/frontend/node_modules
```

Это нужно, чтобы зависимости не перезаписывались локальной папкой и не ставились заново полностью при каждом изменении файлов.

## Типовой сценарий работы

1. Открыть `http://localhost:5173`.
2. Загрузить PPTX-файл.
3. Дождаться анализа презентации.
4. Посмотреть найденные шаблоны и HTML-превью.
5. Ввести текстовый бриф.
6. Запустить генерацию через LLM.
7. Скачать результат в PPTX, HTML или PDF.

## Проверка API

```bash
curl http://localhost:8000/health
```

## Остановка проекта

```bash
docker compose down
```

