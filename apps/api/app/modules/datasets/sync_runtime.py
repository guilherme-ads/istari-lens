from __future__ import annotations

import logging
import threading
from typing import Iterable

from app.modules.datasets.sync_services import DatasetSyncSchedulerService, DatasetSyncWorkerService
from app.shared.infrastructure.settings import Settings, get_settings

logger = logging.getLogger(__name__)


class DatasetSyncRuntimeManager:
    def __init__(
        self,
        *,
        settings: Settings | None = None,
        scheduler_service: DatasetSyncSchedulerService | None = None,
        worker_service: DatasetSyncWorkerService | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._scheduler_service = scheduler_service or DatasetSyncSchedulerService(settings=self._settings)
        self._worker_service = worker_service or DatasetSyncWorkerService(settings=self._settings)
        self._stop_event = threading.Event()
        self._threads: list[threading.Thread] = []
        self._started = False
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            if not bool(getattr(self._settings, "dataset_sync_runtime_enabled", True)):
                logger.info("Dataset sync runtime disabled by settings")
                return
            if self._settings.environment == "test":
                logger.info("Dataset sync runtime disabled in test environment")
                return

            self._stop_event.clear()
            scheduler_thread = threading.Thread(
                target=self._scheduler_loop,
                name="dataset-sync-scheduler",
                daemon=True,
            )
            worker_thread = threading.Thread(
                target=self._worker_loop,
                name="dataset-sync-worker",
                daemon=True,
            )
            self._threads = [scheduler_thread, worker_thread]
            for thread in self._threads:
                thread.start()
            self._started = True
            logger.info("Dataset sync runtime started")

    def stop(self) -> None:
        with self._lock:
            if not self._started:
                return
            self._stop_event.set()
            self._join_threads(self._threads)
            self._threads = []
            self._started = False
            logger.info("Dataset sync runtime stopped")

    def _scheduler_loop(self) -> None:
        startup_delay = max(0, int(getattr(self._settings, "dataset_sync_runtime_startup_delay_seconds", 5)))
        if startup_delay > 0 and self._stop_event.wait(startup_delay):
            return
        interval_seconds = max(5, int(getattr(self._settings, "dataset_sync_scheduler_interval_seconds", 30)))
        while not self._stop_event.is_set():
            try:
                enqueued = self._scheduler_service.enqueue_due_runs()
                if enqueued > 0:
                    logger.info("Dataset sync scheduler enqueued %s run(s)", enqueued)
            except Exception:
                logger.exception("Dataset sync scheduler loop failed")
            self._stop_event.wait(interval_seconds)

    def _worker_loop(self) -> None:
        idle_seconds = max(1, int(getattr(self._settings, "dataset_sync_worker_idle_seconds", 3)))
        while not self._stop_event.is_set():
            processed = False
            try:
                processed = self._worker_service.process_next_queued_run()
            except Exception:
                logger.exception("Dataset sync worker loop failed")

            if not processed:
                self._stop_event.wait(idle_seconds)

    @staticmethod
    def _join_threads(threads: Iterable[threading.Thread]) -> None:
        for thread in threads:
            try:
                thread.join(timeout=3)
            except Exception:
                logger.exception("Failed joining runtime thread: %s", thread.name)

