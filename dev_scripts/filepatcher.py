# dev_scripts/filepatcher.py
#
# Command:
#   npm run patch
#
# Optional:
#   npm run patch -- --dry-run
#   npm run patch -- --patch dev_scripts/another-patch.json
#   npm run patch -- --allow-dirty
#   npm run patch -- --reapply
#
# Recommended package.json entry:
#
# {
#   "scripts": {
#     "patch": "python ./dev_scripts/filepatcher.py"
#   }
# }

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIR.parent

DEFAULT_PATCH_FILE = SCRIPT_DIR / "filepatcher.json"
BACKUP_ROOT = SCRIPT_DIR / "backups"
HISTORY_ROOT = SCRIPT_DIR / "patch-history"

SUPPORTED_SCHEMA_VERSIONS = {1, 2}

TEXT_OPERATIONS = {
    "replace",
    "append",
    "prepend",
    "delete",
    "write",
    "overwrite",
    "create",
}

FILE_OPERATIONS = {
    "remove_file",
    "move_file",
}

SUPPORTED_OPERATIONS = TEXT_OPERATIONS | FILE_OPERATIONS

DEFAULT_PROTECTED_PATHS = {
    ".git",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    "node_modules",
}

DEFAULT_TEMP_COPY_EXCLUDES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".next",
    "dist",
    "build",
    "coverage",
}

SOURCE_FILE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".cjs",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".js",
    ".jsx",
    ".json",
    ".mjs",
    ".mts",
    ".py",
    ".rs",
    ".scss",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}

IMPORT_LIKE_EXTENSIONS = {
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".py",
}

MAX_ERROR_CONTEXT_LENGTH = 180


class PatchError(Exception):
    """Raised when a patch cannot be applied safely."""


@dataclass(frozen=True)
class OriginalFileState:
    exists: bool
    content: bytes | None
    mode: int | None


@dataclass(frozen=True)
class ChangeSummary:
    created: tuple[Path, ...]
    modified: tuple[Path, ...]
    removed: tuple[Path, ...]


@dataclass(frozen=True)
class ValidationResult:
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


@dataclass
class PatchContext:
    patch_path: Path
    data: dict[str, Any]
    patch_id: str
    patch_name: str
    dry_run: bool
    allow_dirty: bool
    allow_reapply: bool
    original_states: dict[Path, OriginalFileState]
    staged_states: dict[Path, bytes | None]
    touched_paths: set[Path]
    moved_paths: list[tuple[Path, Path]]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Safely apply a JSON repository patch."
    )

    parser.add_argument(
        "--patch",
        type=Path,
        default=DEFAULT_PATCH_FILE,
        help=(
            "Path to the JSON patch file. "
            f"Defaults to {DEFAULT_PATCH_FILE.relative_to(REPOSITORY_ROOT)}."
        ),
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and report the patch without modifying the repository.",
    )

    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help=(
            "Allow affected files to have uncommitted Git changes. "
            "This weakens patch safety."
        ),
    )

    parser.add_argument(
        "--reapply",
        action="store_true",
        help="Allow a patch ID that already exists in patch history.",
    )

    return parser.parse_args()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp_for_path() -> str:
    return utc_now().strftime("%Y-%m-%dT%H-%M-%S.%fZ")


def normalize_patch_id(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    normalized = normalized.strip("-._")

    if not normalized:
        raise PatchError("The patch ID becomes empty after normalization.")

    return normalized


def ensure_json_object(
    value: Any,
    description: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PatchError(f"{description} must be a JSON object.")

    return value


def ensure_json_array(
    value: Any,
    description: str,
) -> list[Any]:
    if not isinstance(value, list):
        raise PatchError(f"{description} must be a JSON array.")

    return value


def ensure_string(
    value: Any,
    description: str,
    *,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise PatchError(f"{description} must be a string.")

    if not allow_empty and not value.strip():
        raise PatchError(f"{description} must not be empty.")

    return value


def ensure_bool(value: Any, description: str) -> bool:
    if not isinstance(value, bool):
        raise PatchError(f"{description} must be a boolean.")

    return value


def ensure_positive_integer(value: Any, description: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise PatchError(f"{description} must be a positive integer.")

    return value


def ensure_nonnegative_integer(value: Any, description: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise PatchError(f"{description} must be a nonnegative integer.")

    return value


def truncate_for_error(value: str) -> str:
    collapsed = value.replace("\r", "\\r").replace("\n", "\\n")

    if len(collapsed) <= MAX_ERROR_CONTEXT_LENGTH:
        return collapsed

    return collapsed[: MAX_ERROR_CONTEXT_LENGTH - 3] + "..."


def load_patch_file(patch_path: Path) -> dict[str, Any]:
    resolved_path = patch_path.expanduser().resolve()

    if not resolved_path.exists():
        raise PatchError(f"Patch file not found: {resolved_path}")

    if not resolved_path.is_file():
        raise PatchError(f"Patch path is not a file: {resolved_path}")

    try:
        raw = resolved_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise PatchError(
            f"Patch file is not valid UTF-8: {resolved_path}"
        ) from error

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PatchError(
            f"Invalid JSON in {resolved_path.name}: "
            f"line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error

    return ensure_json_object(data, "The patch file root")


def validate_known_keys(
    value: dict[str, Any],
    allowed: set[str],
    description: str,
    *,
    allow_unknown: bool = False,
) -> None:
    if allow_unknown:
        return

    unknown = sorted(set(value) - allowed)

    if unknown:
        raise PatchError(
            f"{description} contains unsupported key(s): "
            + ", ".join(repr(key) for key in unknown)
        )


def validate_patch_schema(data: dict[str, Any]) -> None:
    root_keys = {
        "schema_version",
        "id",
        "name",
        "description",
        "backup",
        "allow_noop",
        "allow_unknown_keys",
        "allow_protected_paths",
        "protected_paths",
        "limits",
        "repository",
        "risk_acceptance",
        "preconditions",
        "postconditions",
        "dependency_changes",
        "validation",
        "operations",
    }

    allow_unknown = data.get("allow_unknown_keys", False)

    if not isinstance(allow_unknown, bool):
        raise PatchError("'allow_unknown_keys' must be a boolean.")

    validate_known_keys(
        data,
        root_keys,
        "Patch root",
        allow_unknown=allow_unknown,
    )

    schema_version = data.get("schema_version", 1)

    if not isinstance(schema_version, int) or isinstance(
        schema_version,
        bool,
    ):
        raise PatchError("'schema_version' must be an integer.")

    if schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        supported = ", ".join(
            str(version) for version in sorted(SUPPORTED_SCHEMA_VERSIONS)
        )
        raise PatchError(
            f"Unsupported schema version {schema_version}. "
            f"Supported versions: {supported}."
        )

    patch_name = data.get("name", "Unnamed patch")
    ensure_string(patch_name, "'name'")

    patch_id = data.get("id")

    if patch_id is not None:
        normalize_patch_id(ensure_string(patch_id, "'id'"))

    for boolean_key in ("backup", "allow_noop"):
        if boolean_key in data:
            ensure_bool(data[boolean_key], repr(boolean_key))

    if "allow_protected_paths" in data:
        values = ensure_json_array(
            data["allow_protected_paths"],
            "'allow_protected_paths'",
        )

        for index, value in enumerate(values, start=1):
            ensure_string(
                value,
                f"'allow_protected_paths' item {index}",
            )

    if "protected_paths" in data:
        values = ensure_json_array(
            data["protected_paths"],
            "'protected_paths'",
        )

        for index, value in enumerate(values, start=1):
            ensure_string(value, f"'protected_paths' item {index}")

    if "limits" in data:
        validate_limits(ensure_json_object(data["limits"], "'limits'"))

    if "repository" in data:
        validate_repository_config(
            ensure_json_object(data["repository"], "'repository'")
        )

    if "risk_acceptance" in data:
        validate_risk_acceptance(
            ensure_json_object(
                data["risk_acceptance"],
                "'risk_acceptance'",
            )
        )

    if "preconditions" in data:
        validate_conditions(
            ensure_json_array(data["preconditions"], "'preconditions'"),
            "precondition",
        )

    if "postconditions" in data:
        validate_conditions(
            ensure_json_array(data["postconditions"], "'postconditions'"),
            "postcondition",
        )

    if "dependency_changes" in data:
        validate_dependency_changes(
            ensure_json_array(
                data["dependency_changes"],
                "'dependency_changes'",
            )
        )

    if "validation" in data:
        validate_validation_config(
            ensure_json_object(data["validation"], "'validation'")
        )

    operations = ensure_json_array(
        data.get("operations"),
        "'operations'",
    )

    if not operations:
        raise PatchError(
            "The patch JSON must contain a non-empty 'operations' array."
        )

    for index, raw_operation in enumerate(operations, start=1):
        operation = ensure_json_object(
            raw_operation,
            f"Operation {index}",
        )
        validate_operation(operation, index, allow_unknown)


def validate_limits(limits: dict[str, Any]) -> None:
    allowed = {
        "max_files_changed",
        "max_total_added_bytes",
        "max_single_file_bytes",
        "allowed_roots",
    }

    validate_known_keys(limits, allowed, "'limits'")

    integer_keys = {
        "max_files_changed",
        "max_total_added_bytes",
        "max_single_file_bytes",
    }

    for key in integer_keys:
        if key in limits:
            ensure_nonnegative_integer(limits[key], f"'limits.{key}'")

    if "allowed_roots" in limits:
        roots = ensure_json_array(
            limits["allowed_roots"],
            "'limits.allowed_roots'",
        )

        if not roots:
            raise PatchError("'limits.allowed_roots' must not be empty.")

        for index, root in enumerate(roots, start=1):
            ensure_string(
                root,
                f"'limits.allowed_roots' item {index}",
            )


def validate_repository_config(repository: dict[str, Any]) -> None:
    allowed = {
        "require_git",
        "require_clean_targets",
        "require_clean_repository",
        "expected_head",
    }

    validate_known_keys(repository, allowed, "'repository'")

    for key in (
        "require_git",
        "require_clean_targets",
        "require_clean_repository",
    ):
        if key in repository:
            ensure_bool(repository[key], f"'repository.{key}'")

    if "expected_head" in repository:
        ensure_string(
            repository["expected_head"],
            "'repository.expected_head'",
        )


def validate_risk_acceptance(config: dict[str, Any]) -> None:
    allowed = {
        "overwrite_files",
        "delete_files",
        "move_files",
        "change_dependencies",
        "modify_package_manifest",
    }

    validate_known_keys(config, allowed, "'risk_acceptance'")

    for key, value in config.items():
        ensure_bool(value, f"'risk_acceptance.{key}'")


def validate_conditions(
    conditions: list[Any],
    description: str,
) -> None:
    supported_types = {
        "file_exists",
        "file_not_exists",
        "contains",
        "not_contains",
        "sha256",
        "json_valid",
        "python_valid",
    }

    for index, raw_condition in enumerate(conditions, start=1):
        condition = ensure_json_object(
            raw_condition,
            f"{description.capitalize()} {index}",
        )

        condition_type = ensure_string(
            condition.get("type"),
            f"{description.capitalize()} {index} 'type'",
        )

        if condition_type not in supported_types:
            raise PatchError(
                f"Unsupported {description} type "
                f"{condition_type!r} at index {index}."
            )

        ensure_string(
            condition.get("file"),
            f"{description.capitalize()} {index} 'file'",
        )

        if condition_type in {"contains", "not_contains"}:
            ensure_string(
                condition.get("text"),
                f"{description.capitalize()} {index} 'text'",
                allow_empty=True,
            )

        if condition_type == "sha256":
            validate_sha256(
                condition.get("value"),
                f"{description.capitalize()} {index} 'value'",
            )


def validate_dependency_changes(changes: list[Any]) -> None:
    allowed_actions = {"replace", "delete", "move"}

    for index, raw_change in enumerate(changes, start=1):
        change = ensure_json_object(
            raw_change,
            f"Dependency change {index}",
        )

        action = ensure_string(
            change.get("action"),
            f"Dependency change {index} 'action'",
        )

        if action not in allowed_actions:
            raise PatchError(
                f"Dependency change {index} has unsupported action "
                f"{action!r}."
            )

        if "symbol" in change:
            ensure_string(
                change["symbol"],
                f"Dependency change {index} 'symbol'",
            )

        if "from" in change:
            ensure_string(
                change["from"],
                f"Dependency change {index} 'from'",
            )

        if action == "replace":
            replacement = ensure_json_object(
                change.get("replacement"),
                f"Dependency change {index} 'replacement'",
            )

            if "symbol" in replacement:
                ensure_string(
                    replacement["symbol"],
                    (
                        f"Dependency change {index} "
                        "'replacement.symbol'"
                    ),
                )

            if "file" in replacement:
                ensure_string(
                    replacement["file"],
                    (
                        f"Dependency change {index} "
                        "'replacement.file'"
                    ),
                )

            if not replacement.get("symbol") and not replacement.get("file"):
                raise PatchError(
                    f"Dependency change {index} replacement must specify "
                    "'symbol', 'file', or both."
                )


def validate_validation_config(config: dict[str, Any]) -> None:
    allowed = {
        "structural",
        "scan_dependencies",
        "commands",
        "copy_excludes",
        "link_node_modules",
        "timeout_seconds",
    }

    validate_known_keys(config, allowed, "'validation'")

    for key in (
        "structural",
        "scan_dependencies",
        "link_node_modules",
    ):
        if key in config:
            ensure_bool(config[key], f"'validation.{key}'")

    if "timeout_seconds" in config:
        ensure_positive_integer(
            config["timeout_seconds"],
            "'validation.timeout_seconds'",
        )

    if "copy_excludes" in config:
        excludes = ensure_json_array(
            config["copy_excludes"],
            "'validation.copy_excludes'",
        )

        for index, value in enumerate(excludes, start=1):
            ensure_string(
                value,
                f"'validation.copy_excludes' item {index}",
            )

    if "commands" in config:
        commands = ensure_json_array(
            config["commands"],
            "'validation.commands'",
        )

        for index, command in enumerate(commands, start=1):
            if isinstance(command, str):
                ensure_string(
                    command,
                    f"'validation.commands' item {index}",
                )
                continue

            command_parts = ensure_json_array(
                command,
                f"'validation.commands' item {index}",
            )

            if not command_parts:
                raise PatchError(
                    f"'validation.commands' item {index} must not be empty."
                )

            for part_index, part in enumerate(command_parts, start=1):
                ensure_string(
                    part,
                    (
                        f"'validation.commands' item {index}, "
                        f"part {part_index}"
                    ),
                )


def validate_operation(
    operation: dict[str, Any],
    index: int,
    allow_unknown: bool,
) -> None:
    common_keys = {
        "operation",
        "file",
        "from",
        "to",
        "find",
        "replace",
        "content",
        "expected_matches",
        "expected_sha256",
        "allow_noop",
        "must_exist",
        "must_not_exist",
        "allow_overwrite",
        "update_references",
    }

    validate_known_keys(
        operation,
        common_keys,
        f"Operation {index}",
        allow_unknown=allow_unknown,
    )

    operation_type = ensure_string(
        operation.get("operation"),
        f"Operation {index} 'operation'",
    )

    if operation_type not in SUPPORTED_OPERATIONS:
        supported = ", ".join(sorted(SUPPORTED_OPERATIONS))
        raise PatchError(
            f"Operation {index} has unsupported type "
            f"{operation_type!r}. Supported operations: {supported}."
        )

    for boolean_key in (
        "allow_noop",
        "must_exist",
        "must_not_exist",
        "allow_overwrite",
        "update_references",
    ):
        if boolean_key in operation:
            ensure_bool(
                operation[boolean_key],
                f"Operation {index} '{boolean_key}'",
            )

    if "expected_matches" in operation:
        ensure_positive_integer(
            operation["expected_matches"],
            f"Operation {index} 'expected_matches'",
        )

    if "expected_sha256" in operation:
        validate_sha256(
            operation["expected_sha256"],
            f"Operation {index} 'expected_sha256'",
        )

    if operation_type == "move_file":
        ensure_string(
            operation.get("from"),
            f"Operation {index} 'from'",
        )
        ensure_string(
            operation.get("to"),
            f"Operation {index} 'to'",
        )
        return

    ensure_string(
        operation.get("file"),
        f"Operation {index} 'file'",
    )

    if operation_type in {"replace", "delete"}:
        ensure_string(
            operation.get("find"),
            f"Operation {index} 'find'",
            allow_empty=False,
        )

    if operation_type == "replace":
        ensure_string(
            operation.get("replace"),
            f"Operation {index} 'replace'",
            allow_empty=True,
        )

    if operation_type in {
        "append",
        "prepend",
        "write",
        "overwrite",
        "create",
    }:
        ensure_string(
            operation.get("content"),
            f"Operation {index} 'content'",
            allow_empty=True,
        )


def validate_sha256(value: Any, description: str) -> str:
    text = ensure_string(value, description)

    if not re.fullmatch(r"[A-Fa-f0-9]{64}", text):
        raise PatchError(
            f"{description} must be a 64-character hexadecimal SHA-256."
        )

    return text.lower()


def resolve_repository_path(relative_path: str) -> Path:
    value = ensure_string(relative_path, "Repository-relative path")
    relative = Path(value)

    if relative.is_absolute():
        raise PatchError(
            f"Absolute target paths are not allowed: {relative_path}"
        )

    target = (REPOSITORY_ROOT / relative).resolve()
    root = REPOSITORY_ROOT.resolve()

    try:
        target.relative_to(root)
    except ValueError as error:
        raise PatchError(
            f"Target path escapes the repository: {relative_path}"
        ) from error

    return target


def repository_relative(path: Path) -> Path:
    try:
        return path.resolve().relative_to(REPOSITORY_ROOT.resolve())
    except ValueError as error:
        raise PatchError(
            f"Path is outside the repository: {path}"
        ) from error


def relative_posix(path: Path) -> str:
    return repository_relative(path).as_posix()


def path_matches_prefix(path: Path, prefix: Path) -> bool:
    path_parts = repository_relative(path).parts
    prefix_parts = prefix.parts

    if len(prefix_parts) > len(path_parts):
        return False

    return path_parts[: len(prefix_parts)] == prefix_parts


def get_protected_paths(data: dict[str, Any]) -> set[Path]:
    configured = data.get("protected_paths", sorted(DEFAULT_PROTECTED_PATHS))
    return {Path(value) for value in configured}


def get_allowed_protected_paths(data: dict[str, Any]) -> set[Path]:
    configured = data.get("allow_protected_paths", [])
    return {Path(value) for value in configured}


def is_explicitly_allowed(
    target: Path,
    allowed_paths: set[Path],
) -> bool:
    return any(path_matches_prefix(target, allowed) for allowed in allowed_paths)


def enforce_protected_path_policy(
    target: Path,
    data: dict[str, Any],
) -> None:
    protected_paths = get_protected_paths(data)
    allowed_paths = get_allowed_protected_paths(data)

    for protected in protected_paths:
        if not path_matches_prefix(target, protected):
            continue

        if is_explicitly_allowed(target, allowed_paths):
            return

        raise PatchError(
            f"Patch attempts to modify protected path "
            f"{relative_posix(target)!r}. Add the path to "
            "'allow_protected_paths' only if this is intentional."
        )


def enforce_allowed_roots(
    target: Path,
    data: dict[str, Any],
) -> None:
    limits = data.get("limits", {})
    allowed_values = limits.get("allowed_roots")

    if not allowed_values:
        return

    allowed_roots = {Path(value) for value in allowed_values}

    if any(path_matches_prefix(target, root) for root in allowed_roots):
        return

    formatted = ", ".join(
        repr(root.as_posix()) for root in sorted(allowed_roots)
    )

    raise PatchError(
        f"Path {relative_posix(target)!r} is outside the configured "
        f"allowed roots: {formatted}."
    )


def enforce_path_policy(target: Path, data: dict[str, Any]) -> None:
    enforce_protected_path_policy(target, data)
    enforce_allowed_roots(target, data)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def read_original_state(path: Path) -> OriginalFileState:
    if not path.exists():
        return OriginalFileState(
            exists=False,
            content=None,
            mode=None,
        )

    if not path.is_file():
        raise PatchError(
            f"Patch target is not a regular file: {relative_posix(path)}"
        )

    stat = path.stat()

    return OriginalFileState(
        exists=True,
        content=path.read_bytes(),
        mode=stat.st_mode,
    )


def get_original_state(
    context: PatchContext,
    path: Path,
) -> OriginalFileState:
    if path not in context.original_states:
        context.original_states[path] = read_original_state(path)

    return context.original_states[path]


def get_staged_content(
    context: PatchContext,
    path: Path,
) -> bytes | None:
    if path not in context.staged_states:
        original = get_original_state(context, path)
        context.staged_states[path] = original.content

    return context.staged_states[path]


def set_staged_content(
    context: PatchContext,
    path: Path,
    content: bytes | None,
) -> None:
    get_original_state(context, path)
    context.staged_states[path] = content
    context.touched_paths.add(path)


def decode_utf8(content: bytes, path: Path) -> str:
    if b"\x00" in content:
        raise PatchError(
            f"Refusing to treat binary-looking file as text: "
            f"{relative_posix(path)}"
        )

    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PatchError(
            f"Target file is not valid UTF-8: {relative_posix(path)}"
        ) from error


def detect_newline(text: str) -> str:
    crlf_count = text.count("\r\n")
    lf_count = text.count("\n") - crlf_count
    cr_count = text.count("\r") - crlf_count

    if crlf_count >= lf_count and crlf_count >= cr_count and crlf_count > 0:
        return "\r\n"

    if cr_count > lf_count and cr_count > 0:
        return "\r"

    return "\n"


def adapt_content_newlines(content: str, existing_text: str) -> str:
    newline = detect_newline(existing_text)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")

    if newline == "\n":
        return normalized

    return normalized.replace("\n", newline)


def verify_expected_hash(
    content: bytes | None,
    expected_hash: Any,
    path: Path,
) -> None:
    if expected_hash is None:
        return

    expected = validate_sha256(
        expected_hash,
        f"Expected hash for {relative_posix(path)}",
    )

    if content is None:
        raise PatchError(
            f"Cannot verify expected SHA-256 for missing file "
            f"{relative_posix(path)!r}."
        )

    actual = sha256_bytes(content)

    if actual != expected:
        raise PatchError(
            f"SHA-256 mismatch for {relative_posix(path)!r}: "
            f"expected {expected}, found {actual}."
        )


def verify_existence_flags(
    content: bytes | None,
    operation: dict[str, Any],
    path: Path,
) -> None:
    if operation.get("must_exist", False) and content is None:
        raise PatchError(
            f"Operation requires existing file, but it is missing: "
            f"{relative_posix(path)}"
        )

    if operation.get("must_not_exist", False) and content is not None:
        raise PatchError(
            f"Operation requires a missing file, but it already exists: "
            f"{relative_posix(path)}"
        )


def operation_allows_noop(
    context: PatchContext,
    operation: dict[str, Any],
) -> bool:
    if "allow_noop" in operation:
        return bool(operation["allow_noop"])

    return bool(context.data.get("allow_noop", False))


def require_existing_text(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> tuple[bytes, str]:
    content = get_staged_content(context, path)
    verify_existence_flags(content, operation, path)
    verify_expected_hash(content, operation.get("expected_sha256"), path)

    if content is None:
        raise PatchError(
            f"Target file does not exist: {relative_posix(path)}"
        )

    return content, decode_utf8(content, path)


def apply_replace_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    original_bytes, text = require_existing_text(
        context,
        path,
        operation,
    )

    find_text = ensure_string(
        operation.get("find"),
        "'find'",
    )
    replacement = ensure_string(
        operation.get("replace"),
        "'replace'",
        allow_empty=True,
    )

    find_text = adapt_content_newlines(find_text, text)
    replacement = adapt_content_newlines(replacement, text)

    expected_matches = operation.get("expected_matches", 1)
    ensure_positive_integer(expected_matches, "'expected_matches'")

    actual_matches = text.count(find_text)

    if actual_matches != expected_matches:
        raise PatchError(
            f"Replace safety check failed for {relative_posix(path)!r}: "
            f"expected {expected_matches} match(es), "
            f"found {actual_matches}. Search text: "
            f"{truncate_for_error(find_text)!r}"
        )

    updated = text.replace(
        find_text,
        replacement,
        expected_matches,
    )
    updated_bytes = updated.encode("utf-8")

    if (
        updated_bytes == original_bytes
        and not operation_allows_noop(context, operation)
    ):
        raise PatchError(
            f"Replace operation produced no change: "
            f"{relative_posix(path)}"
        )

    set_staged_content(context, path, updated_bytes)


def apply_delete_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    original_bytes, text = require_existing_text(
        context,
        path,
        operation,
    )

    find_text = ensure_string(
        operation.get("find"),
        "'find'",
    )
    find_text = adapt_content_newlines(find_text, text)

    expected_matches = operation.get("expected_matches", 1)
    ensure_positive_integer(expected_matches, "'expected_matches'")

    actual_matches = text.count(find_text)

    if actual_matches != expected_matches:
        raise PatchError(
            f"Delete safety check failed for {relative_posix(path)!r}: "
            f"expected {expected_matches} match(es), "
            f"found {actual_matches}. Search text: "
            f"{truncate_for_error(find_text)!r}"
        )

    updated = text.replace(find_text, "", expected_matches)
    updated_bytes = updated.encode("utf-8")

    if (
        updated_bytes == original_bytes
        and not operation_allows_noop(context, operation)
    ):
        raise PatchError(
            f"Delete operation produced no change: "
            f"{relative_posix(path)}"
        )

    set_staged_content(context, path, updated_bytes)


def apply_append_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    original_bytes, text = require_existing_text(
        context,
        path,
        operation,
    )

    content = ensure_string(
        operation.get("content"),
        "'content'",
        allow_empty=True,
    )
    content = adapt_content_newlines(content, text)

    newline = detect_newline(text)
    separator = "" if text.endswith(("\n", "\r")) or not text else newline
    updated = text + separator + content
    updated_bytes = updated.encode("utf-8")

    if (
        updated_bytes == original_bytes
        and not operation_allows_noop(context, operation)
    ):
        raise PatchError(
            f"Append operation produced no change: "
            f"{relative_posix(path)}"
        )

    set_staged_content(context, path, updated_bytes)


def apply_prepend_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    original_bytes, text = require_existing_text(
        context,
        path,
        operation,
    )

    content = ensure_string(
        operation.get("content"),
        "'content'",
        allow_empty=True,
    )
    content = adapt_content_newlines(content, text)

    newline = detect_newline(text)
    separator = (
        ""
        if content.endswith(("\n", "\r")) or not text
        else newline
    )
    updated = content + separator + text
    updated_bytes = updated.encode("utf-8")

    if (
        updated_bytes == original_bytes
        and not operation_allows_noop(context, operation)
    ):
        raise PatchError(
            f"Prepend operation produced no change: "
            f"{relative_posix(path)}"
        )

    set_staged_content(context, path, updated_bytes)


def apply_create_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    existing = get_staged_content(context, path)
    verify_existence_flags(existing, operation, path)

    if existing is not None:
        raise PatchError(
            f"Create operation refuses to overwrite existing file: "
            f"{relative_posix(path)}"
        )

    content = ensure_string(
        operation.get("content"),
        "'content'",
        allow_empty=True,
    )

    set_staged_content(context, path, content.encode("utf-8"))


def apply_overwrite_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    existing = get_staged_content(context, path)
    verify_existence_flags(existing, operation, path)
    verify_expected_hash(existing, operation.get("expected_sha256"), path)

    if existing is None:
        raise PatchError(
            f"Overwrite operation requires an existing file: "
            f"{relative_posix(path)}"
        )

    existing_text = decode_utf8(existing, path)
    content = ensure_string(
        operation.get("content"),
        "'content'",
        allow_empty=True,
    )
    content = adapt_content_newlines(content, existing_text)
    updated = content.encode("utf-8")

    if (
        updated == existing
        and not operation_allows_noop(context, operation)
    ):
        raise PatchError(
            f"Overwrite operation produced no change: "
            f"{relative_posix(path)}"
        )

    set_staged_content(context, path, updated)


def apply_legacy_write_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    existing = get_staged_content(context, path)
    verify_existence_flags(existing, operation, path)
    verify_expected_hash(existing, operation.get("expected_sha256"), path)

    content = ensure_string(
        operation.get("content"),
        "'content'",
        allow_empty=True,
    )

    if existing is not None:
        existing_text = decode_utf8(existing, path)
        content = adapt_content_newlines(content, existing_text)

    updated = content.encode("utf-8")

    if (
        updated == existing
        and not operation_allows_noop(context, operation)
    ):
        raise PatchError(
            f"Write operation produced no change: "
            f"{relative_posix(path)}"
        )

    set_staged_content(context, path, updated)


def apply_remove_file_operation(
    context: PatchContext,
    path: Path,
    operation: dict[str, Any],
) -> None:
    existing = get_staged_content(context, path)
    verify_existence_flags(existing, operation, path)
    verify_expected_hash(existing, operation.get("expected_sha256"), path)

    if existing is None:
        raise PatchError(
            f"Cannot remove missing file: {relative_posix(path)}"
        )

    set_staged_content(context, path, None)


def apply_move_file_operation(
    context: PatchContext,
    operation: dict[str, Any],
) -> None:
    source = resolve_repository_path(
        ensure_string(operation.get("from"), "'from'")
    )
    destination = resolve_repository_path(
        ensure_string(operation.get("to"), "'to'")
    )

    enforce_path_policy(source, context.data)
    enforce_path_policy(destination, context.data)

    if source == destination:
        raise PatchError(
            f"Move source and destination are the same: "
            f"{relative_posix(source)}"
        )

    source_content = get_staged_content(context, source)
    destination_content = get_staged_content(context, destination)

    verify_expected_hash(
        source_content,
        operation.get("expected_sha256"),
        source,
    )

    if source_content is None:
        raise PatchError(
            f"Move source does not exist: {relative_posix(source)}"
        )

    allow_overwrite = operation.get("allow_overwrite", False)

    if destination_content is not None and not allow_overwrite:
        raise PatchError(
            f"Move destination already exists: "
            f"{relative_posix(destination)}. Set 'allow_overwrite' to "
            "true only when replacement is intentional."
        )

    set_staged_content(context, source, None)
    set_staged_content(context, destination, source_content)
    context.moved_paths.append((source, destination))


def apply_operation(
    context: PatchContext,
    operation: dict[str, Any],
    index: int,
) -> None:
    operation_type = operation["operation"]

    if operation_type == "move_file":
        apply_move_file_operation(context, operation)
        return

    path = resolve_repository_path(operation["file"])
    enforce_path_policy(path, context.data)

    if operation_type == "replace":
        apply_replace_operation(context, path, operation)
    elif operation_type == "delete":
        apply_delete_operation(context, path, operation)
    elif operation_type == "append":
        apply_append_operation(context, path, operation)
    elif operation_type == "prepend":
        apply_prepend_operation(context, path, operation)
    elif operation_type == "create":
        apply_create_operation(context, path, operation)
    elif operation_type == "overwrite":
        apply_overwrite_operation(context, path, operation)
    elif operation_type == "write":
        apply_legacy_write_operation(context, path, operation)
    elif operation_type == "remove_file":
        apply_remove_file_operation(context, path, operation)
    else:
        raise PatchError(
            f"Internal error: unsupported operation {operation_type!r} "
            f"at index {index}."
        )


def detect_conflicting_operations(
    operations: list[dict[str, Any]],
) -> None:
    terminally_removed: set[Path] = set()
    created_paths: set[Path] = set()
    overwritten_paths: set[Path] = set()

    for index, operation in enumerate(operations, start=1):
        operation_type = operation["operation"]

        if operation_type == "move_file":
            source = resolve_repository_path(operation["from"])
            destination = resolve_repository_path(operation["to"])

            if source in terminally_removed:
                raise PatchError(
                    f"Operation {index} tries to move a file that was "
                    f"already removed: {relative_posix(source)}"
                )

            terminally_removed.add(source)

            if destination in created_paths:
                raise PatchError(
                    f"Operation {index} moves onto a file already created "
                    f"by this patch: {relative_posix(destination)}"
                )

            created_paths.add(destination)
            continue

        path = resolve_repository_path(operation["file"])

        if path in terminally_removed:
            raise PatchError(
                f"Operation {index} targets a file after it was removed "
                f"or moved away: {relative_posix(path)}"
            )

        if operation_type == "remove_file":
            terminally_removed.add(path)

        if operation_type == "create":
            if path in created_paths:
                raise PatchError(
                    f"Multiple create operations target "
                    f"{relative_posix(path)!r}."
                )
            created_paths.add(path)

        if operation_type in {"write", "overwrite"}:
            if path in overwritten_paths:
                raise PatchError(
                    f"Multiple whole-file write operations target "
                    f"{relative_posix(path)!r}."
                )
            overwritten_paths.add(path)


def derive_patch_id(
    data: dict[str, Any],
    patch_path: Path,
) -> str:
    explicit = data.get("id")

    if explicit:
        return normalize_patch_id(explicit)

    name = data.get("name") or patch_path.stem
    return normalize_patch_id(str(name))


def history_path_for_patch(patch_id: str) -> Path:
    return HISTORY_ROOT / f"{patch_id}.json"


def enforce_reapply_policy(
    patch_id: str,
    allow_reapply: bool,
) -> None:
    history_path = history_path_for_patch(patch_id)

    if history_path.exists() and not allow_reapply:
        raise PatchError(
            f"Patch {patch_id!r} appears to have already been applied. "
            "Use --reapply only after verifying that reapplication is safe."
        )


def run_git(
    arguments: Sequence[str],
    *,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *arguments],
            cwd=REPOSITORY_ROOT,
            text=True,
            capture_output=True,
            check=check,
        )
    except FileNotFoundError as error:
        raise PatchError(
            "Git is required by this patch but was not found."
        ) from error
    except subprocess.CalledProcessError as error:
        raise PatchError(
            f"Git command failed: git {' '.join(arguments)}\n"
            f"{error.stderr.strip()}"
        ) from error


def is_git_repository() -> bool:
    try:
        result = run_git(
            ["rev-parse", "--is-inside-work-tree"],
        )
    except PatchError:
        return False

    return (
        result.returncode == 0
        and result.stdout.strip().lower() == "true"
    )


def get_git_head() -> str:
    result = run_git(["rev-parse", "HEAD"], check=True)
    return result.stdout.strip()


def get_git_status_paths() -> set[str]:
    result = run_git(
        ["status", "--porcelain=v1", "-z"],
        check=True,
    )

    entries = result.stdout.split("\0")
    paths: set[str] = set()

    for entry in entries:
        if not entry:
            continue

        record = entry[3:] if len(entry) >= 4 else entry
        record = record.strip()

        if " -> " in record:
            old_path, new_path = record.split(" -> ", 1)
            paths.add(old_path)
            paths.add(new_path)
        elif record:
            paths.add(record)

    return paths


def enforce_git_policy(context: PatchContext) -> None:
    repository = context.data.get("repository", {})
    require_git = repository.get("require_git", False)
    require_clean_targets = repository.get(
        "require_clean_targets",
        True,
    )
    require_clean_repository = repository.get(
        "require_clean_repository",
        False,
    )
    expected_head = repository.get("expected_head")

    git_available = is_git_repository()

    if require_git and not git_available:
        raise PatchError(
            "The patch requires a Git repository, but none was detected."
        )

    if not git_available:
        if expected_head:
            raise PatchError(
                "The patch declares 'repository.expected_head', but the "
                "repository is not available through Git."
            )
        return

    if expected_head:
        actual_head = get_git_head()

        if not actual_head.startswith(expected_head):
            raise PatchError(
                f"Git HEAD mismatch: expected {expected_head!r}, "
                f"found {actual_head!r}."
            )

    if context.allow_dirty:
        return

    dirty_paths = get_git_status_paths()

    if require_clean_repository and dirty_paths:
        preview = ", ".join(sorted(dirty_paths)[:10])

        if len(dirty_paths) > 10:
            preview += ", ..."

        raise PatchError(
            f"The repository contains uncommitted changes: {preview}. "
            "Commit or stash them, or use --allow-dirty deliberately."
        )

    if require_clean_targets:
        target_paths = {
            repository_relative(path).as_posix()
            for path in context.touched_paths
        }
        dirty_targets = sorted(target_paths & dirty_paths)

        if dirty_targets:
            raise PatchError(
                "Affected files contain uncommitted Git changes: "
                + ", ".join(dirty_targets)
                + ". Commit or stash them, or use --allow-dirty "
                "deliberately."
            )


def state_exists(
    context: PatchContext,
    path: Path,
    *,
    staged: bool,
) -> bool:
    if staged:
        return get_staged_content(context, path) is not None

    return get_original_state(context, path).exists


def state_content(
    context: PatchContext,
    path: Path,
    *,
    staged: bool,
) -> bytes | None:
    if staged:
        return get_staged_content(context, path)

    return get_original_state(context, path).content


def validate_conditions_against_state(
    context: PatchContext,
    conditions: list[Any],
    *,
    staged: bool,
    description: str,
) -> None:
    for index, raw_condition in enumerate(conditions, start=1):
        condition = ensure_json_object(
            raw_condition,
            f"{description.capitalize()} {index}",
        )
        condition_type = condition["type"]
        path = resolve_repository_path(condition["file"])
        content = state_content(context, path, staged=staged)
        exists = content is not None

        if condition_type == "file_exists":
            if not exists:
                raise PatchError(
                    f"{description.capitalize()} {index} failed: "
                    f"{relative_posix(path)} does not exist."
                )
            continue

        if condition_type == "file_not_exists":
            if exists:
                raise PatchError(
                    f"{description.capitalize()} {index} failed: "
                    f"{relative_posix(path)} exists."
                )
            continue

        if content is None:
            raise PatchError(
                f"{description.capitalize()} {index} failed because "
                f"{relative_posix(path)} does not exist."
            )

        if condition_type == "sha256":
            expected = validate_sha256(
                condition["value"],
                f"{description} SHA-256",
            )
            actual = sha256_bytes(content)

            if actual != expected:
                raise PatchError(
                    f"{description.capitalize()} {index} failed for "
                    f"{relative_posix(path)}: expected SHA-256 "
                    f"{expected}, found {actual}."
                )
            continue

        text = decode_utf8(content, path)

        if condition_type == "contains":
            needle = adapt_content_newlines(condition["text"], text)

            if needle not in text:
                raise PatchError(
                    f"{description.capitalize()} {index} failed: "
                    f"{relative_posix(path)} does not contain "
                    f"{truncate_for_error(needle)!r}."
                )
            continue

        if condition_type == "not_contains":
            needle = adapt_content_newlines(condition["text"], text)

            if needle in text:
                raise PatchError(
                    f"{description.capitalize()} {index} failed: "
                    f"{relative_posix(path)} still contains "
                    f"{truncate_for_error(needle)!r}."
                )
            continue

        if condition_type == "json_valid":
            validate_json_text(text, path)
            continue

        if condition_type == "python_valid":
            validate_python_text(text, path)
            continue

        raise PatchError(
            f"Internal error: unsupported condition type "
            f"{condition_type!r}."
        )


def validate_json_text(text: str, path: Path) -> None:
    try:
        json.loads(text)
    except json.JSONDecodeError as error:
        raise PatchError(
            f"Invalid JSON after patching {relative_posix(path)}: "
            f"line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error


def validate_python_text(text: str, path: Path) -> None:
    try:
        ast.parse(text, filename=relative_posix(path))
    except SyntaxError as error:
        line = error.lineno or "?"
        column = error.offset or "?"

        raise PatchError(
            f"Invalid Python after patching {relative_posix(path)}: "
            f"line {line}, column {column}: {error.msg}"
        ) from error


def validate_structural_syntax(context: PatchContext) -> None:
    validation = context.data.get("validation", {})

    if validation.get("structural", True) is False:
        return

    for path in sorted(context.touched_paths):
        content = get_staged_content(context, path)

        if content is None:
            continue

        suffix = path.suffix.lower()

        if suffix not in {".json", ".py"}:
            continue

        text = decode_utf8(content, path)

        if suffix == ".json":
            validate_json_text(text, path)
        elif suffix == ".py":
            validate_python_text(text, path)


def iter_repository_source_files(
    context: PatchContext,
) -> Iterable[tuple[Path, bytes]]:
    excluded_top_level = {
        ".git",
        "node_modules",
        ".next",
        "dist",
        "build",
        "coverage",
    }

    seen: set[Path] = set()

    for root, directory_names, file_names in os.walk(REPOSITORY_ROOT):
        root_path = Path(root)

        directory_names[:] = [
            name
            for name in directory_names
            if name not in excluded_top_level
        ]

        for file_name in file_names:
            path = (root_path / file_name).resolve()

            if path.suffix.lower() not in SOURCE_FILE_EXTENSIONS:
                continue

            if path in context.staged_states:
                content = context.staged_states[path]

                if content is not None:
                    seen.add(path)
                    yield path, content

                continue

            try:
                content = path.read_bytes()
            except OSError:
                continue

            seen.add(path)
            yield path, content

    for path, content in context.staged_states.items():
        if (
            path not in seen
            and content is not None
            and path.suffix.lower() in SOURCE_FILE_EXTENSIONS
        ):
            yield path, content


def normalize_import_candidate(value: str) -> str:
    normalized = value.replace("\\", "/").strip()
    normalized = normalized.removeprefix("./")
    return normalized


def possible_module_references(path: Path) -> set[str]:
    relative = repository_relative(path).as_posix()
    without_suffix = relative[: -len(path.suffix)] if path.suffix else relative

    references = {
        relative,
        without_suffix,
        f"./{relative}",
        f"./{without_suffix}",
        path.name,
        path.stem,
    }

    if path.name.startswith("index."):
        parent = repository_relative(path.parent).as_posix()
        references.add(parent)
        references.add(f"./{parent}")

    return {normalize_import_candidate(value) for value in references}


def extract_import_like_strings(text: str, suffix: str) -> set[str]:
    values: set[str] = set()

    if suffix in {
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".mjs",
        ".cjs",
        ".mts",
        ".cts",
    }:
        patterns = [
            r"""(?:from\s*|import\s*)["']([^"']+)["']""",
            r"""require\s*\(\s*["']([^"']+)["']\s*\)""",
            r"""import\s*\(\s*["']([^"']+)["']\s*\)""",
        ]

        for pattern in patterns:
            values.update(re.findall(pattern, text))

    if suffix == ".py":
        for match in re.findall(
            r"^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+",
            text,
            flags=re.MULTILINE,
        ):
            values.add(match.replace(".", "/"))

        for match in re.findall(
            r"^\s*import\s+([A-Za-z0-9_.]+)",
            text,
            flags=re.MULTILINE,
        ):
            values.add(match.replace(".", "/"))

    return {normalize_import_candidate(value) for value in values}


def find_references_to_path(
    context: PatchContext,
    target: Path,
) -> list[tuple[Path, str]]:
    candidates = possible_module_references(target)
    findings: list[tuple[Path, str]] = []

    for source_path, content in iter_repository_source_files(context):
        if source_path == target:
            continue

        if source_path.suffix.lower() not in IMPORT_LIKE_EXTENSIONS:
            continue

        try:
            text = decode_utf8(content, source_path)
        except PatchError:
            continue

        imports = extract_import_like_strings(
            text,
            source_path.suffix.lower(),
        )

        for imported in imports:
            normalized = normalize_import_candidate(imported)

            if normalized in candidates:
                findings.append((source_path, imported))
                continue

            for candidate in candidates:
                if normalized.endswith("/" + candidate):
                    findings.append((source_path, imported))
                    break

    return findings


def find_symbol_references(
    context: PatchContext,
    symbol: str,
    *,
    exclude_paths: set[Path] | None = None,
) -> list[Path]:
    exclude = exclude_paths or set()
    pattern = re.compile(rf"\b{re.escape(symbol)}\b")
    findings: list[Path] = []

    for path, content in iter_repository_source_files(context):
        if path in exclude:
            continue

        try:
            text = decode_utf8(content, path)
        except PatchError:
            continue

        if pattern.search(text):
            findings.append(path)

    return findings


def validate_removed_file_dependencies(context: PatchContext) -> None:
    validation = context.data.get("validation", {})

    if validation.get("scan_dependencies", True) is False:
        return

    removed_paths = [
        path
        for path in context.touched_paths
        if get_original_state(context, path).exists
        and get_staged_content(context, path) is None
    ]

    moved_sources = {source for source, _ in context.moved_paths}

    for removed in removed_paths:
        references = find_references_to_path(context, removed)

        if not references:
            continue

        destination = next(
            (
                target
                for source, target in context.moved_paths
                if source == removed
            ),
            None,
        )

        formatted = ", ".join(
            f"{relative_posix(path)} imports {value!r}"
            for path, value in references[:8]
        )

        if len(references) > 8:
            formatted += ", ..."

        if removed in moved_sources and destination is not None:
            raise PatchError(
                f"File {relative_posix(removed)!r} was moved to "
                f"{relative_posix(destination)!r}, but old import "
                f"references remain: {formatted}"
            )

        raise PatchError(
            f"File {relative_posix(removed)!r} is deleted but appears "
            f"to still be imported: {formatted}"
        )


def validate_declared_dependency_changes(
    context: PatchContext,
) -> None:
    changes = context.data.get("dependency_changes", [])

    for index, change in enumerate(changes, start=1):
        action = change["action"]
        source_file = (
            resolve_repository_path(change["from"])
            if change.get("from")
            else None
        )
        symbol = change.get("symbol")

        if action == "delete" and source_file is not None:
            if get_staged_content(context, source_file) is not None:
                raise PatchError(
                    f"Dependency change {index} declares file deletion, "
                    f"but {relative_posix(source_file)} still exists."
                )

        if action == "delete" and symbol:
            exclude = {source_file} if source_file else set()
            references = find_symbol_references(
                context,
                symbol,
                exclude_paths=exclude,
            )

            if references:
                formatted = ", ".join(
                    relative_posix(path) for path in references[:10]
                )

                if len(references) > 10:
                    formatted += ", ..."

                raise PatchError(
                    f"Dependency change {index} declares symbol "
                    f"{symbol!r} deleted, but references remain in: "
                    f"{formatted}"
                )

        if action == "replace":
            replacement = change["replacement"]
            replacement_file = replacement.get("file")
            replacement_symbol = replacement.get("symbol")

            if replacement_file:
                path = resolve_repository_path(replacement_file)
                content = get_staged_content(context, path)

                if content is None:
                    raise PatchError(
                        f"Dependency change {index} replacement file "
                        f"does not exist after staging: "
                        f"{relative_posix(path)}"
                    )

                if replacement_symbol:
                    text = decode_utf8(content, path)

                    if not re.search(
                        rf"\b{re.escape(replacement_symbol)}\b",
                        text,
                    ):
                        raise PatchError(
                            f"Dependency change {index} replacement "
                            f"symbol {replacement_symbol!r} was not found "
                            f"in {relative_posix(path)}."
                        )


def derive_change_summary(context: PatchContext) -> ChangeSummary:
    created: list[Path] = []
    modified: list[Path] = []
    removed: list[Path] = []

    for path in sorted(context.touched_paths):
        original = get_original_state(context, path)
        staged = get_staged_content(context, path)

        if not original.exists and staged is not None:
            created.append(path)
        elif original.exists and staged is None:
            removed.append(path)
        elif original.content != staged:
            modified.append(path)

    return ChangeSummary(
        created=tuple(created),
        modified=tuple(modified),
        removed=tuple(removed),
    )


def enforce_patch_not_empty(
    context: PatchContext,
    summary: ChangeSummary,
) -> None:
    if summary.created or summary.modified or summary.removed:
        return

    if context.data.get("allow_noop", False):
        return

    raise PatchError(
        "The entire patch produces no repository changes. "
        "Set 'allow_noop' to true only when this is intentional."
    )


def enforce_limits(
    context: PatchContext,
    summary: ChangeSummary,
) -> None:
    limits = context.data.get("limits", {})
    changed_paths = (
        summary.created + summary.modified + summary.removed
    )

    max_files = limits.get("max_files_changed")

    if max_files is not None and len(changed_paths) > max_files:
        raise PatchError(
            f"Patch changes {len(changed_paths)} files, exceeding "
            f"'max_files_changed' of {max_files}."
        )

    total_added_bytes = 0

    for path in changed_paths:
        original = get_original_state(context, path).content or b""
        staged = get_staged_content(context, path) or b""
        total_added_bytes += max(0, len(staged) - len(original))

        max_single = limits.get("max_single_file_bytes")

        if max_single is not None and len(staged) > max_single:
            raise PatchError(
                f"Staged file {relative_posix(path)!r} is "
                f"{len(staged)} bytes, exceeding "
                f"'max_single_file_bytes' of {max_single}."
            )

    max_added = limits.get("max_total_added_bytes")

    if max_added is not None and total_added_bytes > max_added:
        raise PatchError(
            f"Patch adds {total_added_bytes} net bytes, exceeding "
            f"'max_total_added_bytes' of {max_added}."
        )


def derive_actual_risks(
    context: PatchContext,
    summary: ChangeSummary,
) -> dict[str, bool]:
    package_paths = {
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
    }

    changed_relative = {
        relative_posix(path)
        for path in (
            summary.created + summary.modified + summary.removed
        )
    }

    overwrite_types = {"write", "overwrite"}
    operations = context.data["operations"]

    return {
        "overwrite_files": any(
            operation["operation"] in overwrite_types
            for operation in operations
        ),
        "delete_files": bool(summary.removed),
        "move_files": bool(context.moved_paths),
        "change_dependencies": bool(
            context.data.get("dependency_changes")
        )
        or bool(summary.removed)
        or bool(context.moved_paths),
        "modify_package_manifest": bool(
            changed_relative & package_paths
        ),
    }


def enforce_risk_acceptance(
    context: PatchContext,
    summary: ChangeSummary,
) -> None:
    declared = context.data.get("risk_acceptance", {})
    actual = derive_actual_risks(context, summary)

    for risk_name, occurs in actual.items():
        accepted = declared.get(risk_name, False)

        if occurs and not accepted:
            raise PatchError(
                f"Patch performs risk {risk_name!r}, but that risk was "
                "not acknowledged in 'risk_acceptance'."
            )

        if accepted and not occurs:
            raise PatchError(
                f"Patch acknowledges risk {risk_name!r}, but the staged "
                "patch does not perform that risk. The patch metadata may "
                "be stale or inaccurate."
            )


def copy_repository_for_validation(
    context: PatchContext,
    temporary_root: Path,
) -> Path:
    validation = context.data.get("validation", {})
    configured_excludes = set(
        validation.get("copy_excludes", [])
    )
    excludes = DEFAULT_TEMP_COPY_EXCLUDES | configured_excludes

    validation_root = temporary_root / "repository"

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored: set[str] = set()

        for name in names:
            if name in excludes:
                ignored.add(name)

        return ignored

    shutil.copytree(
        REPOSITORY_ROOT,
        validation_root,
        ignore=ignore,
        copy_function=shutil.copy2,
    )

    for path in context.touched_paths:
        relative = repository_relative(path)
        destination = validation_root / relative
        content = get_staged_content(context, path)

        if content is None:
            if destination.is_file() or destination.is_symlink():
                destination.unlink()
            elif destination.is_dir():
                shutil.rmtree(destination)
            continue

        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    if validation.get("link_node_modules", True):
        source_node_modules = REPOSITORY_ROOT / "node_modules"
        target_node_modules = validation_root / "node_modules"

        if source_node_modules.exists() and not target_node_modules.exists():
            try:
                os.symlink(
                    source_node_modules,
                    target_node_modules,
                    target_is_directory=True,
                )
            except OSError:
                # Validation may still work when package managers or
                # commands do not require local node_modules.
                pass

    return validation_root


def normalize_validation_command(
    raw_command: Any,
) -> tuple[list[str] | str, bool, tuple[str, ...]]:
    if isinstance(raw_command, str):
        return raw_command, True, (raw_command,)

    parts = [str(part) for part in raw_command]
    return parts, False, tuple(parts)


def run_validation_commands(
    context: PatchContext,
) -> list[ValidationResult]:
    validation = context.data.get("validation", {})
    raw_commands = validation.get("commands", [])

    if not raw_commands:
        return []

    timeout_seconds = validation.get("timeout_seconds", 600)
    results: list[ValidationResult] = []

    with tempfile.TemporaryDirectory(
        prefix="filepatcher-validation-"
    ) as temporary_directory:
        temporary_root = Path(temporary_directory)
        validation_root = copy_repository_for_validation(
            context,
            temporary_root,
        )

        for raw_command in raw_commands:
            command, use_shell, display_command = (
                normalize_validation_command(raw_command)
            )

            try:
                completed = subprocess.run(
                    command,
                    cwd=validation_root,
                    text=True,
                    capture_output=True,
                    shell=use_shell,
                    timeout=timeout_seconds,
                    env=os.environ.copy(),
                )
            except subprocess.TimeoutExpired as error:
                raise PatchError(
                    f"Validation command timed out after "
                    f"{timeout_seconds} seconds: "
                    f"{' '.join(display_command)}"
                ) from error
            except FileNotFoundError as error:
                raise PatchError(
                    f"Validation command executable was not found: "
                    f"{' '.join(display_command)}"
                ) from error

            result = ValidationResult(
                command=display_command,
                returncode=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )
            results.append(result)

            if completed.returncode != 0:
                details = completed.stderr.strip()

                if not details:
                    details = completed.stdout.strip()

                raise PatchError(
                    f"Validation command failed with exit code "
                    f"{completed.returncode}: "
                    f"{' '.join(display_command)}\n{details}"
                )

    return results


def create_backup_set(
    context: PatchContext,
    summary: ChangeSummary,
) -> Path | None:
    if context.data.get("backup", True) is False:
        return None

    changed_paths = (
        summary.modified + summary.removed
    )

    if not changed_paths:
        return None

    backup_directory = (
        BACKUP_ROOT
        / f"{timestamp_for_path()}-{context.patch_id}"
    )

    for path in changed_paths:
        original = get_original_state(context, path)

        if not original.exists or original.content is None:
            continue

        destination = backup_directory / repository_relative(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(original.content)

        if original.mode is not None:
            try:
                os.chmod(destination, original.mode)
            except OSError:
                pass

    metadata = {
        "patch_id": context.patch_id,
        "patch_name": context.patch_name,
        "created_at": utc_now().isoformat(),
        "repository_root": str(REPOSITORY_ROOT),
        "files": [
            relative_posix(path)
            for path in changed_paths
        ],
    }

    backup_directory.mkdir(parents=True, exist_ok=True)
    (backup_directory / "backup-manifest.json").write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )

    return backup_directory


def write_file_atomically(
    path: Path,
    content: bytes,
    mode: int | None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    temporary = path.with_name(
        f".{path.name}.filepatcher-{os.getpid()}.tmp"
    )

    try:
        temporary.write_bytes(content)

        if mode is not None:
            try:
                os.chmod(temporary, mode)
            except OSError:
                pass

        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def remove_empty_parent_directories(
    path: Path,
) -> None:
    current = path.parent
    root = REPOSITORY_ROOT.resolve()

    while current.resolve() != root:
        try:
            current.rmdir()
        except OSError:
            break

        current = current.parent


def restore_original_states(context: PatchContext) -> None:
    errors: list[str] = []

    for path in sorted(
        context.touched_paths,
        key=lambda value: len(value.parts),
        reverse=True,
    ):
        original = get_original_state(context, path)

        try:
            if original.exists and original.content is not None:
                write_file_atomically(
                    path,
                    original.content,
                    original.mode,
                )
            else:
                if path.is_file() or path.is_symlink():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path)

                remove_empty_parent_directories(path)
        except OSError as error:
            errors.append(
                f"{relative_posix(path)}: {error}"
            )

    if errors:
        raise PatchError(
            "Rollback encountered errors:\n- "
            + "\n- ".join(errors)
        )


def commit_staged_changes(context: PatchContext) -> None:
    written_paths: list[Path] = []

    try:
        # Remove files first so moves that only differ by case are less
        # likely to collide on case-insensitive file systems.
        removal_paths = [
            path
            for path in context.touched_paths
            if get_staged_content(context, path) is None
        ]

        write_paths = [
            path
            for path in context.touched_paths
            if get_staged_content(context, path) is not None
        ]

        for path in sorted(
            removal_paths,
            key=lambda value: len(value.parts),
            reverse=True,
        ):
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.exists():
                raise PatchError(
                    f"Refusing to remove non-file target: "
                    f"{relative_posix(path)}"
                )

            written_paths.append(path)

        for path in sorted(write_paths):
            content = get_staged_content(context, path)

            if content is None:
                continue

            original = get_original_state(context, path)
            write_file_atomically(
                path,
                content,
                original.mode,
            )
            written_paths.append(path)

    except Exception as error:
        try:
            restore_original_states(context)
        except PatchError as rollback_error:
            raise PatchError(
                f"Patch commit failed: {error}\n"
                f"Automatic rollback also failed: {rollback_error}"
            ) from error

        if isinstance(error, PatchError):
            raise PatchError(
                f"Patch commit failed and was rolled back: {error}"
            ) from error

        raise PatchError(
            f"Patch commit failed and was rolled back: {error}"
        ) from error


def make_history_record(
    context: PatchContext,
    summary: ChangeSummary,
    backup_directory: Path | None,
    validation_results: list[ValidationResult],
) -> dict[str, Any]:
    def file_record(path: Path) -> dict[str, Any]:
        original = get_original_state(context, path)
        staged = get_staged_content(context, path)

        return {
            "file": relative_posix(path),
            "original_exists": original.exists,
            "result_exists": staged is not None,
            "original_sha256": (
                sha256_bytes(original.content)
                if original.content is not None
                else None
            ),
            "result_sha256": (
                sha256_bytes(staged)
                if staged is not None
                else None
            ),
            "original_bytes": (
                len(original.content)
                if original.content is not None
                else 0
            ),
            "result_bytes": len(staged) if staged is not None else 0,
        }

    changed_paths = (
        summary.created + summary.modified + summary.removed
    )

    return {
        "schema_version": 1,
        "patch_id": context.patch_id,
        "patch_name": context.patch_name,
        "patch_file": str(context.patch_path),
        "applied_at": utc_now().isoformat(),
        "repository_root": str(REPOSITORY_ROOT),
        "git_head": get_git_head() if is_git_repository() else None,
        "backup_directory": (
            str(backup_directory)
            if backup_directory is not None
            else None
        ),
        "created": [
            relative_posix(path) for path in summary.created
        ],
        "modified": [
            relative_posix(path) for path in summary.modified
        ],
        "removed": [
            relative_posix(path) for path in summary.removed
        ],
        "files": [
            file_record(path) for path in changed_paths
        ],
        "validation_commands": [
            {
                "command": list(result.command),
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            for result in validation_results
        ],
    }


def write_history_record(
    context: PatchContext,
    record: dict[str, Any],
) -> Path:
    HISTORY_ROOT.mkdir(parents=True, exist_ok=True)

    history_path = history_path_for_patch(context.patch_id)
    temporary = history_path.with_name(
        f".{history_path.name}.{os.getpid()}.tmp"
    )

    temporary.write_text(
        json.dumps(record, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, history_path)

    return history_path


def print_change_summary(
    context: PatchContext,
    summary: ChangeSummary,
    validation_results: list[ValidationResult],
) -> None:
    print(f"Patch: {context.patch_name}")
    print(f"Patch ID: {context.patch_id}")
    print(f"Repository root: {REPOSITORY_ROOT}")
    print()

    print("Planned changes:")

    for path in summary.created:
        print(f"  A {relative_posix(path)}")

    for path in summary.modified:
        print(f"  M {relative_posix(path)}")

    for path in summary.removed:
        print(f"  D {relative_posix(path)}")

    print()

    if context.moved_paths:
        print("Moves:")

        for source, destination in context.moved_paths:
            print(
                f"  {relative_posix(source)}"
                f" -> {relative_posix(destination)}"
            )

        print()

    print("Validation:")
    print("  Patch schema: PASS")
    print("  Preconditions: PASS")
    print("  Operation safety checks: PASS")
    print("  Structural parsing: PASS")
    print("  Dependency checks: PASS")
    print("  Postconditions: PASS")

    for result in validation_results:
        print(f"  {' '.join(result.command)}: PASS")

    if not validation_results:
        print("  External commands: none configured")

    print()


def build_context(
    arguments: argparse.Namespace,
    data: dict[str, Any],
    patch_path: Path,
) -> PatchContext:
    patch_name = str(data.get("name", "Unnamed patch"))
    patch_id = derive_patch_id(data, patch_path)

    return PatchContext(
        patch_path=patch_path,
        data=data,
        patch_id=patch_id,
        patch_name=patch_name,
        dry_run=bool(arguments.dry_run),
        allow_dirty=bool(arguments.allow_dirty),
        allow_reapply=bool(arguments.reapply),
        original_states={},
        staged_states={},
        touched_paths=set(),
        moved_paths=[],
    )


def pre_register_operation_paths(context: PatchContext) -> None:
    for operation in context.data["operations"]:
        if operation["operation"] == "move_file":
            paths = [
                resolve_repository_path(operation["from"]),
                resolve_repository_path(operation["to"]),
            ]
        else:
            paths = [resolve_repository_path(operation["file"])]

        for path in paths:
            enforce_path_policy(path, context.data)
            get_original_state(context, path)
            context.touched_paths.add(path)


def apply_patch(
    arguments: argparse.Namespace,
) -> None:
    patch_path = arguments.patch.expanduser().resolve()
    data = load_patch_file(patch_path)
    validate_patch_schema(data)

    context = build_context(
        arguments,
        data,
        patch_path,
    )

    enforce_reapply_policy(
        context.patch_id,
        context.allow_reapply,
    )

    operations = [
        ensure_json_object(operation, "Operation")
        for operation in data["operations"]
    ]

    detect_conflicting_operations(operations)
    pre_register_operation_paths(context)

    # Git policy is checked before any operation is applied. This catches
    # dirty target files using their original paths.
    enforce_git_policy(context)

    validate_conditions_against_state(
        context,
        data.get("preconditions", []),
        staged=False,
        description="precondition",
    )

    for index, operation in enumerate(operations, start=1):
        apply_operation(context, operation, index)

    summary = derive_change_summary(context)
    enforce_patch_not_empty(context, summary)
    enforce_limits(context, summary)
    enforce_risk_acceptance(context, summary)

    validate_structural_syntax(context)
    validate_removed_file_dependencies(context)
    validate_declared_dependency_changes(context)

    validate_conditions_against_state(
        context,
        data.get("postconditions", []),
        staged=True,
        description="postcondition",
    )

    validation_results = run_validation_commands(context)

    print_change_summary(
        context,
        summary,
        validation_results,
    )

    if context.dry_run:
        print("Dry run complete. No repository files were modified.")
        return

    backup_directory = create_backup_set(context, summary)

    commit_staged_changes(context)

    try:
        history_record = make_history_record(
            context,
            summary,
            backup_directory,
            validation_results,
        )
        history_path = write_history_record(
            context,
            history_record,
        )
    except Exception as error:
        # The repository change succeeded. A history-writing failure should
        # be reported honestly, but should not silently undo a valid patch.
        print(
            f"WARNING: Patch was applied, but history could not be "
            f"written: {error}",
            file=sys.stderr,
        )
        history_path = None

    if backup_directory is not None:
        print(
            "Backup: "
            f"{backup_directory.relative_to(REPOSITORY_ROOT)}"
        )

    if history_path is not None:
        print(
            "History: "
            f"{history_path.relative_to(REPOSITORY_ROOT)}"
        )

    print()
    print("Patch applied successfully.")


def main() -> int:
    try:
        arguments = parse_arguments()
        apply_patch(arguments)
        return 0

    except PatchError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    except KeyboardInterrupt:
        print("ERROR: Patch cancelled by user.", file=sys.stderr)
        return 130

    except OSError as error:
        print(f"FILESYSTEM ERROR: {error}", file=sys.stderr)
        return 1

    except Exception as error:
        print(
            f"UNEXPECTED ERROR: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())