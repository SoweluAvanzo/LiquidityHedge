# LP Strategy v2 - Fly.io Deployment
# Multi-stage build for smaller image size
#
# Deploy from STLService/ root directory:
# cd /path/to/STLService && flyctl deploy -c test_deployment_v2/fly.toml
# Or use: ./test_deployment_v2/deploy.sh deploy

FROM python:3.11-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy requirements file (from test_deployment_v2/ subdirectory)
COPY test_deployment_v2/requirements.txt ./

# Install dependencies
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

# Final stage
FROM python:3.11-slim

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

# Copy wheels from builder and install
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir /wheels/* && rm -rf /wheels

# Copy the app module (chain clients, orca_client, etc.)
# From the test_deployment_v2/app/ subdirectory
COPY test_deployment_v2/app/ ./app/

# Cache bust - increment this to force rebuild of subsequent layers
# IMPORTANT: This invalidates cache for the Python files COPY below
ARG CACHE_BUST=20260113_wsol_cleanup_fix_v2
RUN echo "Cache bust: $CACHE_BUST" && echo "$CACHE_BUST" > /tmp/.cache_bust && date

# Copy strategy modules (all .py files from test_deployment_v2)
# NOTE: Docker caches this layer. Changing CACHE_BUST above forces rebuild.
# The cache bust file is created before this COPY to ensure fresh copy.
COPY test_deployment_v2/*.py ./

# Verify session_manager.py syntax (fail build if error)
RUN python3 -m py_compile session_manager.py || (echo "ERROR: session_manager.py has syntax errors!" && exit 1)

# Verify lp_strategy.py syntax and check for cleanup_before_open bug
RUN python3 -m py_compile lp_strategy.py || (echo "ERROR: lp_strategy.py has syntax errors!" && exit 1) && \
    python3 -c "import re; code = open('lp_strategy.py').read(); matches = re.findall(r'cleanup_before_open', code); exit(1 if matches else 0)" || \
    (echo "ERROR: Found 'cleanup_before_open' in lp_strategy.py - this attribute doesn't exist!" && exit 1)

# Create data directory for persistent storage
RUN mkdir -p /data && chown -R appuser:appuser /data

# Set ownership
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV DATA_DIR=/data
ENV HEALTH_PORT=8080

# Expose health check port
EXPOSE 8080

# Health check via HTTP endpoint
HEALTHCHECK --interval=60s --timeout=30s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Default command - run the LP strategy
CMD ["python", "lp_strategy.py"]
