#!/bin/bash

# Quick setup script for development

set -e

echo "Setting up Istari Lens MVP..."

# Copy env file
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✓ Created .env file"
fi

# Install pnpm if not installed
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi

echo "✓ pnpm is available"

# Install dependencies
echo "Installing dependencies..."
pnpm install

echo "✓ Dependencies installed"

# Start services
echo "Starting Docker services..."
docker-compose up -d

echo ""
echo "✓ Setup complete!"
echo ""
echo "The following services are now running:"
echo "  - Frontend (Next.js): http://localhost:3000"
echo "  - API (FastAPI): http://localhost:8000"
echo "  - API Docs (Swagger): http://localhost:8000/docs"
echo ""
echo "Demo credentials:"
echo "  Admin: admin@local / admin123"
echo "  User: user@example.com / password"
echo ""
echo "To stop services, run: docker-compose down"
echo "To view logs, run: docker-compose logs -f"
