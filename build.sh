#!/bin/bash

# NovaBit Proxy - Build Script
# Usage: ./build.sh [dev|build|dmg]

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

case "${1:-dev}" in
  dev)
    echo "🚀 Starting in development mode..."
    npm start
    ;;

  build)
    echo "🔨 Building for macOS..."
    npm run build
    echo "✅ Build complete! Check dist/ directory."
    ;;

  dmg)
    echo "📦 Building DMG..."
    npm run build:dmg
    echo "✅ DMG created! Check dist/ directory."
    ;;

  *)
    echo "Usage: $0 {dev|build|dmg}"
    echo "  dev  - Run in development mode"
    echo "  build - Build for macOS"
    echo "  dmg  - Build DMG installer"
    exit 1
    ;;
esac
