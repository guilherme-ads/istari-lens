#!/bin/bash

# Create .env from .env.example if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
fi

# Start Docker services
echo "Starting Docker services..."
docker-compose up -d

# Wait for services to be healthy
echo "Waiting for services to be healthy..."
sleep 15

# Check API health
echo "Checking API health..."
for i in {1..10}; do
    if curl -s http://localhost:8000/health | grep -q "ok"; then
        echo "API is healthy"
        break
    fi
    echo "Waiting for API... ($i/10)"
    sleep 3
done

echo "All services started!"
echo ""
echo "Access the application:"
echo "  Frontend: http://localhost:3000"
echo "  API Docs: http://localhost:8000/docs"
echo ""
echo "Use 'docker-compose down' to stop services"
