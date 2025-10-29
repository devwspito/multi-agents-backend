#!/bin/bash

# Script para probar el build localmente como lo haría Render
echo "🧪 Testing build process like Render would..."

# Limpiar dist anterior
echo "🧹 Cleaning old dist..."
rm -rf dist/

# Instalar dependencias
echo "📦 Installing dependencies..."
npm ci --include=dev

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Verificar resultado
echo "🔍 Checking build output..."
if [ -f "dist/index.js" ]; then
    echo "✅ Build successful! dist/index.js exists"
    echo ""
    echo "📁 dist/ contents:"
    ls -la dist/ | head -20
    echo ""
    echo "🎯 You can now test locally with:"
    echo "   npm start"
else
    echo "❌ Build failed! dist/index.js not found"
    echo ""
    echo "📁 Current directory contents:"
    ls -la
    exit 1
fi