# Testing Guide

## Manual Testing

### 1. Start Services

```bash
docker-compose up -d
# or
make dev
```

### 2. Test Admin Flow

#### 2.1 Login as Admin

```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@local",
    "password": "admin123"
  }' | jq
```

Save the `access_token` from the response.

#### 2.2 Register View

```bash
TOKEN="your-token-from-login"

curl -X POST http://localhost:8000/admin/views \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schema_name": "public",
    "view_name": "vw_growth_users",
    "description": "Growth users analytics"
  }' | jq
```

Save the `id` from the response (should be 1).

#### 2.3 Sync View Metadata

```bash
curl -X POST http://localhost:8000/admin/views/1/sync \
  -H "Authorization: Bearer $TOKEN" | jq
```

This should fetch columns from analytics_db and display:
- id
- created_at
- category
- channel
- is_active
- revenue

#### 2.4 Activate View

```bash
curl -X PATCH http://localhost:8000/admin/views/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "is_active": true
  }' | jq
```

### 3. Test User Flow

#### 3.1 Register User (Optional)

```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password",
    "full_name": "Demo User"
  }' | jq
```

#### 3.2 Login as User

```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password"
  }' | jq
```

Save the token.

#### 3.3 List Datasets

```bash
USER_TOKEN="token-from-user-login"

curl -X GET http://localhost:8000/datasets \
  -H "Authorization: Bearer $USER_TOKEN" | jq
```

Should return the activated vw_growth_users view.

#### 3.4 Preview Query

```bash
curl -X POST http://localhost:8000/query/preview \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "datasetId": 1,
    "metrics": [
      {"field": "revenue", "agg": "sum"}
    ],
    "dimensions": ["category"],
    "filters": [],
    "sort": [],
    "limit": 500,
    "offset": 0,
    "visualization": {"type": "bar"}
  }' | jq
```

Should return:
```json
{
  "columns": ["category", "sum"],
  "rows": [
    {"category": "enterprise", "sum": ...},
    {"category": "mid-market", "sum": ...},
    {"category": "startup", "sum": ...}
  ],
  "row_count": 3
}
```

#### 3.5 Create Analysis

```bash
curl -X POST http://localhost:8000/analyses \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dataset_id": 1,
    "name": "Revenue by Category",
    "description": "Total revenue grouped by category",
    "query_config": {
      "datasetId": 1,
      "metrics": [
        {"field": "revenue", "agg": "sum"}
      ],
      "dimensions": ["category"],
      "filters": [],
      "sort": [],
      "limit": 500,
      "offset": 0,
      "visualization": {"type": "bar"}
    },
    "visualization_config": {
      "type": "bar"
    }
  }' | jq
```

Save the `id` from response (should be 1).

#### 3.6 List Analyses

```bash
curl -X GET http://localhost:8000/analyses \
  -H "Authorization: Bearer $USER_TOKEN" | jq
```

#### 3.7 Create Share

```bash
curl -X POST http://localhost:8000/analyses/1/share \
  -H "Authorization: Bearer $USER_TOKEN" | jq
```

Save the `token` from response.

#### 3.8 Access Shared Analysis (No Auth)

```bash
SHARE_TOKEN="token-from-share-response"

curl -X GET "http://localhost:8000/shared/$SHARE_TOKEN" | jq
```

Should return the analysis and the data preview.

### 4. Frontend Testing

Visit http://localhost:3000 and:

1. Login with admin@local / admin123
2. Register view vw_growth_users
3. Sync metadata
4. Logout
5. Login with user@example.com
6. Open dataset and create analysis
7. Save analysis
8. Generate share link
9. Open shared link in incognito window

## Automated Tests

```bash
# API tests
cd apps/api
poetry run pytest

# Frontend tests (not yet implemented)
cd apps/web
npm test
```

## Health Checks

```bash
# API health
curl http://localhost:8000/health | jq

# OpenAPI schema
curl http://localhost:8000/openapi.json | jq

# Database connection
docker-compose exec app_db psql -U postgres -c "SELECT version();"
```

## Logs

```bash
# View all logs
docker-compose logs -f

# Specific service logs
docker-compose logs -f api
docker-compose logs -f web
docker-compose logs -f app_db
docker-compose logs -f analytics_db
```

## Troubleshooting

### API won't start
```bash
# Check migrations
docker-compose logs api

# Reset database
docker-compose down -v
docker-compose up -d
```

### Frontend can't reach API
- Check frontend API URL env var in compose/.env
- Verify API is running: curl http://localhost:8000/health
- Check CORS headers in response

### Database connection issues
```bash
# Connect to app_db
docker-compose exec app_db psql -U postgres -d istari_product

# List tables
\dt

# Connect to analytics_db
docker-compose exec analytics_db psql -U postgres -d istari_analytics

# Check vw_growth_users
SELECT * FROM public.vw_growth_users LIMIT 5;
```


