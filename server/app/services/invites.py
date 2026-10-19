from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..models import InviteCode


REGISTRATION_MODES = ("open", "invite")
INVITE_CODE_BYTES = 16


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def generate_invite_code() -> str:
    return secrets.token_urlsafe(INVITE_CODE_BYTES)


def hash_invite_code(code: str) -> str:
    return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()


def create_invite_code(
    db: Session,
    created_by: str,
    max_uses: int = 1,
    expires_in_days: int | None = None,
    note: str | None = None,
) -> tuple[InviteCode, str]:
    code = generate_invite_code()
    expires_at = None
    if expires_in_days is not None:
        expires_at = _utcnow() + timedelta(days=expires_in_days)
    invite = InviteCode(
        code_hash=hash_invite_code(code),
        code_prefix=code[:8],
        created_by=created_by,
        expires_at=expires_at,
        max_uses=max_uses,
        note=note,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return invite, code


def invite_status(invite: InviteCode, now: datetime | None = None) -> str:
    if invite.revoked_at is not None:
        return "revoked"
    current = now if now is not None else _utcnow()
    if current.tzinfo is not None:
        current = current.astimezone(timezone.utc).replace(tzinfo=None)
    if invite.expires_at is not None:
        expires_at = invite.expires_at
        if expires_at.tzinfo is not None:
            expires_at = expires_at.astimezone(timezone.utc).replace(tzinfo=None)
        if expires_at <= current:
            return "expired"
    if invite.use_count >= invite.max_uses:
        return "used"
    return "active"


def check_invite_code(db: Session, code: str) -> InviteCode | None:
    code_hash = hash_invite_code(code)
    invite = db.execute(
        select(InviteCode).where(InviteCode.code_hash == code_hash)
    ).scalar_one_or_none()
    if invite is None:
        return None
    if not hmac.compare_digest(invite.code_hash, code_hash):
        return None
    if invite_status(invite) != "active":
        return None
    return invite


def consume_invite_code(db: Session, code: str) -> InviteCode | None:
    code_hash = hash_invite_code(code)
    now = _utcnow()
    result = db.execute(
        update(InviteCode)
        .where(
            InviteCode.code_hash == code_hash,
            InviteCode.use_count < InviteCode.max_uses,
            InviteCode.revoked_at.is_(None),
            (InviteCode.expires_at.is_(None)) | (InviteCode.expires_at > now),
        )
        .values(use_count=InviteCode.use_count + 1)
    )
    if result.rowcount != 1:
        return None
    return db.execute(
        select(InviteCode)
        .where(InviteCode.code_hash == code_hash)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
