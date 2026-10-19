"""Coverage for registration modes, invite codes, and runtime mode switching."""

import secrets
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app import main
from app.db import Base, get_db
from app.models import InviteCode, User
from app.services import storage
from app.services.invites import consume_invite_code, create_invite_code
from app.settings import Settings


ADMIN_HASH = "of1_" + secrets.token_urlsafe(45)
INVALID_CODE_DETAIL = "Invalid invite code"


def _config(tmp_path, *, mode=None, admin_hash=ADMIN_HASH, admin_username="admin"):
    kwargs = {
        "_env_file": None,
        "database_url": f"sqlite:///{tmp_path / 'test.db'}",
        "data_dir": tmp_path,
        "music_dir": tmp_path / "music",
        "downloads_dir": tmp_path / "downloads",
        "artwork_dir": tmp_path / "artwork",
        "admin_username": admin_username,
        "admin_hash": admin_hash,
    }
    if mode is not None:
        kwargs["registration_mode"] = mode
    return Settings(**kwargs)


def _wire(tmp_path, monkeypatch, config):
    engine = create_engine(config.database_url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys = ON")

    sessions = sessionmaker(bind=engine, autoflush=False)
    Base.metadata.create_all(engine)
    monkeypatch.setattr(main, "settings", config)
    monkeypatch.setattr(storage, "settings", config)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "SessionLocal", sessions)
    monkeypatch.setattr(main, "_prefetch_artist_images", lambda: None)
    main._rate_limit_store.clear()

    def override_db():
        with sessions() as db:
            yield db

    main.app.dependency_overrides[get_db] = override_db
    return SimpleNamespace(config=config, engine=engine, sessions=sessions, tmp_path=tmp_path)


@pytest.fixture
def wired_env(tmp_path, monkeypatch):
    env = _wire(tmp_path, monkeypatch, _config(tmp_path))
    yield env
    main.app.dependency_overrides.pop(get_db)
    main._rate_limit_store.clear()
    env.engine.dispose()


@pytest.fixture
def invites_env(wired_env):
    wired_env.client = TestClient(main.app)
    main._startup()
    yield wired_env
    wired_env.client.close()


def _admin_headers(env):
    return {"x-auth-hash": env.config.admin_hash}


def _make_invite(env, **kwargs):
    with env.sessions() as db:
        invite, code = create_invite_code(db, created_by="admin", **kwargs)
        return invite.id, code


def _invite_use_count(env, invite_id):
    with env.sessions() as db:
        return db.get(InviteCode, invite_id).use_count


def _user_exists(env, name):
    with env.sessions() as db:
        return db.execute(select(User).where(User.name == name)).scalar_one_or_none() is not None


def _signup(env, name, code=None):
    payload = {"name": name}
    if code is not None:
        payload["invite_code"] = code
    return env.client.post("/auth/signup", json=payload)


def test_open_mode_allows_signup_without_code_and_does_not_consume_supplied_code(invites_env):
    env = invites_env
    assert env.client.put(
        "/admin/registration-mode", json={"mode": "open"}, headers=_admin_headers(env)
    ).status_code == 200
    invite_id, code = _make_invite(env)

    response = _signup(env, "open-no-code")
    assert response.status_code == 200
    assert _user_exists(env, "open-no-code")

    response = _signup(env, "open-with-code", code=code)
    assert response.status_code == 200
    assert response.json()["name"] == "open-with-code"
    assert _invite_use_count(env, invite_id) == 0


@pytest.mark.parametrize("invalid", ["missing", "unknown", "expired", "revoked", "exhausted"])
def test_invite_mode_rejects_invalid_codes(invites_env, invalid):
    env = invites_env
    name = f"rejected-{invalid}"
    code = None
    invite_id = None
    if invalid == "unknown":
        code = "definitely-not-a-real-code"
    elif invalid in {"expired", "revoked", "exhausted"}:
        invite_id, code = _make_invite(env)

    if invalid == "expired":
        with env.sessions() as db:
            invite = db.get(InviteCode, invite_id)
            invite.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)
            db.commit()
    elif invalid == "revoked":
        response = env.client.delete(f"/admin/invites/{invite_id}", headers=_admin_headers(env))
        assert response.status_code == 200
    elif invalid == "exhausted":
        first = _signup(env, f"{name}-first", code=code)
        assert first.status_code == 200
        assert _invite_use_count(env, invite_id) == 1

    response = _signup(env, name, code=code)
    assert response.status_code == 400
    assert response.json() == {"detail": INVALID_CODE_DETAIL}
    assert not _user_exists(env, name)


def test_single_use_invite_race_between_sessions(invites_env):
    env = invites_env
    invite_id, code = _make_invite(env, max_uses=1)

    with env.sessions() as winner_session:
        winner = consume_invite_code(winner_session, code)
        assert winner is not None
        assert winner.id == invite_id
        winner_session.commit()

    with env.sessions() as loser_session:
        assert consume_invite_code(loser_session, code) is None
        loser_session.rollback()

    assert _invite_use_count(env, invite_id) == 1


def test_single_use_invite_allows_exactly_one_signup(invites_env):
    env = invites_env
    invite_id, code = _make_invite(env, max_uses=1)

    first = _signup(env, "race-first", code=code)
    second = _signup(env, "race-second", code=code)

    assert first.status_code == 200
    assert second.status_code == 400
    assert second.json() == {"detail": INVALID_CODE_DETAIL}
    assert _user_exists(env, "race-first")
    assert not _user_exists(env, "race-second")
    assert _invite_use_count(env, invite_id) == 1


def test_duplicate_username_rolls_back_invite_consumption(invites_env):
    env = invites_env
    invite_id, code = _make_invite(env)
    with env.sessions() as db:
        db.add(User(name="existing-user", auth_hash="e" * 64))
        db.commit()

    response = _signup(env, "existing-user", code=code)
    assert response.status_code == 409
    assert response.json() == {"detail": "Username taken"}
    assert _invite_use_count(env, invite_id) == 0

    retry = _signup(env, "fresh-user", code=code)
    assert retry.status_code == 200
    assert _invite_use_count(env, invite_id) == 1


def test_runtime_mode_switch_applies_to_next_request(invites_env):
    env = invites_env
    assert env.client.get("/auth/registration-mode").json() == {"mode": "invite"}
    assert _signup(env, "switch-blocked").status_code == 400

    response = env.client.put(
        "/admin/registration-mode", json={"mode": "open"}, headers=_admin_headers(env)
    )
    assert response.status_code == 200
    assert response.json() == {"mode": "open"}
    assert env.client.get("/auth/registration-mode").json() == {"mode": "open"}
    assert _signup(env, "switch-allowed").status_code == 200

    response = env.client.put(
        "/admin/registration-mode", json={"mode": "invite"}, headers=_admin_headers(env)
    )
    assert response.status_code == 200
    assert env.client.get("/auth/registration-mode").json() == {"mode": "invite"}
    assert _signup(env, "switch-blocked-again").status_code == 400
    assert not _user_exists(env, "switch-blocked-again")


def test_invite_survives_mode_round_trip(invites_env):
    env = invites_env
    invite_id, code = _make_invite(env)

    for mode in ("open", "invite"):
        response = env.client.put(
            "/admin/registration-mode", json={"mode": mode}, headers=_admin_headers(env)
        )
        assert response.status_code == 200
        assert response.json() == {"mode": mode}

    response = _signup(env, "round-trip-user", code=code)
    assert response.status_code == 200
    assert _invite_use_count(env, invite_id) == 1


def test_non_admin_cannot_manage_invites_or_mode(invites_env):
    env = invites_env
    assert env.client.put(
        "/admin/registration-mode", json={"mode": "open"}, headers=_admin_headers(env)
    ).status_code == 200
    signup = _signup(env, "regular-user")
    assert signup.status_code == 200
    headers = {"x-auth-hash": signup.json()["auth_hash"]}
    invite_id, _ = _make_invite(env)

    assert env.client.put(
        "/admin/registration-mode", json={"mode": "invite"}, headers=headers
    ).status_code == 403
    assert env.client.post("/admin/invites", json={}, headers=headers).status_code == 403
    assert env.client.get("/admin/invites", headers=headers).status_code == 403
    assert env.client.delete(f"/admin/invites/{invite_id}", headers=headers).status_code == 403

    assert env.client.get("/auth/registration-mode").json() == {"mode": "open"}
    with env.sessions() as db:
        assert db.get(InviteCode, invite_id).revoked_at is None


def test_public_registration_mode_exact_payload_and_runtime_reflection(invites_env):
    env = invites_env
    response = env.client.get("/auth/registration-mode")
    assert response.status_code == 200
    assert set(response.json()) == {"mode"}
    assert response.json() == {"mode": "invite"}

    assert env.client.put(
        "/admin/registration-mode", json={"mode": "open"}, headers=_admin_headers(env)
    ).status_code == 200
    response = env.client.get("/auth/registration-mode")
    assert response.status_code == 200
    assert set(response.json()) == {"mode"}
    assert response.json() == {"mode": "open"}


def test_invite_validate_exact_payload_and_non_consumption(invites_env):
    env = invites_env
    invite_id, code = _make_invite(env)

    response = env.client.post("/auth/invite/validate", json={"invite_code": code})
    assert response.status_code == 200
    assert set(response.json()) == {"valid"}
    assert response.json() == {"valid": True}
    assert _invite_use_count(env, invite_id) == 0

    response = env.client.post("/auth/invite/validate", json={"invite_code": "nope"})
    assert response.status_code == 200
    assert set(response.json()) == {"valid"}
    assert response.json() == {"valid": False}

    assert env.client.delete(f"/admin/invites/{invite_id}", headers=_admin_headers(env)).status_code == 200
    response = env.client.post("/auth/invite/validate", json={"invite_code": code})
    assert response.json() == {"valid": False}
    assert _invite_use_count(env, invite_id) == 0

    single_id, single_code = _make_invite(env, max_uses=1)
    assert env.client.post(
        "/auth/invite/validate", json={"invite_code": single_code}
    ).json() == {"valid": True}
    assert _signup(env, "validate-consumer", code=single_code).status_code == 200
    assert env.client.post(
        "/auth/invite/validate", json={"invite_code": single_code}
    ).json() == {"valid": False}
    assert _invite_use_count(env, single_id) == 1


def test_invite_validate_rate_limit_is_isolated_from_signup(invites_env):
    env = invites_env
    for _ in range(20):
        assert env.client.post("/auth/invite/validate", json={"invite_code": "x"}).status_code == 200
    assert env.client.post("/auth/invite/validate", json={"invite_code": "x"}).status_code == 429

    invite_id, code = _make_invite(env)
    response = _signup(env, "after-validate-limit", code=code)
    assert response.status_code == 200
    assert _invite_use_count(env, invite_id) == 1


def test_env_value_seeds_mode_when_db_row_absent(wired_env, monkeypatch):
    monkeypatch.setenv("OPENFY_REGISTRATION_MODE", "open")
    env_settings = _config(wired_env.tmp_path)
    assert env_settings.registration_mode == "open"
    monkeypatch.setattr(main, "settings", env_settings)

    main._startup()
    with wired_env.sessions() as db:
        assert main._get_app_setting(db, main.REGISTRATION_MODE_SETTING_KEY) == "open"
        assert main._get_registration_mode(db) == "open"


def test_existing_db_mode_wins_over_env_value(wired_env, monkeypatch):
    main._startup()
    with wired_env.sessions() as db:
        assert main._get_app_setting(db, main.REGISTRATION_MODE_SETTING_KEY) == "invite"

    monkeypatch.setenv("OPENFY_REGISTRATION_MODE", "open")
    env_settings = _config(wired_env.tmp_path)
    assert env_settings.registration_mode == "open"
    monkeypatch.setattr(main, "settings", env_settings)

    main._startup()
    with wired_env.sessions() as db:
        assert main._get_app_setting(db, main.REGISTRATION_MODE_SETTING_KEY) == "invite"
        assert main._get_registration_mode(db) == "invite"
