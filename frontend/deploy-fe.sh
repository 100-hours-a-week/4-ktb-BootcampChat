#!/bin/bash

# 변수 설정
IMAGE_NAME="4moa/right-fe"
PLATFORM="linux/amd64"
TAG="latest"

NEXT_PUBLIC_API_URL="https://api.goorm-ktb-004.goorm.team"

# 빌드
echo "📦 Building frontend Docker image..."
docker build \
  --platform $PLATFORM \
  --build-arg NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
  -t $IMAGE_NAME:$TAG .

# 푸시
echo "🚀 Pushing frontend image to Docker Hub..."
docker push $IMAGE_NAME:$TAG

echo "✅ Frontend deployment script finished."

# 실행 방법
# ./deploy-fe.sh
