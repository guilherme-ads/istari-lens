cd $(dirname "$0")

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Istari Lens MVP - Validation Script ===${NC}\n"

# Check if Docker is running
echo "Checking Docker..."
if ! docker info > /dev/null 2>&1; then
    echo "Docker is not running. Please start Docker."
    exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}\n"

# Check if services are up
echo "Checking services..."
SERVICES=('istari_app_db' 'istari_analytics_db' 'istari_api' 'istari_web')

for service in "${SERVICES[@]}"; do
    if docker ps | grep -q "$service"; then
        echo -e "${GREEN}✓ $service is running${NC}"
    else
        echo "✗ $service is not running"
    fi
done

echo ""
echo -e "${BLUE}=== URLs ===${NC}"
echo "Frontend: http://localhost:3000"
echo "API Docs: http://localhost:8000/docs"
echo "Health: http://localhost:8000/health"
echo ""

echo -e "${BLUE}=== Demo Credentials ===${NC}"
echo "Admin:"
echo "  Email: admin@local"
echo "  Password: admin123"
echo ""
echo "User:"
echo "  Email: user@example.com"
echo "  Password: password"
echo ""

echo -e "${GREEN}Ready to test!${NC}"
