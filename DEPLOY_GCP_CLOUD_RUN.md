# Deploy Lens no GCP (Cloud Run + Artifact Registry)

Este guia assume:
- Banco de dados ja esta pronto.
- Deploy sem dominio customizado (URLs `*.run.app`).
- Repositorio atual contem `cloudbuild.images.yaml`.
- Ambiente local detectado: `PROJECT_ID=lens-490714`.

## 1) Preparar variaveis base

```powershell
$env:PROJECT_ID="lens-490714"
$env:REGION="us-central1" # ajuste se quiser outra regiao
$env:REPO="lens"
$env:TAG="prod"

gcloud.cmd auth login
gcloud.cmd config set project $env:PROJECT_ID
gcloud.cmd config set run/region $env:REGION
```

## 2) Habilitar APIs e criar repositorio Docker (uma vez)

```powershell
gcloud.cmd services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud.cmd artifacts repositories create $env:REPO `
  --repository-format=docker `
  --location=$env:REGION `
  --description="Lens Docker images"
```

Se o repositorio ja existir, o comando pode falhar com "already exists"; pode seguir.

## 3) Definir valores sensiveis e URLs de banco

Use valores fortes em producao.

```powershell
$INSTANCE_CONNECTION_NAME="lens-490714:us-central1:lens-pg"
$RUNTIME_SA="24978620691-compute@developer.gserviceaccount.com"

# Permissao necessaria para Cloud SQL Connector (uma vez)
gcloud.cmd projects add-iam-policy-binding $env:PROJECT_ID `
  --member="serviceAccount:$RUNTIME_SA" `
  --role="roles/cloudsql.client"

$DB_USER="lens_app"
$DB_PASS="SUA_SENHA_AQUI"
$DB_NAME="lens-db"
$DB_PASS_ENCODED=[System.Uri]::EscapeDataString($DB_PASS)

# URLs via Cloud SQL socket (nao usar IP publico)
$APP_DB_URL="postgresql+psycopg://${DB_USER}:${DB_PASS_ENCODED}@/${DB_NAME}?host=/cloudsql/${INSTANCE_CONNECTION_NAME}"
$ANALYTICS_DB_URL=$APP_DB_URL

# Segredos fortes (>= 32 chars)
$APP_SECRET_KEY=[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object {[byte]$_}))

# Fernet key valida: 32 bytes codificados em URL-safe base64 (44 chars)
$fernetBytes=New-Object byte[] 32
$rng=[System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($fernetBytes)
$rng.Dispose()
$APP_ENCRYPTION_KEY=([Convert]::ToBase64String($fernetBytes)).Replace('+','-').Replace('/','_')

$ENGINE_SERVICE_SECRET=[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object {[byte]$_}))

# Validacao rapida antes do deploy
$APP_DB_URL
$APP_SECRET_KEY.Length
$APP_ENCRYPTION_KEY.Length
$ENGINE_SERVICE_SECRET.Length
```

## 4) Primeiro build/push das imagens

No primeiro build, use placeholder para `VITE_API_URL` (sera corrigido depois que a API subir).

```powershell
$env:VITE_API_URL="https://placeholder.invalid"
$env:NEXT_PUBLIC_API_URL=$env:VITE_API_URL

gcloud.cmd builds submit `
  --project=$env:PROJECT_ID `
  --region=$env:REGION `
  --config=cloudbuild.images.yaml `
  --substitutions=_REGION=$env:REGION,_REPO=$env:REPO,_TAG=$env:TAG,_VITE_API_URL=$env:VITE_API_URL,_NEXT_PUBLIC_API_URL=$env:NEXT_PUBLIC_API_URL `
  .
```

## 5) Deploy/Update do Engine

API depende de `APP_ENGINE_BASE_URL`, entao configure engine antes.
Se o `lens-engine` ja existe, o mesmo comando abaixo faz update da configuracao.

```powershell
gcloud.cmd run deploy lens-engine `
  --image "$env:REGION-docker.pkg.dev/$env:PROJECT_ID/$env:REPO/lens-engine:$env:TAG" `
  --region $env:REGION `
  --platform managed `
  --allow-unauthenticated `
  --port 8010 `
  --add-cloudsql-instances $INSTANCE_CONNECTION_NAME `
  --set-env-vars "ENVIRONMENT=production,ANALYTICS_DB_URL=$ANALYTICS_DB_URL,ENGINE_SERVICE_SECRET=$ENGINE_SERVICE_SECRET"
```

Capture a URL do engine:

```powershell
$ENGINE_URL = gcloud.cmd run services describe lens-engine --region=$env:REGION --format="value(status.url)"
$ENGINE_URL
```

## 6) Deploy da API (primeira passada)

Sem dominio customizado, a URL final do web ainda nao existe. Para passar na validacao de producao, use CORS temporario.

```powershell
$TEMP_CORS_ORIGIN="https://example.com"

gcloud.cmd run deploy lens-api `
  --image "$env:REGION-docker.pkg.dev/$env:PROJECT_ID/$env:REPO/lens-api:$env:TAG" `
  --region $env:REGION `
  --platform managed `
  --allow-unauthenticated `
  --port 8000 `
  --add-cloudsql-instances $INSTANCE_CONNECTION_NAME `
  --set-env-vars "APP_ENVIRONMENT=production,APP_DATABASE_URL=$APP_DB_URL,APP_APP_DB_URL=$APP_DB_URL,APP_DB_URL=$APP_DB_URL,APP_ANALYTICS_DB_URL=$ANALYTICS_DB_URL,APP_SECRET_KEY=$APP_SECRET_KEY,APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY,APP_ENGINE_BASE_URL=$ENGINE_URL,APP_ENGINE_SERVICE_SECRET=$ENGINE_SERVICE_SECRET,APP_CORS_ORIGINS=$TEMP_CORS_ORIGIN"

```

Capture a URL da API:

```powershell
$API_URL = gcloud.cmd run services describe lens-api --region=$env:REGION --format="value(status.url)"
$API_URL
```

## 7) Segundo build/push (frontend com URL real da API)

```powershell
$env:VITE_API_URL=$API_URL
$env:NEXT_PUBLIC_API_URL=$API_URL

gcloud.cmd builds submit `
  --project=$env:PROJECT_ID `
  --region=$env:REGION `
  --config=cloudbuild.images.yaml `
  --substitutions=_REGION=$env:REGION,_REPO=$env:REPO,_TAG=$env:TAG,_VITE_API_URL=$env:VITE_API_URL,_NEXT_PUBLIC_API_URL=$env:NEXT_PUBLIC_API_URL `
  .
```

## 8) Deploy do Web

```powershell
gcloud.cmd run deploy lens-web `
  --image "$env:REGION-docker.pkg.dev/$env:PROJECT_ID/$env:REPO/lens-web:$env:TAG" `
  --region $env:REGION `
  --platform managed `
  --allow-unauthenticated `
  --port 3000
```

Capture a URL do web:

```powershell
$WEB_URL = gcloud.cmd run services describe lens-web --region=$env:REGION --format="value(status.url)"
$WEB_URL
```

## 9) Atualizar CORS da API para a URL real do Web

Use sempre uma unica origem, reaproveitando a URL capturada no passo 8 (`$WEB_URL`).

```powershell
gcloud.cmd run services update lens-api `
  --region $env:REGION `
  --update-env-vars "APP_CORS_ORIGINS=$WEB_URL"
```

Conferir valor aplicado:

```powershell
gcloud.cmd run services describe lens-api `
  --region $env:REGION `
  --format="value(spec.template.spec.containers[0].env)"
```

## 10) Verificacoes finais

```powershell
Invoke-WebRequest "$API_URL/health"
Invoke-WebRequest "$ENGINE_URL/health"
Invoke-WebRequest "$WEB_URL"
```

## 11) Comandos uteis de troubleshooting

```powershell
gcloud.cmd run services list --region $env:REGION
gcloud.cmd run revisions list --service lens-api --region $env:REGION
gcloud.cmd logging read "resource.type=cloud_run_revision AND resource.labels.service_name=lens-api" --limit=100 --format="value(textPayload)"
```

