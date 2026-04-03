"""
Main FastAPI application for multi-user LP strategy platform.

This is the entry point for the API server. Run with:
    uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload

Or in production:
    gunicorn api.main:app -w 4 -k uvicorn.workers.UvicornWorker
"""

import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# =============================================================================
# DATABASE DEPENDENCY
# =============================================================================

async def get_db() -> AsyncSession:
    """
    Database session dependency.

    Provides async database sessions for request handlers.
    """
    from app.db.session import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


# =============================================================================
# LIFESPAN MANAGEMENT
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.

    Handles startup and shutdown events.
    """
    # Startup
    logger.info("Starting LP Strategy Multi-User API...")

    # Verify required environment variables
    required_vars = [
        "DATABASE_URL",
        "JWT_SECRET_KEY",
        "ENCRYPTION_MASTER_KEY",
    ]

    missing = [var for var in required_vars if not os.getenv(var)]
    if missing:
        logger.warning(f"Missing environment variables: {missing}")

    # Initialize Celery connection
    try:
        from tasks.celery_app import celery_app
        logger.info("Celery app initialized")
    except Exception as e:
        logger.warning(f"Celery not available: {e}")

    logger.info("API startup complete")

    yield  # Application runs here

    # Shutdown
    logger.info("Shutting down LP Strategy API...")


# =============================================================================
# APPLICATION FACTORY
# =============================================================================

def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""

    app = FastAPI(
        title="LP Strategy Multi-User Platform API",
        description="""
        REST API for the SOL/USDC concentrated liquidity management platform.

        ## Authentication
        Uses Sign In With Solana (SIWS) for wallet-based authentication.
        1. Request a nonce via POST /api/auth/nonce
        2. Sign the message with your Solana wallet
        3. Verify signature via POST /api/auth/verify to get JWT token
        4. Include token in Authorization header: `Bearer <token>`

        ## Features
        - User profile and settings management
        - Strategy configuration (range params, rebalance rules, etc.)
        - Strategy session lifecycle (start/pause/resume/stop)
        - Portfolio overview and position tracking
        - Historical data and CSV export
        """,
        version="2.0.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    # CORS configuration
    cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Import routers
    from api import auth, users, strategy, sessions, portfolio

    # Include routers
    app.include_router(auth.router, prefix="/api")
    app.include_router(users.router, prefix="/api")
    app.include_router(strategy.router, prefix="/api")
    app.include_router(sessions.router, prefix="/api")
    app.include_router(portfolio.router, prefix="/api")

    # Health check endpoint
    @app.get("/health", tags=["health"])
    async def health_check():
        """Health check endpoint for load balancers."""
        return {
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": "2.0.0",
        }

    @app.get("/api/health", tags=["health"])
    async def api_health_check():
        """API health check with database connectivity test."""
        try:
            from app.db.session import AsyncSessionLocal
            async with AsyncSessionLocal() as session:
                await session.execute(text("SELECT 1"))
            db_status = "connected"
        except Exception as e:
            db_status = f"error: {e}"

        return {
            "status": "healthy" if db_status == "connected" else "degraded",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "database": db_status,
            "version": "2.0.0",
        }

    # Global exception handler
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        logger.exception(f"Unhandled exception: {exc}")
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Internal server error",
                "type": type(exc).__name__,
            }
        )

    return app


# Create application instance
app = create_app()


# =============================================================================
# WEBSOCKET ENDPOINT
# =============================================================================

from fastapi import WebSocket, WebSocketDisconnect


class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    def __init__(self):
        # Map of user_id -> list of WebSocket connections
        self.active_connections: dict[int, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, user_id: int):
        await websocket.accept()
        if user_id not in self.active_connections:
            self.active_connections[user_id] = []
        self.active_connections[user_id].append(websocket)
        logger.info(f"WebSocket connected for user {user_id}")

    def disconnect(self, websocket: WebSocket, user_id: int):
        if user_id in self.active_connections:
            if websocket in self.active_connections[user_id]:
                self.active_connections[user_id].remove(websocket)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
        logger.info(f"WebSocket disconnected for user {user_id}")

    async def send_to_user(self, user_id: int, message: dict):
        """Send message to all connections for a user."""
        if user_id in self.active_connections:
            for connection in self.active_connections[user_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.warning(f"Failed to send WS message: {e}")

    async def broadcast(self, message: dict):
        """Broadcast message to all connected users."""
        for user_id in self.active_connections:
            await self.send_to_user(user_id, message)


manager = ConnectionManager()


@app.websocket("/ws/portfolio")
async def websocket_endpoint(websocket: WebSocket, token: str = None):
    """
    WebSocket endpoint for real-time portfolio updates.

    Clients should connect with their JWT token as a query parameter:
    ws://host/ws/portfolio?token=<jwt_token>

    Messages sent:
    - {"type": "position_update", "data": {...}}
    - {"type": "metrics_update", "data": {...}}
    - {"type": "rebalance", "data": {...}}
    - {"type": "error", "data": {...}}
    """
    from api.auth import decode_token

    # Verify token
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except Exception as e:
        await websocket.close(code=4001, reason=f"Invalid token: {e}")
        return

    await manager.connect(websocket, user_id)

    try:
        # Send initial connection confirmation
        await websocket.send_json({
            "type": "connected",
            "data": {"user_id": user_id}
        })

        # Keep connection alive and handle incoming messages
        while True:
            try:
                # Receive message (can be ping/pong or commands)
                data = await websocket.receive_json()

                if data.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})

            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.warning(f"WebSocket receive error: {e}")
                break

    finally:
        manager.disconnect(websocket, user_id)


# Export connection manager for use by Celery workers
def get_ws_manager() -> ConnectionManager:
    """Get the WebSocket connection manager."""
    return manager


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("API_PORT", "8000")),
        reload=os.getenv("ENV", "development") == "development",
    )
