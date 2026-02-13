# FAQ & Troubleshooting

## General Questions

### Q: How do I start the app?

A: 
```bash
cp .env.example .env
docker-compose up -d
```
- Frontend: http://localhost:3000
- API Docs: http://localhost:8000/docs

### Q: Where are the demo credentials?

A:
- **Admin**: admin@local / admin123
- **User**: user@example.com / password

Admin user is auto-created. User can be created via:
```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password","full_name":"Demo User"}'
```

### Q: How do I stop the containers?

A:
```bash
docker-compose down
```

To also delete volumes (databases):
```bash
docker-compose down -v
```

### Q: What's the difference between app_db and analytics_db?

A:
- **app_db**: Product database (users, analyses, views metadata)
- **analytics_db**: Read-only analytics source (your actual data)

This separation allows analytics_db to be a read replica or external data warehouse.

### Q: Can I scale this horizontally?

A: Yes, the API is stateless (uses JWT). You can:
- Run multiple API instances behind a load balancer
- Run database read replicas for analytics_db
- Add caching layer (Redis) for query results

### Q: How does sharing work?

A:
1. User creates analysis
2. User clicks "Share"
3. System generates unique token
4. Share URL: `/shared/{token}`
5. Anyone with URL can view (no login needed)
6. Read-only access (can't edit)

---

## Troubleshooting

### Docker Issues

#### Q: "docker-compose: command not found"

A: Install Docker Compose:
```bash
# Mac/Linux
sudo pip install docker-compose

# Or use Docker Desktop (includes compose)
```

#### Q: Container won't start

A: Check logs:
```bash
docker-compose logs api
docker-compose logs web
docker-compose logs app_db
```

Common causes:
- Port already in use
- Insufficient disk space
- Volume permission issues

#### Q: "Connection refused" when services try to connect

A: Services must use Docker network names (not localhost):
- ✅ Correct: `postgresql://postgres:postgres@app_db:5432/istari_product`
- ❌ Wrong: `postgresql://postgres:postgres@localhost:5432/istari_product`

### Backend Issues

#### Q: API won't start, alembic error

A:
```bash
# Check the full error
docker-compose logs api

# Reset database and retry
docker-compose down -v
docker-compose up -d
```

If migrations fail, check:
1. Database connection string in .env
2. Database is running: `docker-compose ps`
3. Look at alembic history

#### Q: "Column not found" when syncing metadata

A:
1. Make sure analytics_db is properly seeded
2. Check that view exists:
```bash
docker-compose exec analytics_db psql -U postgres -d istari_analytics \
  -c "SELECT * FROM public.vw_growth_users LIMIT 1;"
```
3. Re-run docker-compose with fresh volumes if needed

#### Q: Query returns no data

A:
1. Check if analytics_db is seeded: `SELECT count(*) FROM public.growth_users;`
2. Check if view is active in admin
3. Try the query directly:
```bash
docker-compose exec analytics_db psql -U postgres -d istari_analytics \
  -c "SELECT * FROM public.vw_growth_users;"
```

#### Q: JWT token invalid/expired error

A: Token expires after JWT_EXPIRE_MINUTES. Log out and log in again:
```bash
# On frontend, localStorage is cleared on logout
# Or manually clear token:
localStorage.removeItem('token');
localStorage.removeItem('user');
```

#### Q: CORS error when frontend calls API

A:
1. Check NEXT_PUBLIC_API_URL in frontend .env
2. API CORS is enabled by default in FastAPI app
3. Make sure API is running: `curl http://localhost:8000/health`

### Frontend Issues

#### Q: Frontend shows white screen

A:
```bash
# Check browser console for errors
# Check frontend logs
docker-compose logs web

# Common issues:
# 1. Node modules not installed: npm install in container
# 2. Next.js build failed: check logs
# 3. API connection failed: NEXT_PUBLIC_API_URL wrong
```

#### Q: Login fails with "Invalid email or password"

A:
1. Check credentials match exactly
2. Admin user: admin@local (not admin@example.com)
3. Try creating new user via API

#### Q: Analysis won't render charts

A:
1. Check browser console for JavaScript errors
2. Make sure query returned data (see table first)
3. Check visualization type matches data (need dimensions for charts)

#### Q: Share link shows "Analysis not found"

A:
1. Share token may have expired (check shares table)
2. Analysis was deleted
3. Share was deactivated
4. Token is wrong format

### Database Issues

#### Q: "Too many connections"

A: Connection pool exhausted. Increase pool_size in app/database.py:
```python
engine = create_engine(
    settings.app_db_url,
    pool_size=20,      # Increase from 10
    max_overflow=30,   # Increase from 20
)
```

Then restart: `docker-compose restart api`

#### Q: Database locked/slow queries

A:
```bash
# Connect to database
docker-compose exec app_db psql -U postgres -d istari_product

# Check active connections
SELECT pid, usename, application_name, state FROM pg_stat_activity;

# Kill long-running query
SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
WHERE query ILIKE '%YOUR_QUERY%';
```

#### Q: Migrations not running

A:
```bash
# Check migration status
docker-compose exec api alembic current
docker-compose exec api alembic heads

# Manual upgrade
docker-compose exec api alembic upgrade head

# Roll back
docker-compose exec api alembic downgrade -1
```

### Performance Issues

#### Q: Queries are slow

A:
1. Check data size: `SELECT count(*) FROM public.growth_users;`
2. Check if indexes exist
3. Reduce query limit in frontend
4. Implement caching (Redis)

#### Q: Memory usage is high

A:
1. Check if query returned too many rows
2. Increase container memory: docker-compose.yml `mem_limit`
3. Check for memory leaks in React (DevTools)

---

## Development Tips

### Run Backend Only (Without Docker)

```bash
cd apps/api

# Install dependencies
poetry install

# Set environment
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/istari_product
export ANALYTICS_DB_URL=postgresql://postgres:postgres@localhost:5433/istari_analytics
export SECRET_KEY=dev-key

# Start database servers first
docker-compose up app_db analytics_db -d

# Run migrations
poetry run alembic upgrade head

# Start API
poetry run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Run Frontend Only (Without Docker)

```bash
cd apps/web

# Install dependencies
npm install

# Set environment
export NEXT_PUBLIC_API_URL=http://localhost:8000

# Start
npm run dev
```

### Debug Database Queries

Backend logs SQL with SQLAlchemy:
```python
# In app/database.py, change echo=True
engine = create_engine(
    settings.app_db_url,
    echo=True  # Shows all SQL queries
)
```

### Check API Health

```bash
# Basic health check
curl http://localhost:8000/health

# Get OpenAPI schema
curl http://localhost:8000/openapi.json | jq

# Test endpoint with curl
curl -X GET http://localhost:8000/datasets \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Monitor Logs in Real-time

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f api
docker-compose logs -f web
docker-compose logs -f app_db

# Follow with grep
docker-compose logs -f api | grep ERROR
```

### Reset Everything

```bash
# Stop and remove everything
docker-compose down -v

# Rebuild images
docker-compose build

# Start fresh
docker-compose up -d
```

---

## Testing Workflows

### Full Admin + User Flow

```bash
# 1. Admin login -> view registration -> sync -> activate
TOKEN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@local","password":"admin123"}' | jq -r '.access_token')

curl -X POST http://localhost:8000/admin/views \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schema_name":"public","view_name":"vw_growth_users"}' 

curl -X POST http://localhost:8000/admin/views/1/sync \
  -H "Authorization: Bearer $TOKEN"

curl -X PATCH http://localhost:8000/admin/views/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_active":true}'

# 2. User login -> create analysis -> share
USER_TOKEN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password"}' | jq -r '.access_token')

curl -X POST http://localhost:8000/analyses \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dataset_id": 1,
    "name": "Test Analysis",
    "query_config": {
      "datasetId": 1,
      "metrics": [{"field": "revenue", "agg": "sum"}],
      "dimensions": ["category"],
      "filters": [],
      "sort": [],
      "limit": 500,
      "offset": 0
    }
  }'

curl -X POST http://localhost:8000/analyses/1/share \
  -H "Authorization: Bearer $USER_TOKEN"
```

### Load Testing

```bash
# Install vegeta
go install github.com/tsenart/vegeta@latest

# Create attack file
echo "GET http://localhost:8000/health" | vegeta attack -duration=30s | vegeta report

# Test authenticated endpoint
echo "GET http://localhost:8000/datasets
Authorization: Bearer YOUR_TOKEN" | vegeta attack -duration=30s | vegeta report
```

---

## Contact & Support

- **Documentation**: See README.md, ARCHITECTURE.md, TESTING.md
- **Issues**: Check CHECKLIST.md for known limitations
- **Features**: See DEPLOYMENT.md for scaling & production setup

**Last Updated**: February 2026
