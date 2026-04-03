"""
Celery application configuration for strategy execution.

Configure broker and backend via environment variables:
- CELERY_BROKER_URL: Redis connection for message queue
- CELERY_RESULT_BACKEND: Redis connection for task results

Run workers with:
    celery -A tasks.celery_app worker --loglevel=info --concurrency=4

Run beat scheduler (for periodic tasks) with:
    celery -A tasks.celery_app beat --loglevel=info
"""

import os
import logging

from celery import Celery

logger = logging.getLogger(__name__)

# =============================================================================
# CELERY CONFIGURATION
# =============================================================================

# Get broker URL from environment
BROKER_URL = os.getenv(
    "CELERY_BROKER_URL",
    os.getenv("REDIS_URL", "redis://localhost:6379/0")
)

RESULT_BACKEND = os.getenv(
    "CELERY_RESULT_BACKEND",
    os.getenv("REDIS_URL", "redis://localhost:6379/0")
)

# Create Celery app
celery_app = Celery(
    "lp_strategy",
    broker=BROKER_URL,
    backend=RESULT_BACKEND,
    include=[
        "tasks.strategy_tasks",
    ]
)

# Configure Celery
celery_app.conf.update(
    # Task settings
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,

    # Task execution settings
    task_acks_late=True,  # Acknowledge after task completes (for reliability)
    task_reject_on_worker_lost=True,  # Retry if worker crashes
    task_time_limit=86400,  # 24 hours max per task
    task_soft_time_limit=82800,  # 23 hours soft limit (graceful stop)

    # Worker settings
    worker_prefetch_multiplier=1,  # One task at a time per worker
    worker_max_tasks_per_child=100,  # Restart worker after 100 tasks (memory leak prevention)
    worker_disable_rate_limits=True,

    # Result backend settings
    result_expires=86400,  # Results expire after 24 hours
    result_extended=True,  # Store task args/kwargs in result

    # Retry settings
    task_default_retry_delay=60,  # 1 minute between retries
    task_max_retries=3,

    # Beat scheduler settings (for periodic tasks)
    beat_schedule={
        # Clean up old metric snapshots every hour
        "cleanup-old-snapshots": {
            "task": "tasks.strategy_tasks.cleanup_old_snapshots",
            "schedule": 3600.0,  # Every hour
        },
        # Clean up expired nonces every 5 minutes
        "cleanup-expired-nonces": {
            "task": "tasks.strategy_tasks.cleanup_expired_nonces",
            "schedule": 300.0,  # Every 5 minutes
        },
    },

    # Task routing (optional - for task-specific queues)
    task_routes={
        "tasks.strategy_tasks.run_user_strategy_session": {"queue": "strategy"},
        "tasks.strategy_tasks.cleanup_*": {"queue": "maintenance"},
    },

    # Default queue
    task_default_queue="default",
)


# =============================================================================
# TASK STATE SIGNALS
# =============================================================================

@celery_app.task(bind=True)
def debug_task(self):
    """Debug task for testing Celery connectivity."""
    print(f"Request: {self.request!r}")
    return {"status": "ok", "worker": self.request.hostname}


# Log Celery events
from celery.signals import (
    task_prerun,
    task_postrun,
    task_failure,
    task_success,
    worker_ready,
)


@worker_ready.connect
def worker_ready_handler(sender, **kwargs):
    """Log when worker is ready."""
    logger.info(f"Celery worker ready: {sender}")


@task_prerun.connect
def task_prerun_handler(task_id, task, args, kwargs, **kw):
    """Log task start."""
    logger.info(f"Task starting: {task.name}[{task_id}]")


@task_postrun.connect
def task_postrun_handler(task_id, task, args, kwargs, retval, state, **kw):
    """Log task completion."""
    logger.info(f"Task completed: {task.name}[{task_id}] - {state}")


@task_failure.connect
def task_failure_handler(task_id, exception, args, kwargs, traceback, einfo, **kw):
    """Log task failure."""
    logger.error(f"Task failed: {task_id} - {exception}")
