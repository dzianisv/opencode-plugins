#!/bin/bash
#
# Deploy Supabase Edge Functions and run migrations
#
# Usage:
#   ./scripts/deploy-supabase.sh              # Deploy all
#   ./scripts/deploy-supabase.sh functions    # Deploy functions only
#   ./scripts/deploy-supabase.sh migrations   # Run migrations only
#
# Environment variables required:
#   SUPABASE_ACCESS_TOKEN - Supabase access token for CLI auth
#   SUPABASE_PROJECT_REF  - Project reference ID (default: slqxwymujuoipyiqscrl)
#
# For CI, also set:
#   SUPABASE_DB_PASSWORD  - Database password for migrations
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
            
            if supabase functions deploy "$func_name" --project-ref "$PROJECT_REF"; then
                log_info "Successfully deployed: $func_name"
            else
                log_error "Failed to deploy: $func_name"
                exit 1
            fi
        fi
    done
    
    log_info "All functions deployed successfully"
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

# Parse command line argument
COMMAND="${1:-all}"

case "$COMMAND" in
    functions)
        deploy_functions
        ;;
    migrations)
        run_migrations
        ;;
    all)
        run_migrations
        deploy_functions
        ;;
    *)
        log_error "Unknown command: $COMMAND"
        echo "Usage: $0 [functions|migrations|all]"
        exit 1
        ;;
esac

log_info "Deployment complete!"
