#!/bin/bash

# 변수 설정
IMAGE_NAME="4moa/right-fe"
PLATFORM="linux/amd64"
TAG="latest"

# 빌드
echo "📦 Building frontend Docker image..."
docker build --platform $PLATFORM -t $IMAGE_NAME:$TAG .

# 푸시
echo "🚀 Pushing frontend image to Docker Hub..."
docker push $IMAGE_NAME:$TAG

echo "✅ Frontend deployment script finished."

# 실행 방법
# ./deploy-fe.sh
