FROM python:3.12-slim

# System deps for the stage features (PDF render, OCR, video frames).
# Comment out what you don't need to slim the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tesseract-ocr libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /code
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
