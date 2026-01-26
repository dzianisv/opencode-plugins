#!/bin/bash
#
# Deploy Supabase Edge Functions and run migrations
#
# Usage:
#   ./scripts/deploy-supabase.sh              # Deploy all
#   ./scripts/deploy-supabase.sh functions    # Deploy functions only
#   ./scripts/deploy-supabase.sh migrations   # Run migrations only
#   ./scripts/deploy-supabase.sh webhook      # Deploy telegram-webhook only
#   ./scripts/deploy-supabase.sh verify       # Verify webhook configuration
#
# Environment variables required:
#   SUPABASE_ACCESS_TOKEN - Supabase access token for CLI auth
#   SUPABASE_PROJECT_REF  - Project reference ID (default: slqxwymujuoipyiqscrl)
#
# For CI, also set:
#   SUPABASE_DB_PASSWORD  - Database password for migrations
#
# CRITICAL: telegram-webhook MUST be deployed with --no-verify-jwt
# because Telegram sends webhook requests without any Authorization header.
# If you see 401 errors in webhook logs, redeploy with: ./scripts/deploy-supabase.sh webhook
#

set -euo pipefail

# Default project reference
PROJECT_REF="${SUPABASE_PROJECT_REF:-slqxwymujuoipyiqscrl}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    log_error "Supabase CLI not found. Install it with: brew install supabase/tap/supabase"
    exit 1
fi

# Check for access token in CI
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    log_info "Using SUPABASE_ACCESS_TOKEN for authentication"
    export SUPABASE_ACCESS_TOKEN
elif [[ -z "${CI:-}" ]]; then
    log_info "Running locally, using existing supabase login"
else
    log_error "SUPABASE_ACCESS_TOKEN required in CI environment"
    exit 1
fi

# Change to repo root (script may be called from anywhere)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

log_info "Working directory: $REPO_ROOT"
log_info "Project reference: $PROJECT_REF"

deploy_functions() {
    log_info "Deploying Edge Functions..."
    
    # List all functions in supabase/functions directory
    FUNCTIONS_DIR="supabase/functions"
    
    if [[ ! -d "$FUNCTIONS_DIR" ]]; then
        log_warn "No functions directory found at $FUNCTIONS_DIR"
        return 0
    fi
    
    # Find all function directories (those with index.ts)
    for func_dir in "$FUNCTIONS_DIR"/*/; do
        if [[ -f "${func_dir}index.ts" ]]; then
            func_name=$(basename "$func_dir")
            log_info "Deploying function: $func_name"
            
            # CRITICAL: telegram-webhook MUST have --no-verify-jwt
            # Telegram sends webhook requests without any Authorization header.
            # Without this flag, ALL webhook requests fail with 401 Unauthorized.
            if [[ "$func_name" == "telegram-webhook" ]]; then
                log_info "  Using --no-verify-jwt for telegram-webhook (Telegram doesn't send auth headers)"
                if supabase functions deploy "$func_name" --no-verify-jwt --project-ref "$PROJECT_REF"; then
                    log_info "Successfully deployed: $func_name (JWT verification DISABLED)"
                else
                    log_error "Failed to deploy: $func_name"
                    exit 1
                fi
            else
                if supabase functions deploy "$func_name" --project-ref "$PROJECT_REF"; then
                    log_info "Successfully deployed: $func_name"
                else
                    log_error "Failed to deploy: $func_name"
                    exit 1
                fi
            fi
        fi
    done
    
    log_info "All functions deployed successfully"
}

deploy_webhook_only() {
    log_info "Deploying telegram-webhook with --no-verify-jwt..."
    
    # CRITICAL: --no-verify-jwt is REQUIRED for telegram-webhook
    # Telegram sends webhook requests without any Authorization header.
    if supabase functions deploy telegram-webhook --no-verify-jwt --project-ref "$PROJECT_REF"; then
        log_info "Successfully deployed: telegram-webhook (JWT verification DISABLED)"
    else
        log_error "Failed to deploy telegram-webhook"
        exit 1
    fi
    
    # Test the endpoint
    log_info "Testing webhook endpoint..."
    RESPONSE=$(curl -s -X POST "https://$PROJECT_REF.supabase.co/functions/v1/telegram-webhook" \
        -H "Content-Type: application/json" \
        -d '{"update_id": 0, "message": {"message_id": 0, "chat": {"id": 0, "type": "private"}}}' || echo "CURL_FAILED")
    
    if [[ "$RESPONSE" == "OK" ]]; then
        log_info "Webhook test PASSED - endpoint returns OK without auth"
    elif [[ "$RESPONSE" == *"401"* ]] || [[ "$RESPONSE" == *"Unauthorized"* ]]; then
        log_error "Webhook test FAILED - still getting 401!"
        log_error "Response: $RESPONSE"
        log_error "The --no-verify-jwt flag may not have been applied."
        log_error "Try redeploying or check Supabase dashboard."
        exit 1
    else
        log_warn "Webhook returned unexpected response: $RESPONSE"
        log_warn "This may be OK if the function is handling the test request differently."
    fi
}

verify_webhook() {
    log_info "Verifying Telegram webhook configuration..."
    
    # Load TELEGRAM_BOT_TOKEN from .env if not set
    if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -f "$REPO_ROOT/.env" ]]; then
        TELEGRAM_BOT_TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$REPO_ROOT/.env" | cut -d'=' -f2- || true)
    fi
    
    if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
        log_warn "TELEGRAM_BOT_TOKEN not set. Cannot verify Telegram webhook."
        log_warn "Set it in .env or export TELEGRAM_BOT_TOKEN=<token>"
        return 0
    fi
    
    WEBHOOK_URL="https://$PROJECT_REF.supabase.co/functions/v1/telegram-webhook"
    
    log_info "Fetching webhook info from Telegram API..."
    WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")
    
    CURRENT_URL=$(echo "$WEBHOOK_INFO" | jq -r '.result.url // empty')
    LAST_ERROR=$(echo "$WEBHOOK_INFO" | jq -r '.result.last_error_message // empty')
    LAST_ERROR_DATE=$(echo "$WEBHOOK_INFO" | jq -r '.result.last_error_date // empty')
    PENDING=$(echo "$WEBHOOK_INFO" | jq -r '.result.pending_update_count // 0')
    
    # Check webhook URL
    if [[ "$CURRENT_URL" != "$WEBHOOK_URL" ]]; then
        log_error "Webhook URL mismatch!"
        log_error "  Current:  $CURRENT_URL"
        log_error "  Expected: $WEBHOOK_URL"
        log_info "Setting correct webhook URL..."
        
        SET_RESULT=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}")
        if echo "$SET_RESULT" | jq -e '.ok == true' > /dev/null; then
            log_info "Webhook URL set successfully!"
        else
            log_error "Failed to set webhook URL: $SET_RESULT"
            exit 1
        fi
    else
        log_info "Webhook URL is correct: $WEBHOOK_URL"
    fi
    
    # Check for recent errors
    if [[ -n "$LAST_ERROR" ]]; then
        log_error "Last webhook error: $LAST_ERROR"
        if [[ -n "$LAST_ERROR_DATE" ]]; then
            ERROR_TIME=$(date -r "$LAST_ERROR_DATE" 2>/dev/null || date -d "@$LAST_ERROR_DATE" 2>/dev/null || echo "unknown time")
            log_error "Error occurred at: $ERROR_TIME"
        fi
        
        if [[ "$LAST_ERROR" == *"401"* ]] || [[ "$LAST_ERROR" == *"Unauthorized"* ]]; then
            log_error ""
            log_error "=============================================="
            log_error "401 UNAUTHORIZED ERROR DETECTED!"
            log_error "=============================================="
            log_error "This means telegram-webhook was deployed WITHOUT --no-verify-jwt"
            log_error ""
            log_error "FIX: Run ./scripts/deploy-supabase.sh webhook"
            log_error "=============================================="
            exit 1
        fi
    else
        log_info "No recent webhook errors."
    fi
    
    log_info "Pending updates: $PENDING"
    
    # Test the endpoint directly
    log_info "Testing webhook endpoint directly..."
    RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d '{"update_id": 0, "message": {"message_id": 0, "chat": {"id": 0, "type": "private"}}}' || echo "CURL_FAILED")
    
    if [[ "$RESPONSE" == "OK" ]]; then
        log_info "Direct test PASSED - endpoint accepts requests without auth"
    elif [[ "$RESPONSE" == *"401"* ]] || [[ "$RESPONSE" == *"Unauthorized"* ]]; then
        log_error "Direct test FAILED - endpoint requires auth!"
        log_error "Run: ./scripts/deploy-supabase.sh webhook"
        exit 1
    else
        log_info "Direct test returned: $RESPONSE"
    fi
    
    log_info "Webhook verification complete!"
}

run_migrations() {
    log_info "Running database migrations..."
    
    # In CI, we need to link the project first (db push doesn't accept --project-ref)
    if [[ -n "${CI:-}" ]]; then
        if [[ -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
            log_warn "SUPABASE_DB_PASSWORD not set, skipping migrations in CI"
            log_warn "Migrations should be run manually or via Supabase dashboard"
            return 0
        fi
        
        log_info "Linking project in CI..."
        if ! supabase link --project-ref "$PROJECT_REF"; then
            log_error "Failed to link project"
            exit 1
        fi
    fi
    
    # Push migrations to remote database
    if supabase db push --password "${SUPABASE_DB_PASSWORD:-}"; then
        log_info "Migrations applied successfully"
    else
        log_error "Failed to apply migrations"
        exit 1
    fi
}

show_help() {
    echo "Supabase Deployment Script"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  all          Deploy everything (migrations + functions) [default]"
    echo "  functions    Deploy Edge Functions only"
    echo "  migrations   Run database migrations only"
    echo "  webhook      Deploy telegram-webhook only (with --no-verify-jwt)"
    echo "  verify       Verify Telegram webhook configuration"
    echo "  help         Show this help message"
    echo ""
    echo "Environment variables:"
    echo "  SUPABASE_ACCESS_TOKEN   CLI authentication token (required in CI)"
    echo "  SUPABASE_PROJECT_REF    Project reference (default: slqxwymujuoipyiqscrl)"
    echo "  SUPABASE_DB_PASSWORD    Database password (for migrations in CI)"
    echo "  TELEGRAM_BOT_TOKEN      Bot token for webhook verification"
    echo ""
    echo "CRITICAL NOTES:"
    echo "  - telegram-webhook MUST be deployed with --no-verify-jwt"
    echo "  - Telegram sends requests without Authorization headers"
    echo "  - If you see 401 errors, run: $0 webhook"
    echo ""
    echo "Examples:"
    echo "  $0                 # Deploy everything"
    echo "  $0 webhook         # Fix 401 errors by redeploying webhook"
    echo "  $0 verify          # Check if webhook is configured correctly"
}

# Parse command line argument
COMMAND="${1:-all}"

case "$COMMAND" in
    functions)
        deploy_functions
        verify_webhook
        ;;
    migrations)
        run_migrations
        ;;
    webhook)
        deploy_webhook_only
        verify_webhook
        ;;
    verify)
        verify_webhook
        ;;
    all)
        run_migrations
        deploy_functions
        verify_webhook
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "Unknown command: $COMMAND"
        show_help
        exit 1
        ;;
esac

log_info "Deployment complete!"
