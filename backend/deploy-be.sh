#!/bin/bash

# 변수 설정
IMAGE_NAME="4moa/right-be"
PLATFORM="linux/amd64"
TAG="latest"

echo "📦 Building backend Docker image..."
docker build --platform $PLATFORM -t $IMAGE_NAME:$TAG .

echo "🚀 Pushing backend image to Docker Hub..."
docker push $IMAGE_NAME:$TAG

echo "✅ Backend deployment script finished."