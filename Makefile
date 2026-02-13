.PHONY: help install dev dev-up dev-down lint test clean

help:
	@echo "Istari Lens - Development Commands"
	@echo "======================================"
	@echo "make install     - Install dependencies"
	@echo "make dev         - Start development environment (docker-compose up)"
	@echo "make dev-stop    - Stop development services"
	@echo "make lint        - Run linters (ESLint, Ruff)"
	@echo "make format      - Format code (Prettier, Black)"
	@echo "make test        - Run tests"
	@echo "make clean       - Clean up caches and build files"
	@echo "make logs        - View docker-compose logs"

install:
	pnpm install

dev: install
	docker-compose up -d
	@echo "Services started! Check logs with: make logs"

dev-stop:
	docker-compose down

dev-logs:
	docker-compose logs -f

lint:
	pnpm lint

format:
	pnpm format
	cd apps/api && ruff check --fix . && black . || true

test:
	pnpm test

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name node_modules -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .next -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete
	find . -type d -name dist -exec rm -rf {} + 2>/dev/null || true

api-shell:
	docker-compose exec api bash

db-shell:
	docker-compose exec app_db psql -U postgres -d istari_product

db-analytics-shell:
	docker-compose exec analytics_db psql -U postgres -d istari_analytics
