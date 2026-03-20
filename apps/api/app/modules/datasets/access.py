from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.modules.core.legacy.models import DataSource, Dataset, DatasetEmailShare, User


def normalize_email(value: str) -> str:
    return value.strip().lower()


def can_view_organization_data(user: User | None) -> bool:
    if user is None:
        return False
    return bool(getattr(user, "is_admin", False) or getattr(user, "is_owner", False))


def resolve_user_role(user: User) -> str:
    if getattr(user, "is_admin", False):
        return "ADMIN"
    if getattr(user, "is_owner", False):
        return "OWNER"
    return "USER"


def can_view_datasource(*, datasource: DataSource | None, user: User) -> bool:
    if datasource is None:
        return False
    if can_view_organization_data(user):
        return True
    return int(datasource.created_by_id) == int(user.id)


def can_manage_dataset(*, dataset: Dataset | None, user: User) -> bool:
    if dataset is None:
        return False
    if getattr(user, "is_admin", False):
        return True
    datasource = dataset.datasource
    if datasource is None:
        return False
    return int(datasource.created_by_id) == int(user.id)


def can_view_dataset(*, dataset: Dataset | None, user: User) -> bool:
    if dataset is None:
        return False
    if can_view_organization_data(user):
        return True

    datasource = dataset.datasource
    if datasource is not None and int(datasource.created_by_id) == int(user.id):
        return True

    target_email = normalize_email(user.email)
    for share in dataset.email_shares or []:
        if normalize_email(share.email) == target_email:
            return True
    return False


def ensure_dataset_view_access(*, dataset: Dataset | None, user: User) -> None:
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    if not can_view_dataset(dataset=dataset, user=user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")


def ensure_dataset_manage_access(*, dataset: Dataset | None, user: User) -> None:
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    if not can_manage_dataset(dataset=dataset, user=user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission for this dataset action")


def load_dataset_with_access_relations(*, db: Session, dataset_id: int) -> Dataset | None:
    return (
        db.query(Dataset)
        .options(joinedload(Dataset.datasource), joinedload(Dataset.email_shares))
        .filter(Dataset.id == dataset_id)
        .first()
    )


def find_dataset_email_share(
    *,
    db: Session,
    dataset_id: int,
    normalized_email: str,
) -> DatasetEmailShare | None:
    return (
        db.query(DatasetEmailShare)
        .filter(
            DatasetEmailShare.dataset_id == dataset_id,
            DatasetEmailShare.email == normalized_email,
        )
        .first()
    )
