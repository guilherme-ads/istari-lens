# Deployment Guide

## Pre-Deployment Checklist

- [ ] All environment variables configured
- [ ] Database backups tested
- [ ] SSL/TLS certificates ready
- [ ] API keys and secrets in secure vault
- [ ] Monitoring and logging configured
- [ ] Load balancer configured (if needed)
- [ ] CDN set up for static assets (if needed)
- [ ] Health checks configured
- [ ] Rollback plan tested

## Environment Setup

### Production Variables

```bash
# Frontend
NEXT_PUBLIC_API_URL=https://api.istari-lens.com
NEXT_PUBLIC_APP_URL=https://istari-lens.com

# Backend
API_HOST=0.0.0.0
API_PORT=8000
ENVIRONMENT=production
CORS_ORIGINS=https://istari-lens.com,https://app.istari-lens.com

# JWT
SECRET_KEY=<strong-random-key-from-vault>
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=60
ENCRYPTION_KEY=<stable-fernet-key-from-vault>

# Database
DATABASE_URL=postgresql+psycopg://user:pass@prod-db.example.com:5432/istari_product
APP_DB_URL=postgresql+psycopg://user:pass@prod-db.example.com:5432/istari_product
ANALYTICS_DB_URL=postgresql://readonly:pass@analytics-db.example.com:5432/istari_analytics
```

## Docker Deployment

### Build Images

```bash
# Build frontend
docker build -f apps/web/Dockerfile -t istari-web:latest .

# Build backend
docker build -f apps/api/Dockerfile -t istari-api:latest .

# Tag for registry
docker tag istari-web:latest registry.example.com/istari-web:latest
docker tag istari-api:latest registry.example.com/istari-api:latest

# Push to registry
docker push registry.example.com/istari-web:latest
docker push registry.example.com/istari-api:latest
```

### Docker Compose Production

```yaml
# docker-compose.prod.yml
# version omitted (Compose v2)

services:
  api:
    image: registry.example.com/istari-api:latest
    environment:
      DATABASE_URL: $DATABASE_URL
      ANALYTICS_DB_URL: $ANALYTICS_DB_URL
      SECRET_KEY: $SECRET_KEY
      ENVIRONMENT: production
    ports:
      - "8000:8000"
    restart: always
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  web:
    image: registry.example.com/istari-web:latest
    environment:
      NEXT_PUBLIC_API_URL: https://api.istari-lens.com
    ports:
      - "3000:3000"
    restart: always
    depends_on:
      - api
```

Deploy:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

## Kubernetes Deployment

### Prerequisites

```bash
# Create namespace
kubectl create namespace istari

# Create secrets
kubectl create secret generic istari-secrets \
  --from-literal=SECRET_KEY=<key> \
  --from-literal=DATABASE_URL=<url> \
  --from-literal=ANALYTICS_DB_URL=<url> \
  -n istari
```

### Deployment Manifests

```yaml
# api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: istari-api
  namespace: istari
spec:
  replicas: 3
  selector:
    matchLabels:
      app: istari-api
  template:
    metadata:
      labels:
        app: istari-api
    spec:
      containers:
      - name: api
        image: registry.example.com/istari-api:latest
        ports:
        - containerPort: 8000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: istari-secrets
              key: DATABASE_URL
        - name: ANALYTICS_DB_URL
          valueFrom:
            secretKeyRef:
              name: istari-secrets
              key: ANALYTICS_DB_URL
        - name: SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: istari-secrets
              key: SECRET_KEY
        - name: ENVIRONMENT
          value: "production"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 5
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: 500m
            memory: 1Gi

---
# api-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: istari-api
  namespace: istari
spec:
  selector:
    app: istari-api
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8000
  type: LoadBalancer
```

Deploy:
```bash
kubectl apply -f api-deployment.yaml
kubectl apply -f api-service.yaml
```

## Database Migration in Production

### Backup first
```bash
pg_dump -U postgres -h prod-db.example.com istari_product > backup.sql
```

### Run migrations
```bash
kubectl exec -it istari-api-<pod-id> -n istari -- alembic upgrade head
```

## Monitoring

### Health Checks

API:
```bash
curl https://api.istari-lens.com/health
```

### Logs

Kubernetes:
```bash
kubectl logs -f deployment/istari-api -n istari
```

Docker:
```bash
docker logs -f istari_api
```

### Metrics (Prometheus)

Add to api:
```python
from prometheus_client import Counter, Histogram

request_count = Counter('api_requests_total', 'Total API requests')
request_duration = Histogram('api_request_duration_seconds', 'API request duration')
```

### Database Monitoring

```sql
-- Monitor connections
SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;

-- Slow queries
SELECT query, mean_exec_time FROM pg_stat_statements 
ORDER BY mean_exec_time DESC LIMIT 10;

-- Cache hit ratio
SELECT 
  sum(heap_blks_read) as heap_read, 
  sum(heap_blks_hit) as heap_hit,
  sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) as blks_hit_ratio
FROM pg_statio_user_tables;
```

## Scaling

### Horizontal Scaling

API is stateless (JWT), can scale:
```bash
# Docker Compose
docker-compose -f docker-compose.prod.yml up -d --scale api=3

# Kubernetes
kubectl scale deployment istari-api --replicas=5 -n istari
```

### Load Balancing

Use Nginx or cloud load balancer:
```nginx
upstream istari_backend {
    server api:8000;
    server api-2:8000;
    server api-3:8000;
}

server {
    listen 80;
    server_name api.istari-lens.com;

    location / {
        proxy_pass http://istari_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Database Scaling

- Read replicas para analytics_db
- Connection pooling (PgBouncer)
- Caching layer (Redis)
- Current dashboard/widget query cache is process-local in-memory only (per API instance/pod)
- There is no cache sharing between pods/processes in the current backend design

## Rollback Procedure

### Via Docker Compose
```bash
# Check previous version
docker image ls istari-api

# Revert to previous
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d  # uses :latest

# Or use specific tag
sed -i 's/istari-api:latest/istari-api:v1.0.0/' docker-compose.prod.yml
docker-compose -f docker-compose.prod.yml up -d
```

### Via Kubernetes
```bash
# Check rollout history
kubectl rollout history deployment/istari-api -n istari

# Rollback to previous version
kubectl rollout undo deployment/istari-api -n istari

# Rollback to specific revision
kubectl rollout undo deployment/istari-api --to-revision=3 -n istari
```

## Security Best Practices

- [ ] HTTPS enforced
- [ ] CORS whitelist específico
- [ ] Rate limiting implementado
- [ ] Input validation em todas rotas
- [ ] Database backups criptografado
- [ ] Secrets em vault (AWS Secrets Manager, HashiCorp Vault, etc)
- [ ] API keys rotacionadas regularmente
- [ ] Audit logs habilitados
- [ ] SQL injection testing feito (sqlmap)
- [ ] XSS prevention verificado (CSP headers)
- [ ] CSRF tokens para mutations (já no React Query)
- [ ] DDoS protection (CloudFlare, AWS Shield)

## Post-Deployment Validation

```bash
# Health checks
curl https://api.istari-lens.com/health

# Test login
curl -X POST https://api.istari-lens.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<admin-email>","password":"<admin-password>"}'

# Monitor for errors
kubectl logs -f deployment/istari-api -n istari | grep ERROR
```

## Incident Response

### API is down
```bash
# Check pod status
kubectl get pods -n istari

# Check logs
kubectl logs istari-api-<pod-id> -n istari

# Health check
curl https://api.istari-lens.com/health

# Restart
kubectl rollout restart deployment/istari-api -n istari
```

### Database connection pool exhausted
```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Kill idle connections
SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
WHERE state = 'idle' AND query_start < now() - interval '10 minutes';
```

### High response times
- Check slow queries (pg_stat_statements)
- Review database indexes
- Check API resource usage
- Monitor network latency

## Backup & Disaster Recovery

### Daily Backups
```bash
# Dump database
pg_dump -U postgres -h prod-db istari_product | gzip > backup_$(date +%Y%m%d).sql.gz

# Upload to S3
aws s3 cp backup_$(date +%Y%m%d).sql.gz s3://istari-backups/
```

### Restore
```bash
# Download from S3
aws s3 cp s3://istari-backups/backup_20260101.sql.gz .

# Restore
gunzip backup_20260101.sql.gz
psql -U postgres -h prod-db istari_product < backup_20260101.sql
```

---

**Last Updated**: February 2026
**Deployment Version**: 1.0.0


