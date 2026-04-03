#!/bin/bash
# LP Strategy v2 - Fly.io Deployment Script
#
# Usage:
#   ./deploy.sh                  # Deploy with current settings
#   ./deploy.sh --dry-run        # Deploy in dry-run mode
#   ./deploy.sh --secrets        # Set/update secrets interactively
#   ./deploy.sh --status         # Check deployment status
#   ./deploy.sh --logs           # Stream logs

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

APP_NAME="lp-strategy-v2"
FLY_CONFIG="$SCRIPT_DIR/fly.toml"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}LP Strategy v2 - Fly.io Deployment${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo -e "${RED}Error: flyctl is not installed${NC}"
    echo "Install it from: https://fly.io/docs/hands-on/install-flyctl/"
    exit 1
fi

# Check if authenticated
if ! flyctl auth whoami &> /dev/null; then
    echo -e "${YELLOW}Not logged in. Running 'flyctl auth login'...${NC}"
    flyctl auth login
fi

# Parse arguments
case "${1:-deploy}" in
    --secrets|-s)
        echo -e "${YELLOW}Setting secrets...${NC}"
        echo ""
        echo "Enter secrets (press Enter to skip):"
        echo ""
        echo -e "${RED}=== REQUIRED SECRETS ===${NC}"
        echo ""

        read -p "WALLET_PRIVATE_KEY_BASE58: " WALLET_KEY
        if [ -n "$WALLET_KEY" ]; then
            flyctl secrets set WALLET_PRIVATE_KEY_BASE58="$WALLET_KEY" -a "$APP_NAME"
        fi

        read -p "SOLANA_RPC_URL: " RPC_URL
        if [ -n "$RPC_URL" ]; then
            flyctl secrets set SOLANA_RPC_URL="$RPC_URL" -a "$APP_NAME"
        fi

        read -p "BIRDEYE_API_KEY: " BIRDEYE_KEY
        if [ -n "$BIRDEYE_KEY" ]; then
            flyctl secrets set BIRDEYE_API_KEY="$BIRDEYE_KEY" -a "$APP_NAME"
        fi

        read -p "JUPITER_API_KEY: " JUPITER_KEY
        if [ -n "$JUPITER_KEY" ]; then
            flyctl secrets set JUPITER_API_KEY="$JUPITER_KEY" -a "$APP_NAME"
        fi

        echo ""
        echo -e "${YELLOW}=== OPTIONAL SECRETS ===${NC}"
        echo "(For monitoring an existing position)"
        echo ""

        read -p "POSITION_ADDRESS (existing position to monitor): " POSITION_ADDR
        if [ -n "$POSITION_ADDR" ]; then
            flyctl secrets set POSITION_ADDRESS="$POSITION_ADDR" -a "$APP_NAME"
        fi

        read -p "OPEN_PRICE (price when position was opened): " OPEN_PRICE
        if [ -n "$OPEN_PRICE" ]; then
            flyctl secrets set OPEN_PRICE="$OPEN_PRICE" -a "$APP_NAME"
        fi

        echo ""
        echo -e "${GREEN}Secrets updated!${NC}"
        echo ""
        flyctl secrets list -a "$APP_NAME"
        ;;

    --status)
        echo -e "${YELLOW}Checking status...${NC}"
        echo ""
        flyctl status -a "$APP_NAME"
        echo ""
        echo -e "${YELLOW}Machines:${NC}"
        flyctl machines list -a "$APP_NAME"
        echo ""
        echo -e "${YELLOW}Health check:${NC}"
        curl -s "https://${APP_NAME}.fly.dev/health" | jq . || echo "Health endpoint not responding"
        ;;

    --logs|-l)
        echo -e "${YELLOW}Streaming logs (Ctrl+C to stop)...${NC}"
        flyctl logs -a "$APP_NAME"
        ;;

    --ssh)
        echo -e "${YELLOW}Connecting to machine...${NC}"
        flyctl ssh console -a "$APP_NAME"
        ;;

    --restart)
        echo -e "${YELLOW}Restarting app...${NC}"
        flyctl apps restart "$APP_NAME"
        echo -e "${GREEN}Restarted!${NC}"
        ;;

    --stop)
        echo -e "${YELLOW}Stopping app (scaling to 0)...${NC}"
        flyctl scale count 0 -a "$APP_NAME"
        echo -e "${GREEN}Stopped!${NC}"
        ;;

    --start)
        echo -e "${YELLOW}Starting app (scaling to 1)...${NC}"
        flyctl scale count 1 -a "$APP_NAME"
        echo -e "${GREEN}Started!${NC}"
        ;;

    --dry-run)
        echo -e "${YELLOW}Setting DRY_RUN=true...${NC}"
        flyctl secrets set DRY_RUN=true -a "$APP_NAME"
        echo -e "${GREEN}Dry-run mode enabled!${NC}"
        ;;

    --live)
        echo -e "${RED}WARNING: This will enable LIVE trading!${NC}"
        read -p "Are you sure? (yes/no): " CONFIRM
        if [ "$CONFIRM" = "yes" ]; then
            flyctl secrets set DRY_RUN=false -a "$APP_NAME"
            echo -e "${GREEN}Live mode enabled!${NC}"
        else
            echo "Cancelled."
        fi
        ;;

    deploy|--deploy)
        echo -e "${YELLOW}Deploying to fly.io...${NC}"
        echo "Project root: $PROJECT_ROOT"
        echo "Config file: $FLY_CONFIG"
        echo ""

        cd "$PROJECT_ROOT"
        flyctl deploy -c "$FLY_CONFIG"

        echo ""
        echo -e "${GREEN}Deployment complete!${NC}"
        echo ""
        echo "Check status: ./deploy.sh --status"
        echo "View logs:    ./deploy.sh --logs"
        echo "Health URL:   https://${APP_NAME}.fly.dev/health"
        ;;

    --help|-h)
        echo "Usage: ./deploy.sh [command]"
        echo ""
        echo "Commands:"
        echo "  deploy      Deploy the app (default)"
        echo "  --secrets   Set/update secrets interactively"
        echo "  --status    Check deployment status"
        echo "  --logs      Stream logs"
        echo "  --ssh       SSH into running machine"
        echo "  --restart   Restart the app"
        echo "  --stop      Stop the app"
        echo "  --start     Start the app"
        echo "  --dry-run   Enable dry-run mode"
        echo "  --live      Enable live trading mode"
        echo "  --help      Show this help"
        ;;

    *)
        echo -e "${RED}Unknown command: $1${NC}"
        echo "Use --help for usage information"
        exit 1
        ;;
esac
